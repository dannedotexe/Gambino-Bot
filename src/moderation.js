import { randomUUID } from "node:crypto";
import { audit } from "./database.js";

export function startModeration({client,db,config}){
  const recent=new Map(),joins=new Map();
  client.on("guildMemberAdd",member=>{
    const now=Date.now(),key=member.guild.id,cut=now-config.RAID_WINDOW_SECONDS*1000;
    const values=(joins.get(key)??[]).filter(t=>t>cut);values.push(now);joins.set(key,values);
    if(values.length>=config.RAID_JOIN_COUNT){
      console.warn(`Possible join raid: guild=${key}, count=${values.length} / ${config.RAID_WINDOW_SECONDS}s`);
      logAutomod(db,member.guild.id,member.id,"join_raid","staff_alert");
      const channelId=config.CHANNEL_AUTOMOD_LOG;
      if(channelId)member.guild.channels.fetch(channelId).then(c=>c?.send(`⚠️ Möglicher Join-Raid erkannt: ${values.length} Beitritte innerhalb von ${config.RAID_WINDOW_SECONDS} Sekunden.`)).catch(()=>{});
    }
  });
  client.on("messageCreate",async message=>{
    if(!config.AUTOMOD_ENABLED||!message.guild||message.author.bot)return;
    const bypassRoles=[...(config.ROLE_STAFF??[]),...(config.ROLE_LEADERS??[]),...(config.ROLE_FINANCE??[]),...(config.ROLE_REVIEWERS??[]),...(config.ROLE_EVENT_TEAM??[])];
    if(message.member?.permissions.has("ManageMessages")||bypassRoles.some(id=>message.member?.roles.cache.has(id)))return;
    const now=Date.now(),key=`${message.guild.id}:${message.author.id}`,cut=now-config.AUTOMOD_SPAM_WINDOW_SECONDS*1000;
    const entries=(recent.get(key)??[]).filter(x=>x.at>cut);entries.push({at:now,content:message.content});recent.set(key,entries);
    let rule=null;
    if(entries.length>=config.AUTOMOD_SPAM_COUNT)rule="message_spam";
    const lower=message.content.toLowerCase();
    if(!rule&&config.AUTOMOD_BLOCKED_TERMS.some(term=>term&&lower.includes(term.toLowerCase())))rule="blocked_term";
    if(!rule&&/(https?:\/\/|www\.)/i.test(message.content)){
      const urls=message.content.match(/(?:https?:\/\/|www\.)[^\s<>]+/gi)??[];
      const allAllowed=urls.length>0&&urls.every(raw=>{try{const host=new URL(raw.startsWith("www.")?`https://${raw}`:raw).hostname.toLowerCase();return config.AUTOMOD_ALLOWED_DOMAINS.some(domain=>host===domain.toLowerCase()||host.endsWith(`.${domain.toLowerCase()}`));}catch{return false;}});
      if(!allAllowed)rule="unapproved_link";
    }
    if(!rule)return;
    try{await message.delete();}catch(error){console.warn("AutoMod could not delete message:",error.message);}
    logAutomod(db,message.guild.id,message.author.id,rule,"message_deleted");
    audit(db,message.guild.id,client.user.id,"automod.action",message.author.id,{rule,action:"message_deleted",channelId:message.channelId});
    const log=await message.guild.channels.fetch(config.CHANNEL_AUTOMOD_LOG).catch(()=>null);
    if(log)await log.send(`AutoMod: Regel \`${rule}\`, Aktion „Nachricht gelöscht“, Person <@${message.author.id}>, Kanal <#${message.channelId}>.`).catch(()=>{});
    if(rule!=="message_spam")await message.channel.send({content:`<@${message.author.id}> Bitte beachte die Serverregeln.`,allowedMentions:{users:[message.author.id]}}).then(m=>setTimeout(()=>m.delete().catch(()=>{}),6000).unref()).catch(()=>{});
  });
}
function logAutomod(db,guild,user,rule,action){db.prepare("INSERT INTO automod_actions(id,guild_id,user_id,rule,action,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(),guild,user,rule,action,new Date().toISOString());}
