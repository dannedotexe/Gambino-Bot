import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder,
  PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { audit } from "./database.js";
import { formatMoney, parseMoney } from "./services/finance.js";
import { requireRole } from "./config.js";
import { BRAND_COLOR, applicationDecisionDm, logEmbed, presentInteractionPayload } from "./presentation.js";

const isoNow=()=>new Date().toISOString();
const ts=()=>Math.floor(Date.now()/1000);
const embed=(title,description)=>new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({name:"GAMBINOS  •  FAMILIENVERWALTUNG"}).setTitle(title).setDescription(description).setFooter({text:"GAMBINOS  •  Grand-RP"}).setTimestamp();
const err=(e)=>e instanceof Error?e.message:"Die Aktion ist fehlgeschlagen.";
const ticketPresentation={
  support:{emoji:"🛠️",description:"Allgemeine Fragen und Hilfe"},
  beschwerde:{emoji:"⚠️",description:"Ein Problem oder eine Beschwerde melden"},
  leitung:{emoji:"👑",description:"Ein wichtiges Anliegen an die Leitung"},
};

export function applicationQuestions(kind) {
  if(kind==="rang")return [
    {id:"name",label:"Dein Ingame-Name",style:TextInputStyle.Short,maxLength:60},
    {id:"aktueller_rang",label:"Dein aktueller Familienrang",style:TextInputStyle.Short,maxLength:60},
    {id:"ziel_rang",label:"Welchen Rang beantragst du?",style:TextInputStyle.Short,maxLength:60},
    {id:"begruendung",label:"Warum sollst du den Rang erhalten?",style:TextInputStyle.Paragraph,maxLength:1000},
  ];
  return [
    {id:"name",label:"Dein Ingame-Name",style:TextInputStyle.Short,maxLength:60},
    {id:"alter",label:"Wie alt bist du?",style:TextInputStyle.Short,maxLength:30},
    {id:"erfahrung",label:"Deine Grand-RP-Erfahrung",style:TextInputStyle.Paragraph,maxLength:1000},
    {id:"motivation",label:"Warum möchtest du zu Gambinos?",style:TextInputStyle.Paragraph,maxLength:1000},
    {id:"aktivitaet",label:"Wann bist du normalerweise aktiv?",style:TextInputStyle.Paragraph,maxLength:500},
  ];
}

function applicationModal(kind) {
  const isRank=kind==="rang";
  const modal=new ModalBuilder().setCustomId(`application:submit:${kind}`).setTitle(isRank?"Rang-Antrag":"Gambinos Bewerbung");
  for(const question of applicationQuestions(kind))modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(question.id).setLabel(question.label).setStyle(question.style).setRequired(true).setMaxLength(question.maxLength)));
  return modal;
}

export function buildApplicationPanelPayload() {
  const panel=new EmbedBuilder().setColor(0xd4af37)
    .setAuthor({name:"GAMBINOS  •  FAMILIENBÜRO"})
    .setTitle("📋  Bewerbungen & Rang-Anträge")
    .setDescription("Wähle den passenden Antrag aus. Beide Formulare fragen gezielt die Informationen ab, die das Leitungsteam für die Entscheidung braucht.")
    .addFields(
      {name:"🤝  Familienbeitritt",value:"Erzähl uns etwas über dich, deine Grand-RP-Erfahrung und warum du zu Gambinos möchtest.",inline:true},
      {name:"🏅  Rang-Antrag",value:"Nenne deinen aktuellen Rang, den gewünschten Rang und deine Begründung.",inline:true},
      {name:"🔒  Vertrauliche Prüfung",value:"Deine Angaben werden an das zuständige Team zur Prüfung weitergeleitet.",inline:false},
    )
    .setFooter({text:"GAMBINOS  •  Danke für dein Interesse"})
    .setTimestamp();
  const buttons=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("application:open:bewerbung").setLabel("🤝  Bei Gambinos bewerben").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("application:open:rang").setLabel("🏅  Rang beantragen").setStyle(ButtonStyle.Secondary),
  );
  return {embeds:[panel],components:[buttons]};
}

export function buildTicketPanelPayload(config) {
  const options=config.TICKET_CATEGORIES_JSON.map(c=>{
    const presentation=ticketPresentation[c.id]??{emoji:"🎫",description:`Ein Ticket für ${c.label}`};
    return {label:c.label,value:c.id,description:presentation.description,emoji:{name:presentation.emoji}};
  });
  const panel=new EmbedBuilder().setColor(0xd4af37)
    .setAuthor({name:"GAMBINOS  •  SUPPORT CENTER"})
    .setTitle("🎫  Wie können wir dir helfen?")
    .setDescription("Wähle unten dein Anliegen. Der Bot öffnet einen privaten Channel für dich und das zuständige Team.\n\n🔒 Nur Beteiligte sehen dein Ticket.\n💬 Beschreibe dein Anliegen direkt im neuen Channel.")
    .setFooter({text:"GAMBINOS  •  Wir helfen dir weiter"})
    .setTimestamp();
  const select=new StringSelectMenuBuilder().setCustomId("ticket:create").setPlaceholder("🎟️  Wähle dein Anliegen aus …").addOptions(options);
  return {embeds:[panel],components:[new ActionRowBuilder().addComponents(select)]};
}

export function buildApplicationReviewPayload(kind,userId,answers,decision=null,reason="",reviewerId=null) {
  const questions=applicationQuestions(kind);
  const labels=new Map(questions.map(question=>[question.id,question.label]));
  const panel=new EmbedBuilder().setColor(0xd4af37)
    .setAuthor({name:"GAMBINOS  •  FAMILIENBÜRO"})
    .setTitle(`${kind==="rang"?"🏅 Rang-Antrag":"🤝 Bewerbung"}`)
    .setDescription(`**Antragsteller:** <@${userId}>\n**Eingereichte Angaben:**${decision?`\n\n**Status:** ${decision==="accepted"?"✅ Angenommen":decision==="rejected"?"❌ Abgelehnt":`🔎 In Prüfung · <@${reviewerId}>`}`:""}`)
    .addFields(Object.entries(answers).map(([key,value])=>({name:labels.get(key)??key,value:String(value).slice(0,1024),inline:false})))
    .setColor(decision==="accepted"?0x2ecc71:decision==="rejected"?0xe74c3c:0xd4af37)
    .setFooter({text:decision==="rejected"?`Ablehnungsgrund: ${reason}`.slice(0,2048):decision==="review"?"GAMBINOS  •  Bearbeitung übernommen":"GAMBINOS  •  Interne Prüfung"})
    .setTimestamp();
  return {embeds:[panel]};
}

