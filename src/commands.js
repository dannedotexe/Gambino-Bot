import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder,
  PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { audit, getSetting, setSetting } from "./database.js";
import { FinanceError, formatMoney, parseMoney } from "./services/finance.js";
import { accessGroups, configWarnings, hasRole } from "./config.js";
import { BRAND_COLOR, applicationDecisionDm, applicationInReviewDm, applicationSubmittedDm, logEmbed, presentInteractionPayload } from "./presentation.js";
import { createEventService } from "./services/events.js";
import { createGiveawayService } from "./services/giveaways.js";
import { canHandleTicket, createTicketService } from "./services/tickets.js";
import { APPLICATION_KINDS, assignRankRole, createApplicationService, questionsFor } from "./services/applications.js";
import { collectStats, PERIODS } from "./services/stats.js";
import { CHANNEL_BINDINGS } from "./channel-setup.js";
import { SETTINGS } from "./services/settings.js";
import { PANEL_SETTING_KEY, VIEWS, buildPanelPayload, buildView, statsEmbed } from "./staff-panel.js";
import { syncNativeAutomod } from "./moderation.js";
import { describeSchedule, nextOccurrence } from "./services/event-series.js";
import { buildActivityBoard, publishActivityBoard, refreshActivityBoard } from "./activity-board.js";
import { PANEL_CHANNEL_KEYS, ensurePanels, postEventResult } from "./panels.js";
import { checkChannels } from "./channel-check.js";
import { moveTicketToClosed, moveTicketToOpen } from "./ticket-channels.js";
import { buildVerification, createVerificationService } from "./services/verification.js";
import { deleteEventPosts, publishEvent, refreshEventPosts } from "./event-posts.js";
import { colorNumber, defaultsFor, panelTexts } from "./services/texts.js";
import { WarningError, createWarningService, warnBlockReason } from "./services/warnings.js";
import { deliverWarning, deliverySummary } from "./warn-actions.js";
import { AbsenceError, createAbsenceService, formatDay, localDay, parseDay } from "./services/absences.js";
import { createActivityService } from "./services/activity.js";
import { buildLeaderboard } from "./leaderboard.js";
import { postAbsence } from "./absence-posts.js";
import { BAN_DELETE_CHOICES, MOD_PERMISSIONS, TIMEOUT_CHOICES, formatMinutes, hierarchyProblem, performModeration } from "./member-moderation.js";
import { MOD_ACTIONS } from "./services/moderation-log.js";
import { PollError, createPollService, publishPoll, refreshPollMessage, announcePollResult, pollPayload, validatePoll } from "./polls.js";

