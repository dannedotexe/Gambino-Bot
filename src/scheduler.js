import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { randomInt, randomUUID } from "node:crypto";
import { audit } from "./database.js";
import { auditLogPayload, BRAND_COLOR, logEmbed } from "./presentation.js";

export function startScheduler({db,client,config}) {
  let running=false,lastTicketCheck=0;
  const tick=async()=>{
    if(running)return;running=true;
    try{
      const now=new Date();
      const due=db.prepare("SELECT * FROM giveaways WHERE status='active' AND ends_at<=?").all(now.toISOString());
      for(const giveaway of due) await finishGiveaway(db,client,giveaway);
      const announce=db.prepare("SELECT g.* FROM giveaways g LEFT JOIN giveaway_announcements a ON a.giveaway_id=g.id WHERE g.status='ended' AND a.giveaway_id IS NULL ORDER BY g.ended_at LIMIT 20").all();
      for(const giveaway of announce)await announceGiveaway(db,client,giveaway);
      const events=db.prepare("SELECT * FROM events WHERE status='scheduled' AND starts_at>? AND starts_at<=?").all(now.toISOString(),new Date(now.getTime()+60*60_000).toISOString());
      for(const event of events){
        const mins=Math.ceil((new Date(event.starts_at)-now)/60_000);
        const slot=mins<=15?15:60;
        if(db.prepare("SELECT 1 FROM event_reminders WHERE event_id=? AND minutes_before=?").get(event.id,slot))continue;
        const inserted=db.prepare("INSERT OR IGNORE INTO event_reminders(event_id,minutes_before,sent_at) VALUES(?,?,?)").run(event.id,slot,now.toISOString());
        if(!inserted.changes)continue;
        const channel=await client.channels.fetch(event.channel_id).catch(()=>null);
        if(channel)await channel.send({embeds:[logEmbed("⏰ Event-Erinnerung",`**${event.name}** beginnt ${slot===15?"in etwa 15 Minuten":"in etwa einer Stunde"}.\n**Start:** <t:${Math.floor(new Date(event.starts_at).getTime()/1000)}:F>\n**Treffpunkt:** ${event.location||"Noch nicht angegeben"}`)]}).catch(()=>{});
      }
      if(Date.now()-lastTicketCheck>60_000){
        lastTicketCheck=Date.now();
        const tickets=db.prepare("SELECT id,guild_id,channel_id,user_id FROM tickets WHERE status='open' AND channel_id IS NOT NULL ORDER BY created_at LIMIT 100").all();
        for(const ticket of tickets){const channel=await client.channels.fetch(ticket.channel_id).catch(()=>null);if(!channel){db.prepare("UPDATE tickets SET status='closed',closed_at=?,updated_at=? WHERE id=? AND status='open'").run(now.toISOString(),now.toISOString(),ticket.id);audit(db,ticket.guild_id,client.user.id,"ticket.channel_missing",ticket.user_id,{ticketId:ticket.id,channelId:ticket.channel_id});}}
      }
      const pending=db.prepare("SELECT a.* FROM audit_logs a LEFT JOIN audit_log_deliveries d ON d.audit_id=a.id WHERE d.audit_id IS NULL ORDER BY a.created_at LIMIT 50").all();
      const logChannel=config.CHANNEL_AUDIT_LOG?await client.channels.fetch(config.CHANNEL_AUDIT_LOG).catch(()=>null):null;
      for(const item of pending){
        const claimed=db.prepare("INSERT OR IGNORE INTO audit_log_deliveries(audit_id,attempted_at,result) VALUES(?,?,?)").run(item.id,now.toISOString(),logChannel?"attempted":"no_channel");
        if(claimed.changes&&logChannel){await logChannel.send(auditLogPayload(item)).catch(error=>console.warn("Audit channel delivery failed; DB audit retained:",error.message));}
      }
    }catch(error){console.error("Scheduler tick failed:",error);}finally{running=false;}
  };
  const timer=setInterval(tick,15_000);timer.unref();void tick();return()=>clearInterval(timer);
}

async function finishGiveaway(db,client,row){
  const end=db.transaction(()=>{
    const changed=db.prepare("UPDATE giveaways SET status='ended',ended_at=? WHERE id=? AND status='active'").run(new Date().toISOString(),row.id).changes;
    if(!changed)return null;
    const participants=db.prepare("SELECT user_id FROM giveaway_entries WHERE giveaway_id=? ORDER BY user_id").all(row.id).map(x=>x.user_id);
    for(let n=participants.length-1;n>0;n--){const j=randomInt(n+1);[participants[n],participants[j]]=[participants[j],participants[n]];}
    const winners=participants.slice(0,row.winner_count);
    db.prepare("UPDATE giveaways SET winners=? WHERE id=?").run(JSON.stringify(winners),row.id);
    audit(db,row.guild_id,row.created_by,"giveaway.ended",row.id,{winnerIds:winners,entries:participants.length});
    return winners;
  });
  if(!end())return;
  const ended=db.prepare("SELECT * FROM giveaways WHERE id=?").get(row.id);
  await announceGiveaway(db,client,ended);
}

async function announceGiveaway(db,client,row){
  const winners=JSON.parse(row.winners??"[]"),channel=await client.channels.fetch(row.channel_id).catch(()=>null);
  if(!channel){console.warn(`Giveaway ${row.id} ended but its channel is unavailable; result remains stored for retry.`);return;}
  const result={embeds:[new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({name:"GAMBINOS  •  GIVEAWAY"}).setTitle(`🎉 Giveaway beendet: ${row.prize}`).setDescription(winners.length?`**Gewonnen haben:**\n${winners.map(id=>`🏆 <@${id}>`).join("\n")}`:"Es gab keine Teilnahmen; es wurde kein Gewinner gezogen.").setFooter({text:"GAMBINOS  •  Ergebnis dauerhaft gespeichert"}).setTimestamp()],components:[],allowedMentions:{users:winners}};
  let delivered=false;const message=row.message_id?await channel.messages.fetch(row.message_id).catch(()=>null):null;
  if(message){await message.edit(result);delivered=true;}else{await channel.send(result);delivered=true;}
  if(delivered)db.prepare("INSERT OR IGNORE INTO giveaway_announcements(giveaway_id,sent_at) VALUES(?,?)").run(row.id,new Date().toISOString());
}