export function buildCommands() {
  const money = new SlashCommandBuilder().setName("konto").setDescription("Gambinos-Familienkonto")
    .addSubcommand(s=>s.setName("stand").setDescription("Eigenen Kontostand sehen"))
    .addSubcommand(s=>s.setName("ansehen").setDescription("Kontostand eines Mitglieds (Finanzrolle)").addUserOption(o=>o.setName("mitglied").setDescription("Mitglied").setRequired(true)))
    .addSubcommand(s=>s.setName("gutschrift").setDescription("Geld gutschreiben (Finanzrolle)").addUserOption(o=>o.setName("mitglied").setDescription("Empfänger").setRequired(true)).addStringOption(o=>o.setName("betrag").setDescription("Betrag in Dollar").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Buchungsgrund").setRequired(true)))
    .addSubcommand(s=>s.setName("auszahlen").setDescription("Guthaben auszahlen und Sanktionen verrechnen").addUserOption(o=>o.setName("mitglied").setDescription("Empfänger").setRequired(true)))
    .addSubcommand(s=>s.setName("liste").setDescription("Auszahlungsliste (Finanzrolle)"))
    .addSubcommand(s=>s.setName("historie").setDescription("Transaktionshistorie").addUserOption(o=>o.setName("mitglied").setDescription("Mitglied (Finanzrolle)")));
  const sanction = new SlashCommandBuilder().setName("sanktion").setDescription("Sanktionsverwaltung")
    .addSubcommand(s=>s.setName("erstellen").setDescription("Auszahlungsabzug vormerken").addUserOption(o=>o.setName("mitglied").setDescription("Betroffenes Mitglied").setRequired(true)).addStringOption(o=>o.setName("betrag").setDescription("Betrag in Dollar").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Grund").setRequired(true)).addStringOption(o=>o.setName("fall").setDescription("Optionale Fall- oder Event-ID")))
    .addSubcommand(s=>s.setName("offen").setDescription("Offene Sanktionen anzeigen").addUserOption(o=>o.setName("mitglied").setDescription("Mitglied (optional)")))
    .addSubcommand(s=>s.setName("aufheben").setDescription("Offene Sanktion aufheben").addStringOption(o=>o.setName("id").setDescription("Sanktions-ID").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Aufhebungsgrund").setRequired(true)))
    .addSubcommand(s=>s.setName("rueckerstatten").setDescription("Bereits abgezogene Sanktion erstatten und aufheben").addStringOption(o=>o.setName("id").setDescription("Sanktions-ID").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Erstattungsgrund").setRequired(true)));
  const ticket = new SlashCommandBuilder().setName("ticket").setDescription("Ticketsystem")
    .addSubcommand(s=>s.setName("panel").setDescription("Ticket-Panel senden (Staff)"))
    .addSubcommand(s=>s.setName("uebernehmen").setDescription("Dieses Ticket übernehmen (Staff)"))
    .addSubcommand(s=>s.setName("wiedereroeffnen").setDescription("Geschlossenes Ticket wieder öffnen (Staff)"))
    .addSubcommand(s=>s.setName("schliessen").setDescription("Dieses Ticket schließen"));
  const event = new SlashCommandBuilder().setName("event").setDescription("Familien-Events")
    .addSubcommand(s=>s.setName("erstellen").setDescription("Event anlegen").addStringOption(o=>o.setName("name").setDescription("Name").setRequired(true)).addStringOption(o=>o.setName("start").setDescription("ISO-Datum, z. B. 2026-12-31T19:00:00+01:00").setRequired(true)).addStringOption(o=>o.setName("treffpunkt").setDescription("Treffpunkt").setRequired(true)).addStringOption(o=>o.setName("beschreibung").setDescription("Beschreibung").setRequired(true)).addIntegerOption(o=>o.setName("maximum").setDescription("Teilnehmerlimit").setMinValue(1)).addStringOption(o=>o.setName("ausruestung").setDescription("Benötigte Ausrüstung")).addStringOption(o=>o.setName("hinweise").setDescription("Teilnahmehinweise")))
    .addSubcommand(s=>s.setName("liste").setDescription("Anstehende Events"))
    .addSubcommand(s=>s.setName("historie").setDescription("Vergangene Events"))
    .addSubcommand(s=>s.setName("bearbeiten").setDescription("Geplantes Event ändern").addStringOption(o=>o.setName("id").setDescription("Event-ID").setRequired(true)).addStringOption(o=>o.setName("name").setDescription("Neuer Name")).addStringOption(o=>o.setName("start").setDescription("Neues ISO-Datum mit Zeitzone")).addStringOption(o=>o.setName("treffpunkt").setDescription("Neuer Treffpunkt")).addStringOption(o=>o.setName("beschreibung").setDescription("Neue Beschreibung")).addIntegerOption(o=>o.setName("maximum").setDescription("Neues Teilnehmerlimit").setMinValue(1)))
    .addSubcommand(s=>s.setName("anwesenheit").setDescription("Teilnahme dokumentieren (Event-Team)").addStringOption(o=>o.setName("id").setDescription("Event-ID").setRequired(true)).addUserOption(o=>o.setName("mitglied").setDescription("Teilnehmer").setRequired(true)).addStringOption(o=>o.setName("status").setDescription("Teilnahme").setRequired(true).addChoices({name:"Anwesend",value:"present"},{name:"Abwesend",value:"absent"})))
    .addSubcommand(s=>s.setName("beenden").setDescription("Event abschließen").addStringOption(o=>o.setName("id").setDescription("Event-ID").setRequired(true)))
    .addSubcommand(s=>s.setName("absagen").setDescription("Event absagen").addStringOption(o=>o.setName("id").setDescription("Event-ID").setRequired(true)));
  const apps = new SlashCommandBuilder().setName("antrag").setDescription("Bewerbung und Rang-Anträge")
    .addSubcommand(s=>s.setName("bewerben").setDescription("Bewerbung einreichen").addStringOption(o=>o.setName("typ").setDescription("Bewerbungstyp").setRequired(true).addChoices({name:"Familienbeitritt",value:"bewerbung"},{name:"Rang-Antrag",value:"rang"})))
    .addSubcommand(s=>s.setName("liste").setDescription("Offene Anträge (Reviewer)"))
    .addSubcommand(s=>s.setName("entscheiden").setDescription("Antrag mit optionalem Kommentar entscheiden (Reviewer)").addStringOption(o=>o.setName("id").setDescription("Antrags-ID").setRequired(true)).addStringOption(o=>o.setName("entscheidung").setDescription("Ergebnis").setRequired(true).addChoices({name:"Annehmen",value:"accepted"},{name:"Ablehnen",value:"rejected"})).addStringOption(o=>o.setName("kommentar").setDescription("Begründung für Antragsteller")))
    .addSubcommand(s=>s.setName("status").setDescription("Eigenen Antrag zurückziehen").addStringOption(o=>o.setName("id").setDescription("Antrags-ID").setRequired(true)));
  const giveaway = new SlashCommandBuilder().setName("giveaway").setDescription("Giveaways")
    .addSubcommand(s=>s.setName("erstellen").setDescription("Giveaway starten").addStringOption(o=>o.setName("preis").setDescription("Preis").setRequired(true)).addIntegerOption(o=>o.setName("minuten").setDescription("Dauer in Minuten").setRequired(true).setMinValue(1).setMaxValue(10080)).addIntegerOption(o=>o.setName("gewinner").setDescription("Gewinnerzahl").setRequired(true).setMinValue(1).setMaxValue(20)).addStringOption(o=>o.setName("bedingungen").setDescription("Teilnahmebedingungen")))
    .addSubcommand(s=>s.setName("abbrechen").setDescription("Giveaway abbrechen").addStringOption(o=>o.setName("id").setDescription("Giveaway-ID").setRequired(true)));
  const misc = [
    new SlashCommandBuilder().setName("ping").setDescription("Bot-Latenz anzeigen"),
    new SlashCommandBuilder().setName("help").setDescription("Befehlsübersicht"),
    new SlashCommandBuilder().setName("bewerbung-panel").setDescription("Bewerbungs-Panel senden (Reviewer)"),
    new SlashCommandBuilder().setName("dashboard").setDescription("Staff-Übersicht (berechtigte Rollen)"),
    new SlashCommandBuilder().setName("statistik").setDescription("Familienstatistik anzeigen"),
  ];
  return [money,sanction,ticket,event,apps,giveaway,...misc].map(c=>c.toJSON());
}

export function createHandler({db,finance,config,client}) {
  client.gambinoOwnerIds=config.BOT_OWNER_IDS??[];
  const guards={leaders:config.ROLE_LEADERS, staff:[...(config.ROLE_LEADERS??[]),...(config.ROLE_STAFF??[])], finance:[...(config.ROLE_LEADERS??[]),...(config.ROLE_FINANCE??[])], reviewers:[...(config.ROLE_LEADERS??[]),...(config.ROLE_REVIEWERS??[])], events:[...(config.ROLE_LEADERS??[]),...(config.ROLE_EVENT_TEAM??[])]};
  const isOwner=i=>config.BOT_OWNER_IDS?.includes(i.user?.id)??false;
  const hasRoleOrOwner=(i,roles)=>isOwner(i)||roles.some(r=>i.member?.roles?.cache?.has(r));
  const answer=(i,options)=>i.reply(presentInteractionPayload(options));
  const followUp=(i,options)=>i.followUp(presentInteractionPayload(options));
  const updateMessage=(i,options)=>i.update(presentInteractionPayload(options));
  const replyError=async(i,e)=>{ const msg=err(e); if(i.deferred||i.replied) return followUp(i,{content:msg,ephemeral:true}).catch(()=>{}); return answer(i,{content:msg,ephemeral:true}).catch(()=>{}); };
  const respond=async(i,content,ephemeral=true)=>answer(i,{content,ephemeral});
  async function command(i) {
    if (!i.inGuild()) return respond(i,"Dieser Bot-Befehl funktioniert nur in einem Server.");
    if(config.DISCORD_GUILD_ID&&i.guildId!==config.DISCORD_GUILD_ID)return respond(i,"Der Bot ist für diesen Server nicht freigeschaltet.");
    const g=i.guildId,u=i.user.id,sub=i.options.getSubcommand(false);
    try {
      if (i.commandName==="ping") return respond(i,`Pong! ${client.ws.ping} ms`);
      if (i.commandName==="help") return respond(i,"**Gambino Bot**\n`/konto` Familienkonto und Auszahlungen · `/sanktion` Sanktionsverwaltung · `/ticket` Supporttickets · `/event` Familien-Events · `/antrag` Bewerbungen und Rang-Anträge · `/giveaway` Giveaways · `/dashboard` Staff-Übersicht · `/statistik` Kennzahlen");
      if (i.commandName==="konto") {
        if (sub==="stand"||sub==="ansehen") {
          const id=sub==="stand"?u:i.options.getUser("mitglied").id;
          if (id!==u&&!hasRoleOrOwner(i,guards.finance)) return respond(i,"Fremde Konten darf nur die Finanzrolle ansehen.");
          return respond(i,`Kontostand von <@${id}>: **${formatMoney(finance.balance(g,id))}**`,true);
        }
        if (sub==="gutschrift") {
          const denied=requireRole(i,guards.finance,"Finanzrolle"); if(denied)return respond(i,denied);
          const target=i.options.getUser("mitglied"),cents=parseMoney(i.options.getString("betrag"));
          const tx=finance.credit({guildId:g,userId:target.id,actorId:u,cents,reason:i.options.getString("grund"),key:`credit:${i.id}`});
          return respond(i,`Gutschrift **${formatMoney(cents)}** für <@${target.id}> gebucht. ID: \`${tx.id}\``);
        }
        if (sub==="auszahlen") {
          const denied=requireRole(i,guards.finance,"Finanzrolle"); if(denied)return respond(i,denied);
          const target=i.options.getUser("mitglied"),gross=finance.balance(g,target.id);
          if(config.PAYOUT_MINIMUM_CENTS!=null&&gross<config.PAYOUT_MINIMUM_CENTS)return respond(i,`Das Guthaben liegt unter dem Mindestbetrag von ${formatMoney(config.PAYOUT_MINIMUM_CENTS)}.`);
          const rows=db.prepare("SELECT remaining_cents FROM sanctions WHERE guild_id=? AND user_id=? AND status IN ('open','partial')").all(g,target.id);
          const deduction=Math.min(gross,rows.reduce((n,r)=>n+r.remaining_cents,0));
          if(gross===0)return respond(i,"Kein auszahlbares Familienguthaben vorhanden.");
          const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`payout:${i.id}:${target.id}:${gross}:${deduction}`).setLabel("Auszahlung bestätigen").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`cancel:${i.id}`).setLabel("Abbrechen").setStyle(ButtonStyle.Secondary));
          return answer(i,{embeds:[embed("Auszahlung bestätigen",`Empfänger: <@${target.id}>\nBrutto: **${formatMoney(gross)}**\nOffene Sanktionen: **${formatMoney(rows.reduce((n,r)=>n+r.remaining_cents,0))}**\nJetzt verrechnet: **${formatMoney(deduction)}**\nTatsächlich ausgezahlt: **${formatMoney(gross-deduction)}**\nVerbleibende Sanktionen: **${formatMoney(rows.reduce((n,r)=>n+r.remaining_cents,0)-deduction)}**\n\nDer Vorgang wird atomar gebucht und kann nicht doppelt ausgeführt werden.`)],components:[row],ephemeral:true});
        }
        if (sub==="liste") {
          const denied=requireRole(i,guards.finance,"Finanzrolle"); if(denied)return respond(i,denied);
          const rows=db.prepare("SELECT user_id,balance_cents FROM accounts WHERE guild_id=? ORDER BY balance_cents DESC LIMIT 30").all(g);
          const min=config.PAYOUT_MINIMUM_CENTS;
          return respond(i,rows.length?rows.map(r=>`<@${r.user_id}> — ${formatMoney(r.balance_cents)}${min==null?"":r.balance_cents>=min?" · auszahlbar":" · Mindestbetrag nicht erreicht"}`).join("\n"):"Noch keine Familienkonten vorhanden.");
        }
        if (sub==="historie") {
          const target=i.options.getUser("mitglied")?.id??u;
          if(target!==u&&!hasRoleOrOwner(i,guards.finance))return respond(i,"Fremde Kontohistorien darf nur die Finanzrolle ansehen.");
          const rows=db.prepare("SELECT type,amount_cents,gross_cents,deduction_cents,net_cents,reason,created_at,id FROM transactions WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 10").all(g,target);
          return respond(i,rows.length?rows.map(r=>`\`${r.id.slice(0,8)}\` ${new Date(r.created_at).toLocaleString("de-AT")} · ${r.type} · ${formatMoney(r.amount_cents)} · ${r.reason}`).join("\n"):"Keine Buchungen vorhanden.");
        }
      }
      if (i.commandName==="sanktion") {
        if(sub==="erstellen") { const denied=requireRole(i,guards.staff,"Staff-Rolle");if(denied)return respond(i,denied);const target=i.options.getUser("mitglied"),id=finance.sanction({guildId:g,userId:target.id,actorId:u,cents:parseMoney(i.options.getString("betrag")),reason:i.options.getString("grund"),caseRef:i.options.getString("fall")});return respond(i,`Sanktion \`${id}\` für <@${target.id}> gespeichert. Sie wird erst bei Auszahlungen abgezogen.`); }
        if(sub==="offen") { const target=i.options.getUser("mitglied")?.id??u;if(target!==u&&!hasRoleOrOwner(i,guards.staff))return respond(i,"Fremde Sanktionen darf nur Staff ansehen.");const rows=db.prepare("SELECT id,remaining_cents,reason,status FROM sanctions WHERE guild_id=? AND user_id=? AND status IN ('open','partial') ORDER BY created_at").all(g,target);return respond(i,rows.length?rows.map(r=>`\`${r.id}\` · ${formatMoney(r.remaining_cents)} offen · ${r.status} · ${r.reason}`).join("\n"):"Keine offenen Sanktionen."); }
        if(sub==="aufheben") {const denied=requireRole(i,guards.leaders,"Leitungsrolle");if(denied)return respond(i,denied);finance.voidSanction({guildId:g,sanctionId:i.options.getString("id"),actorId:u,reason:i.options.getString("grund")});return respond(i,"Sanktion wurde nachvollziehbar aufgehoben.");}
        if(sub==="rueckerstatten") {const denied=requireRole(i,guards.leaders,"Leitungsrolle");if(denied)return respond(i,denied);const tx=finance.refundSanction({guildId:g,sanctionId:i.options.getString("id"),actorId:u,reason:i.options.getString("grund"),key:`refund:${i.id}`});return respond(i,`Abzug von **${formatMoney(tx.amount_cents)}** erstattet. Transaktion: \`${tx.id}\``);}
      }
      if(i.commandName==="ticket"&&sub==="panel") {
        const denied=requireRole(i,guards.staff,"Staff-Rolle");if(denied)return respond(i,denied);
        await i.channel.send(buildTicketPanelPayload(config));
        return respond(i,"Das Support-Panel wurde veröffentlicht.");
      }
      if(i.commandName==="ticket"&&sub==="uebernehmen"){const denied=requireRole(i,guards.staff,"Staff-Rolle");if(denied)return respond(i,denied);const row=db.prepare("UPDATE tickets SET claimed_by=?,updated_at=? WHERE channel_id=? AND status='open' AND claimed_by IS NULL RETURNING id,user_id").get(u,isoNow(),i.channelId);if(!row)return respond(i,"Ticket nicht gefunden oder bereits übernommen.");audit(db,g,u,"ticket.claimed",row.user_id,{ticketId:row.id});return respond(i,`Ticket übernommen · \`${row.id}\``);}
      if(i.commandName==="ticket"&&sub==="wiedereroeffnen"){const denied=requireRole(i,guards.staff,"Staff-Rolle");if(denied)return respond(i,denied);const row=db.prepare("UPDATE tickets SET status='open',closed_at=NULL,updated_at=? WHERE channel_id=? AND status='closed' RETURNING id,user_id").get(isoNow(),i.channelId);if(!row)return respond(i,"Geschlossenes Ticket nicht gefunden.");await i.channel.permissionOverwrites.edit(row.user_id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});audit(db,g,u,"ticket.reopened",row.user_id,{ticketId:row.id});await i.channel.send({embeds:[embed("🔓 Ticket wieder geöffnet",`<@${row.user_id}> kann das Ticket wieder nutzen. Staff kann die Bearbeitung übernehmen.`)]});return respond(i,"Ticket wieder geöffnet.");}
      if(i.commandName==="ticket"&&sub==="schliessen") {const row=db.prepare("SELECT * FROM tickets WHERE channel_id=? AND status='open'").get(i.channelId);if(!row)return respond(i,"Dies ist kein offenes Ticket.");if(row.user_id!==u&&!hasRoleOrOwner(i,guards.staff))return respond(i,"Nur Ersteller oder Staff können dieses Ticket schließen.");await answer(i,{content:"Ticket wirklich schließen?",components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticket:close:${row.id}`).setLabel("Schließen").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId("cancel:ticket").setLabel("Abbrechen").setStyle(ButtonStyle.Secondary))],ephemeral:true});return;}
      if(i.commandName==="event") return await eventCommand(i,sub,{db,config,guards,g,u});
      if(i.commandName==="antrag") return await applicationCommand(i,sub,{db,config,guards,g,u});
      if(i.commandName==="bewerbung-panel") {const denied=requireRole(i,guards.reviewers,"Reviewer-Rolle");if(denied)return respond(i,denied);await i.channel.send(buildApplicationPanelPayload());return respond(i,"Bewerbungs-Panel veröffentlicht.");}
      if(i.commandName==="giveaway") return await giveawayCommand(i,sub,{db,guards,g,u});
      if(i.commandName==="dashboard"||i.commandName==="statistik") {const denied=requireRole(i,guards.staff,"Staff-Rolle");if(denied)return respond(i,denied);return respond(i,stats(db,g,i.commandName==="dashboard"));}
      return respond(i,"Unbekannter Befehl.");
    } catch(e) { console.error(`Command ${i.commandName} failed:`,e); return replyError(i,e); }
  }

  async function eventCommand(i,sub,{db,config,guards,g,u}) {
    if(sub==="erstellen") {const denied=requireRole(i,guards.events,"Event-Team");if(denied)return respond(i,denied);const start=parseOffsetDate(i.options.getString("start"));if(!start||start.getTime()<Date.now()+60_000)return respond(i,"Bitte ein gültiges zukünftiges Datum mit Zeitzone angeben (ISO-Format mit Z oder Offset).");const id=randomUUID(),ch=await targetChannel(i.guild,config.CHANNEL_EVENT_ANNOUNCEMENTS)??i.channel;const item={id,guild_id:g,name:i.options.getString("name"),description:i.options.getString("beschreibung"),starts_at:start.toISOString(),location:i.options.getString("treffpunkt"),host_id:u,equipment:i.options.getString("ausruestung")??"",notes:i.options.getString("hinweise")??"",max_participants:i.options.getInteger("maximum")};db.prepare("INSERT INTO events(id,guild_id,name,description,starts_at,location,host_id,equipment,notes,max_participants,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'scheduled',?)").run(id,g,item.name,item.description,item.starts_at,item.location,u,item.equipment,item.notes,item.max_participants,isoNow());const sent=await ch.send({embeds:[eventEmbed(item,0)],components:[eventButtons(id)]});db.prepare("UPDATE events SET channel_id=?,message_id=? WHERE id=?").run(ch.id,sent.id,id);await answer(i,{content:`Event **${item.name}** erstellt · ID \`${id}\``,ephemeral:true});return;}
    if(sub==="liste"||sub==="historie") {const status=sub==="liste"?"scheduled":"ended";const rows=db.prepare("SELECT * FROM events WHERE guild_id=? AND status=? ORDER BY starts_at LIMIT 10").all(g,status);return respond(i,rows.length?rows.map(e=>`\`${e.id.slice(0,8)}\` **${e.name}** · <t:${Math.floor(new Date(e.starts_at).getTime()/1000)}:F> · ${db.prepare("SELECT COUNT(*) n FROM event_participants WHERE event_id=? AND status IN ('signed_up','present')").get(e.id).n} angemeldet`).join("\n"):"Keine passenden Events vorhanden.");}
    if(sub==="bearbeiten"){const denied=requireRole(i,guards.events,"Event-Team");if(denied)return respond(i,denied);const id=i.options.getString("id"),old=db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled'").get(id,g);if(!old)return respond(i,"Geplantes Event nicht gefunden.");const startText=i.options.getString("start"),start=startText?parseOffsetDate(startText):new Date(old.starts_at);if(!start||start.getTime()<Date.now()+60_000)return respond(i,"Bitte ein gültiges zukünftiges Datum mit Zeitzone angeben.");db.prepare("UPDATE events SET name=?,starts_at=?,location=?,description=?,max_participants=COALESCE(?,max_participants) WHERE id=?").run(i.options.getString("name")??old.name,start.toISOString(),i.options.getString("treffpunkt")??old.location,i.options.getString("beschreibung")??old.description,i.options.getInteger("maximum"),id);const updated=db.prepare("SELECT * FROM events WHERE id=?").get(id);audit(db,g,u,"event.updated",id,{name:updated.name,startsAt:updated.starts_at});const channel=await targetChannel(i.guild,old.channel_id);const message=channel&&old.message_id?await channel.messages.fetch(old.message_id).catch(()=>null):null;if(message)await message.edit({embeds:[eventEmbed(updated,db.prepare("SELECT COUNT(*) n FROM event_participants WHERE event_id=? AND status IN ('signed_up','present')").get(id).n,db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status IN ('signed_up','present')").all(id))]}).catch(()=>{});return respond(i,`Event **${updated.name}** aktualisiert.`);}
    if(sub==="anwesenheit"){const denied=requireRole(i,guards.events,"Event-Team");if(denied)return respond(i,denied);const id=i.options.getString("id"),target=i.options.getUser("mitglied"),status=i.options.getString("status");const res=db.prepare("UPDATE event_participants SET status=?,updated_at=? WHERE event_id=? AND user_id=? AND event_id IN (SELECT id FROM events WHERE guild_id=?)").run(status,isoNow(),id,target.id,g);if(!res.changes)return respond(i,"Teilnehmer wurde für dieses Event nicht gefunden.");audit(db,g,u,"event.attendance",target.id,{eventId:id,status});return respond(i,`Teilnahme von <@${target.id}> als ${status==="present"?"anwesend":"abwesend"} erfasst.`);}
    if(sub==="beenden"||sub==="absagen") {const denied=requireRole(i,guards.events,"Event-Team");if(denied)return respond(i,denied);const status=sub==="beenden"?"ended":"cancelled",id=i.options.getString("id");const row=db.prepare("UPDATE events SET status=? WHERE id=? AND guild_id=? AND status='scheduled' RETURNING name,channel_id,message_id").get(status,id,g);if(!row)return respond(i,"Geplantes Event nicht gefunden.");audit(db,g,u,`event.${status}`,id,{name:row.name});const channel=await targetChannel(i.guild,row.channel_id),message=channel&&row.message_id?await channel.messages.fetch(row.message_id).catch(()=>null):null;if(message)await message.edit({content:sub==="absagen"?`❌ Event **${row.name}** wurde abgesagt.`:`✅ Event **${row.name}** ist beendet.`,components:[]}).catch(()=>{});await answer(i,{content:`Event **${row.name}** ${sub==="beenden"?"beendet":"abgesagt"}.`,ephemeral:true});return;}
  }

  async function applicationCommand(i,sub,{db,config,guards,g,u}) {
    if(sub==="bewerben"){const kind=i.options.getString("typ");await i.showModal(applicationModal(kind));return;}
    if(sub==="liste"){const denied=requireRole(i,guards.reviewers,"Reviewer-Rolle");if(denied)return respond(i,denied);const rows=db.prepare("SELECT id,user_id,kind,status,created_at FROM applications WHERE guild_id=? AND status IN ('open','review') ORDER BY created_at LIMIT 20").all(g);return respond(i,rows.length?rows.map(r=>`\`${r.id}\` · <@${r.user_id}> · ${r.kind} · ${r.status} · <t:${Math.floor(new Date(r.created_at).getTime()/1000)}:R>`).join("\n"):"Keine offenen Anträge.");}
    if(sub==="entscheiden"){const denied=requireRole(i,guards.reviewers,"Reviewer-Rolle");if(denied)return respond(i,denied);const id=i.options.getString("id"),status=i.options.getString("entscheidung"),note=i.options.getString("kommentar")?.trim()??"";if(status==="rejected"&&!note)return respond(i,"Bitte gib bei einer Ablehnung einen Grund an.");const row=db.prepare("UPDATE applications SET status=?,reviewer_id=?,review_note=?,updated_at=? WHERE id=? AND guild_id=? AND status IN ('open','review') RETURNING user_id,message_id,kind,answers").get(status,u,note,isoNow(),id,g);if(!row)return respond(i,"Offener Antrag nicht gefunden.");audit(db,g,u,`application.${status}`,id,{note,kind:row.kind});const channel=await applicationReviewChannel(i.guild,config,row.kind);if(channel&&row.message_id){const msg=await channel.messages.fetch(row.message_id).catch(()=>null);if(msg)await msg.edit({...buildApplicationReviewPayload(row.kind,row.user_id,JSON.parse(row.answers),status,note),components:[]}).catch(()=>{});}const applicant=await client.users.fetch(row.user_id).catch(()=>null);await applicant?.send(applicationDecisionDm({kind:row.kind,status,applicationId:id,reason:note})).catch(()=>{});return respond(i,`Entscheidung zum Antrag gespeichert: ${status}.`);}
    if(sub==="status"){const id=i.options.getString("id"),row=db.prepare("UPDATE applications SET status='withdrawn',updated_at=? WHERE id=? AND guild_id=? AND user_id=? AND status IN ('open','review') RETURNING id").get(isoNow(),id,g,u);return respond(i,row?"Antrag zurückgezogen.":"Offener eigener Antrag nicht gefunden.");}
  }

  async function giveawayCommand(i,sub,{db,guards,g,u}) {
    if(sub==="erstellen"){const denied=requireRole(i,guards.staff,"Staff-Rolle");if(denied)return respond(i,denied);const id=randomUUID(),ends=new Date(Date.now()+i.options.getInteger("minuten")*60_000).toISOString(),prize=i.options.getString("preis"),winnerCount=i.options.getInteger("gewinner"),conditions=i.options.getString("bedingungen")??"Keine weiteren Bedingungen";const row={id,guild_id:g,prize,ends_at:ends,winner_count:winnerCount,conditions,created_by:u};const sent=await i.channel.send({embeds:[embed(`🎉 Giveaway: ${prize}`,`${conditions}\n\nEndet <t:${Math.floor(new Date(ends).getTime()/1000)}:R> · **${winnerCount}** Gewinner · ID \`${id.slice(0,8)}\``)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`giveaway:join:${id}`).setLabel("Teilnehmen").setStyle(ButtonStyle.Success))]});db.prepare("INSERT INTO giveaways(id,guild_id,channel_id,message_id,prize,ends_at,winner_count,conditions,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,'active',?,?)").run(id,g,i.channelId,sent.id,prize,ends,winnerCount,conditions,u,isoNow());return respond(i,`Giveaway gestartet · ID \`${id}\``);}
    if(sub==="abbrechen"){const denied=requireRole(i,guards.staff,"Staff-Rolle");if(denied)return respond(i,denied);const row=db.prepare("UPDATE giveaways SET status='cancelled',ended_at=? WHERE id=? AND guild_id=? AND status='active' RETURNING channel_id,message_id").get(isoNow(),i.options.getString("id"),g);if(!row)return respond(i,"Aktives Giveaway nicht gefunden.");await answer(i,{content:"Giveaway abgebrochen.",ephemeral:true});if(row.channel_id&&row.message_id){const ch=await i.guild.channels.fetch(row.channel_id).catch(()=>null);const msg=ch?await ch.messages.fetch(row.message_id).catch(()=>null):null;if(msg)await msg.edit({components:[]}).catch(()=>{});}return;}
  }

  async function button(i) {
    try {
      if(!i.inGuild()||(config.DISCORD_GUILD_ID&&i.guildId!==config.DISCORD_GUILD_ID))return answer(i,{content:"Der Bot ist für diesen Server nicht freigeschaltet.",ephemeral:true});
      const [kind,action,id,extra,expectedDeduction]=i.customId.split(":");const g=i.guildId,u=i.user.id;
      if(kind==="setup")return answer(i,{content:"Dieser Channel-Einrichtungsbefehl wurde entfernt.",ephemeral:true});
      if(kind==="cancel")return updateMessage(i,{content:"Aktion abgebrochen.",embeds:[],components:[]});
      if(kind==="payout") {if(action!==i.message.interaction?.id&&action!==i.message.interactionMetadata?.id)return answer(i,{content:"Diese Auszahlungsvorschau ist abgelaufen.",ephemeral:true});const denied=requireRole(i,guards.finance,"Finanzrolle");if(denied)return answer(i,{content:denied,ephemeral:true});const currentGross=finance.balance(g,id),currentOpen=db.prepare("SELECT COALESCE(SUM(remaining_cents),0) amount FROM sanctions WHERE guild_id=? AND user_id=? AND status IN ('open','partial')").get(g,id).amount,currentDeduction=Math.min(currentGross,currentOpen);if(currentGross!==Number(extra)||currentDeduction!==Number(expectedDeduction))return updateMessage(i,{content:"Kontostand oder Sanktionen haben sich seit der Vorschau geändert. Bitte starte `/konto auszahlen` erneut und prüfe die neue Vorschau.",embeds:[],components:[]});const tx=finance.payout({guildId:g,userId:id,actorId:u,key:`payout:${action}`,minimumCents:config.PAYOUT_MINIMUM_CENTS});return updateMessage(i,{content:`Auszahlung verbucht. Brutto ${formatMoney(tx.gross_cents)}, Sanktionen ${formatMoney(tx.deduction_cents)}, tatsächlich ausgezahlt ${formatMoney(tx.net_cents)}. Buchungs-ID: \`${tx.id}\``,embeds:[],components:[]});}
      if(kind==="ticket"&&action==="closeconfirm")return answer(i,{content:"Ticket schließen? Der Channel bleibt für Staff einsehbar.",components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticket:close:${id}`).setLabel("Schließen bestätigen").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId("cancel:ticket").setLabel("Abbrechen").setStyle(ButtonStyle.Secondary))],ephemeral:true});
      if(kind==="ticket"&&action==="close"){const t=db.prepare("SELECT * FROM tickets WHERE id=? AND guild_id=? AND status='open'").get(id,g);if(!t)return answer(i,{content:"Ticket bereits geschlossen oder nicht gefunden.",ephemeral:true});if(t.user_id!==u&&!hasRoleOrOwner(i,guards.staff))return answer(i,{content:"Nur Ersteller oder Staff können dieses Ticket schließen.",ephemeral:true});const fetched=await i.channel.messages.fetch({limit:100}).catch(()=>null);const transcript=(fetched?[...fetched.values()].reverse():[]).map(m=>({id:m.id,author:m.author?.tag??"gelöscht",userId:m.author?.id??null,createdAt:m.createdAt?.toISOString(),content:m.content}));db.transaction(()=>{db.prepare("INSERT OR REPLACE INTO ticket_transcripts(ticket_id,messages,created_at) VALUES(?,?,?)").run(id,JSON.stringify(transcript),isoNow());db.prepare("UPDATE tickets SET status='closed',closed_at=?,updated_at=? WHERE id=? AND status='open'").run(isoNow(),isoNow(),id);audit(db,g,u,"ticket.closed",t.user_id,{ticketId:id,channelId:i.channelId,transcriptMessages:transcript.length});})();await i.channel.permissionOverwrites.edit(t.user_id,{SendMessages:false}).catch(()=>{});await i.channel.setName(`closed-${t.category}-${t.user_id.slice(-4)}`.slice(0,90)).catch(()=>{});await answer(i,{content:"Ticket geschlossen. Der Channel bleibt für Staff als Transkript erhalten.",ephemeral:true});await i.channel.send({embeds:[embed("🔒 Ticket geschlossen","Dieses Ticket wurde geschlossen. Staff kann es über `/ticket wiedereroeffnen` erneut öffnen.")]});return;}
      if(kind==="ticket"&&action==="claim"){const denied=requireRole(i,guards.staff,"Staff-Rolle");if(denied)return answer(i,{content:denied,ephemeral:true});const row=db.prepare("UPDATE tickets SET claimed_by=?,updated_at=? WHERE id=? AND guild_id=? AND status='open' AND claimed_by IS NULL RETURNING user_id").get(u,isoNow(),id,g);if(!row)return answer(i,{content:"Ticket wurde bereits übernommen oder geschlossen.",ephemeral:true});audit(db,g,u,"ticket.claimed",row.user_id,{ticketId:id});return answer(i,{content:`Ticket wird von <@${u}> bearbeitet.`,allowedMentions:{users:[u]}});}
      if(kind==="giveaway"&&action==="join"){const res=db.prepare("INSERT OR IGNORE INTO giveaway_entries(giveaway_id,user_id,created_at) SELECT id,?,? FROM giveaways WHERE id=? AND guild_id=? AND status='active' AND ends_at>?").run(u,isoNow(),id,g,isoNow());if(!res.changes)return answer(i,{content:"Giveaway ist beendet oder du bist bereits eingetragen.",ephemeral:true});return answer(i,{content:"Du nimmst am Giveaway teil.",ephemeral:true});}
      if(kind==="event"&&(action==="join"||action==="leave")){const ev=db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled'").get(id,g);if(!ev)return answer(i,{content:"Dieses Event ist nicht mehr offen.",ephemeral:true});if(action==="leave"){db.prepare("UPDATE event_participants SET status='left',updated_at=? WHERE event_id=? AND user_id=? AND status IN ('signed_up','present')").run(isoNow(),id,u);await refreshEvent(i.message,db,ev);return answer(i,{content:"Du bist abgemeldet.",ephemeral:true});}const count=db.prepare("SELECT COUNT(*) n FROM event_participants WHERE event_id=? AND status IN ('signed_up','present')").get(id).n;if(ev.max_participants&&count>=ev.max_participants)return answer(i,{content:"Das Event ist bereits voll.",ephemeral:true});const result=db.prepare("INSERT OR IGNORE INTO event_participants(event_id,user_id,status,updated_at) VALUES(?,?,'signed_up',?) ON CONFLICT(event_id,user_id) DO UPDATE SET status='signed_up',updated_at=excluded.updated_at WHERE event_participants.status='left'").run(id,u,isoNow());await refreshEvent(i.message,db,ev);return answer(i,{content:result.changes?"Du bist angemeldet.":"Du bist bereits angemeldet.",ephemeral:true});}
    } catch(e){console.error("Button action failed:",e);if(i.deferred||i.replied)return followUp(i,{content:err(e),ephemeral:true}).catch(()=>{});return answer(i,{content:err(e),ephemeral:true}).catch(()=>{});}
  }
  async function select(i){
    try{
      if(!i.inGuild()||(config.DISCORD_GUILD_ID&&i.guildId!==config.DISCORD_GUILD_ID))return answer(i,{content:"Der Bot ist für diesen Server nicht freigeschaltet.",ephemeral:true});
      if(i.customId!=="ticket:create")return;
      const category=i.values[0],categoryDef=config.TICKET_CATEGORIES_JSON.find(c=>c.id===category);
      if(!categoryDef)return answer(i,{content:"Diese Ticket-Kategorie ist nicht mehr konfiguriert.",ephemeral:true});
      const open=db.prepare("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND user_id=? AND status='open'").get(i.guildId,i.user.id).n;
      if(open>=config.TICKET_MAX_OPEN_PER_USER)return answer(i,{content:"Du hast bereits die maximale Zahl offener Tickets.",ephemeral:true});
      const last=db.prepare("SELECT created_at FROM tickets WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1").get(i.guildId,i.user.id);
      if(last&&Date.now()-new Date(last.created_at).getTime()<config.TICKET_COOLDOWN_SECONDS*1000)return answer(i,{content:"Bitte warte kurz, bevor du ein weiteres Ticket öffnest.",ephemeral:true});
      const staffRoles=[...new Set([...guards.staff,...categoryDef.roleIds])];
      const channel=await i.guild.channels.create({name:`ticket-${category}-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g,"-").slice(0,90),type:ChannelType.GuildText,parent:config.CHANNEL_TICKET_CATEGORY||undefined,permissionOverwrites:[{id:i.guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},{id:i.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]},{id:client.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]},...staffRoles.map(id=>({id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]}))]});
      const id=randomUUID();db.prepare("INSERT INTO tickets(id,guild_id,channel_id,user_id,category,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)").run(id,i.guildId,channel.id,i.user.id,category,isoNow(),isoNow());
      await channel.send({content:`<@${i.user.id}> ${staffRoles.map(r=>`<@&${r}>`).join(" ")}`,embeds:[embed(`Ticket: ${categoryDef.label}`,"Beschreibe dein Anliegen. Staff kann das Ticket mit `/ticket schliessen` schließen.")],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticket:claim:${id}`).setLabel("Übernehmen").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId(`ticket:closeconfirm:${id}`).setLabel("Schließen").setStyle(ButtonStyle.Danger))]});
      audit(db,i.guildId,i.user.id,"ticket.created",id,{category,channelId:channel.id});
      if(config.CHANNEL_TICKET_LOG){const log=await targetChannel(i.guild,config.CHANNEL_TICKET_LOG);if(log)await log.send({embeds:[logEmbed("🎫 Neues Support-Ticket",`**Kategorie:** ${categoryDef.label}\n**Mitglied:** <@${i.user.id}>\n**Ticket:** <#${channel.id}>`)]}).catch(()=>{});}
      return answer(i,{content:`Dein Ticket wurde erstellt: ${channel}`,ephemeral:true});
    }catch(e){console.error("Ticket create failed:",e);return answer(i,{content:"Ticket konnte nicht angelegt werden. Prüfe die Bot-Berechtigungen und Ticket-Konfiguration.",ephemeral:true}).catch(()=>{});}
  }
  async function modal(i){
    if(!i.inGuild()||(config.DISCORD_GUILD_ID&&i.guildId!==config.DISCORD_GUILD_ID))return answer(i,{content:"Der Bot ist für diesen Server nicht freigeschaltet.",ephemeral:true});
    if(i.customId.startsWith("application:reject-reason:")){
      const denied=requireRole(i,guards.reviewers,"Reviewer-Rolle");if(denied)return answer(i,{content:denied,ephemeral:true});
      const id=i.customId.split(":")[2],reason=i.fields.getTextInputValue("reason").trim();
      if(reason.length<3)return answer(i,{content:"Bitte beschreibe den Ablehnungsgrund etwas genauer.",ephemeral:true});
      const row=db.prepare("UPDATE applications SET status='rejected',reviewer_id=?,review_note=?,updated_at=? WHERE id=? AND guild_id=? AND status IN ('open','review') RETURNING user_id,message_id,kind,answers").get(i.user.id,reason,isoNow(),id,i.guildId);
      if(!row)return answer(i,{content:"Dieser Antrag wurde bereits entschieden oder nicht gefunden.",ephemeral:true});
      audit(db,i.guildId,i.user.id,"application.rejected",id,{reason,kind:row.kind});
      const channel=await applicationReviewChannel(i.guild,config,row.kind);
      if(channel&&row.message_id){const message=await channel.messages.fetch(row.message_id).catch(()=>null);if(message)await message.edit({...buildApplicationReviewPayload(row.kind,row.user_id,JSON.parse(row.answers),"rejected",reason),components:[]}).catch(()=>{});}
      const applicant=await client.users.fetch(row.user_id).catch(()=>null);
      await applicant?.send(applicationDecisionDm({kind:row.kind,status:"rejected",applicationId:id,reason})).catch(()=>{});
      return answer(i,{content:"Antrag abgelehnt. Der Grund wurde gespeichert und dem Antragsteller gesendet.",ephemeral:true});
    }
    if(!i.customId.startsWith("application:submit:"))return;
    const kind=i.customId.split(":")[2];if(!["bewerbung","rang"].includes(kind))return answer(i,{content:"Dieser Antragstyp ist ungültig.",ephemeral:true});
    const answers=Object.fromEntries(applicationQuestions(kind).map(question=>[question.id,i.fields.getTextInputValue(question.id)]));
    const open=db.prepare("SELECT id FROM applications WHERE guild_id=? AND user_id=? AND kind=? AND status IN ('open','review')").get(i.guildId,i.user.id,kind);if(open)return answer(i,{content:`Du hast bereits einen offenen Antrag: \`${open.id}\``,ephemeral:true});
    const id=randomUUID(),ts=isoNow();db.prepare("INSERT INTO applications(id,guild_id,user_id,kind,answers,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)").run(id,i.guildId,i.user.id,kind,JSON.stringify(answers),ts,ts);audit(db,i.guildId,i.user.id,"application.submitted",id,{kind});
    const channel=await applicationReviewChannel(i.guild,config,kind);
    if(channel){const reviewButtons=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`application:review:${id}`).setLabel("Übernehmen").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId(`application:accept:${id}`).setLabel("Annehmen").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`application:reject:${id}`).setLabel("Ablehnen").setStyle(ButtonStyle.Danger));const msg=await channel.send({...buildApplicationReviewPayload(kind,i.user.id,answers),components:[reviewButtons]});db.prepare("UPDATE applications SET message_id=? WHERE id=?").run(msg.id,id);}else{return answer(i,{content:`Dein Antrag wurde gespeichert, aber der Staff-Channel für ${kind==="rang"?"Rang-Anträge":"Bewerbungen"} wurde nicht gefunden. Bitte melde es der Leitung. Referenz: \`${id}\``,ephemeral:true});}
    return answer(i,{content:`Dein Antrag wurde gespeichert. Referenz: \`${id}\``,ephemeral:true});
  }

  async function reviewButton(i){
    if(!i.inGuild()||(config.DISCORD_GUILD_ID&&i.guildId!==config.DISCORD_GUILD_ID))return answer(i,{content:"Der Bot ist für diesen Server nicht freigeschaltet.",ephemeral:true});
    const [,action,id]=i.customId.split(":");
    if(action==="open"){if(!["bewerbung","rang"].includes(id))return answer(i,{content:"Dieser Antragstyp ist ungültig.",ephemeral:true});return i.showModal(applicationModal(id));}
    const denied=requireRole(i,guards.reviewers,"Reviewer-Rolle");if(denied)return answer(i,{content:denied,ephemeral:true});
    const row=db.prepare("SELECT * FROM applications WHERE id=? AND guild_id=? AND status IN ('open','review')").get(id,i.guildId);if(!row)return answer(i,{content:"Dieser Antrag wurde bereits abgeschlossen.",ephemeral:true});
    if(action==="review"){
      if(row.status==="review"){
        const channel=await applicationReviewChannel(i.guild,config,row.kind);
        if(channel&&row.message_id){const message=await channel.messages.fetch(row.message_id).catch(()=>null);if(message)await message.edit({...buildApplicationReviewPayload(row.kind,row.user_id,JSON.parse(row.answers),"review","",row.reviewer_id),components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`application:accept:${id}`).setLabel("Annehmen").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`application:reject:${id}`).setLabel("Ablehnen").setStyle(ButtonStyle.Danger))]}).catch(()=>{});}
        return answer(i,{content:`Dieser Antrag wird bereits von <@${row.reviewer_id}> bearbeitet.`,ephemeral:true});
      }
      const claimed=db.prepare("UPDATE applications SET status='review',reviewer_id=?,updated_at=? WHERE id=? AND guild_id=? AND status='open' RETURNING user_id,kind,answers,message_id").get(i.user.id,isoNow(),id,i.guildId);
      if(!claimed)return answer(i,{content:"Der Antrag wurde gerade bereits übernommen oder entschieden. Bitte aktualisiere die Ansicht.",ephemeral:true});
      audit(db,i.guildId,i.user.id,"application.claimed",id,{kind:claimed.kind});
      await updateMessage(i,{...buildApplicationReviewPayload(claimed.kind,claimed.user_id,JSON.parse(claimed.answers),"review","",i.user.id),components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`application:accept:${id}`).setLabel("Annehmen").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`application:reject:${id}`).setLabel("Ablehnen").setStyle(ButtonStyle.Danger))]});
      return;
    }
    if(action==="reject"){
      const modal=new ModalBuilder().setCustomId(`application:reject-reason:${id}`).setTitle("Antrag mit Grund ablehnen");
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Ablehnungsgrund für den Antragsteller").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(1000)));
      return i.showModal(modal);
    }
    if(action!=="accept")return answer(i,{content:"Unbekannte Antragsaktion.",ephemeral:true});
    const accepted=db.prepare("UPDATE applications SET status='accepted',reviewer_id=?,review_note='',updated_at=? WHERE id=? AND guild_id=? AND status IN ('open','review') RETURNING user_id,kind,answers").get(i.user.id,isoNow(),id,i.guildId);if(!accepted)return answer(i,{content:"Dieser Antrag wurde gerade bereits entschieden.",ephemeral:true});
    audit(db,i.guildId,i.user.id,"application.accepted",id,{kind:accepted.kind});
    await updateMessage(i,{...buildApplicationReviewPayload(accepted.kind,accepted.user_id,JSON.parse(accepted.answers),"accepted"),components:[]});
    const applicant=await client.users.fetch(accepted.user_id).catch(()=>null);await applicant?.send(applicationDecisionDm({kind:accepted.kind,status:"accepted",applicationId:id})).catch(()=>{});
    return;
  }

  async function eventButton(i){const [,action]=i.customId.split(":");if(action==="join"||action==="leave")return button(i);return answer(i,{content:"Unbekannte Event-Aktion.",ephemeral:true});}

  return {command,button,select,modal,reviewButton,eventButton};
}