const isoNow=()=>new Date().toISOString();
const unix=iso=>Math.floor(new Date(iso).getTime()/1000);
const embed=(title,description)=>new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({name:"GAMBINOS  •  GRAND-RP"}).setTitle(title).setDescription(description).setFooter({text:"GAMBINOS  •  Grand-RP"}).setTimestamp();
const fieldsEmbed=(title,fields,description="")=>{const panel=embed(title,description||null);if(fields.length)panel.addFields(fields.slice(0,25));return {embeds:[panel]};};
export const ticketCard=(category,requesterId,claimedBy=null)=>embed(`🎫 ${category}`,`**Antragsteller:** <@${requesterId}>\n**Status:** ${claimedBy?`🔎 In Bearbeitung · <@${claimedBy}>`:"🟡 Offen – wartet auf Staff"}\n\nBeschreibe dein Anliegen hier im privaten Ticket. Staff kann das Ticket über die Schaltflächen verwalten.`);
export const ticketClosedCard=(category,requesterId)=>embed(`🔒 ${category} · geschlossen`,`**Antragsteller:** <@${requesterId}>\n**Status:** Geschlossen\n\nDieses Ticket ist abgeschlossen. Der Verlauf bleibt für das zuständige Team gespeichert.`);
export const ticketActions=(id,claimed=false)=>[new ActionRowBuilder().addComponents(...(claimed?[]:[new ButtonBuilder().setCustomId(`ticket:claim:${id}`).setLabel("Übernehmen").setStyle(ButtonStyle.Primary)]),new ButtonBuilder().setCustomId(`ticket:closeconfirm:${id}`).setLabel("Schließen").setStyle(ButtonStyle.Danger))];
export const ticketClosedActions=id=>[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticket:reopen:${id}`).setLabel("Wieder öffnen").setEmoji("🔓").setStyle(ButtonStyle.Secondary))];
const ticketCategoryLabel=(category,config)=>config.TICKET_CATEGORIES_JSON.find(item=>item.id===category)?.label??category;
const transactionLabels={credit:"Gutschrift",payout:"Auszahlung",sanction_refund:"Sanktions-Rückerstattung",correction:"Korrektur",correction_credit:"Korrektur (+)",correction_debit:"Korrektur (−)"};
const statusLabels={open:"Offen",partial:"Teilweise verrechnet",paid:"Beglichen",void:"Aufgehoben",review:"In Prüfung",accepted:"Angenommen",rejected:"Abgelehnt",scheduled:"Geplant",ended:"Beendet",cancelled:"Abgesagt",withdrawn:"Zurückgezogen"};
const warningStateLabel={active:"Aktiv",expired:"Abgelaufen",revoked:"Zurückgenommen"};
const warningStateIcon={active:"🟠",expired:"⚪",revoked:"↩️"};
const err=(e)=>e instanceof Error?e.message:"Die Aktion ist fehlgeschlagen.";
const ticketPresentation={
  support:{emoji:"🛠️",description:"Allgemeine Fragen und Hilfe"},
  beschwerde:{emoji:"⚠️",description:"Ein Problem oder eine Beschwerde melden"},
  leitung:{emoji:"👑",description:"Ein wichtiges Anliegen an die Leitung"},
};

// Antragsfragen können per APPLICATION_QUESTIONS_JSON überschrieben werden; createHandler setzt die aktive Konfiguration.
let questionConfig={};
export function applicationQuestions(kind,config=questionConfig) {
  return questionsFor(kind,config).map(question=>({...question,style:question.style==="paragraph"?TextInputStyle.Paragraph:TextInputStyle.Short}));
}

function applicationModal(kind) {
  const isRank=kind==="rang";
  const modal=new ModalBuilder().setCustomId(`application:submit:${kind}`).setTitle(isRank?"Rang-Antrag":"Gambinos Bewerbung");
  for(const question of applicationQuestions(kind)){
    const input=new TextInputBuilder().setCustomId(question.id).setLabel(question.label).setStyle(question.style).setRequired(question.required!==false).setMaxLength(question.maxLength);
    if(question.placeholder)input.setPlaceholder(question.placeholder);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

/** Embed aus bearbeitbaren Texten; leere Teile werden weggelassen (Discord lehnt leere Felder ab). */
function textEmbed(texts,fields=[]){
  const panel=new EmbedBuilder().setColor(colorNumber(texts.color??"#d4af37")).setTimestamp();
  if(texts.author)panel.setAuthor({name:texts.author});
  if(texts.title)panel.setTitle(texts.title);
  if(texts.description)panel.setDescription(texts.description);
  const usable=fields.filter(field=>field.name&&field.value);
  if(usable.length)panel.addFields(usable);
  if(texts.footer)panel.setFooter({text:texts.footer});
  return panel;
}

export function buildApplicationPanelPayload(texts=defaultsFor("application")) {
  const panel=textEmbed(texts,[
    {name:texts.field1Name,value:texts.field1Value,inline:true},
    {name:texts.field2Name,value:texts.field2Value,inline:true},
    {name:texts.field3Name,value:texts.field3Value,inline:false},
  ]);
  const buttons=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("application:open:bewerbung").setLabel(texts.buttonApply).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("application:open:rang").setLabel(texts.buttonRank).setStyle(ButtonStyle.Secondary),
  );
  return {embeds:[panel],components:[buttons]};
}

export function buildAccountPanelPayload(texts=defaultsFor("account")) {
  return {embeds:[textEmbed(texts)],components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("account:balance").setLabel(texts.buttonBalance).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("account:history").setLabel(texts.buttonHistory).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("account:sanctions").setLabel(texts.buttonSanctions).setStyle(ButtonStyle.Secondary),
  )]};
}

export function buildVerificationPanelPayload(texts=defaultsFor("verification")) {
  return {embeds:[textEmbed(texts)],components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("verify:open").setLabel(texts.button).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("verify:rename").setLabel(texts.buttonRename||"✏️  Name ändern").setStyle(ButtonStyle.Secondary),
  )]};
}

export function buildAbsencePanelPayload(texts=defaultsFor("absence")) {
  return {embeds:[textEmbed(texts)],components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("absence:open").setLabel(texts.buttonAbsent).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("absence:back").setLabel(texts.buttonBack).setStyle(ButtonStyle.Success),
  )]};
}

export function buildTicketPanelPayload(config,texts=defaultsFor("ticket")) {
  const options=config.TICKET_CATEGORIES_JSON.map(c=>{
    const presentation=ticketPresentation[c.id]??{emoji:"🎫",description:`Ein Ticket für ${c.label}`};
    return {label:c.label,value:c.id,description:c.description??presentation.description,emoji:{name:c.emoji??presentation.emoji}};
  });
  const panel=textEmbed(texts);
  const select=new StringSelectMenuBuilder().setCustomId("ticket:create").setPlaceholder(texts.placeholder).addOptions(options);
  return {embeds:[panel],components:[new ActionRowBuilder().addComponents(select)]};
}

export function buildApplicationReviewPayload(kind,userId,answers,decision=null,reason="",reviewerId=null) {
  const labels=new Map([...questionsFor(kind,{}),...applicationQuestions(kind)].map(question=>[question.id,question.label]));
  const panel=new EmbedBuilder().setColor(0xd4af37)
    .setAuthor({name:"GAMBINOS  •  BEWERBUNGEN"})
    .setTitle(`${kind==="rang"?"🏅 Rang-Antrag":"🤝 Bewerbung"}`)
    .setDescription(`**Antragsteller:** <@${userId}>\n**Eingereichte Angaben:**${decision?`\n\n**Status:** ${decision==="accepted"?"✅ Angenommen":decision==="rejected"?"❌ Abgelehnt":decision==="withdrawn"?"↩️ Zurückgezogen":`🔎 In Prüfung · <@${reviewerId}>`}`:""}`)
    .addFields(Object.entries(answers).map(([key,value])=>({name:labels.get(key)??key,value:String(value||"—").slice(0,1024),inline:false})))
    .setColor(decision==="accepted"?0x2ecc71:decision==="rejected"?0xe74c3c:decision==="withdrawn"?0x7f8c8d:0xd4af37)
    .setFooter({text:decision==="rejected"?`Ablehnungsgrund: ${reason}`.slice(0,2048):decision==="review"?"GAMBINOS  •  Bearbeitung übernommen":decision==="withdrawn"?"GAMBINOS  •  Vom Antragsteller zurückgezogen":"GAMBINOS  •  Interne Prüfung"})
    .setTimestamp();
  return {embeds:[panel]};
}

/** Reviewer-Schaltflächen je nach Status. */
export function applicationReviewComponents(id,status="open"){
  const buttons=[];
  if(status==="open")buttons.push(new ButtonBuilder().setCustomId(`application:review:${id}`).setLabel("Übernehmen").setStyle(ButtonStyle.Primary));
  buttons.push(
    new ButtonBuilder().setCustomId(`application:accept:${id}`).setLabel("Annehmen").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`application:reject:${id}`).setLabel("Ablehnen").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`application:note:${id}`).setLabel("Notiz").setEmoji("💬").setStyle(ButtonStyle.Secondary),
  );
  return [new ActionRowBuilder().addComponents(...buttons)];
}

export function giveawayButtons(id){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`giveaway:join:${id}`).setLabel("🎉 Teilnehmen").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`giveaway:leave:${id}`).setLabel("Abmelden").setStyle(ButtonStyle.Secondary),
  );
}

export function giveawayCard(row,entries=0){
  const card=embed(`🎉 ${row.prize}`,"Nimm über die Schaltfläche teil. Die Gewinner werden nach Ablauf automatisch gezogen.");
  card.addFields(
    {name:"⏳ Ende",value:`<t:${unix(row.ends_at)}:F> · <t:${unix(row.ends_at)}:R>`,inline:true},
    {name:"🏆 Gewinner",value:String(row.winner_count),inline:true},
    {name:"🙋 Teilnahmen",value:String(entries),inline:true},
    {name:"📌 Bedingungen",value:`${row.conditions}${row.required_role_id?`\nErforderliche Rolle: <@&${row.required_role_id}>`:""}`.slice(0,1024),inline:false},
  );
  return card.setFooter({text:`GAMBINOS  •  Giveaway ${row.id.slice(0,8)}`});
}

export function buildCommands() {
  const money = new SlashCommandBuilder().setName("konto").setDescription("Gambinos-Familienkonto")
    .addSubcommand(s=>s.setName("stand").setDescription("Eigenen Kontostand sehen"))
    .addSubcommand(s=>s.setName("anlegen").setDescription("Familienkonto für ein Mitglied anlegen (Finanzrolle)").addUserOption(o=>o.setName("mitglied").setDescription("Mitglied").setRequired(true)).addStringOption(o=>o.setName("notiz").setDescription("Optionale Notiz, z. B. neues Familienmitglied").setMaxLength(300)))
    .addSubcommand(s=>s.setName("ansehen").setDescription("Kontostand eines Mitglieds (Finanzrolle)").addUserOption(o=>o.setName("mitglied").setDescription("Mitglied").setRequired(true)))
    .addSubcommand(s=>s.setName("gutschrift").setDescription("Geld gutschreiben (Finanzrolle)").addUserOption(o=>o.setName("mitglied").setDescription("Empfänger").setRequired(true)).addStringOption(o=>o.setName("betrag").setDescription("Betrag in Dollar").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Buchungsgrund").setRequired(true).setMaxLength(300)))
    .addSubcommand(s=>s.setName("auszahlen").setDescription("Guthaben auszahlen und Sanktionen verrechnen").addUserOption(o=>o.setName("mitglied").setDescription("Empfänger").setRequired(true)))
    .addSubcommand(s=>s.setName("korrektur").setDescription("Korrekturbuchung (Leitung)").addUserOption(o=>o.setName("mitglied").setDescription("Mitglied").setRequired(true)).addStringOption(o=>o.setName("richtung").setDescription("Richtung").setRequired(true).addChoices({name:"Guthaben erhöhen",value:"credit"},{name:"Guthaben verringern",value:"debit"})).addStringOption(o=>o.setName("betrag").setDescription("Betrag in Dollar").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Korrekturgrund").setRequired(true).setMaxLength(300)))
    .addSubcommand(s=>s.setName("liste").setDescription("Auszahlungsliste (Finanzrolle)").addIntegerOption(o=>o.setName("seite").setDescription("Seite der Liste").setMinValue(1)))
    .addSubcommand(s=>s.setName("historie").setDescription("Transaktionshistorie").addUserOption(o=>o.setName("mitglied").setDescription("Mitglied (Finanzrolle)")).addIntegerOption(o=>o.setName("seite").setDescription("Seite").setMinValue(1)));
  const sanction = new SlashCommandBuilder().setName("sanktion").setDescription("Sanktionsverwaltung")
    .addSubcommand(s=>s.setName("erstellen").setDescription("Auszahlungsabzug vormerken").addUserOption(o=>o.setName("mitglied").setDescription("Betroffenes Mitglied").setRequired(true)).addStringOption(o=>o.setName("betrag").setDescription("Betrag in Dollar").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Grund").setRequired(true).setMaxLength(300)).addStringOption(o=>o.setName("fall").setDescription("Optionale Fall- oder Event-ID").setMaxLength(100)))
    .addSubcommand(s=>s.setName("verwarnung").setDescription("Verwarnung ohne Geldabzug eintragen").addUserOption(o=>o.setName("mitglied").setDescription("Betroffenes Mitglied").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Grund").setRequired(true).setMaxLength(300)).addStringOption(o=>o.setName("fall").setDescription("Optionale Fall- oder Event-ID").setMaxLength(100)))
    .addSubcommand(s=>s.setName("offen").setDescription("Offene Sanktionen anzeigen").addUserOption(o=>o.setName("mitglied").setDescription("Mitglied (optional)")))
    .addSubcommand(s=>s.setName("historie").setDescription("Alle Sanktionen und Verwarnungen eines Mitglieds").addUserOption(o=>o.setName("mitglied").setDescription("Mitglied (optional)")))
    .addSubcommand(s=>s.setName("korrigieren").setDescription("Sanktionsbetrag korrigieren (Leitung)").addStringOption(o=>o.setName("id").setDescription("Sanktion auswählen").setRequired(true).setAutocomplete(true)).addStringOption(o=>o.setName("betrag").setDescription("Neuer Gesamtbetrag in Dollar").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Korrekturgrund").setRequired(true).setMaxLength(300)))
    .addSubcommand(s=>s.setName("aufheben").setDescription("Offene Sanktion aufheben").addStringOption(o=>o.setName("id").setDescription("Sanktion auswählen").setRequired(true).setAutocomplete(true)).addStringOption(o=>o.setName("grund").setDescription("Aufhebungsgrund").setRequired(true).setMaxLength(300)))
    .addSubcommand(s=>s.setName("rueckerstatten").setDescription("Bereits abgezogene Sanktion erstatten und aufheben").addStringOption(o=>o.setName("id").setDescription("Sanktion auswählen").setRequired(true).setAutocomplete(true)).addStringOption(o=>o.setName("grund").setDescription("Erstattungsgrund").setRequired(true).setMaxLength(300)));
  const ticket = new SlashCommandBuilder().setName("ticket").setDescription("Ticketsystem")
    .addSubcommand(s=>s.setName("panel").setDescription("Ticket-Panel senden (Staff)"))
    .addSubcommand(s=>s.setName("uebernehmen").setDescription("Dieses Ticket übernehmen (Staff)"))
    .addSubcommand(s=>s.setName("wiedereroeffnen").setDescription("Geschlossenes Ticket wieder öffnen (Staff)"))
    .addSubcommand(s=>s.setName("schliessen").setDescription("Dieses Ticket schließen"));
  const event = new SlashCommandBuilder().setName("event").setDescription("Familien-Events")
    .addSubcommand(s=>s.setName("erstellen").setDescription("Event anlegen").addStringOption(o=>o.setName("name").setDescription("Name").setRequired(true).setMaxLength(100)).addStringOption(o=>o.setName("start").setDescription("Datum und Uhrzeit, z. B. 31.12.2026 19:00 (Server-Zeitzone)").setRequired(true)).addStringOption(o=>o.setName("treffpunkt").setDescription("Treffpunkt").setRequired(true).setMaxLength(100)).addStringOption(o=>o.setName("beschreibung").setDescription("Beschreibung").setRequired(true).setMaxLength(1000)).addIntegerOption(o=>o.setName("maximum").setDescription("Teilnehmerlimit").setMinValue(1).setMaxValue(500)).addStringOption(o=>o.setName("ausruestung").setDescription("Benötigte Ausrüstung").setMaxLength(500)).addStringOption(o=>o.setName("hinweise").setDescription("Teilnahmehinweise").setMaxLength(500)))
    .addSubcommand(s=>s.setName("liste").setDescription("Anstehende Events"))
    .addSubcommand(s=>s.setName("historie").setDescription("Vergangene Events"))
    .addSubcommand(s=>s.setName("teilnehmer").setDescription("Teilnehmerliste eines Events").addStringOption(o=>o.setName("id").setDescription("Event auswählen").setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName("bearbeiten").setDescription("Geplantes Event ändern").addStringOption(o=>o.setName("id").setDescription("Event auswählen").setRequired(true).setAutocomplete(true)).addStringOption(o=>o.setName("name").setDescription("Neuer Name").setMaxLength(100)).addStringOption(o=>o.setName("start").setDescription("Datum und Uhrzeit, z. B. 31.12.2026 19:00 (Server-Zeitzone)")).addStringOption(o=>o.setName("treffpunkt").setDescription("Neuer Treffpunkt").setMaxLength(100)).addStringOption(o=>o.setName("beschreibung").setDescription("Neue Beschreibung").setMaxLength(1000)).addIntegerOption(o=>o.setName("maximum").setDescription("Neues Teilnehmerlimit").setMinValue(1).setMaxValue(500)).addStringOption(o=>o.setName("ausruestung").setDescription("Neue Ausrüstung").setMaxLength(500)).addStringOption(o=>o.setName("hinweise").setDescription("Neue Teilnahmehinweise").setMaxLength(500)))
    .addSubcommand(s=>s.setName("anwesenheit").setDescription("Teilnahme dokumentieren (Event-Team)").addStringOption(o=>o.setName("id").setDescription("Event auswählen").setRequired(true).setAutocomplete(true)).addUserOption(o=>o.setName("mitglied").setDescription("Teilnehmer").setRequired(true)).addStringOption(o=>o.setName("status").setDescription("Teilnahme").setRequired(true).addChoices({name:"Anwesend",value:"present"},{name:"Abwesend",value:"absent"})))
    .addSubcommand(s=>s.setName("beenden").setDescription("Event abschließen").addStringOption(o=>o.setName("id").setDescription("Event auswählen").setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName("absagen").setDescription("Event absagen").addStringOption(o=>o.setName("id").setDescription("Event auswählen").setRequired(true).setAutocomplete(true)).addStringOption(o=>o.setName("grund").setDescription("Grund für die Absage").setMaxLength(300)));
  const apps = new SlashCommandBuilder().setName("antrag").setDescription("Bewerbung und Rang-Anträge")
    .addSubcommand(s=>s.setName("bewerben").setDescription("Bewerbung einreichen").addStringOption(o=>o.setName("typ").setDescription("Bewerbungstyp").setRequired(true).addChoices({name:"Familienbeitritt",value:"bewerbung"},{name:"Rang-Antrag",value:"rang"})))
    .addSubcommand(s=>s.setName("liste").setDescription("Offene Anträge (Reviewer)"))
    .addSubcommand(s=>s.setName("kommentieren").setDescription("Interne Notiz zu einem Antrag (Reviewer)").addStringOption(o=>o.setName("id").setDescription("Antrag auswählen").setRequired(true).setAutocomplete(true)).addStringOption(o=>o.setName("notiz").setDescription("Interne Notiz").setRequired(true).setMaxLength(1000)))
    .addSubcommand(s=>s.setName("entscheiden").setDescription("Antrag mit optionalem Kommentar entscheiden (Reviewer)").addStringOption(o=>o.setName("id").setDescription("Antrag auswählen").setRequired(true).setAutocomplete(true)).addStringOption(o=>o.setName("entscheidung").setDescription("Ergebnis").setRequired(true).addChoices({name:"Annehmen",value:"accepted"},{name:"Ablehnen",value:"rejected"})).addStringOption(o=>o.setName("kommentar").setDescription("Begründung für Antragsteller").setMaxLength(1000)))
    .addSubcommand(s=>s.setName("status").setDescription("Eigenen Antrag zurückziehen").addStringOption(o=>o.setName("id").setDescription("Eigenen offenen Antrag auswählen").setRequired(true).setAutocomplete(true)));
  const giveaway = new SlashCommandBuilder().setName("giveaway").setDescription("Giveaways")
    .addSubcommand(s=>s.setName("erstellen").setDescription("Giveaway starten").addStringOption(o=>o.setName("preis").setDescription("Preis").setRequired(true).setMaxLength(200)).addIntegerOption(o=>o.setName("minuten").setDescription("Dauer in Minuten").setRequired(true).setMinValue(1).setMaxValue(43200)).addIntegerOption(o=>o.setName("gewinner").setDescription("Gewinnerzahl").setRequired(true).setMinValue(1).setMaxValue(20)).addStringOption(o=>o.setName("bedingungen").setDescription("Teilnahmebedingungen").setMaxLength(500)).addRoleOption(o=>o.setName("rolle").setDescription("Nur Mitglieder mit dieser Rolle dürfen teilnehmen")))
    .addSubcommand(s=>s.setName("abbrechen").setDescription("Giveaway abbrechen").addStringOption(o=>o.setName("id").setDescription("Giveaway auswählen").setRequired(true).setAutocomplete(true)).addStringOption(o=>o.setName("grund").setDescription("Grund").setMaxLength(300)));
  const dashboard = new SlashCommandBuilder().setName("dashboard").setDescription("Staff-Dashboard")
    .addSubcommand(s=>s.setName("ansicht").setDescription("Private Staff-Übersicht anzeigen").addStringOption(o=>o.setName("bereich").setDescription("Bereich").addChoices(...Object.entries(VIEWS).map(([value,view])=>({name:view.label,value})))))
    .addSubcommand(s=>s.setName("panel").setDescription("Dauerhaftes Dashboard-Panel in diesem Channel veröffentlichen (Staff)"));
  const settings = new SlashCommandBuilder().setName("einstellungen").setDescription("Bot-Einstellungen (Leitung)")
    .addSubcommand(s=>s.setName("anzeigen").setDescription("Aktive Rollen-, Channel- und Moduleinstellungen prüfen"))
    .addSubcommand(s=>s.setName("pruefen").setDescription("Prüft, ob alle Channels zu ihren Funktionen passen (Rechte, Sichtbarkeit, Name)"))
    .addSubcommand(s=>s.setName("kanal").setDescription("Funktions-Channel festlegen").addStringOption(o=>o.setName("schluessel").setDescription("Funktion (tippen zum Suchen)").setRequired(true).setAutocomplete(true)).addChannelOption(o=>o.setName("kanal").setDescription("Channel oder Kategorie").setRequired(true).addChannelTypes(ChannelType.GuildText,ChannelType.GuildCategory,ChannelType.GuildAnnouncement)));
  const automod = new SlashCommandBuilder().setName("automod").setDescription("AutoMod und Raid-Schutz")
    .addSubcommand(s=>s.setName("status").setDescription("AutoMod-Einstellungen und letzte Maßnahmen (Staff)"))
    .addSubcommand(s=>s.setName("sync").setDescription("Gesperrte Begriffe als native Discord-AutoMod-Regel übernehmen (Leitung)"));
  const activities = new SlashCommandBuilder().setName("aktivitaeten").setDescription("Wiederkehrende Familien-Aktivitäten")
    .addSubcommand(s=>s.setName("liste").setDescription("Aktivitätenplan anzeigen"))
    .addSubcommand(s=>s.setName("status").setDescription("Aktivität aktivieren oder deaktivieren (Event-Team)").addStringOption(o=>o.setName("aktivitaet").setDescription("Aktivität auswählen").setRequired(true).setAutocomplete(true)).addBooleanOption(o=>o.setName("aktiv").setDescription("Aktiv = Termine werden automatisch angekündigt").setRequired(true)))
    .addSubcommand(s=>s.setName("board").setDescription("Dauerhafte Aktivitäten-Übersicht in diesem Channel posten (Event-Team)"));
  const warn = new SlashCommandBuilder().setName("warn").setDescription("Mitglied verwarnen (ohne Geldabzug)")
    .addUserOption(o=>o.setName("mitglied").setDescription("Wer verwarnt wird").setRequired(true))
    .addStringOption(o=>o.setName("grund").setDescription("Grund – die Person bekommt ihn per DM").setRequired(true).setMinLength(3).setMaxLength(300))
    .addStringOption(o=>o.setName("fall").setDescription("Optionale Fall-, Ticket- oder Event-ID").setMaxLength(100));
  const warnings = new SlashCommandBuilder().setName("warnings").setDescription("Verwarnungen ansehen")
    .addUserOption(o=>o.setName("mitglied").setDescription("Mitglied (nur Moderation; leer = du selbst)"));
  const unwarn = new SlashCommandBuilder().setName("unwarn").setDescription("Verwarnung zurücknehmen (Moderation)")
    .addUserOption(o=>o.setName("mitglied").setDescription("Wessen Verwarnung zurückgenommen wird").setRequired(true))
    .addStringOption(o=>o.setName("grund").setDescription("Grund der Rücknahme").setRequired(true).setMinLength(3).setMaxLength(300))
    .addStringOption(o=>o.setName("warnung").setDescription("Welche Verwarnung (leer = die neueste aktive)").setAutocomplete(true));
  const absence = new SlashCommandBuilder().setName("abwesend").setDescription("Abmeldung bei der Familie (Urlaub, Pause)")
    .addSubcommand(s=>s.setName("melden").setDescription("Für einen Zeitraum abmelden").addStringOption(o=>o.setName("von").setDescription("Beginn, z. B. heute oder 20.10.").setRequired(true).setMaxLength(20)).addStringOption(o=>o.setName("bis").setDescription("Ende (inklusive), z. B. 27.10.").setRequired(true).setMaxLength(20)).addStringOption(o=>o.setName("grund").setDescription("Grund – sieht nur das Team").setRequired(true).setMinLength(2).setMaxLength(300)))
    .addSubcommand(s=>s.setName("beenden").setDescription("Eigene Abmeldung vorzeitig beenden (wieder da)"))
    .addSubcommand(s=>s.setName("liste").setDescription("Wer gerade abgemeldet ist (Staff)"));
  const leaderboard = new SlashCommandBuilder().setName("rangliste").setDescription("Aktivste Mitglieder nach Event-Teilnahmen")
    .addStringOption(o=>o.setName("zeitraum").setDescription("Zeitraum").addChoices({name:"Diese Woche",value:"week"},{name:"Dieser Monat",value:"month"},{name:"Gesamt",value:"all"}));
  const reasonOption=o=>o.setName("grund").setDescription("Grund – die Person bekommt ihn per DM").setRequired(true).setMinLength(3).setMaxLength(300);
  const timeout = new SlashCommandBuilder().setName("timeout").setDescription("Mitglied stummschalten (Moderation)")
    .addUserOption(o=>o.setName("mitglied").setDescription("Wer stummgeschaltet wird").setRequired(true))
    .addIntegerOption(o=>o.setName("dauer").setDescription("Dauer").setRequired(true).addChoices(...TIMEOUT_CHOICES.map(([value,name])=>({name,value}))))
    .addStringOption(reasonOption);
  const untimeout = new SlashCommandBuilder().setName("untimeout").setDescription("Timeout vorzeitig aufheben (Moderation)")
    .addUserOption(o=>o.setName("mitglied").setDescription("Mitglied").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Grund").setRequired(true).setMinLength(3).setMaxLength(300));
  const kick = new SlashCommandBuilder().setName("kick").setDescription("Mitglied vom Server entfernen (Staff, mit Bestätigung)")
    .addUserOption(o=>o.setName("mitglied").setDescription("Mitglied").setRequired(true)).addStringOption(reasonOption);
  const ban = new SlashCommandBuilder().setName("ban").setDescription("Person bannen (Leitung, mit Bestätigung)")
    .addUserOption(o=>o.setName("mitglied").setDescription("Person (auch per ID)").setRequired(true)).addStringOption(reasonOption)
    .addIntegerOption(o=>o.setName("nachrichten").setDescription("Nachrichten der Person löschen").addChoices(...BAN_DELETE_CHOICES.map(([value,name])=>({name,value}))));
  const unban = new SlashCommandBuilder().setName("unban").setDescription("Bann aufheben (Leitung)")
    .addUserOption(o=>o.setName("person").setDescription("Gebannte Person (Benutzer-ID einfügen)").setRequired(true)).addStringOption(o=>o.setName("grund").setDescription("Grund").setRequired(true).setMinLength(3).setMaxLength(300));
  const poll = new SlashCommandBuilder().setName("umfrage").setDescription("Abstimmungen")
    .addSubcommand(s=>s.setName("erstellen").setDescription("Abstimmung starten (Staff)")
      .addStringOption(o=>o.setName("frage").setDescription("Die Frage").setRequired(true).setMinLength(3).setMaxLength(250))
      .addStringOption(o=>o.setName("optionen").setDescription("Antworten, getrennt durch ; z. B. Ja; Nein; Egal (2–10)").setRequired(true).setMaxLength(900))
      .addIntegerOption(o=>o.setName("stunden").setDescription("Dauer in Stunden (Standard 24, max. 720)").setMinValue(1).setMaxValue(720))
      .addBooleanOption(o=>o.setName("anonym").setDescription("Niemand (auch nicht das Team) sieht, wer was gewählt hat"))
      .addBooleanOption(o=>o.setName("ergebnis_verstecken").setDescription("Zwischenstand erst am Ende zeigen"))
      .addRoleOption(o=>o.setName("rolle").setDescription("Nur Mitglieder mit dieser Rolle dürfen abstimmen"))
      .addChannelOption(o=>o.setName("kanal").setDescription("Channel (Standard: Abstimmungs-Channel)").addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement)))
    .addSubcommand(s=>s.setName("beenden").setDescription("Abstimmung vorzeitig beenden (Staff)").addStringOption(o=>o.setName("umfrage").setDescription("Abstimmung auswählen").setRequired(true).setAutocomplete(true)));
  const misc = [
    new SlashCommandBuilder().setName("ping").setDescription("Bot-Latenz anzeigen"),
    new SlashCommandBuilder().setName("help").setDescription("Befehlsübersicht"),
    new SlashCommandBuilder().setName("bewerbung-panel").setDescription("Bewerbungs-Panel senden (Reviewer)"),
    new SlashCommandBuilder().setName("statistik").setDescription("Familienstatistik anzeigen (Staff)").addIntegerOption(o=>o.setName("zeitraum").setDescription("Zeitraum").addChoices(...Object.entries(PERIODS).map(([days,label])=>({name:label,value:Number(days)})))),
  ];
  return [money,sanction,warn,warnings,unwarn,poll,timeout,untimeout,kick,ban,unban,absence,leaderboard,ticket,event,apps,giveaway,dashboard,settings,automod,activities,...misc].map(c=>c.toJSON());
}

export function createHandler({db,finance,config,client,settings=null,series=null}) {
  client.gambinoOwnerIds=config.BOT_OWNER_IDS??[];
  questionConfig=config;
  // Live berechnet: Rollenänderungen über Website/Discord gelten sofort.
  const groups=new Proxy({}, { get: (_, key) => accessGroups(config)[key] });
  const polls=createPollService(db);
  const verifications=createVerificationService(db),warningService=createWarningService(db),absences=createAbsenceService(db),activity=createActivityService(db);
  const pendingModeration=new Map();
  const events=createEventService(db),giveaways=createGiveawayService(db),tickets=createTicketService(db),applications=createApplicationService(db);
  const isOwner=i=>config.BOT_OWNER_IDS?.includes(i.user?.id)??false;
  const memberRoleIds=i=>[...(i.member?.roles?.cache?.keys?.()??i.member?.roles??[])];
  const hasRoleOrOwner=(i,roles)=>isOwner(i)||roles.some(r=>i.member?.roles?.cache?.has(r));
  const can=(i,group)=>hasRoleOrOwner(i,groups[group]);
  const describe=i=>i.isChatInputCommand?.()?`/${i.commandName}${i.options.getSubcommand(false)?` ${i.options.getSubcommand(false)}`:""}`:i.customId?.split(":").slice(0,2).join(":");
  /** Serverseitige Rechteprüfung. Bot-Owner ohne passende Rolle werden durchgelassen, aber protokolliert. */
  const guard=(i,group,label)=>{
    if(!i.inGuild())return "Dieser Befehl funktioniert nur auf einem Server.";
    const roles=groups[group]??[];
    if(hasRole(i.member,roles))return null;
    if(isOwner(i)){audit(db,i.guildId,i.user.id,"admin.override",null,{command:describe(i),group});return null;}
    if(!roles.length)return "Die Rollen für diese Aktion sind noch nicht konfiguriert. Bitte ROLE_* in der .env setzen.";
    return `Dafür brauchst du eine ${label}.`;
  };
  const memberGate=i=>!groups.members.length||can(i,"members")||can(i,"anyStaff")?null:"Diese Funktion ist Familienmitgliedern vorbehalten.";
  const answer=(i,options)=>i.reply(presentInteractionPayload(options));
  const followUp=(i,options)=>i.followUp(presentInteractionPayload(options));
  const updateMessage=(i,options)=>i.update(presentInteractionPayload(options));
  const replyError=async(i,e)=>{ const msg=err(e); if(i.deferred||i.replied) return followUp(i,{content:msg,ephemeral:true}).catch(()=>{}); return answer(i,{content:msg,ephemeral:true}).catch(()=>{}); };
  const respond=async(i,content,ephemeral=true)=>answer(i,{content,ephemeral});
  const wrongGuild=i=>!i.inGuild()||(config.DISCORD_GUILD_ID&&i.guildId!==config.DISCORD_GUILD_ID);

  async function autocomplete(i){
    try{
      if(wrongGuild(i))return i.respond([]);
      const g=i.guildId,sub=i.options.getSubcommand(false),focused=i.options.getFocused(true),query=String(focused.value??"").toLocaleLowerCase("de-AT");
      let rows=[],choices=[];
      if(i.commandName==="event"&&(can(i,"events")||sub==="teilnehmer")){
        rows=["anwesenheit","teilnehmer"].includes(sub)
          ?db.prepare("SELECT id,name,starts_at FROM events WHERE guild_id=? AND status IN ('scheduled','ended') ORDER BY starts_at DESC LIMIT 100").all(g)
          :db.prepare("SELECT id,name,starts_at FROM events WHERE guild_id=? AND status='scheduled' ORDER BY starts_at LIMIT 100").all(g);
        choices=rows.map(r=>({name:`${r.name} · ${new Date(r.starts_at).toLocaleString("de-AT",{timeZone:config.TIMEZONE,dateStyle:"short",timeStyle:"short"})}`.slice(0,100),value:r.id}));
      }else if(i.commandName==="antrag"){
        if(sub==="status")rows=db.prepare("SELECT id,kind,status,created_at FROM applications WHERE guild_id=? AND user_id=? AND status IN ('open','review') ORDER BY created_at DESC LIMIT 25").all(g,i.user.id);
        else if(["entscheiden","kommentieren"].includes(sub)&&can(i,"reviewers"))rows=db.prepare("SELECT id,user_id,kind,status,created_at FROM applications WHERE guild_id=? AND status IN ('open','review') ORDER BY created_at LIMIT 100").all(g);
        choices=rows.map(r=>({name:`${r.kind==="rang"?"🏅 Rang-Antrag":"🤝 Bewerbung"} · ${r.status==="review"?"in Bearbeitung":"offen"} · …${r.user_id?.slice(-5)??""} · ${r.id.slice(0,8)}`,value:r.id}));
      }else if(i.commandName==="sanktion"&&can(i,"leaders")){
        if(sub==="aufheben")rows=db.prepare("SELECT s.id,s.user_id,s.remaining_cents AS cents,s.reason FROM sanctions s WHERE s.guild_id=? AND s.status IN ('open','partial') AND NOT EXISTS(SELECT 1 FROM payout_allocations p WHERE p.sanction_id=s.id) ORDER BY s.created_at DESC LIMIT 100").all(g);
        else if(sub==="korrigieren")rows=db.prepare("SELECT s.id,s.user_id,s.amount_cents AS cents,s.reason FROM sanctions s WHERE s.guild_id=? AND s.status<>'void' ORDER BY s.created_at DESC LIMIT 100").all(g);
        else if(sub==="rueckerstatten")rows=db.prepare("SELECT s.id,s.user_id,s.reason,COALESCE((SELECT SUM(amount_cents) FROM payout_allocations p WHERE p.sanction_id=s.id),0)-COALESCE((SELECT SUM(amount_cents) FROM sanction_refunds r WHERE r.sanction_id=s.id),0) AS cents FROM sanctions s WHERE s.guild_id=? AND COALESCE((SELECT SUM(amount_cents) FROM payout_allocations p WHERE p.sanction_id=s.id),0)>COALESCE((SELECT SUM(amount_cents) FROM sanction_refunds r WHERE r.sanction_id=s.id),0) ORDER BY s.created_at DESC LIMIT 100").all(g);
        choices=rows.map(r=>({name:`${r.reason.slice(0,55)} · Mitglied …${r.user_id.slice(-5)} · ${formatMoney(r.cents)}`.slice(0,100),value:r.id}));
      }else if(i.commandName==="umfrage"&&can(i,"staff")){
        choices=polls.list(g,25).filter(p=>p.status==="open").map(p=>({name:`${p.question} · endet ${new Date(p.ends_at).toLocaleString("de-AT",{timeZone:config.TIMEZONE,dateStyle:"short",timeStyle:"short"})}`.slice(0,100),value:p.id}));
      }else if(i.commandName==="einstellungen"&&can(i,"leaders")){
        choices=Object.keys(CHANNEL_BINDINGS).map(key=>{const label=SETTINGS.find(s=>s.key===key)?.label;return {name:`${label?`${label} · `:""}${key}`.slice(0,100),value:key};});
      }else if(i.commandName==="unwarn"&&can(i,"moderation")){
        // Mit gewähltem Mitglied nur dessen Verwarnungen; die Suche läuft über Grund und Referenz statt über Namen.
        const target=i.options.get?.("mitglied")?.value??null;
        const rows=target?warningService.list(g,target,{limit:25,expireDays:config.WARN_EXPIRE_DAYS}).filter(r=>r.state==="active"):warningService.recent(g,{limit:100,activeOnly:true,expireDays:config.WARN_EXPIRE_DAYS});
        const nick=id=>verifications.byUser(g,id)?.nickname??i.guild?.members?.cache?.get?.(id)?.displayName??`Mitglied …${id.slice(-5)}`;
        choices=rows.filter(r=>r.user_id!==i.user.id||isOwner(i)).map(r=>({name:`${target?"":`${nick(r.user_id)} · `}${new Date(r.created_at).toLocaleDateString("de-AT",{timeZone:config.TIMEZONE})} · ${r.reason} · ${r.id.slice(0,8)}`.slice(0,100),value:r.id}));
      }else if(i.commandName==="aktivitaeten"&&series&&can(i,"events")){
        choices=series.list(g).map(r=>({name:`${r.active?"🟢":"⚪"} ${r.name} · ${describeSchedule(r)}`.slice(0,100),value:r.id}));
      }else if(i.commandName==="giveaway"&&sub==="abbrechen"&&can(i,"staff")){
        rows=db.prepare("SELECT id,prize,ends_at FROM giveaways WHERE guild_id=? AND status='active' ORDER BY ends_at LIMIT 100").all(g);
        choices=rows.map(r=>({name:`🎉 ${r.prize.slice(0,65)} · endet ${new Date(r.ends_at).toLocaleDateString("de-AT",{timeZone:config.TIMEZONE})}`,value:r.id}));
      }
      return i.respond(choices.filter(choice=>!query||choice.name.toLocaleLowerCase("de-AT").includes(query)||choice.value.toLowerCase().startsWith(query)).slice(0,25));
    }catch(error){console.warn("Autocomplete konnte nicht geladen werden:",error.message);return i.respond([]).catch(()=>{});}
  }

  async function command(i) {
    if (!i.inGuild()) return respond(i,"Dieser Bot-Befehl funktioniert nur in einem Server.");
    if(config.DISCORD_GUILD_ID&&i.guildId!==config.DISCORD_GUILD_ID)return respond(i,"Der Bot ist für diesen Server nicht freigeschaltet.");
    const g=i.guildId,u=i.user.id,sub=i.options.getSubcommand(false);
    try {
      if (i.commandName==="ping") return respond(i,`Pong! ${client.ws.ping} ms`);
      if (i.commandName==="help") return answer(i,{...fieldsEmbed("📚 Gambinos Bot – Befehle",[
        {name:"💰 Konto & Sanktionen",value:"`/konto` Guthaben, Gutschriften, Auszahlungen, Korrekturen und Historie\n`/sanktion` Sanktionen und Verwarnungen eintragen, ansehen, korrigieren oder aufheben"},
        {name:"🚫 Abmeldung & Aktivität",value:"`/abwesend melden | beenden | liste` Urlaub oder Pause eintragen\n`/rangliste` aktivste Mitglieder nach Event-Teilnahmen"},
        {name:"🛡️ Moderation",value:"`/timeout` `/untimeout` (Moderation) · `/kick` (Staff) · `/ban` `/unban` (Leitung) – mit Grund, DM und Eintrag in der Mitgliederhistorie"},
        {name:"📝 Verwarnungen",value:"`/warn` Mitglied verwarnen (DM, ohne Geldabzug)\n`/warnings` eigene bzw. fremde Verwarnungen ansehen\n`/unwarn` Verwarnung zurücknehmen"},
        {name:"🎫 Support",value:"`/ticket` Ticket-Panel, Übernahme, Schließen und Wiederöffnen"},
        {name:"📅 Familie",value:"`/event` Events verwalten und Teilnahme dokumentieren\n`/antrag` Bewerbung oder Rang-Antrag einreichen, kommentieren und entscheiden"},
        {name:"🎉 Community",value:"`/giveaway` Gewinnspiele verwalten\n`/umfrage erstellen | beenden` Abstimmungen mit Buttons"},
        {name:"🧭 Staff",value:"`/dashboard` Staff-Übersicht und Panel\n`/statistik` Auswertungen nach Zeitraum\n`/automod` Schutzmaßnahmen\n`/einstellungen` Konfiguration prüfen (Leitung)\n`/ping` Bot-Verbindung prüfen"},
      ],"Die verfügbaren Aktionen richten sich nach deiner Rolle."),ephemeral:true});
      if (i.commandName==="konto") return await accountCommand(i,sub,g,u);
      if (i.commandName==="sanktion") return await sanctionCommand(i,sub,g,u);
      if (i.commandName==="warn") return await issueWarning(i,g,u,{target:i.options.getUser("mitglied"),reason:i.options.getString("grund"),caseRef:i.options.getString("fall")});
      if (i.commandName==="warnings") return await warningsCommand(i,g,u);
      if (i.commandName==="unwarn") return await unwarnCommand(i,g,u);
      if (i.commandName==="abwesend") return await absenceCommand(i,sub,g,u);
      if (i.commandName==="umfrage") return await pollCommand(i,sub,g,u);
      if (i.commandName==="rangliste") return answer(i,{...buildLeaderboardView(g,i.options.getString("zeitraum")??"week"),ephemeral:true});
      if (MOD_PERMISSIONS[i.commandName]) return await moderationCommand(i,g,u);
      if (i.commandName==="ticket") return await ticketCommand(i,sub,g,u);
      if (i.commandName==="event") return await eventCommand(i,sub,g,u);
      if (i.commandName==="antrag") return await applicationCommand(i,sub,g,u);
      if (i.commandName==="bewerbung-panel") {const denied=guard(i,"reviewers","Reviewer-Rolle");if(denied)return respond(i,denied);await postManagedPanel(i,"CHANNEL_APPLICATION_PANEL","PANEL_APPLICATION",buildApplicationPanelPayload(panelTexts(db,g,"application")));return respond(i,"Bewerbungs-Panel veröffentlicht.");}
      if (i.commandName==="giveaway") return await giveawayCommand(i,sub,g,u);
      if (i.commandName==="dashboard") return await dashboardCommand(i,sub,g,u);
      if (i.commandName==="statistik") {
        const denied=guard(i,"anyStaff","Staff-Rolle");if(denied)return respond(i,denied);
        const days=i.options.getInteger("zeitraum")??30;
        const stats=collectStats(db,g,{days,includeFinance:can(i,"financeView")});
        return answer(i,{embeds:[statsEmbed(stats,{memberCount:i.guild?.memberCount??null})],ephemeral:true});
      }
      if (i.commandName==="einstellungen") return await settingsCommand(i,sub,g,u);
      if (i.commandName==="automod") return await automodCommand(i,sub,g,u);
      if (i.commandName==="aktivitaeten") return await activityCommand(i,sub,g,u);
      return respond(i,"Unbekannter Befehl.");
    } catch(e) { if(!(e instanceof FinanceError||e instanceof WarningError||e instanceof AbsenceError||e instanceof PollError))console.error(`Command ${i.commandName} failed:`,e); return replyError(i,e); }
  }

  /** Kontoansichten, gemeinsam genutzt von Slash-Befehlen und dem „Mein Konto“-Panel. */
  function balanceView(g,id){
    const plan=finance.previewPayout(g,id);
    const exists=Boolean(db.prepare("SELECT 1 FROM accounts WHERE guild_id=? AND user_id=?").get(g,id));
    return {...fieldsEmbed("💰 Familienkonto",[
        {name:"Mitglied",value:`<@${id}>`,inline:true},
        {name:"Familienguthaben (brutto)",value:`**${formatMoney(plan.gross)}**`,inline:true},
        {name:"Offene Sanktionen",value:formatMoney(plan.openCents),inline:true},
        {name:"Voraussichtliche Auszahlung",value:`**${formatMoney(plan.net)}**`,inline:true},
        ...(plan.remainingAfter?[{name:"Danach noch offene Sanktionen",value:formatMoney(plan.remainingAfter),inline:true}]:[]),
      ],exists?"Gambinos-Familienguthaben für Grand-RP-Events und Familienaktivitäten. Sanktionen werden erst bei der Auszahlung verrechnet.":"Für dieses Mitglied wurde noch kein Familienkonto angelegt. Es entsteht mit der ersten Gutschrift oder über /konto anlegen."),ephemeral:true};
  }
  function historyView(g,target,page=1){
    const pageSize=10,total=db.prepare("SELECT COUNT(*) n FROM transactions WHERE guild_id=? AND user_id=?").get(g,target).n;
    const rows=db.prepare("SELECT type,amount_cents,gross_cents,deduction_cents,net_cents,reason,created_at,id,actor_id FROM transactions WHERE guild_id=? AND user_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?").all(g,target,pageSize,(page-1)*pageSize);
    const sign=type=>["payout","correction_debit"].includes(type)?"−":"+";
    const items=rows.map(r=>({name:`${transactionLabels[r.type]??"Buchung"} · ${new Date(r.created_at).toLocaleString("de-AT",{timeZone:config.TIMEZONE})}`.slice(0,256),value:`${r.type==="payout"?`**Brutto:** ${formatMoney(r.gross_cents)} · **Abzug:** ${formatMoney(r.deduction_cents)} · **Netto:** ${formatMoney(r.net_cents)}`:`**Betrag:** ${sign(r.type)}${formatMoney(r.amount_cents)}`}\n**Grund:** ${r.reason}\n**Durch:** <@${r.actor_id}> · \`${r.id.slice(0,8)}\``.slice(0,1024),inline:false}));
    return {...fieldsEmbed("🧾 Buchungshistorie",items,total?`Mitglied: <@${target}> · Seite ${page} von ${Math.max(1,Math.ceil(total/pageSize))} · ${total} Buchungen`:"Noch keine Buchungen vorhanden."),ephemeral:true};
  }
  function sanctionsView(g,target){
    const rows=db.prepare("SELECT id,amount_cents,remaining_cents,reason,status,created_at FROM sanctions WHERE guild_id=? AND user_id=? AND status IN ('open','partial') ORDER BY created_at").all(g,target);
    const items=rows.map(r=>({name:`${statusLabels[r.status]??r.status} · ${formatMoney(r.remaining_cents)} offen${r.status==="partial"?` von ${formatMoney(r.amount_cents)}`:""}`,value:`**Grund:** ${r.reason}\n**Seit:** <t:${unix(r.created_at)}:d> · **Referenz:** \`${r.id.slice(0,8)}\``.slice(0,1024),inline:false}));
    const total=rows.reduce((n,r)=>n+r.remaining_cents,0);
    return {...fieldsEmbed("⚠️ Offene Sanktionen",items,rows.length?`Mitglied: <@${target}> · Summe offen: **${formatMoney(total)}**\nDiese Beträge werden erst bei Auszahlungen verrechnet.`:`Für <@${target}> gibt es keine offenen Sanktionen.`),ephemeral:true};
  }

  /** Gemeinsamer Ablauf für /warn und /sanktion verwarnung: Rechte, Schutzregeln, Speichern, DM und Eskalation. */
  async function issueWarning(i,g,u,{target,reason,caseRef}){
    const denied=guard(i,"moderation","Moderations- oder Staff-Rolle");if(denied)return respond(i,denied);
    const targetMember=i.options.getMember?.("mitglied")??await i.guild?.members?.fetch?.(target.id).catch(()=>null)??null;
    const targetRoleIds=targetMember?.roles?.cache?[...targetMember.roles.cache.keys()]:Array.isArray(targetMember?.roles)?targetMember.roles:[];
    const blocked=warnBlockReason({actorId:u,targetId:target.id,targetIsBot:target.bot,targetRoleIds,staffRoleIds:groups.anyStaff,actorIsLeader:hasRole(i.member,groups.leaders),actorIsOwner:isOwner(i)});
    if(blocked)return respond(i,blocked);
    const warning=warningService.add({guildId:g,userId:target.id,actorId:u,reason,caseRef,expireDays:config.WARN_EXPIRE_DAYS});
    const fields=[{name:"Mitglied",value:`<@${target.id}>`,inline:true},{name:"Aktive Verwarnungen",value:`**${warning.active}**`,inline:true},{name:"Referenz",value:`\`${warning.id.slice(0,8)}\``,inline:true},{name:"Grund",value:reason},...(caseRef?[{name:"Fallbezug",value:caseRef,inline:true}]:[])];
    const note="Verwarnungen haben keinen Einfluss auf das Familienkonto oder Auszahlungen.";
    await answer(i,{...fieldsEmbed("📝 Verwarnung eingetragen",fields,note),ephemeral:true});
    const result=await deliverWarning({db,client,config,guildId:g,userId:target.id,actorId:u,reason,caseRef,warning});
    const summary=deliverySummary(result,config);
    if(summary&&typeof i.editReply==="function")await i.editReply(presentInteractionPayload({...fieldsEmbed("📝 Verwarnung eingetragen",[...fields,{name:"Folgen",value:summary}],note)})).catch(()=>{});
    return result;
  }

  async function warningsCommand(i,g,u){
    const target=i.options.getUser("mitglied")?.id??u;
    if(target!==u&&!can(i,"moderation"))return respond(i,"Fremde Verwarnungen darf nur die Moderation ansehen.");
    const rows=warningService.list(g,target,{limit:15,expireDays:config.WARN_EXPIRE_DAYS});
    const active=warningService.activeCount(g,target,{expireDays:config.WARN_EXPIRE_DAYS});
    const items=rows.map(r=>({name:`${warningStateIcon[r.state]} ${warningStateLabel[r.state]} · <t:${unix(r.created_at)}:d>`.slice(0,256),value:`**Grund:** ${r.reason}${r.case_ref?` · Fall: ${r.case_ref}`:""}\n**Von:** <@${r.actor_id}> · \`${r.id.slice(0,8)}\`${r.revoked_at?`\n**Zurückgenommen:** <@${r.revoked_by}> – ${r.revoke_reason}`:""}`.slice(0,1024)}));
    const expiry=config.WARN_EXPIRE_DAYS>0?` Verwarnungen verfallen nach ${config.WARN_EXPIRE_DAYS} Tagen.`:"";
    return answer(i,{...fieldsEmbed("📝 Verwarnungen",items,rows.length?`Mitglied: <@${target}> · **${active} aktiv** · letzte ${rows.length} Einträge.${expiry}`:`Für <@${target}> gibt es keine Verwarnungen.`),ephemeral:true});
  }

  /** Findet die gemeinte Verwarnung: ausgewählte ID, eingetippte Referenz bzw. Grund, sonst die neueste aktive. */
  function resolveWarning(g,targetId,input){
    const active=warningService.list(g,targetId,{limit:100,expireDays:config.WARN_EXPIRE_DAYS}).filter(r=>r.state==="active");
    const value=String(input??"").trim();
    if(!value)return {row:active[0]??null,active};
    const exact=warningService.get(g,value);
    if(exact)return {row:exact.user_id===targetId?exact:null,active,mismatch:exact.user_id!==targetId};
    const needle=value.toLocaleLowerCase("de-AT");
    const hits=active.filter(r=>r.id.startsWith(needle)||r.reason.toLocaleLowerCase("de-AT").includes(needle));
    return {row:hits.length===1?hits[0]:null,active,ambiguous:hits.length>1};
  }

  async function unwarnCommand(i,g,u){
    const denied=guard(i,"moderation","Moderations- oder Staff-Rolle");if(denied)return respond(i,denied);
    const target=i.options.getUser("mitglied");
    const {row:existing,active,mismatch,ambiguous}=resolveWarning(g,target.id,i.options.getString("warnung"));
    if(mismatch)return respond(i,`Diese Verwarnung gehört nicht zu <@${target.id}>.`);
    if(ambiguous)return respond(i,"Mehrere Verwarnungen passen dazu. Bitte eine aus der Vorschlagsliste wählen.");
    if(!existing)return respond(i,active.length?"Diese Verwarnung wurde nicht gefunden. Bitte aus der Vorschlagsliste wählen oder das Feld leer lassen (dann wird die neueste genommen).":`<@${target.id}> hat keine aktiven Verwarnungen.`);
    // Reine Moderationsrollen nehmen nur eigene Verwarnungen zurück; Staff und Leitung alle.
    if(existing.actor_id!==u&&!can(i,"staff"))return respond(i,"Verwarnungen anderer Teammitglieder kann nur Staff oder die Leitung zurücknehmen.");
    const row=warningService.revoke({guildId:g,warningId:existing.id,actorId:u,allowSelf:isOwner(i),reason:i.options.getString("grund")});
    const remaining=warningService.activeCount(g,row.user_id,{expireDays:config.WARN_EXPIRE_DAYS});
    if(config.WARN_DM_ENABLED)await client.users.fetch(row.user_id).then(user=>user.send({embeds:[embed("✅ Verwarnung zurückgenommen",`Deine Verwarnung vom <t:${unix(row.created_at)}:d> („${row.reason}“) wurde zurückgenommen.\n**Grund:** ${row.revoke_reason}\n**Aktive Verwarnungen:** ${remaining}`)]})).catch(()=>{});
    return answer(i,{...fieldsEmbed("↩️ Verwarnung zurückgenommen",[{name:"Mitglied",value:`<@${row.user_id}>`,inline:true},{name:"Noch aktiv",value:String(remaining),inline:true},{name:"Ursprünglicher Grund",value:row.reason},{name:"Grund der Rücknahme",value:row.revoke_reason}],"Die Verwarnung zählt nicht mehr. In der Historie bleibt sie als „zurückgenommen“ sichtbar."),ephemeral:true});
  }

  // ---------------------------------------------------------------- Abmeldungen
  const today=()=>localDay(new Date(),config.TIMEZONE);
  const absenceEmbed=(row,title="🚫 Abmeldung eingetragen",note="Du zählst in dieser Zeit nicht als inaktiv; Fehlen bei Events gilt als entschuldigt.")=>fieldsEmbed(title,[
    {name:"Zeitraum",value:`**${formatDay(row.starts_on)} – ${formatDay(row.ends_on)}**`,inline:true},{name:"Grund",value:row.reason,inline:true}],note);
  async function createAbsence(i,{from,until,reason}){
    const gate=memberGate(i);if(gate)return answer(i,{content:"Abmeldungen gibt es nur für Mitglieder der Gambinos-Familie.",ephemeral:true});
    const row=absences.create({guildId:i.guildId,userId:i.user.id,actorId:i.user.id,startsOn:parseDay(from,config.TIMEZONE),endsOn:parseDay(until,config.TIMEZONE),reason,timezone:config.TIMEZONE,maxDays:config.ABSENCE_MAX_DAYS});
    await answer(i,{...absenceEmbed(row),ephemeral:true});
    await postAbsence({client,config,row});
    return row;
  }
  async function endOwnAbsence(i){
    const open=absences.openFor(i.guildId,i.user.id,today());
    if(!open)return answer(i,{content:"Du hast gerade keine offene Abmeldung.",ephemeral:true});
    const row=absences.end({guildId:i.guildId,absenceId:open.id,actorId:i.user.id});
    await answer(i,{...absenceEmbed(row,"✅ Willkommen zurück!","Deine Abmeldung ist beendet."),ephemeral:true});
    if(open.starts_on<=today())await postAbsence({client,config,row,kind:"ended"});
    return row;
  }
  async function absenceCommand(i,sub,g,u){
    if(sub==="melden")return createAbsence(i,{from:i.options.getString("von"),until:i.options.getString("bis"),reason:i.options.getString("grund")});
    if(sub==="beenden")return endOwnAbsence(i);
    if(sub==="liste"){
      const denied=guard(i,"anyStaff","Staff-Rolle");if(denied)return respond(i,denied);
      const now=absences.current(g,today()),next=absences.upcoming(g,today(),10);
      const line=r=>`<@${r.user_id}> · ${formatDay(r.starts_on)} – ${formatDay(r.ends_on)} · ${r.reason}`;
      return answer(i,{...fieldsEmbed("🚫 Abmeldungen",[
        {name:`Gerade abgemeldet (${now.length})`,value:(now.map(line).join("\n")||"Niemand").slice(0,1024)},
        {name:`Geplant (${next.length})`,value:(next.map(line).join("\n")||"Keine").slice(0,1024)},
      ],"Alle Abmeldungen und Inaktivität auch auf der Website im Bereich *Aktivität*."),ephemeral:true});
    }
  }
  function openAbsenceModal(i){
    const field=(id,label,placeholder,style=TextInputStyle.Short,max=20)=>new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(true).setMaxLength(max));
    return i.showModal(new ModalBuilder().setCustomId("absence:submit").setTitle("Abmeldung").addComponents(
      field("from","Von","heute oder 20.10."),field("until","Bis (inklusive)","z. B. 27.10. oder 27.10.2026"),field("reason","Grund (sieht nur das Team)","z. B. Urlaub",TextInputStyle.Paragraph,300)));
  }

  // ---------------------------------------------------------------- Rangliste
  function buildLeaderboardView(g,period){
    if(period==="all"){
      const rows=activity.leaderboard(g,{period:"all",timezone:config.TIMEZONE,limit:15});
      return fieldsEmbed("🏆 Rangliste · Gesamt",[{name:"Event-Teilnahmen",value:rows.map((r,n)=>`${["🥇","🥈","🥉"][n]??`**${n+1}.**`} <@${r.userId}> · **${r.count}**`).join("\n")||"Noch keine Teilnahmen."}]);
    }
    const texts=panelTexts(db,g,"leaderboard"),payload=buildLeaderboard({activity,guildId:g,timezone:config.TIMEZONE,texts});
    if(period==="month")payload.embeds[0].spliceFields(0,1);else payload.embeds[0].spliceFields(1,1);
    return payload;
  }

  // ---------------------------------------------------------------- Moderation (Timeout, Kick, Bann)
  async function moderationCommand(i,g,u){
    const action=i.commandName,[group,label]=MOD_PERMISSIONS[action];
    const denied=guard(i,group,label);if(denied)return respond(i,denied);
    const user=i.options.getUser(action==="unban"?"person":"mitglied"),reason=i.options.getString("grund");
    const targetMember=action==="unban"?null:i.options.getMember?.("mitglied")??await i.guild?.members?.fetch?.(user.id).catch(()=>null)??null;
    if(action!=="unban"){
      const targetRoleIds=targetMember?.roles?.cache?[...targetMember.roles.cache.keys()]:[];
      const blocked=warnBlockReason({actorId:u,targetId:user.id,targetIsBot:user.bot,targetRoleIds,staffRoleIds:groups.anyStaff,actorIsLeader:hasRole(i.member,groups.leaders),actorIsOwner:isOwner(i)});
      if(blocked)return respond(i,blocked.replace("verwarnen","moderieren").replace("verwarnt","moderiert"));
      const problem=hierarchyProblem({action,actorMember:i.member,targetMember,actorIsOwner:isOwner(i),guildOwnerId:i.guild?.ownerId});
      if(problem)return respond(i,problem);
    }
    const request={action,userId:user.id,reason,minutes:i.options.getInteger("dauer"),deleteSeconds:i.options.getInteger("nachrichten")??0,actorId:u,expires:Date.now()+120_000};
    if(action==="kick"||action==="ban"){
      for(const [key,value] of pendingModeration)if(value.expires<Date.now())pendingModeration.delete(key);
      pendingModeration.set(i.id,request);
      const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mod:confirm:${i.id}`).setLabel(action==="ban"?"Endgültig bannen":"Kicken").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`cancel:${i.id}`).setLabel("Abbrechen").setStyle(ButtonStyle.Secondary));
      return answer(i,{...fieldsEmbed(`${MOD_ACTIONS[action].emoji} ${MOD_ACTIONS[action].label} bestätigen`,[{name:"Person",value:`<@${user.id}>`,inline:true},{name:"Grund",value:reason},...(action==="ban"&&request.deleteSeconds?[{name:"Nachrichten löschen",value:BAN_DELETE_CHOICES.find(([v])=>v===request.deleteSeconds)?.[1]??"—",inline:true}]:[])],"Die Person bekommt vorher eine DM mit dem Grund. Die Bestätigung gilt 2 Minuten."),components:[row],ephemeral:true});
    }
    return executeModeration(i,request,targetMember,false);
  }
  async function executeModeration(i,request,targetMember,viaButton){
    const result=await performModeration({db,guild:i.guild,client,action:request.action,userId:request.userId,targetMember,actorId:request.actorId,reason:request.reason,minutes:request.minutes,deleteSeconds:request.deleteSeconds});
    const meta=MOD_ACTIONS[request.action];
    const payload=result.ok
      ?fieldsEmbed(`${meta.emoji} ${meta.label} ausgeführt`,[{name:"Person",value:`<@${request.userId}>`,inline:true},...(request.action==="timeout"?[{name:"Dauer",value:formatMinutes(request.minutes),inline:true}]:[]),{name:"Grund",value:request.reason},...(["timeout","kick","ban"].includes(request.action)?[{name:"DM",value:result.dm?"zugestellt":"nicht zustellbar (DMs geschlossen)",inline:true}]:[])],"Eingetragen in der Mitgliederhistorie und im Sanktions-Log.")
      :{content:`${meta.label} fehlgeschlagen: ${result.error}`};
    return viaButton?updateMessage(i,{...payload,components:[]}):answer(i,{...payload,ephemeral:true});
  }
  async function confirmModeration(i,token){
    const request=pendingModeration.get(token);
    if(!request||request.expires<Date.now()){pendingModeration.delete(token);return updateMessage(i,{content:"Die Bestätigung ist abgelaufen. Bitte den Befehl erneut ausführen.",embeds:[],components:[]});}
    if(request.actorId!==i.user.id)return answer(i,{content:"Nur wer die Aktion gestartet hat, kann sie bestätigen.",ephemeral:true});
    const [group,label]=MOD_PERMISSIONS[request.action];const denied=guard(i,group,label);if(denied)return answer(i,{content:denied,ephemeral:true});
    pendingModeration.delete(token);
    const targetMember=request.action==="kick"?await i.guild?.members?.fetch?.(request.userId).catch(()=>null):null;
    if(request.action==="kick"&&!targetMember)return updateMessage(i,{content:"Diese Person ist nicht mehr auf dem Server.",embeds:[],components:[]});
    return executeModeration(i,request,targetMember,true);
  }

  // ---------------------------------------------------------------- Abstimmungen
  async function pollCommand(i,sub,g,u){
    const denied=guard(i,"staff","Staff-Rolle");if(denied)return respond(i,denied);
    if(sub==="erstellen"){
      const channelId=i.options.getChannel?.("kanal")?.id??config.CHANNEL_POLLS??i.channelId;
      const data=validatePoll({question:i.options.getString("frage"),options:i.options.getString("optionen"),hours:i.options.getInteger("stunden")??24,anonymous:i.options.getBoolean?.("anonym")??false,hideResults:i.options.getBoolean?.("ergebnis_verstecken")??false,requiredRoleId:i.options.getRole?.("rolle")?.id??null,channelId},{timezone:config.TIMEZONE});
      const row=polls.create({guildId:g,actorId:u,data});
      await publishPoll({db,client,poll:row});
      return respond(i,`Abstimmung gestartet in <#${data.channelId}>. Sie endet <t:${Math.floor(new Date(data.endsAt).getTime()/1000)}:R>.`);
    }
    if(sub==="beenden"){
      const row=polls.close({guildId:g,id:i.options.getString("umfrage"),actorId:u});
      if(!row)return respond(i,"Diese Abstimmung ist nicht (mehr) offen.");
      await refreshPollMessage({db,client,pollId:row.id});await announcePollResult({db,client,poll:row});
      return respond(i,"Abstimmung beendet, Ergebnis wurde gepostet.");
    }
  }
  async function pollButton(i,action,pollId,option){
    const poll=polls.byId(pollId);
    if(!poll||poll.guild_id!==i.guildId)return answer(i,{content:"Diese Abstimmung gibt es nicht mehr.",ephemeral:true});
    if(poll.required_role_id&&!hasRole(i.member,[poll.required_role_id]))return answer(i,{content:`Bei dieser Abstimmung dürfen nur Mitglieder mit <@&${poll.required_role_id}> abstimmen.`,ephemeral:true});
    const result=action==="unvote"?polls.unvote({pollId,userId:i.user.id}):polls.vote({pollId,userId:i.user.id,optionIndex:Number(option)});
    if(result.status==="closed")return answer(i,{content:"Diese Abstimmung ist bereits beendet.",ephemeral:true});
    const label=n=>`**${poll.options[n]}**`;
    const text={voted:`Deine Stimme: ${label(result.optionIndex)}. Du kannst sie bis zum Ende ändern.`,changed:`Stimme geändert auf ${label(result.optionIndex)}.`,same:`Du hast bereits für ${label(result.optionIndex)} gestimmt.`,removed:"Deine Stimme wurde zurückgezogen.",none:"Du hattest noch nicht abgestimmt.",invalid:"Ungültige Auswahl."}[result.status];
    const fresh=polls.byId(pollId);
    if(["voted","changed","removed"].includes(result.status)&&typeof i.update==="function"){
      await i.update(pollPayload(fresh,polls.results(pollId))).catch(()=>{});
      return followUp(i,{content:text,ephemeral:true});
    }
    return answer(i,{content:text,ephemeral:true});
  }

  async function accountCommand(i,sub,g,u){
    if (sub==="stand"||sub==="ansehen") {
      const id=sub==="stand"?u:i.options.getUser("mitglied").id;
      if (id!==u&&!can(i,"financeView")) return respond(i,"Fremde Konten darf nur die Finanzrolle ansehen.");
      return answer(i,balanceView(g,id));
    }
    if (sub==="anlegen") {
      const denied=guard(i,"finance","Finanzrolle"); if(denied)return respond(i,denied);
      const target=i.options.getUser("mitglied");
      if(target.bot)return respond(i,"Bots können kein Familienkonto besitzen.");
      const result=finance.openAccount({guildId:g,userId:target.id,actorId:u,note:i.options.getString("notiz")??""});
      return answer(i,{...fieldsEmbed(result.created?"🏦 Familienkonto angelegt":"ℹ️ Konto existiert bereits",[
        {name:"Mitglied",value:`<@${target.id}>`,inline:true},{name:"Kontostand",value:formatMoney(result.balance),inline:true},
      ],result.created?"Das Konto erscheint jetzt in der Auszahlungsliste und kann Gutschriften erhalten.":"Für dieses Mitglied gibt es schon ein Familienkonto; es wurde nichts verändert."),ephemeral:true});
    }
    if (sub==="gutschrift") {
      const denied=guard(i,"finance","Finanzrolle"); if(denied)return respond(i,denied);
      const target=i.options.getUser("mitglied"),cents=parseMoney(i.options.getString("betrag"));
      if(target.bot)return respond(i,"Bots können kein Familienkonto besitzen.");
      const tx=finance.credit({guildId:g,userId:target.id,actorId:u,cents,reason:i.options.getString("grund"),key:`credit:${i.id}`});
      return answer(i,{...fieldsEmbed("✅ Gutschrift verbucht",[
        {name:"Empfänger",value:`<@${target.id}>`,inline:true},{name:"Betrag",value:`**${formatMoney(cents)}**`,inline:true},
        {name:"Neuer Kontostand",value:formatMoney(finance.balance(g,target.id)),inline:true},
        {name:"Buchungsgrund",value:i.options.getString("grund")},{name:"Buchungsreferenz",value:`\`${tx.id}\``},
      ],"Das Familienguthaben wurde aktualisiert."),ephemeral:true});
    }
    if (sub==="korrektur") {
      const denied=guard(i,"leaders","Leitungsrolle"); if(denied)return respond(i,denied);
      const target=i.options.getUser("mitglied"),cents=parseMoney(i.options.getString("betrag")),direction=i.options.getString("richtung"),reason=i.options.getString("grund");
      const tx=finance.correction({guildId:g,userId:target.id,actorId:u,cents,direction,reason,key:`correction:${i.id}`});
      return answer(i,{...fieldsEmbed("🛠️ Korrektur verbucht",[
        {name:"Mitglied",value:`<@${target.id}>`,inline:true},{name:"Korrektur",value:`**${direction==="debit"?"−":"+"}${formatMoney(cents)}**`,inline:true},
        {name:"Neuer Kontostand",value:formatMoney(finance.balance(g,target.id)),inline:true},
        {name:"Grund",value:reason},{name:"Buchungsreferenz",value:`\`${tx.id}\``},
      ],"Die Korrektur ist als eigene, unveränderliche Buchung protokolliert."),ephemeral:true});
    }
    if (sub==="auszahlen") {
      const denied=guard(i,"finance","Finanzrolle"); if(denied)return respond(i,denied);
      const target=i.options.getUser("mitglied"),plan=finance.previewPayout(g,target.id);
      if(plan.gross===0)return respond(i,"Kein auszahlbares Familienguthaben vorhanden.");
      if(config.PAYOUT_MINIMUM_CENTS!=null&&plan.gross<config.PAYOUT_MINIMUM_CENTS)return respond(i,`Das Guthaben liegt unter dem Mindestbetrag von ${formatMoney(config.PAYOUT_MINIMUM_CENTS)}.`);
      const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`payout:${i.id}:${target.id}:${plan.gross}:${plan.deduction}`).setLabel(plan.net===0?"Verrechnung ohne Auszahlung bestätigen":"Auszahlung bestätigen").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`cancel:${i.id}`).setLabel("Abbrechen").setStyle(ButtonStyle.Secondary));
      return answer(i,{...fieldsEmbed("💸 Auszahlung prüfen",[
        {name:"Empfänger",value:`<@${target.id}>`,inline:true},{name:"Brutto",value:`**${formatMoney(plan.gross)}**`,inline:true},
        {name:"Offene Sanktionen",value:formatMoney(plan.openCents),inline:true},
        {name:"Jetzt verrechnet",value:`− ${formatMoney(plan.deduction)}`,inline:true},{name:"Tatsächlicher Auszahlungsbetrag",value:`**${formatMoney(plan.net)}**`,inline:true},
        {name:"Verbleibende Sanktionen",value:formatMoney(plan.remainingAfter),inline:true},
        ...(plan.allocations.length?[{name:"Verrechnete Sanktionen",value:plan.allocations.map(a=>`\`${a.id.slice(0,8)}\` −${formatMoney(a.cents)}${a.remainingAfter?` (Rest ${formatMoney(a.remainingAfter)})`:" (beglichen)"}`).join("\n").slice(0,1024)}]:[]),
      ],`${plan.net===0?"⚠️ Das gesamte Guthaben wird durch Sanktionen aufgebraucht. Es wird nichts ausgezahlt, die Verrechnung wird aber dokumentiert.\n\n":""}Bitte prüfe die Beträge und bestätige die Buchung. Eine bestätigte Auszahlung kann nicht doppelt ausgeführt werden.`),components:[row],ephemeral:true});
    }
    if (sub==="liste") {
      const denied=guard(i,"financeView","Finanzrolle"); if(denied)return respond(i,denied);
      return answer(i,payoutListPayload(db,g,config.PAYOUT_MINIMUM_CENTS,i.options.getInteger("seite")??1));
    }
    if (sub==="historie") {
      const target=i.options.getUser("mitglied")?.id??u;
      if(target!==u&&!can(i,"financeView"))return respond(i,"Fremde Kontohistorien darf nur die Finanzrolle ansehen.");
      return answer(i,historyView(g,target,Math.max(1,i.options.getInteger("seite")??1)));
    }
  }

  async function sanctionCommand(i,sub,g,u){
    if(sub==="erstellen"){
      const denied=guard(i,"staff","Staff-Rolle");if(denied)return respond(i,denied);
      const target=i.options.getUser("mitglied"),amount=parseMoney(i.options.getString("betrag")),reason=i.options.getString("grund"),caseRef=i.options.getString("fall");
      if(target.bot)return respond(i,"Bots können nicht sanktioniert werden.");
      const id=finance.sanction({guildId:g,userId:target.id,actorId:u,cents:amount,reason,caseRef});
      return answer(i,{...fieldsEmbed("⚠️ Sanktion vorgemerkt",[
        {name:"Betroffenes Mitglied",value:`<@${target.id}>`,inline:true},{name:"Auszahlungsabzug",value:`**${formatMoney(amount)}**`,inline:true},
        {name:"Grund",value:reason},{name:"Sanktionsreferenz",value:`\`${id}\``,inline:true},...(caseRef?[{name:"Fallbezug",value:caseRef,inline:true}]:[]),
      ],"Der Betrag wird noch nicht abgezogen. Er wird bei der nächsten Auszahlung berücksichtigt."),ephemeral:true});
    }
    if(sub==="verwarnung")return issueWarning(i,g,u,{target:i.options.getUser("mitglied"),reason:i.options.getString("grund"),caseRef:i.options.getString("fall")});
    if(sub==="offen"){
      const target=i.options.getUser("mitglied")?.id??u;
      if(target!==u&&!can(i,"staff")&&!can(i,"financeView"))return respond(i,"Fremde Sanktionen darf nur Staff ansehen.");
      return answer(i,sanctionsView(g,target));
    }
    if(sub==="historie"){
      const target=i.options.getUser("mitglied")?.id??u;
      if(target!==u&&!can(i,"staff")&&!can(i,"financeView"))return respond(i,"Fremde Sanktionshistorien darf nur Staff ansehen.");
      const rows=finance.sanctionDetails(g,target,{limit:15});
      const warnings=warningService.list(g,target,{limit:5,expireDays:config.WARN_EXPIRE_DAYS});
      const items=rows.map(r=>({name:`${statusLabels[r.status]??r.status} · ${formatMoney(r.amount_cents)} · <t:${unix(r.created_at)}:d>`.slice(0,256),value:`**Grund:** ${r.reason}\n**Verrechnet:** ${formatMoney(r.collected_cents)}${r.refunded_cents?` · **Erstattet:** ${formatMoney(r.refunded_cents)}`:""} · **Offen:** ${formatMoney(r.remaining_cents)}\n**Aussteller:** <@${r.actor_id}> · \`${r.id.slice(0,8)}\`${r.case_ref?` · Fall: ${r.case_ref}`:""}`.slice(0,1024)}));
      if(warnings.length)items.push({name:`📝 Verwarnungen (${warnings.length} zuletzt)`,value:warnings.map(w=>`${warningStateIcon[w.state]} <t:${unix(w.created_at)}:d> · ${w.reason} · <@${w.actor_id}>`).join("\n").slice(0,1024)});
      return answer(i,{...fieldsEmbed("📚 Sanktionshistorie",items.slice(0,25),rows.length||warnings.length?`Mitglied: <@${target}> · Letzte 15 Sanktionen`:`Für <@${target}> gibt es keine Sanktionen oder Verwarnungen.`),ephemeral:true});
    }
    if(sub==="korrigieren"){
      const denied=guard(i,"leaders","Leitungsrolle");if(denied)return respond(i,denied);
      const row=finance.correctSanction({guildId:g,sanctionId:i.options.getString("id"),actorId:u,cents:parseMoney(i.options.getString("betrag")),reason:i.options.getString("grund")});
      return answer(i,{...fieldsEmbed("✏️ Sanktion korrigiert",[{name:"Mitglied",value:`<@${row.user_id}>`,inline:true},{name:"Neuer Betrag",value:formatMoney(row.amount_cents),inline:true},{name:"Noch offen",value:formatMoney(row.remaining_cents),inline:true},{name:"Status",value:statusLabels[row.status]??row.status,inline:true},{name:"Grund",value:i.options.getString("grund")}],"Bereits verrechnete Beträge bleiben unverändert; die Änderung ist in der Sanktionshistorie protokolliert."),ephemeral:true});
    }
    if(sub==="aufheben"){
      const denied=guard(i,"leaders","Leitungsrolle");if(denied)return respond(i,denied);
      const row=finance.voidSanction({guildId:g,sanctionId:i.options.getString("id"),actorId:u,reason:i.options.getString("grund")});
      return answer(i,{...fieldsEmbed("🚫 Sanktion aufgehoben",[
        {name:"Betroffenes Mitglied",value:`<@${row.user_id}>`,inline:true},{name:"Offener Rest",value:formatMoney(row.remaining_cents),inline:true},
        {name:"Grund der Aufhebung",value:i.options.getString("grund")},{name:"Sanktionsreferenz",value:`\`${row.id}\``,inline:true},
      ],"Die Sanktion ist geschlossen und wird bei künftigen Auszahlungen nicht mehr verrechnet."),ephemeral:true});
    }
    if(sub==="rueckerstatten"){
      const denied=guard(i,"leaders","Leitungsrolle");if(denied)return respond(i,denied);
      const tx=finance.refundSanction({guildId:g,sanctionId:i.options.getString("id"),actorId:u,reason:i.options.getString("grund"),key:`refund:${i.id}`});
      return answer(i,{...fieldsEmbed("↩️ Sanktion erstattet",[{name:"Erstatteter Betrag",value:`**${formatMoney(tx.amount_cents)}**`,inline:true},{name:"Transaktionsreferenz",value:`\`${tx.id}\``,inline:true},{name:"Grund",value:i.options.getString("grund")}],"Der bereits abgezogene Betrag wurde dem Familienkonto gutgeschrieben."),ephemeral:true});
    }
  }

  const ticketAllowed=(i,ticket)=>canHandleTicket({memberRoleIds:memberRoleIds(i),isOwner:isOwner(i)},ticket,config,groups.staff);

  async function ticketCommand(i,sub,g,u){
    if(sub==="panel"){
      const denied=guard(i,"staff","Staff-Rolle");if(denied)return respond(i,denied);
      await postManagedPanel(i,"CHANNEL_TICKET_PANEL","PANEL_TICKET",buildTicketPanelPayload(config,panelTexts(db,g,"ticket")));
      return respond(i,"Das Support-Panel wurde veröffentlicht.");
    }
    const ticket=db.prepare("SELECT * FROM tickets WHERE channel_id=? AND guild_id=?").get(i.channelId,g);
    if(!ticket)return respond(i,"Dieser Channel ist kein Ticket.");
    if(sub==="uebernehmen"){
      if(!ticketAllowed(i,ticket))return respond(i,"Dafür brauchst du eine Staff- oder zuständige Ticket-Rolle.");
      const row=tickets.claim({guildId:g,ticketId:ticket.id,actorId:u});
      if(!row)return respond(i,"Ticket nicht gefunden, geschlossen oder bereits übernommen.");
      await refreshTicketMessage(i.channel,row,u);
      return respond(i,"Du hast das Ticket übernommen. Der Channel zeigt jetzt dich als zuständigen Bearbeiter.");
    }
    if(sub==="wiedereroeffnen")return reopenTicket(i,ticket,false);
    if(sub==="schliessen"){
      if(ticket.status!=="open")return respond(i,"Dies ist kein offenes Ticket.");
      if(ticket.user_id!==u&&!ticketAllowed(i,ticket))return respond(i,"Nur Ersteller oder Staff können dieses Ticket schließen.");
      return answer(i,{content:"Ticket wirklich schließen? Der Verlauf wird gespeichert und der Channel bleibt für Staff einsehbar.",components:[closeConfirmRow(ticket.id)],ephemeral:true});
    }
  }
  const closeConfirmRow=id=>new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticket:close:${id}`).setLabel("Schließen bestätigen").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId("cancel:ticket").setLabel("Abbrechen").setStyle(ButtonStyle.Secondary));
  async function refreshTicketMessage(channel,row,claimedBy=null){
    const message=row.message_id?await channel.messages.fetch(row.message_id).catch(()=>null):null;
    const payload=row.status==="closed"
      ?{embeds:[ticketClosedCard(ticketCategoryLabel(row.category,config),row.user_id)],components:ticketClosedActions(row.id)}
      :{embeds:[ticketCard(ticketCategoryLabel(row.category,config),row.user_id,claimedBy??row.claimed_by)],components:ticketActions(row.id,Boolean(claimedBy??row.claimed_by))};
    if(message){await message.edit(payload).catch(()=>{});return;}
    const sent=await channel.send(payload).catch(()=>null);
    if(sent)db.prepare("UPDATE tickets SET message_id=? WHERE id=?").run(sent.id,row.id);
  }
  async function reopenTicket(i,ticket,viaButton){
    const reply=content=>viaButton?answer(i,{content,ephemeral:true}):respond(i,content);
    if(!ticketAllowed(i,ticket))return reply("Dafür brauchst du eine Staff- oder zuständige Ticket-Rolle.");
    const row=tickets.reopen({guildId:i.guildId,ticketId:ticket.id,actorId:i.user.id});
    if(!row)return reply("Geschlossenes Ticket nicht gefunden.");
    const channel=await targetChannel(i.guild,row.channel_id);
    if(channel){
      await channel.permissionOverwrites.edit(row.user_id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true}).catch(error=>console.warn("Ticket-Berechtigung nicht wiederhergestellt:",error.message));
      await channel.setName(`ticket-${row.category}-${row.user_id.slice(-4)}`.slice(0,90)).catch(()=>{});
      await moveTicketToOpen(channel,config);
      await refreshTicketMessage(channel,row);
    }
    await sendTicketLog(i.guild,logEmbed("🔓 Ticket wieder geöffnet",`**Ticket:** <#${row.channel_id}>\n**Mitglied:** <@${row.user_id}>\n**Durch:** <@${i.user.id}>`));
    return reply("Ticket wieder geöffnet. Der Antragsteller kann den Channel wieder nutzen.");
  }
  async function sendTicketLog(guild,logPayloadEmbed,files=[]){
    if(!config.CHANNEL_TICKET_LOG)return;
    const log=await targetChannel(guild,config.CHANNEL_TICKET_LOG);
    if(log)await log.send({embeds:[logPayloadEmbed],files}).catch(error=>console.warn("Ticket-Log konnte nicht gesendet werden:",error.message));
  }

  async function eventCommand(i,sub,g,u) {
    const invalidDate=()=>respond(i,`Bitte ein gültiges zukünftiges Datum eingeben, z. B. 31.12.2026 19:00 (${config.TIMEZONE}).`);
    const participantsOf=id=>events.participants(id);
    if(sub==="erstellen") {
      const denied=guard(i,"events","Event-Team");if(denied)return respond(i,denied);
      const start=parseEventDate(i.options.getString("start"),config.TIMEZONE);
      if(!start||start.getTime()<Date.now()+60_000)return invalidDate();
      const id=randomUUID();
      const item={id,guild_id:g,name:i.options.getString("name"),description:i.options.getString("beschreibung"),starts_at:start.toISOString(),location:i.options.getString("treffpunkt"),host_id:u,equipment:i.options.getString("ausruestung")??"",notes:i.options.getString("hinweise")??"",max_participants:i.options.getInteger("maximum")};
      const posted=await publishEvent({db,client,config,event:{...item,status:"scheduled"},fallbackChannel:i.channel});
      try{
        db.transaction(()=>{
          db.prepare("INSERT INTO events(id,guild_id,channel_id,message_id,announce_channel_id,announce_message_id,name,description,starts_at,location,host_id,equipment,notes,max_participants,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',?)").run(id,g,posted.channelId,posted.messageId,posted.announceChannelId,posted.announceMessageId,item.name,item.description,item.starts_at,item.location,u,item.equipment,item.notes,item.max_participants,isoNow());
          audit(db,g,u,"event.created",id,{name:item.name,startsAt:item.starts_at,channelId:posted.channelId});
        })();
      }catch(error){await deleteEventPosts({client,posted});throw error;}
      return answer(i,{...fieldsEmbed("📅 Event veröffentlicht",[
        {name:"Event",value:`**${item.name}**`,inline:true},{name:"Beginn",value:`<t:${unix(item.starts_at)}:F>`,inline:true},
        {name:"Anmeldung",value:`<#${posted.channelId}>`,inline:true},...(posted.announceChannelId?[{name:"Ankündigung",value:`<#${posted.announceChannelId}>`,inline:true}]:[]),
        {name:"Erinnerungen",value:config.EVENT_REMINDER_MINUTES.length?config.EVENT_REMINDER_MINUTES.map(m=>`${m} Min.`).join(", ")+" vorher":"deaktiviert",inline:true},
      ],"Das Event ist jetzt für die Familie sichtbar."),ephemeral:true});
    }
    if(sub==="liste"||sub==="historie") {
      const rows=sub==="liste"
        ?db.prepare("SELECT * FROM events WHERE guild_id=? AND status='scheduled' ORDER BY starts_at LIMIT 10").all(g)
        :db.prepare("SELECT * FROM events WHERE guild_id=? AND status IN ('ended','cancelled') ORDER BY starts_at DESC LIMIT 10").all(g);
      const items=rows.map(e=>{
        const c=db.prepare("SELECT SUM(status IN ('signed_up','present')) active, SUM(status='present') present, SUM(status='absent') absent FROM event_participants WHERE event_id=?").get(e.id);
        return {name:`${sub==="historie"?`${statusLabels[e.status]} · `:""}${e.name} · <t:${unix(e.starts_at)}:${sub==="liste"?"F":"d"}>`.slice(0,256),value:`**Treffpunkt:** ${e.location}\n**Teilnehmer:** ${c.active??0}${e.max_participants?` / ${e.max_participants}`:""}${sub==="historie"?` · **Anwesend:** ${c.present??0} · **Abwesend:** ${c.absent??0}`:""}\n**Event-ID:** \`${e.id.slice(0,8)}\``.slice(0,1024),inline:false};
      });
      return answer(i,{...fieldsEmbed(sub==="liste"?"📅 Anstehende Familien-Events":"🏁 Event-Historie",items,rows.length?`${rows.length} ${sub==="liste"?"kommende":"vergangene"} Events, maximal 10 angezeigt.`:"Keine passenden Events vorhanden."),ephemeral:true});
    }
    if(sub==="teilnehmer"){
      const event=db.prepare("SELECT * FROM events WHERE id=? AND guild_id=?").get(i.options.getString("id"),g);
      if(!event)return respond(i,"Event nicht gefunden.");
      const rows=db.prepare("SELECT user_id,status FROM event_participants WHERE event_id=? AND status<>'left' ORDER BY updated_at").all(event.id);
      const label={signed_up:"🙋 angemeldet",present:"✅ anwesend",absent:"➖ abwesend"};
      return answer(i,{...fieldsEmbed(`🙋 Teilnehmer · ${event.name}`.slice(0,256),[],rows.length?rows.map(r=>`<@${r.user_id}> · ${label[r.status]??r.status}`).join("\n").slice(0,4000):"Noch keine Teilnehmer."),ephemeral:true});
    }
    if(sub==="bearbeiten"){
      const denied=guard(i,"events","Event-Team");if(denied)return respond(i,denied);
      const id=i.options.getString("id"),old=db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled'").get(id,g);
      if(!old)return respond(i,"Geplantes Event nicht gefunden.");
      const startText=i.options.getString("start"),start=startText?parseEventDate(startText,config.TIMEZONE):new Date(old.starts_at);
      if(startText&&(!start||start.getTime()<Date.now()+60_000))return invalidDate();
      const next={name:i.options.getString("name")??old.name,starts_at:start.toISOString(),location:i.options.getString("treffpunkt")??old.location,description:i.options.getString("beschreibung")??old.description,max_participants:i.options.getInteger("maximum")??old.max_participants,equipment:i.options.getString("ausruestung")??old.equipment,notes:i.options.getString("hinweise")??old.notes};
      const changes=Object.fromEntries(Object.entries(next).filter(([key,value])=>value!==old[key]).map(([key,value])=>[key,{alt:old[key],neu:value}]));
      if(!Object.keys(changes).length)return respond(i,"Keine Änderung angegeben.");
      db.transaction(()=>{
        db.prepare("UPDATE events SET name=?,starts_at=?,location=?,description=?,max_participants=?,equipment=?,notes=? WHERE id=? AND status='scheduled'").run(next.name,next.starts_at,next.location,next.description,next.max_participants,next.equipment,next.notes,id);
        if(changes.starts_at)db.prepare("DELETE FROM event_reminders WHERE event_id=?").run(id);
        audit(db,g,u,"event.updated",id,{name:next.name,startsAt:next.starts_at,changed:Object.keys(changes).join(", ")});
      })();
      const updated=db.prepare("SELECT * FROM events WHERE id=?").get(id);
      const message=await refreshEventPosts({db,client,config,event:updated});
      return answer(i,{...fieldsEmbed("✏️ Event aktualisiert",[
        {name:"Event",value:`**${updated.name}**`,inline:true},{name:"Beginn",value:`<t:${unix(updated.starts_at)}:F>`,inline:true},
        {name:"Geändert",value:Object.keys(changes).join(", ")},
        {name:"Ankündigung",value:message?"Die veröffentlichte Event-Karte wurde aktualisiert.":"Eventdaten gespeichert; die ursprüngliche Ankündigung war nicht mehr verfügbar."},
      ]),ephemeral:true});
    }
    if(sub==="anwesenheit"){
      const denied=guard(i,"events","Event-Team");if(denied)return respond(i,denied);
      const target=i.options.getUser("mitglied"),status=i.options.getString("status");
      const result=events.setAttendance({guildId:g,eventId:i.options.getString("id"),userId:target.id,status,actorId:u});
      if(!result)return respond(i,"Event nicht gefunden oder abgesagt.");
      const excused=status==="absent"&&absences.wasAbsent(g,target.id,result.event.starts_at,config.TIMEZONE);
      return answer(i,{...fieldsEmbed("📝 Teilnahme dokumentiert",[
        {name:"Event",value:result.event.name,inline:true},{name:"Mitglied",value:`<@${target.id}>`,inline:true},{name:"Ergebnis",value:status==="present"?"✅ Anwesend":excused?"🚫 Abwesend – entschuldigt (abgemeldet)":"➖ Abwesend",inline:true},
      ],result.previous?"Der Teilnahmestatus wurde in der Eventhistorie gespeichert.":"Das Mitglied war nicht angemeldet und wurde nachgetragen."),ephemeral:true});
    }
    if(sub==="beenden"||sub==="absagen") {
      const denied=guard(i,"events","Event-Team");if(denied)return respond(i,denied);
      const status=sub==="beenden"?"ended":"cancelled",id=i.options.getString("id"),reason=i.options.getString("grund")??"";
      const row=db.transaction(()=>{
        const changed=db.prepare("UPDATE events SET status=? WHERE id=? AND guild_id=? AND status='scheduled' RETURNING *").get(status,id,g);
        if(changed)audit(db,g,u,`event.${status}`,id,{name:changed.name,reason});
        return changed;
      })();
      if(!row)return respond(i,"Geplantes Event nicht gefunden.");
      const participants=participantsOf(id);
      const message=await eventMessage(i.guild,row);
      await refreshEventPosts({db,client,config,event:row,state:status});
      if(sub==="beenden")await postEventResult({db,client,config,event:row});
      if(sub==="absagen"&&participants.length&&message?.channel&&!(row.series_id&&config.EVENT_SERIES_DELETE_ENDED))await message.channel.send({content:`${participants.slice(0,50).map(p=>`<@${p.user_id}>`).join(" ")}`,embeds:[logEmbed("❌ Event abgesagt",`**${row.name}** am <t:${unix(row.starts_at)}:F> findet nicht statt.${reason?`\n**Grund:** ${reason}`:""}`,"warning")],allowedMentions:{users:participants.slice(0,50).map(p=>p.user_id)}}).catch(()=>{});
      return respond(i,`Event **${row.name}** wurde ${sub==="beenden"?"beendet":"abgesagt"}.`);
    }
  }
  async function eventMessage(guild,event){const channel=await targetChannel(guild,event.channel_id);return channel&&event.message_id?channel.messages.fetch(event.message_id).catch(()=>null):null;}

  async function decideApplication(i,{id,status,note}){
    const row=db.transaction(()=>{
      const changed=db.prepare("UPDATE applications SET status=?,reviewer_id=?,review_note=?,updated_at=? WHERE id=? AND guild_id=? AND status IN ('open','review') RETURNING *").get(status,i.user.id,note,isoNow(),id,i.guildId);
      if(changed)audit(db,i.guildId,i.user.id,`application.${status}`,id,{kind:changed.kind,applicantId:changed.user_id,reviewerId:i.user.id,reason:note});
      return changed;
    })();
    if(!row)return null;
    if(status==="accepted"&&row.kind==="bewerbung"&&config.ACCOUNT_AUTO_OPEN_FOR_MEMBERS)finance.openAccount({guildId:i.guildId,userId:row.user_id,actorId:i.user.id,note:"Familienbewerbung angenommen"});
    const channel=await applicationReviewChannel(i.guild,config,row.kind);
    if(channel&&row.message_id){const msg=await channel.messages.fetch(row.message_id).catch(()=>null);if(msg&&msg.id!==i.message?.id)await msg.edit({...buildApplicationReviewPayload(row.kind,row.user_id,JSON.parse(row.answers),status,note),components:[]}).catch(()=>{});}
    const dmSent=await client.users.fetch(row.user_id).then(user=>user.send(applicationDecisionDm({kind:row.kind,status,applicationId:id,reason:note}))).then(()=>true).catch(()=>false);
    return {row,dmSent};
  }
  /** Bietet nach einem angenommenen Rang-Antrag die ausdrücklich konfigurierte Rollenvergabe an (nur Leitung). */
  function roleAssignmentOffer(i,row){
    if(row.kind!=="rang"||!config.RANK_ROLE_ASSIGNMENT_ENABLED||!config.RANK_ROLES_JSON.length||!can(i,"leaders"))return null;
    const select=new StringSelectMenuBuilder().setCustomId(`application:assignrole:${row.id}`).setPlaceholder("Optional: Rang-Rolle vergeben …")
      .addOptions([...config.RANK_ROLES_JSON.map(item=>({label:item.label,value:item.roleId})),{label:"Keine Rolle vergeben",value:"none"}].slice(0,25));
    return {content:`Soll <@${row.user_id}> jetzt eine Rang-Rolle erhalten? Die Vergabe wird protokolliert.`,components:[new ActionRowBuilder().addComponents(select)],ephemeral:true};
  }

  async function applicationCommand(i,sub,g,u) {
    if(sub==="bewerben"){
      const kind=i.options.getString("typ");
      if(kind==="rang"){const gate=memberGate(i);if(gate)return respond(i,gate);}
      await i.showModal(applicationModal(kind));return;
    }
    if(sub==="liste"){
      const denied=guard(i,"reviewers","Reviewer-Rolle");if(denied)return respond(i,denied);
      const rows=db.prepare("SELECT id,user_id,kind,status,reviewer_id,created_at FROM applications WHERE guild_id=? AND status IN ('open','review') ORDER BY created_at LIMIT 20").all(g);
      const items=rows.map(r=>({name:`${r.kind==="rang"?"🏅 Rang-Antrag":"🤝 Familienbewerbung"} · ${statusLabels[r.status]??r.status}`,value:`**Antragsteller:** <@${r.user_id}>\n**Eingereicht:** <t:${unix(r.created_at)}:R>${r.reviewer_id?`\n**Bearbeitung:** <@${r.reviewer_id}>`:""}\n**Antrags-ID:** \`${r.id}\``,inline:false}));
      return answer(i,{...fieldsEmbed("📨 Offene Anträge",items,rows.length?"Wähle den passenden Antrag im jeweiligen Staff-Channel aus.":"Es gibt aktuell keine offenen Anträge."),ephemeral:true});
    }
    if(sub==="kommentieren"){
      const denied=guard(i,"reviewers","Reviewer-Rolle");if(denied)return respond(i,denied);
      const result=applications.addNote({guildId:g,applicationId:i.options.getString("id"),authorId:u,note:i.options.getString("notiz")});
      await postApplicationNote(i.guild,result.application,u,i.options.getString("notiz"));
      return respond(i,"Notiz wurde gespeichert. Sie ist nur für das Team sichtbar.");
    }
    if(sub==="entscheiden"){
      const denied=guard(i,"reviewers","Reviewer-Rolle");if(denied)return respond(i,denied);
      const id=i.options.getString("id"),status=i.options.getString("entscheidung"),note=i.options.getString("kommentar")?.trim()??"";
      if(status==="rejected"&&note.length<3)return respond(i,"Bitte gib bei einer Ablehnung einen Grund an.");
      const result=await decideApplication(i,{id,status,note});
      if(!result)return respond(i,"Offener Antrag nicht gefunden.");
      await respond(i,`${result.row.kind==="rang"?"Der Rang-Antrag":"Die Familienbewerbung"} wurde ${status==="accepted"?"angenommen":"abgelehnt"}.${result.dmSent?"":" Die private Nachricht konnte nicht zugestellt werden."}`);
      const offer=status==="accepted"?roleAssignmentOffer(i,result.row):null;
      if(offer)await followUp(i,offer).catch(()=>{});
      return;
    }
    if(sub==="status"){
      const id=i.options.getString("id"),row=db.prepare("UPDATE applications SET status='withdrawn',updated_at=? WHERE id=? AND guild_id=? AND user_id=? AND status IN ('open','review') RETURNING id,kind,answers,message_id").get(isoNow(),id,g,u);
      if(!row)return respond(i,"Offener eigener Antrag nicht gefunden.");
      audit(db,g,u,"application.withdrawn",id,{kind:row.kind,applicantId:u});
      const channel=await applicationReviewChannel(i.guild,config,row.kind);
      if(channel&&row.message_id){const message=await channel.messages.fetch(row.message_id).catch(()=>null);if(message)await message.edit({...buildApplicationReviewPayload(row.kind,u,JSON.parse(row.answers),"withdrawn"),components:[]}).catch(()=>{});}
      return respond(i,"Dein Antrag wurde zurückgezogen. Das Team sieht den aktualisierten Status.");
    }
  }
  async function postApplicationNote(guild,application,authorId,note){
    const channel=await applicationReviewChannel(guild,config,application.kind);
    if(!channel)return;
    const original=application.message_id?await channel.messages.fetch(application.message_id).catch(()=>null):null;
    const payload={embeds:[logEmbed("💬 Interne Notiz",`**Antrag:** \`${application.id.slice(0,8)}\` · <@${application.user_id}>\n**Von:** <@${authorId}>\n\n${note}`)],allowedMentions:{parse:[]}};
    await (original?original.reply(payload):channel.send(payload)).catch(error=>console.warn("Antragsnotiz konnte nicht gepostet werden:",error.message));
  }

  async function giveawayCommand(i,sub,g,u) {
    if(sub==="erstellen"){
      const denied=guard(i,"staff","Staff-Rolle");if(denied)return respond(i,denied);
      const role=i.options.getRole("rolle");
      const targetGiveawayChannel=await targetChannel(i.guild,config.CHANNEL_GIVEAWAYS)??i.channel;
      const row={id:randomUUID(),guild_id:g,prize:i.options.getString("preis"),ends_at:new Date(Date.now()+i.options.getInteger("minuten")*60_000).toISOString(),winner_count:i.options.getInteger("gewinner"),conditions:i.options.getString("bedingungen")??"Keine weiteren Bedingungen",required_role_id:role?.id??null,created_by:u};
      db.transaction(()=>{
        db.prepare("INSERT INTO giveaways(id,guild_id,channel_id,prize,ends_at,winner_count,conditions,status,created_by,created_at,required_role_id) VALUES(?,?,?,?,?,?,?,'active',?,?,?)").run(row.id,g,targetGiveawayChannel.id,row.prize,row.ends_at,row.winner_count,row.conditions,u,isoNow(),row.required_role_id);
        audit(db,g,u,"giveaway.created",row.id,{prize:row.prize,endsAt:row.ends_at,winners:row.winner_count,channelId:i.channelId});
      })();
      let sent;
      try{sent=await targetGiveawayChannel.send({embeds:[giveawayCard(row)],components:[giveawayButtons(row.id)]});}
      catch(error){giveaways.cancel({guildId:g,giveawayId:row.id,actorId:u,reason:`Veröffentlichung fehlgeschlagen: ${error.message}`});throw new Error("Das Giveaway konnte nicht veröffentlicht werden und wurde abgebrochen. Prüfe die Bot-Berechtigungen in diesem Channel.");}
      db.prepare("UPDATE giveaways SET message_id=? WHERE id=?").run(sent.id,row.id);
      return answer(i,{...fieldsEmbed("🎉 Giveaway gestartet",[
        {name:"Preis",value:`**${row.prize}**`,inline:true},{name:"Endet",value:`<t:${unix(row.ends_at)}:R>`,inline:true},
        {name:"Veröffentlicht in",value:`${targetGiveawayChannel}`,inline:true},{name:"Verwaltung",value:`Referenz: \`${row.id}\``},
      ],"Die Teilnahme ist ab sofort möglich."),ephemeral:true});
    }
    if(sub==="abbrechen"){
      const denied=guard(i,"staff","Staff-Rolle");if(denied)return respond(i,denied);
      const row=giveaways.cancel({guildId:g,giveawayId:i.options.getString("id"),actorId:u,reason:i.options.getString("grund")??""});
      if(!row)return respond(i,"Aktives Giveaway nicht gefunden.");
      if(row.channel_id&&row.message_id){const ch=await targetChannel(i.guild,row.channel_id);const msg=ch?await ch.messages.fetch(row.message_id).catch(()=>null):null;if(msg)await msg.edit({embeds:[embed("🚫 Giveaway abgebrochen",`**${row.prize}** wird nicht mehr verlost. Die Teilnahme ist geschlossen.`)],components:[]}).catch(()=>{});}
      return answer(i,{...fieldsEmbed("🚫 Giveaway abgebrochen",[
        {name:"Preis",value:`**${row.prize}**`,inline:true},{name:"Status",value:"Abgebrochen · Es wird kein Gewinner gezogen.",inline:true},
      ],"Die Teilnahmeschaltfläche wurde deaktiviert."),ephemeral:true});
    }
  }

  async function dashboardCommand(i,sub,g,u){
    if(sub==="panel"){
      const denied=guard(i,"staff","Staff-Rolle");if(denied)return respond(i,denied);
      const sent=await i.channel.send(buildPanelPayload(db,g,panelTexts(db,g,"staffDashboard")));
      const previous=getSetting(db,g,PANEL_SETTING_KEY);
      setSetting(db,g,PANEL_SETTING_KEY,`${sent.channelId}:${sent.id}`);
      audit(db,g,u,"config.panel_published",sent.id,{channelId:sent.channelId,previous});
      return respond(i,"Das Dashboard-Panel wurde veröffentlicht. Es wird automatisch aktualisiert; Details sieht jede Person nur privat und nur mit passender Rolle.");
    }
    const view=i.options.getString("bereich");
    if(!view){const denied=guard(i,"anyStaff","Staff-Rolle");if(denied)return respond(i,denied);const {components,...payload}=buildPanelPayload(db,g,panelTexts(db,g,"staffDashboard"));return answer(i,{...payload,components,ephemeral:true});}
    return showView(i,view);
  }
  function showView(i,view){
    const definition=VIEWS[view];
    if(!definition)return answer(i,{content:"Unbekannte Ansicht.",ephemeral:true});
    if(!can(i,definition.group))return answer(i,{content:`Für „${definition.label}“ fehlt dir die passende Rolle.`,ephemeral:true});
    return answer(i,{embeds:[buildView(db,i.guildId,view,{config,finance})],ephemeral:true});
  }

  async function settingsCommand(i,sub,g,u){
    const denied=guard(i,"leaders","Leitungsrolle");if(denied)return respond(i,denied);
    if(sub==="anzeigen"){
      const roles=list=>list?.length?list.map(id=>`<@&${id}>`).join(" "):"—";
      const channel=id=>id?`<#${id}>`:"—";
      const warnings=configWarnings(config);
      return answer(i,{...fieldsEmbed("⚙️ Aktive Einstellungen",[
        {name:"Rollen",value:`Leitung: ${roles(config.ROLE_LEADERS)}\nStaff: ${roles(config.ROLE_STAFF)}\nFinanzen: ${roles(config.ROLE_FINANCE)}\nFinanz-Einsicht: ${roles(config.ROLE_FINANCE_VIEWERS)}\nReviewer: ${roles(config.ROLE_REVIEWERS)}\nEvent-Team: ${roles(config.ROLE_EVENT_TEAM)}\nMitglieder: ${roles(config.ROLE_MEMBERS)}`.slice(0,1024)},
        {name:"Channels",value:Object.keys(CHANNEL_BINDINGS).map(key=>`${key}: ${channel(config[key])}`).join("\n").slice(0,1024)},
        {name:"Module",value:`AutoMod: ${config.AUTOMOD_ENABLED?"aktiv":"aus"} · Raid-Aktionen: ${config.RAID_ACTIONS.join(", ")||"keine"}\nRang-Rollenvergabe: ${config.RANK_ROLE_ASSIGNMENT_ENABLED?"aktiv":"aus"} · Webdashboard: ${config.DASHBOARD_ENABLED?"aktiv":"aus"}\nZeitzone: ${config.TIMEZONE} · Erinnerungen: ${config.EVENT_REMINDER_MINUTES.join(", ")||"aus"} Min.\nAuszahlungs-Mindestbetrag: ${config.PAYOUT_MINIMUM_CENTS!=null?formatMoney(config.PAYOUT_MINIMUM_CENTS):"keiner"}`},
        {name:`Hinweise (${warnings.length})`,value:warnings.length?warnings.map(w=>`• ${w}`).join("\n").slice(0,1024):"Keine offenen Konfigurationspunkte."},
      ],"Rollen werden in der .env gepflegt. Funktions-Channels können mit `/einstellungen kanal` gesetzt werden."),ephemeral:true});
    }
    if(sub==="pruefen"){
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const report=await checkChannels({guild:i.guild,config});
      const icon={ok:"✅",warn:"⚠️",error:"❌"};
      const lines=report.channels.map(r=>`${icon[r.status]} **${r.label}**${r.channel?` → #${r.channel.name}`:""}${r.issues.filter(x=>x.level!=="info").map(x=>`\n　└ ${x.text}`).join("")}`);
      const perms=report.guildPermissions.filter(p=>p.needed&&!p.has).map(p=>`❌ Bot fehlt **${p.label}** (${p.reason})`);
      const text=`**${report.summary.ok} ok · ${report.summary.warn} Hinweise · ${report.summary.error} Fehler**\n\n${[...perms,...lines].join("\n")}${report.administrator?"\n\nℹ️ Der Bot hat Administrator-Rechte – empfohlen sind nur die nötigen Einzelrechte.":""}`;
      return i.editReply(presentInteractionPayload({embeds:[embed("🔍 Channel-Prüfung",text.slice(0,4000))]}));
    }
    if(sub==="kanal"){
      if(!config.DISCORD_GUILD_ID)return respond(i,"Channel-Einstellungen werden nur mit gesetzter DISCORD_GUILD_ID gespeichert.");
      const key=i.options.getString("schluessel"),channel=i.options.getChannel("kanal");
      if(!Object.hasOwn(CHANNEL_BINDINGS,key))return respond(i,"Unbekannte Einstellung.");
      const wantsCategory=key==="CHANNEL_TICKET_CATEGORY";
      if(wantsCategory!==(channel.type===ChannelType.GuildCategory))return respond(i,wantsCategory?"Bitte eine Kategorie auswählen.":"Bitte einen Text-Channel auswählen.");
      if(settings)settings.update({key,value:channel.id,actorId:u,actorRoleIds:memberRoleIds(i),actorIsOwner:isOwner(i)});
      else{const previous=config[key]??null;setSetting(db,g,key,channel.id);config[key]=channel.id;audit(db,g,u,"config.changed",key,{setting:key,previous,value:channel.id});}
      if(PANEL_CHANNEL_KEYS.includes(key))await ensurePanels({db,client,config,series,only:[key]}).catch(()=>{});
      return respond(i,`Einstellung ${key} wurde aktualisiert: ${channel}. Die Änderung gilt sofort und bleibt nach einem Neustart erhalten.`);
    }
  }

  /** Postet ein Panel per Befehl. Ist für das Panel noch kein Channel eingestellt, wird es automatisch verwaltet. */
  async function postManagedPanel(i,channelKey,settingKey,payload){
    const sent=await i.channel.send(payload);
    if(!config[channelKey]&&config.DISCORD_GUILD_ID){
      setSetting(db,i.guildId,settingKey,`${sent.channelId}:${sent.id}`);
      if(settings)settings.update({key:channelKey,value:sent.channelId,actorId:i.user.id,actorRoleIds:memberRoleIds(i),actorIsOwner:true});
    }
    return sent;
  }

  async function activityCommand(i,sub,g,u){
    if(!series)return respond(i,"Aktivitäten sind nicht verfügbar.");
    if(sub==="liste"){
      const list=series.list(g);
      const lines=list.map(item=>{const next=item.active?nextOccurrence(item,config.TIMEZONE):null;return `${item.active?"🟢":"⚪"} **${item.name}** · ${describeSchedule(item)}${next?` · nächstes <t:${unix(next.toISOString())}:R>`:""}`;});
      return answer(i,{...fieldsEmbed("📆 Aktivitätenplan",[],(lines.join("\n")||"Keine Aktivitäten angelegt.").slice(0,4000)+"\n\n🟢 aktiv (wird automatisch angekündigt) · ⚪ inaktiv"),ephemeral:true});
    }
    const denied=guard(i,"events","Event-Team");if(denied)return respond(i,denied);
    if(sub==="status"){
      const row=series.setActive({guildId:g,id:i.options.getString("aktivitaet"),actorId:u,active:i.options.getBoolean("aktiv")});
      if(!row)return respond(i,"Aktivität nicht gefunden.");
      await refreshActivityBoard({db,client,config,series});
      return respond(i,`**${row.name}** ist jetzt ${row.active?"aktiv. Termine werden automatisch im Event-Channel angekündigt.":"inaktiv. Es werden keine neuen Termine mehr angekündigt."}`);
    }
    if(sub==="board"){
      await publishActivityBoard({db,channel:i.channel,config,series,actorId:u});
      return respond(i,"Die Aktivitäten-Übersicht wurde veröffentlicht und aktualisiert sich automatisch.");
    }
  }

  async function automodCommand(i,sub,g,u){
    if(sub==="status"){
      const denied=guard(i,"staff","Staff-Rolle");if(denied)return respond(i,denied);
      const rows=db.prepare("SELECT rule,COUNT(*) n FROM automod_actions WHERE guild_id=? AND created_at>=? GROUP BY rule").all(g,new Date(Date.now()-7*86_400_000).toISOString());
      const nativeId=getSetting(db,g,"AUTOMOD_NATIVE_RULE_ID");
      return answer(i,{...fieldsEmbed("🛡️ AutoMod & Raid-Schutz",[
        {name:"Status",value:`Bot-AutoMod: **${config.AUTOMOD_ENABLED?"aktiv":"aus"}**\nNative Discord-Regel: ${nativeId?`eingerichtet (\`${nativeId}\`)`:"nicht eingerichtet"}`},
        {name:"Regeln & Aktionen",value:`Spam (${config.AUTOMOD_SPAM_COUNT} in ${config.AUTOMOD_SPAM_WINDOW_SECONDS}s): ${config.AUTOMOD_SPAM_ACTIONS.join(", ")}\nWiederholung (${config.AUTOMOD_DUPLICATE_COUNT}×): ${config.AUTOMOD_DUPLICATE_ACTIONS.join(", ")}\nLinks (erlaubt: ${config.AUTOMOD_ALLOWED_DOMAINS.join(", ")||"keine"}): ${config.AUTOMOD_LINK_ACTIONS.join(", ")}\nBegriffe (${config.AUTOMOD_BLOCKED_TERMS.length}): ${config.AUTOMOD_TERM_ACTIONS.join(", ")}\nEskalation: ${config.AUTOMOD_ESCALATION_COUNT?`${config.AUTOMOD_ESCALATION_COUNT} Verstöße in ${config.AUTOMOD_ESCALATION_WINDOW_MINUTES} Min. → Timeout ${config.AUTOMOD_TIMEOUT_MINUTES} Min.`:"aus"}`.slice(0,1024)},
        {name:"Raid-Schutz",value:`${config.RAID_JOIN_COUNT} Beitritte in ${config.RAID_WINDOW_SECONDS}s → ${config.RAID_ACTIONS.join(", ")||"nur Protokoll"}\nNachrichtenflut: ${config.FLOOD_MESSAGE_COUNT?`${config.FLOOD_MESSAGE_COUNT} in ${config.FLOOD_WINDOW_SECONDS}s → Staff-Meldung`:"aus"}`},
        {name:"Ausnahmen",value:"Mitglieder mit „Nachrichten verwalten“, alle Staff-Rollen sowie AUTOMOD_EXEMPT_ROLES/AUTOMOD_EXEMPT_CHANNELS."},
        {name:"Maßnahmen (7 Tage)",value:rows.length?rows.map(r=>`${r.rule}: ${r.n}`).join("\n"):"Keine"},
      ]),ephemeral:true});
    }
    if(sub==="sync"){
      const denied=guard(i,"leaders","Leitungsrolle");if(denied)return respond(i,denied);
      const result=await syncNativeAutomod({guild:i.guild,db,config,actorId:u,getSetting,setSetting});
      return respond(i,`Native Discord-AutoMod-Regel wurde ${result.created?"erstellt":"aktualisiert"} (${result.terms} Begriffe). Staff-Rollen sind ausgenommen.`);
    }
  }

  async function button(i) {
    try {
      if(wrongGuild(i))return answer(i,{content:"Der Bot ist für diesen Server nicht freigeschaltet.",ephemeral:true});
      const [kind,action,id,extra,expectedDeduction]=i.customId.split(":");const g=i.guildId,u=i.user.id;
      if(kind==="setup")return answer(i,{content:"Dieser Channel-Einrichtungsbefehl wurde entfernt.",ephemeral:true});
      if(kind==="verify"&&action==="open"){
        const existing=verifications.byUser(i.guildId,i.user.id);
        if(existing)return answer(i,{content:`Du bist bereits verifiziert als **${existing.nickname}**.\nUm deinen Namen zu ändern, nutze „Name ändern“. Die Ingame-ID kann nur das Team zurücksetzen – melde dich dafür per Ticket.`,ephemeral:true});
        return openVerification(i);
      }
      if(kind==="verify"&&action==="rename"){
        if(!verifications.byUser(i.guildId,i.user.id))return answer(i,{content:"Du bist noch nicht verifiziert. Bitte klicke zuerst auf „Verifizieren“.",ephemeral:true});
        return openVerification(i,{rename:true});
      }
      if(kind==="poll")return pollButton(i,action,id,extra);
      if(kind==="absence"&&action==="open"){const gate=memberGate(i);if(gate)return answer(i,{content:"Abmeldungen gibt es nur für Mitglieder der Gambinos-Familie.",ephemeral:true});return openAbsenceModal(i);}
      if(kind==="absence"&&action==="back")return endOwnAbsence(i);
      if(kind==="mod"&&action==="confirm")return confirmModeration(i,id);
      if(kind==="account"){
        const gate=memberGate(i);if(gate)return answer(i,{content:"Das Familienkonto gibt es nur für Mitglieder der Gambinos-Familie.",ephemeral:true});
        if(action==="balance")return answer(i,balanceView(g,u));
        if(action==="history")return answer(i,historyView(g,u));
        if(action==="sanctions")return answer(i,sanctionsView(g,u));
      }
      if(kind==="cancel")return updateMessage(i,{content:"Aktion abgebrochen.",embeds:[],components:[]});
      if(kind==="staffpanel"&&action==="refresh"){
        if(!can(i,"anyStaff"))return answer(i,{content:"Das Dashboard ist nur für Staff.",ephemeral:true});
        return updateMessage(i,buildPanelPayload(db,g));
      }
      if(kind==="konto"&&action==="list"){
        const denied=guard(i,"financeView","Finanzrolle");if(denied)return answer(i,{content:denied,ephemeral:true});
        const {ephemeral,...payload}=payoutListPayload(db,g,config.PAYOUT_MINIMUM_CENTS,Number(id));
        return updateMessage(i,payload);
      }
      if(kind==="payout") return await confirmPayout(i,{previewId:action,userId:id,gross:Number(extra),deduction:Number(expectedDeduction)});
      if(kind==="ticket"){
        const t=db.prepare("SELECT * FROM tickets WHERE id=? AND guild_id=?").get(id,g);
        if(!t)return answer(i,{content:"Ticket nicht gefunden.",ephemeral:true});
        if(action==="closeconfirm"){
          if(t.status!=="open")return answer(i,{content:"Ticket ist bereits geschlossen.",ephemeral:true});
          if(t.user_id!==u&&!ticketAllowed(i,t))return answer(i,{content:"Nur der Ersteller oder Staff kann dieses Ticket schließen.",ephemeral:true});
          return answer(i,{content:"Ticket schließen? Der Verlauf wird gespeichert und der Channel bleibt für Staff einsehbar.",components:[closeConfirmRow(id)],ephemeral:true});
        }
        if(action==="close")return await closeTicket(i,t);
        if(action==="claim"){
          if(!ticketAllowed(i,t))return answer(i,{content:"Dafür brauchst du eine Staff- oder zuständige Ticket-Rolle.",ephemeral:true});
          const row=tickets.claim({guildId:g,ticketId:id,actorId:u});
          if(!row)return answer(i,{content:"Ticket wurde bereits übernommen oder geschlossen.",ephemeral:true});
          return updateMessage(i,{embeds:[ticketCard(ticketCategoryLabel(row.category,config),row.user_id,u)],components:ticketActions(id,true)});
        }
        if(action==="reopen")return reopenTicket(i,t,true);
      }
      if(kind==="giveaway"&&(action==="join"||action==="leave")){
        const result=action==="join"
          ?giveaways.join({guildId:g,giveawayId:id,userId:u,memberRoleIds:memberRoleIds(i)})
          :giveaways.leave({guildId:g,giveawayId:id,userId:u});
        const messages={closed:"Dieses Giveaway ist bereits beendet.",missing_role:`Für dieses Giveaway brauchst du die Rolle <@&${result.giveaway?.required_role_id}>.`,already:"Du bist für dieses Giveaway bereits eingetragen.",not_joined:"Du warst für dieses Giveaway nicht eingetragen."};
        if(messages[result.status])return answer(i,{content:messages[result.status],ephemeral:true});
        await i.message?.edit({embeds:[giveawayCard(result.giveaway,giveaways.entryCount(id))]}).catch(()=>{});
        if(action==="leave")return answer(i,{content:"Du bist vom Giveaway abgemeldet.",ephemeral:true});
        return answer(i,{...fieldsEmbed("🎉 Teilnahme bestätigt",[
          {name:"Preis",value:`**${result.giveaway.prize}**`,inline:true},
          {name:"Endet",value:`<t:${unix(result.giveaway.ends_at)}:R>`,inline:true},
        ],"Du bist jetzt im Lostopf. Viel Glück!"),ephemeral:true});
      }
      if(kind==="event"&&(action==="join"||action==="leave")){
        if(action==="join"){const gate=memberGate(i);if(gate)return answer(i,{content:gate,ephemeral:true});}
        const result=action==="join"?events.join({guildId:g,eventId:id,userId:u}):events.leave({guildId:g,eventId:id,userId:u});
        if(result.status==="closed")return answer(i,{content:"Dieses Event ist nicht mehr offen.",ephemeral:true});
        if(result.status==="full")return answer(i,{content:"Das Event ist bereits voll.",ephemeral:true});
        if(["joined","left"].includes(result.status))await refreshEventPosts({db,client,config,event:result.event,cardOnly:true});
        const titles={joined:"✅ Anmeldung bestätigt",already:"ℹ️ Bereits angemeldet",left:"↩️ Abmeldung bestätigt",not_joined:"ℹ️ Keine aktive Anmeldung"};
        const texts={joined:"Du stehst jetzt auf der Teilnehmerliste.",already:"Deine Anmeldung ist bereits gespeichert.",left:"Du wurdest von der Teilnehmerliste entfernt.",not_joined:"Du warst für dieses Event nicht angemeldet."};
        return answer(i,{...fieldsEmbed(titles[result.status],[
          {name:"Event",value:`**${result.event.name}**`,inline:true},
          {name:"Beginn",value:`<t:${unix(result.event.starts_at)}:F>`,inline:true},
        ],texts[result.status]),ephemeral:true});
      }
      return answer(i,{content:"Diese Schaltfläche ist nicht mehr aktiv.",ephemeral:true});
    } catch(e){if(!(e instanceof FinanceError))console.error("Button action failed:",e);return replyError(i,e);}
  }

  function openVerification(i,{rename=false}={}){
    const previous=verifications.byUser(i.guildId,i.user.id);
    const field=(id,label,max,value,placeholder)=>{const input=new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMinLength(id==="ingame_id"?1:2).setMaxLength(max).setPlaceholder(placeholder);if(value)input.setValue(value);return new ActionRowBuilder().addComponents(input);};
    // Beim Namen ändern bleibt die Ingame-ID fest; nur Vor- und Nachname sind änderbar.
    const modal=new ModalBuilder().setCustomId(rename?"verify:rename-submit":"verify:submit").setTitle(rename?`Namen ändern (ID ${previous.ingame_id})`.slice(0,45):"Gambinos Verifizierung").addComponents(
      ...(rename?[]:[field("ingame_id","Ingame-ID",10,previous?.ingame_id,"z. B. 12345")]),
      field("first_name","Vorname (Ingame)",20,previous?.first_name,"z. B. Tony"),
      field("last_name","Nachname (Ingame)",20,previous?.last_name,"z. B. Gambino"),
    );
    return i.showModal(modal);
  }
  async function submitVerification(i,{rename=false}={}){
    let data;
    const stored=rename?verifications.byUser(i.guildId,i.user.id):null;
    if(rename&&!stored)return answer(i,{content:"Du bist noch nicht verifiziert. Bitte klicke zuerst auf „Verifizieren“.",ephemeral:true});
    try{data=buildVerification({ingameId:rename?stored.ingame_id:i.fields.getTextInputValue("ingame_id"),firstName:i.fields.getTextInputValue("first_name"),lastName:i.fields.getTextInputValue("last_name")});verifications.assertAvailable(i.guildId,i.user.id,data.ingameId);}
    catch(error){return answer(i,{content:error.message,ephemeral:true});}
    const verifiedBefore=verifications.byUser(i.guildId,i.user.id);
    await i.deferReply({flags:MessageFlags.Ephemeral});
    const member=await i.guild.members.fetch(i.user.id).catch(()=>null);
    if(!member)return i.editReply(presentInteractionPayload({content:"Du wurdest auf dem Server nicht gefunden. Bitte versuche es erneut."}));
    const isOwner=i.guild.ownerId===i.user.id;
    let nicknameNote="";
    if(isOwner)nicknameNote=`\n\nℹ️ Als Server-Inhaber kann Discord deinen Namen nicht durch Bots ändern. Bitte setze ihn selbst auf **${data.nickname}**.`;
    else{
      const changed=await member.setNickname(data.nickname,"Gambinos Verifizierung").then(()=>true).catch(error=>{console.warn("Verifizierung: Name nicht änderbar:",error.message);return false;});
      if(!changed){
        audit(db,i.guildId,i.user.id,"member.verification_failed",i.user.id,{name:data.nickname,reason:"Name konnte nicht geändert werden"});
        return i.editReply(presentInteractionPayload({content:"Dein Name konnte nicht geändert werden. Wahrscheinlich steht deine Rolle über der Bot-Rolle oder dem Bot fehlt „Spitznamen verwalten“. Bitte melde dich per Ticket beim Team – deine Angaben wurden nicht gespeichert."}));
      }
    }
    const roleIds=config.ROLE_VERIFIED??[],failedRoles=[];
    for(const roleId of roleIds){if(member.roles.cache.has(roleId))continue;await member.roles.add(roleId,"Gambinos Verifizierung").catch(error=>{failedRoles.push(roleId);console.warn("Verifizierungsrolle nicht vergeben:",error.message);});}
    try{verifications.save({guildId:i.guildId,userId:i.user.id,data,roleResult:roleIds.length?(failedRoles.length?"teilweise fehlgeschlagen":"vergeben"):null});}
    catch(error){return i.editReply(presentInteractionPayload({content:error.message}));}
    const previousName=verifiedBefore?.nickname;
    if(previousName)return i.editReply(presentInteractionPayload({embeds:[embed("✏️ Name geändert",`${previousName===data.nickname?"Dein Name war bereits":"Dein Name lautet jetzt"} **${data.nickname}**.${previousName!==data.nickname?`\nVorher: ${previousName}`:""}${nicknameNote}`)]}));
    return i.editReply(presentInteractionPayload({embeds:[embed("✅ Verifizierung abgeschlossen",`Willkommen, **${data.firstName} ${data.lastName}**!\nDein Name lautet jetzt **${data.nickname}**.${roleIds.length&&!failedRoles.length?"\nDu kannst jetzt im öffentlichen Chat schreiben.":""}${failedRoles.length?"\n\n⚠️ Eine Rolle konnte nicht vergeben werden – das Team wurde im Protokoll informiert.":""}${nicknameNote}`)]}));
  }

  async function confirmPayout(i,{previewId,userId,gross,deduction}){
    if(previewId!==i.message.interaction?.id&&previewId!==i.message.interactionMetadata?.id)return answer(i,{content:"Diese Auszahlungsvorschau ist abgelaufen.",ephemeral:true});
    const denied=guard(i,"finance","Finanzrolle");if(denied)return answer(i,{content:denied,ephemeral:true});
    const key=`payout:${previewId}`;
    const existing=db.prepare("SELECT * FROM transactions WHERE idempotency_key=?").get(key);
    let tx=existing;
    if(!tx){
      try{tx=finance.payout({guildId:i.guildId,userId,actorId:i.user.id,key,minimumCents:config.PAYOUT_MINIMUM_CENTS,expectedGross:gross,expectedDeduction:deduction});}
      catch(error){
        if(error.code==="PREVIEW_MISMATCH")return updateMessage(i,{...fieldsEmbed("⚠️ Vorschau nicht mehr aktuell",[
          {name:"Was ist passiert?",value:"Kontostand oder offene Sanktionen haben sich seit der Vorschau geändert. Es wurde nichts gebucht."},
          {name:"Nächster Schritt",value:"Starte `/konto auszahlen` erneut und prüfe die aktuellen Beträge, bevor du bestätigst."},
        ]),components:[]});
        throw error;
      }
    }
    const remaining=finance.openSanctionTotal(i.guildId,userId);
    await updateMessage(i,{...fieldsEmbed(existing?"ℹ️ Auszahlung bereits verbucht":"✅ Auszahlung verbucht",[
      {name:"Empfänger",value:`<@${userId}>`,inline:true},{name:"Brutto",value:`**${formatMoney(tx.gross_cents)}**`,inline:true},
      {name:"Sanktionsabzug",value:`− ${formatMoney(tx.deduction_cents)}`,inline:true},{name:"Tatsächlich ausgezahlt",value:`**${formatMoney(tx.net_cents)}**`,inline:true},
      {name:"Noch offene Sanktionen",value:formatMoney(remaining),inline:true},
      {name:"Buchungsreferenz",value:`\`${tx.id}\``,inline:true},
    ],existing?"Diese Vorschau wurde bereits bestätigt; es wurde nichts doppelt gebucht.":"Die Buchung und alle zugehörigen Sanktionsverrechnungen wurden gemeinsam gespeichert. Bitte zahle den Nettobetrag jetzt im Spiel aus."),components:[]});
    if(!existing){
      const dm=new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({name:"GAMBINOS  •  FAMILIENKONTO"}).setTitle("💸 Auszahlung verbucht")
        .addFields({name:"Brutto",value:formatMoney(tx.gross_cents),inline:true},{name:"Sanktionsabzug",value:formatMoney(tx.deduction_cents),inline:true},{name:"Auszahlung",value:`**${formatMoney(tx.net_cents)}**`,inline:true},{name:"Referenz",value:`\`${tx.id.slice(0,8)}\``,inline:true})
        .setFooter({text:"GAMBINOS  •  Private Nachricht"}).setTimestamp();
      await client.users.fetch(userId).then(user=>user.send({embeds:[dm]})).catch(()=>{});
    }
  }

  async function closeTicket(i,t){
    if(t.status!=="open")return answer(i,{content:"Ticket ist bereits geschlossen.",ephemeral:true});
    if(t.user_id!==i.user.id&&!ticketAllowed(i,t))return answer(i,{content:"Nur der Ersteller oder Staff kann dieses Ticket schließen.",ephemeral:true});
    await i.deferReply({flags:MessageFlags.Ephemeral});
    const channel=i.channel?.id===t.channel_id?i.channel:await targetChannel(i.guild,t.channel_id);
    let transcript;
    try{transcript=await fetchTranscript(channel,config.TICKET_TRANSCRIPT_LIMIT);}
    catch(error){return i.editReply(presentInteractionPayload({content:`Der Ticketverlauf konnte nicht gesichert werden (${error.message}). Das Ticket bleibt offen; bitte Bot-Berechtigungen prüfen.`}));}
    const row=tickets.close({guildId:i.guildId,ticketId:t.id,actorId:i.user.id,transcript});
    if(!row)return i.editReply(presentInteractionPayload({content:"Ticket wurde bereits geschlossen."}));
    await channel.permissionOverwrites.edit(t.user_id,{SendMessages:false}).catch(()=>{});
    await channel.setName(`closed-${t.category}-${t.user_id.slice(-4)}`.slice(0,90)).catch(()=>{});
    const moved=await moveTicketToClosed(channel,config);
    await refreshTicketMessage(channel,{...row,status:"closed"});
    const text=transcript.map(m=>`[${m.createdAt}] ${m.author}: ${m.content}${m.attachments?.length?` [Anhänge: ${m.attachments.map(a=>a.name).join(", ")}]`:""}`).join("\n");
    await sendTicketLog(i.guild,logEmbed("🔒 Ticket geschlossen",`**Kategorie:** ${ticketCategoryLabel(t.category,config)}\n**Mitglied:** <@${t.user_id}>\n**Bearbeiter:** ${t.claimed_by?`<@${t.claimed_by}>`:"—"}\n**Geschlossen von:** <@${i.user.id}>\n**Eröffnet:** <t:${unix(t.created_at)}:f>\n**Nachrichten im Transkript:** ${transcript.length}`),[new AttachmentBuilder(Buffer.from(text||"(keine Nachrichten)","utf8"),{name:`ticket-${t.id.slice(0,8)}.txt`})]);
    return i.editReply(presentInteractionPayload({content:`Ticket geschlossen. Der Verlauf wurde gespeichert; Staff kann es über die Schaltfläche wieder öffnen.${moved==="failed"?" Hinweis: Der Channel konnte nicht in die Kategorie für geschlossene Tickets verschoben werden (voll oder fehlende Rechte).":""}`}));
  }

  async function select(i){
    try{
      if(wrongGuild(i))return answer(i,{content:"Der Bot ist für diesen Server nicht freigeschaltet.",ephemeral:true});
      if(i.customId==="staffpanel:view")return showView(i,i.values[0]);
      if(i.customId.startsWith("application:assignrole:"))return await assignRoleSelect(i);
      if(i.customId!=="ticket:create")return answer(i,{content:"Dieses Menü ist nicht mehr aktiv.",ephemeral:true});
      return await createTicket(i);
    }catch(e){console.error("Select action failed:",e);return replyError(i,e);}
  }
  async function assignRoleSelect(i){
    const applicationId=i.customId.split(":")[2],roleId=i.values[0];
    const denied=guard(i,"leaders","Leitungsrolle");if(denied)return answer(i,{content:denied,ephemeral:true});
    if(roleId==="none"){audit(db,i.guildId,i.user.id,"application.role_skipped",applicationId,{});return updateMessage(i,{content:"Es wurde keine Rolle vergeben.",components:[]});}
    const result=await assignRankRole({db,config,guild:i.guild,applicationId,roleId,actorId:i.user.id});
    return updateMessage(i,{content:result.message,components:[]});
  }
  async function createTicket(i){
    const category=i.values[0],categoryDef=config.TICKET_CATEGORIES_JSON.find(c=>c.id===category);
    if(!categoryDef)return answer(i,{content:"Diese Ticket-Kategorie ist nicht mehr konfiguriert.",ephemeral:true});
    const open=db.prepare("SELECT channel_id FROM tickets WHERE guild_id=? AND user_id=? AND status='open'").all(i.guildId,i.user.id);
    if(open.length>=config.TICKET_MAX_OPEN_PER_USER)return answer(i,{content:`Du hast bereits die maximale Zahl offener Tickets: ${open.map(t=>`<#${t.channel_id}>`).join(", ")}`,ephemeral:true});
    const last=db.prepare("SELECT created_at FROM tickets WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1").get(i.guildId,i.user.id);
    if(last&&Date.now()-new Date(last.created_at).getTime()<config.TICKET_COOLDOWN_SECONDS*1000)return answer(i,{content:"Bitte warte kurz, bevor du ein weiteres Ticket öffnest.",ephemeral:true});
    await i.deferReply({flags:MessageFlags.Ephemeral});
    const staffRoles=[...new Set([...groups.staff,...categoryDef.roleIds])];
    const allow=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles];
    let channel;
    try{
      channel=await i.guild.channels.create({name:`ticket-${category}-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g,"-").slice(0,90),type:ChannelType.GuildText,parent:config.CHANNEL_TICKET_CATEGORY||undefined,permissionOverwrites:[{id:i.guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},{id:i.user.id,allow},{id:client.user.id,allow:[...allow,PermissionFlagsBits.ManageChannels]},...staffRoles.map(id=>({id,allow}))]});
    }catch(error){console.error("Ticket-Channel konnte nicht erstellt werden:",error.message);return i.editReply(presentInteractionPayload({content:"Ticket konnte nicht angelegt werden. Prüfe die Bot-Berechtigungen (Channels verwalten) und die Ticket-Kategorie."}));}
    const id=randomUUID();
    try{
      db.transaction(()=>{
        db.prepare("INSERT INTO tickets(id,guild_id,channel_id,user_id,category,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)").run(id,i.guildId,channel.id,i.user.id,category,isoNow(),isoNow());
        audit(db,i.guildId,i.user.id,"ticket.created",id,{category,channelId:channel.id});
      })();
    }catch(error){await channel.delete("Ticket konnte nicht gespeichert werden").catch(()=>{});throw error;}
    const ticketMessage=await channel.send({content:`<@${i.user.id}> ${staffRoles.map(r=>`<@&${r}>`).join(" ")}`,embeds:[ticketCard(categoryDef.label,i.user.id)],components:ticketActions(id)}).catch(()=>null);
    if(ticketMessage)db.prepare("UPDATE tickets SET message_id=? WHERE id=?").run(ticketMessage.id,id);
    await sendTicketLog(i.guild,logEmbed("🎫 Neues Support-Ticket",`**Kategorie:** ${categoryDef.label}\n**Mitglied:** <@${i.user.id}>\n**Ticket:** <#${channel.id}>`));
    return i.editReply(presentInteractionPayload({content:`Dein Ticket wurde erstellt: ${channel}`}));
  }

  async function modal(i){
    try{
      if(wrongGuild(i))return answer(i,{content:"Der Bot ist für diesen Server nicht freigeschaltet.",ephemeral:true});
      if(i.customId.startsWith("application:reject-reason:")){
        const denied=guard(i,"reviewers","Reviewer-Rolle");if(denied)return answer(i,{content:denied,ephemeral:true});
        const id=i.customId.split(":")[2],reason=i.fields.getTextInputValue("reason").trim();
        if(reason.length<3)return answer(i,{content:"Bitte beschreibe den Ablehnungsgrund etwas genauer.",ephemeral:true});
        const result=await decideApplication(i,{id,status:"rejected",note:reason});
        if(!result)return answer(i,{content:"Dieser Antrag wurde bereits entschieden oder nicht gefunden.",ephemeral:true});
        if(i.message)await i.message.edit({...buildApplicationReviewPayload(result.row.kind,result.row.user_id,JSON.parse(result.row.answers),"rejected",reason),components:[]}).catch(()=>{});
        return answer(i,{content:`Antrag abgelehnt. Der Grund wurde gespeichert${result.dmSent?" und dem Antragsteller gesendet":"; die private Nachricht konnte nicht zugestellt werden"}.`,ephemeral:true});
      }
      if(i.customId.startsWith("application:note-submit:")){
        const denied=guard(i,"reviewers","Reviewer-Rolle");if(denied)return answer(i,{content:denied,ephemeral:true});
        const note=i.fields.getTextInputValue("note");
        const result=applications.addNote({guildId:i.guildId,applicationId:i.customId.split(":")[2],authorId:i.user.id,note});
        await postApplicationNote(i.guild,result.application,i.user.id,note.trim());
        return answer(i,{content:"Notiz wurde gespeichert. Sie ist nur für das Team sichtbar.",ephemeral:true});
      }
      if(i.customId==="absence:submit")return await createAbsence(i,{from:i.fields.getTextInputValue("from"),until:i.fields.getTextInputValue("until"),reason:i.fields.getTextInputValue("reason")});
      if(i.customId==="verify:submit")return await submitVerification(i);
      if(i.customId==="verify:rename-submit")return await submitVerification(i,{rename:true});
      if(!i.customId.startsWith("application:submit:"))return;
      const kind=i.customId.split(":")[2];if(!APPLICATION_KINDS.includes(kind))return answer(i,{content:"Dieser Antragstyp ist ungültig.",ephemeral:true});
      const answers=Object.fromEntries(applicationQuestions(kind).map(question=>[question.id,i.fields.getTextInputValue(question.id)??""]));
      const id=randomUUID(),ts=isoNow();
      const inserted=db.transaction(()=>{
        const open=db.prepare("SELECT id FROM applications WHERE guild_id=? AND user_id=? AND kind=? AND status IN ('open','review')").get(i.guildId,i.user.id,kind);
        if(open)return open;
        db.prepare("INSERT INTO applications(id,guild_id,user_id,kind,answers,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)").run(id,i.guildId,i.user.id,kind,JSON.stringify(answers),ts,ts);
        const previous=db.prepare("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND user_id=? AND kind=? AND id<>?").get(i.guildId,i.user.id,kind,id).n;
        audit(db,i.guildId,i.user.id,"application.submitted",id,{kind,applicantId:i.user.id,previousSubmissions:previous});
        return null;
      })();
      if(inserted)return answer(i,{content:`Du hast bereits einen offenen Antrag dieses Typs (Referenz \`${inserted.id.slice(0,8)}\`). Ziehe ihn mit \`/antrag status\` zurück, wenn du neu einreichen möchtest.`,ephemeral:true});
      const channel=await applicationReviewChannel(i.guild,config,kind);
      if(!channel)return answer(i,{content:`Dein Antrag wurde gespeichert, aber der Staff-Channel für ${kind==="rang"?"Rang-Anträge":"Bewerbungen"} wurde nicht gefunden. Bitte melde es der Leitung. Referenz: \`${id}\``,ephemeral:true});
      const previous=db.prepare("SELECT COUNT(*) n FROM applications WHERE guild_id=? AND user_id=? AND kind=? AND id<>?").get(i.guildId,i.user.id,kind,id).n;
      const payload=buildApplicationReviewPayload(kind,i.user.id,answers);
      if(previous)payload.embeds[0].addFields({name:"ℹ️ Hinweis",value:`Neue Einreichung · ${previous} frühere(r) Antrag/Anträge dieses Typs`});
      const msg=await channel.send({...payload,components:applicationReviewComponents(id,"open")});
      db.prepare("UPDATE applications SET message_id=? WHERE id=?").run(msg.id,id);
      const dmSent=await i.user.send(applicationSubmittedDm({kind,applicationId:id})).then(()=>true).catch(()=>false);
      return answer(i,{...fieldsEmbed("📨 Antrag eingereicht",[
        {name:"Antrag",value:kind==="rang"?"🏅 Rang-Antrag":"🤝 Familienbewerbung",inline:true},
        {name:"Status",value:"✅ An das zuständige Team weitergeleitet",inline:true},
        {name:"Referenz",value:`\`${id}\``,inline:false},
        {name:"Private Nachricht",value:dmSent?"Eine Eingangsbestätigung wurde dir per DM geschickt.":"Deine Discord-DMs sind geschlossen. Der Antrag ist trotzdem sicher eingegangen.",inline:false},
      ],"Du wirst privat benachrichtigt, sobald die Prüfung beginnt oder das Team entschieden hat."),ephemeral:true});
    }catch(e){console.error("Modal action failed:",e);return replyError(i,e);}
  }

  async function reviewButton(i){
    try{
      if(wrongGuild(i))return answer(i,{content:"Der Bot ist für diesen Server nicht freigeschaltet.",ephemeral:true});
      const [,action,id]=i.customId.split(":");
      if(action==="open"){
        if(!APPLICATION_KINDS.includes(id))return answer(i,{content:"Dieser Antragstyp ist ungültig.",ephemeral:true});
        if(id==="rang"){const gate=memberGate(i);if(gate)return answer(i,{content:gate,ephemeral:true});}
        return i.showModal(applicationModal(id));
      }
      const denied=guard(i,"reviewers","Reviewer-Rolle");if(denied)return answer(i,{content:denied,ephemeral:true});
      const row=db.prepare("SELECT * FROM applications WHERE id=? AND guild_id=?").get(id,i.guildId);
      if(!row)return answer(i,{content:"Antrag nicht gefunden.",ephemeral:true});
      if(action==="note"){
        const noteModal=new ModalBuilder().setCustomId(`application:note-submit:${id}`).setTitle("Interne Notiz");
        noteModal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("note").setLabel("Notiz (nur für das Team sichtbar)").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(2).setMaxLength(1000)));
        return i.showModal(noteModal);
      }
      if(!["open","review"].includes(row.status))return answer(i,{content:"Dieser Antrag wurde bereits abgeschlossen.",ephemeral:true});
      if(action==="review"){
        if(row.status==="review"){
          await i.message.edit({...buildApplicationReviewPayload(row.kind,row.user_id,JSON.parse(row.answers),"review","",row.reviewer_id),components:applicationReviewComponents(id,"review")}).catch(()=>{});
          return answer(i,{content:`Dieser Antrag wird bereits von <@${row.reviewer_id}> bearbeitet.`,ephemeral:true});
        }
        const claimed=db.transaction(()=>{
          const changed=db.prepare("UPDATE applications SET status='review',reviewer_id=?,updated_at=? WHERE id=? AND guild_id=? AND status='open' RETURNING user_id,kind,answers,message_id").get(i.user.id,isoNow(),id,i.guildId);
          if(changed)audit(db,i.guildId,i.user.id,"application.claimed",id,{kind:changed.kind,applicantId:changed.user_id,reviewerId:i.user.id});
          return changed;
        })();
        if(!claimed)return answer(i,{content:"Der Antrag wurde gerade bereits übernommen oder entschieden. Bitte aktualisiere die Ansicht.",ephemeral:true});
        await updateMessage(i,{...buildApplicationReviewPayload(claimed.kind,claimed.user_id,JSON.parse(claimed.answers),"review","",i.user.id),components:applicationReviewComponents(id,"review")});
        await client.users.fetch(claimed.user_id).then(user=>user.send(applicationInReviewDm({kind:claimed.kind,applicationId:id,reviewerId:i.user.id}))).catch(()=>{});
        return;
      }
      if(action==="reject"){
        const rejectModal=new ModalBuilder().setCustomId(`application:reject-reason:${id}`).setTitle("Antrag mit Grund ablehnen");
        rejectModal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Ablehnungsgrund für den Antragsteller").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(1000)));
        return i.showModal(rejectModal);
      }
      if(action!=="accept")return answer(i,{content:"Unbekannte Antragsaktion.",ephemeral:true});
      const result=await decideApplication(i,{id,status:"accepted",note:""});
      if(!result)return answer(i,{content:"Dieser Antrag wurde gerade bereits entschieden.",ephemeral:true});
      await updateMessage(i,{...buildApplicationReviewPayload(result.row.kind,result.row.user_id,JSON.parse(result.row.answers),"accepted"),components:[]});
      const offer=roleAssignmentOffer(i,result.row);
      if(offer)await followUp(i,offer).catch(()=>{});
    }catch(e){console.error("Review action failed:",e);return replyError(i,e);}
  }

  async function eventButton(i){const [,action]=i.customId.split(":");if(action==="join"||action==="leave")return button(i);return answer(i,{content:"Unbekannte Event-Aktion.",ephemeral:true});}

  return {command,autocomplete,button,select,modal,reviewButton,eventButton};
}

/** Lädt bis zu `limit` Nachrichten (seitenweise à 100) chronologisch. Wirft bei fehlendem Zugriff. */
export async function fetchTranscript(channel,limit=500){
  if(!channel?.messages)throw new Error("Ticket-Channel nicht erreichbar");
  const collected=[];let before;
  while(collected.length<limit){
    const batch=await channel.messages.fetch({limit:Math.min(100,limit-collected.length),...(before?{before}:{})});
    const items=[...batch.values()];
    if(!items.length)break;
    collected.push(...items);
    before=items.reduce((oldest,m)=>m.createdTimestamp<oldest.createdTimestamp?m:oldest).id;
    if(items.length<100)break;
  }
  return collected.sort((a,b)=>a.createdTimestamp-b.createdTimestamp).map(m=>({id:m.id,author:m.author?.tag??"gelöscht",userId:m.author?.id??null,createdAt:m.createdAt?.toISOString(),content:m.content,attachments:[...(m.attachments?.values?.()??[])].map(a=>({name:a.name,url:a.url}))}));
}

export function payoutListPayload(db,guildId,minimumCents,page=1){
  const total=db.prepare("SELECT COUNT(*) n FROM accounts WHERE guild_id=?").get(guildId).n;
  const pageSize=10,pageCount=Math.max(1,Math.ceil(total/pageSize)),current=Math.min(pageCount,Math.max(1,Number.isInteger(page)?page:1)),offset=(current-1)*pageSize;
  const rows=db.prepare("SELECT a.user_id,a.balance_cents,COALESCE((SELECT SUM(remaining_cents) FROM sanctions s WHERE s.guild_id=a.guild_id AND s.user_id=a.user_id AND s.status IN ('open','partial')),0) AS open_cents FROM accounts a WHERE a.guild_id=? ORDER BY a.balance_cents DESC,a.user_id LIMIT ? OFFSET ?").all(guildId,pageSize,offset);
  const fields=rows.length?[{name:`Mitglieder ${offset+1}–${offset+rows.length}`,value:rows.map((row,index)=>{
    const eligibility=minimumCents==null?"":row.balance_cents>=minimumCents?" · ✅ auszahlbar":" · ⏳ Mindestbetrag fehlt";
    const deduction=Math.min(row.balance_cents,row.open_cents);
    return `**${offset+index+1}.** <@${row.user_id}> · **${formatMoney(row.balance_cents)}**${deduction?` · Abzug −${formatMoney(deduction)} · Netto ${formatMoney(row.balance_cents-deduction)}`:""}${eligibility}`;
  }).join("\n").slice(0,1024),inline:false}]:[];
  const sums=db.prepare("SELECT COALESCE(SUM(balance_cents),0) n FROM accounts WHERE guild_id=?").get(guildId).n;
  const description=total===0?"Es sind noch keine Familienkonten vorhanden.":`${total} Familienkonten · Seite ${current} von ${pageCount}\nAusstehendes Familienguthaben gesamt: ${formatMoney(sums)}${minimumCents==null?"":"\nAuszahlungsgrenze: "+formatMoney(minimumCents)}`;
  const payload=fieldsEmbed("📋 Familien-Auszahlungsliste",fields,description);
  if(pageCount>1)payload.components=[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`konto:list:${current-1}`).setLabel("← Zurück").setStyle(ButtonStyle.Secondary).setDisabled(current<=1),
    new ButtonBuilder().setCustomId(`konto:list:${current+1}`).setLabel("Weiter →").setStyle(ButtonStyle.Secondary).setDisabled(current>=pageCount),
  )];
  payload.ephemeral=true;
  return payload;
}

export function parseEventDate(value,timezone="Europe/Vienna"){
  const text=String(value??"").trim();
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)){
    const date=new Date(text);return Number.isFinite(date.getTime())?date:null;
  }
  const match=/^(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s+(\d{1,2}):(\d{2})$/.exec(text);
  if(!match)return null;
  const [,dayText,monthText,yearText,hourText,minuteText]=match;
  const desired={year:Number(yearText),month:Number(monthText),day:Number(dayText),hour:Number(hourText),minute:Number(minuteText)};
  const naive=Date.UTC(desired.year,desired.month-1,desired.day,desired.hour,desired.minute);
  const check=new Date(naive);
  if(check.getUTCFullYear()!==desired.year||check.getUTCMonth()+1!==desired.month||check.getUTCDate()!==desired.day||desired.hour>23||desired.minute>59)return null;
  let formatter;
  try{formatter=new Intl.DateTimeFormat("en-GB",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});}catch{return null;}
  const partsAt=epoch=>Object.fromEntries(formatter.formatToParts(new Date(epoch)).filter(part=>part.type!=="literal").map(part=>[part.type,Number(part.value)]));
  const wanted=[desired.year,desired.month,desired.day,desired.hour,desired.minute].join(":");
  const offsets=[naive-36*60*60_000,naive,naive+36*60*60_000].map(epoch=>{const p=partsAt(epoch);return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-epoch;});
  const candidates=[...new Set(offsets)].map(offset=>naive-offset).filter(epoch=>{const p=partsAt(epoch);return [p.year,p.month,p.day,p.hour,p.minute].join(":")===wanted;}).sort((a,b)=>a-b);
  return candidates.length?new Date(candidates[0]):null;
}
export function eventButtons(id){return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`event:join:${id}`).setLabel("Teilnehmen").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`event:leave:${id}`).setLabel("Abmelden").setStyle(ButtonStyle.Secondary));}
export function eventEmbed(e,count,participants=[]){
  const list=participants.length?participants.slice(0,30).map(x=>`<@${x.user_id}>`).join(", ")+(participants.length>30?`, +${participants.length-30} weitere`:""):"Noch keine Anmeldungen";
  return embed(`📅 ${e.name}`.slice(0,256),e.description||"Familien-Event").addFields(
    {name:"🕒 Wann",value:`<t:${unix(e.starts_at)}:F> · <t:${unix(e.starts_at)}:R>`,inline:true},
    {name:"📍 Treffpunkt",value:e.location||"Noch nicht angegeben",inline:true},
    {name:"👤 Veranstalter",value:`<@${e.host_id}>`,inline:true},
    {name:"🧰 Ausrüstung",value:e.equipment||"Keine besondere Ausrüstung angegeben",inline:true},
    {name:"ℹ️ Hinweise",value:e.notes||"Keine weiteren Hinweise",inline:true},
    {name:`🙋 Teilnehmende (${count}${e.max_participants?`/${e.max_participants}`:""})`,value:list.slice(0,1024),inline:false},
  );
}
async function targetChannel(guild,id){return id?guild.channels.fetch(id).catch(()=>null):null;}
export function applicationReviewChannelKey(kind){return kind==="rang"?"CHANNEL_RANK_REVIEW":"CHANNEL_APPLICATION_REVIEW";}
async function applicationReviewChannel(guild,config,kind){
  const channelName=kind==="rang"?"rang-anträge":"bewerbungen";
  const configured=await targetChannel(guild,config[applicationReviewChannelKey(kind)]);
  if(configured)return configured;
  const channels=await guild.channels.fetch().catch(()=>null);
  return channels?.find(channel=>channel?.isTextBased()&&channel.name.includes(channelName)&&channel.parent?.name.toLowerCase().includes("staff"))??null;
}

export async function handleComponent(i,handlers){if(i.isButton()){if(i.customId.startsWith("application:"))return handlers.reviewButton(i);if(i.customId.startsWith("event:"))return handlers.eventButton(i);return handlers.button(i);}if(i.isStringSelectMenu())return handlers.select(i);if(i.isModalSubmit())return handlers.modal(i);}