function parseOffsetDate(value){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value??""))return null;const date=new Date(value);return Number.isFinite(date.getTime())?date:null;}
function eventButtons(id){return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`event:join:${id}`).setLabel("Teilnehmen").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`event:leave:${id}`).setLabel("Abmelden").setStyle(ButtonStyle.Secondary));}
function eventEmbed(e,count,participants=[]){const list=participants.length?participants.slice(0,30).map(x=>`<@${x.user_id}>`).join(", ")+(participants.length>30?`, +${participants.length-30} weitere`:""):"Noch keine Anmeldungen";return embed(`📅 ${e.name}`,`${e.description}\n\n**Wann:** <t:${Math.floor(new Date(e.starts_at).getTime()/1000)}:F>\n**Treffpunkt:** ${e.location}\n**Veranstalter:** <@${e.host_id}>\n**Ausrüstung:** ${e.equipment||"Keine Angabe"}\n**Hinweise:** ${e.notes||"Keine"}\n**Teilnehmer (${count}${e.max_participants?`/${e.max_participants}`:""}):** ${list}`);}
async function refreshEvent(message,db,event){const participants=db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status IN ('signed_up','present') ORDER BY updated_at").all(event.id);await message.edit({embeds:[eventEmbed(event,participants.length,participants)]}).catch(()=>{});}
async function targetChannel(guild,id){return id?guild.channels.fetch(id).catch(()=>null):null;}
export function applicationReviewChannelKey(kind){return kind==="rang"?"CHANNEL_RANK_REVIEW":"CHANNEL_APPLICATION_REVIEW";}
async function applicationReviewChannel(guild,config,kind){
  const channelName=kind==="rang"?"rang-anträge":"bewerbungen";
  const configured=await targetChannel(guild,config[applicationReviewChannelKey(kind)]);
  if(configured)return configured;
  const channels=await guild.channels.fetch();
  return channels.find(channel=>channel?.isTextBased()&&channel.name.includes(channelName)&&channel.parent?.name.toLowerCase().includes("staff"))??null;
}
function stats(db,guildId,dashboard=false){const count=(q,...a)=>db.prepare(q).get(...a)?.n??0;const financeRoles="Finanzkennzahlen sind nur der Finanzrolle zugänglich.";const base=[`Mitglieder: **${count("SELECT COUNT(*) n FROM accounts WHERE guild_id=?",guildId)}** Familienkonten`,`Offene Tickets: **${count("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open'",guildId)}**`,`Offene Anträge: **${count("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND status IN ('open','review')",guildId)}**`,`Anstehende Events: **${count("SELECT COUNT(*) n FROM events WHERE guild_id=? AND status='scheduled' AND starts_at>?",guildId,isoNow())}**`,`Aktive Giveaways: **${count("SELECT COUNT(*) n FROM giveaways WHERE guild_id=? AND status='active'",guildId)}**`];if(dashboard)base.push(`Offene Sanktionen: **${count("SELECT COUNT(*) n FROM sanctions WHERE guild_id=? AND status IN ('open','partial')",guildId)}**`,financeRoles);return base.join("\n");}

export async function handleComponent(i,handlers){if(i.isButton()){if(i.customId.startsWith("application:"))return handlers.reviewButton(i);if(i.customId.startsWith("event:"))return handlers.eventButton(i);return handlers.button(i);}if(i.isStringSelectMenu())return handlers.select(i);if(i.isModalSubmit())return handlers.modal(i);}
