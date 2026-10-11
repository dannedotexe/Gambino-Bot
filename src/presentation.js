import { EmbedBuilder } from "discord.js";

export const BRAND_COLOR = 0xd4af37;
const COLORS = { success: 0x2ecc71, error: 0xe74c3c, warning: 0xf39c12, info: BRAND_COLOR };
const shortReference = value => String(value).slice(0, 8).toUpperCase();

function responseTone(text) {
  if (/^(Dafür brauchst du|Du hast bereits|Bitte |Nur |Dieser |Diese |Das Event ist bereits|Offener .* nicht|Keine |Nicht |Ungültig|Unbekannter|Ticket konnte|Ticket wurde bereits|Der Bot ist|Aktion fehlgeschlagen|Diese Aktion|Kontostand oder Sanktionen|Es ist ein Fehler|Für diese Sanktion|Von dieser Sanktion|Das Guthaben liegt)/i.test(text)) return "error";
  if (/(wurde(n)? (erstellt|gespeichert|verbucht|aktualisiert|angenommen|abgelehnt|abgeschlossen|gestartet|beendet|abgesagt|zurückgezogen|erstattet|aufgehoben|wieder geöffnet)|\b(erstellt|aktualisiert|abgebrochen|erfolgreich)\b|Du bist (angemeldet|abgemeldet)|Du nimmst am Giveaway teil|Pong!|Ticket wird von)/i.test(text)) return "success";
  return "info";
}

function responseTitle(text, tone) {
  const rules = [
    [/^Pong!/i, "🏓 Verbindung aktiv"],
    [/Ticket.*(erstellt|angelegt)/i, "🎫 Ticket eröffnet"],
    [/Ticket.*übernommen/i, "👤 Ticket übernommen"],
    [/Ticket.*(geschlossen|wieder geöffnet)/i, "🎫 Ticket aktualisiert"],
    [/Support-Panel.*veröffentlicht/i, "🎫 Support-Panel veröffentlicht"],
    [/Antrag.*(gespeichert|eingereicht)/i, "📨 Antrag eingereicht"],
    [/Antrag.*(angenommen|abgelehnt|zurückgezogen)/i, "📨 Antrag aktualisiert"],
    [/Event.*(erstellt|aktualisiert|beendet|abgesagt)/i, "📅 Event aktualisiert"],
    [/Giveaway.*(gestartet|beendet|abgebrochen)/i, "🎉 Giveaway aktualisiert"],
    [/Sanktion.*(gespeichert|vorgemerkt|aufgehoben|erstattet)/i, "⚖️ Sanktion aktualisiert"],
    [/Gutschrift.*(verbucht|gespeichert)/i, "💰 Gutschrift verbucht"],
    [/Auszahlung.*(verbucht|abgeschlossen)/i, "💸 Auszahlung abgeschlossen"],
    [/bereits angemeldet|Du bist angemeldet|Du bist abgemeldet/i, "📅 Event-Teilnahme"],
    [/Du nimmst am Giveaway teil/i, "🎉 Teilnahme bestätigt"],
    [/^Dafür brauchst du|^Nur |^Bitte |^Dieser |^Diese |^Das Event ist bereits|^Offener |^Keine |^Nicht |^Ungültig|^Unbekannter|^Der Bot ist/i, "⚠️ Bitte beachten"],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1]
    ?? (tone === "success" ? "✅ Vorgang abgeschlossen" : tone === "error" ? "⚠️ Aktion nicht möglich" : "ℹ️ Gambinos Bot");
}

export function brandedTextEmbed(text, title = null) {
  const tone = responseTone(text);
  return new EmbedBuilder()
    .setColor(COLORS[tone])
    .setAuthor({ name: "GAMBINOS  •  FAMILIENVERWALTUNG" })
    .setTitle(title ?? responseTitle(String(text), tone))
    .setDescription(String(text).slice(0, 4096))
    .setFooter({ text: "GAMBINOS  •  Grand-RP Familienserver" })
    .setTimestamp();
}

export function presentInteractionPayload(options) {
  if (typeof options.content !== "string" || options.embeds?.length) return options;
  const { content, ...rest } = options;
  return { ...rest, embeds: [brandedTextEmbed(content)] };
}

export function applicationDecisionDm({ kind, status, applicationId, reason = "" }) {
  const accepted = status === "accepted";
  const label = kind === "rang" ? "Rang-Antrag" : "Familienbewerbung";
  const embed = new EmbedBuilder()
    .setColor(accepted ? COLORS.success : COLORS.error)
    .setAuthor({ name: "GAMBINOS  •  FAMILIENBÜRO" })
    .setTitle(accepted ? "✅ Antrag angenommen" : "❌ Antrag abgelehnt")
    .setDescription(accepted
      ? `Dein **${label}** wurde angenommen. Das Team meldet sich bei dir, falls noch etwas zu tun ist.`
      : `Dein **${label}** wurde geprüft und abgelehnt.`)
    .addFields({ name: "Referenz", value: `\`${shortReference(applicationId)}\``, inline: true });
  if (!accepted) embed.addFields({ name: "Begründung", value: String(reason || "Kein Grund angegeben.").slice(0, 1024), inline: false });
  return { embeds: [embed.setFooter({ text: "GAMBINOS  •  Private Nachricht" }).setTimestamp()] };
}

export function applicationSubmittedDm({ kind, applicationId }) {
  const label = kind === "rang" ? "Dein Rang-Antrag" : "Deine Familienbewerbung";
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({ name: "GAMBINOS  •  FAMILIENBÜRO" })
    .setTitle("📨 Antrag sicher eingegangen")
    .setDescription(`${label} wurde an das zuständige Team weitergeleitet. Du erhältst hier eine Nachricht, sobald die Prüfung beginnt oder eine Entscheidung getroffen wurde.`)
    .addFields({ name: "Referenz", value: `\`${shortReference(applicationId)}\``, inline: true })
    .setFooter({ text: "GAMBINOS  •  Bitte antworte nicht auf diese Nachricht" })
    .setTimestamp();
  return { embeds: [embed] };
}

export function applicationInReviewDm({ kind, applicationId, reviewerId }) {
  const label = kind === "rang" ? "Dein Rang-Antrag" : "Deine Familienbewerbung";
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({ name: "GAMBINOS  •  FAMILIENBÜRO" })
    .setTitle("🔎 Antrag wird bearbeitet")
    .setDescription(`${label} wurde von unserem Team übernommen und ist jetzt in Bearbeitung. Wir prüfen deine Angaben und melden uns, sobald es Neuigkeiten gibt.`)
    .addFields({ name: "Referenz", value: `\`${shortReference(applicationId)}\``, inline: true });
  if (reviewerId) embed.addFields({ name: "Zuständig", value: `<@${reviewerId}>`, inline: true });
  return { embeds: [embed.setFooter({ text: "GAMBINOS  •  Wir halten dich auf dem Laufenden" }).setTimestamp()] };
}

const ACTIONS = {
  "application.submitted": "Neuer Antrag eingereicht",
  "application.claimed": "Antrag zur Bearbeitung übernommen",
  "application.accepted": "Antrag angenommen",
  "application.rejected": "Antrag abgelehnt",
  "application.withdrawn": "Antrag zurückgezogen",
  "ticket.created": "Ticket eröffnet",
  "ticket.claimed": "Ticket übernommen",
  "ticket.closed": "Ticket geschlossen",
  "ticket.reopened": "Ticket wieder geöffnet",
  "ticket.channel_missing": "Ticket-Channel nicht gefunden",
  "event.updated": "Event geändert",
  "event.attendance": "Anwesenheit erfasst",
  "event.ended": "Event abgeschlossen",
  "event.cancelled": "Event abgesagt",
  "giveaway.ended": "Giveaway ausgelost",
  "finance.credit": "Familienguthaben gutgeschrieben",
  "finance.payout": "Familienauszahlung verbucht",
  "sanction.created": "Sanktion vorgemerkt",
  "sanction.applied": "Sanktion bei Auszahlung verrechnet",
  "sanction.refunded": "Sanktionsabzug erstattet",
  "sanction.void": "Sanktion aufgehoben",
  "automod.action": "AutoMod-Maßnahme ausgeführt",
};

const ACTION_EMOJI = {
  "application.submitted": "📨", "application.claimed": "🔎", "application.accepted": "✅", "application.rejected": "❌", "application.withdrawn": "↩️",
  "ticket.created": "🎫", "ticket.claimed": "👤", "ticket.closed": "🔒", "ticket.reopened": "🔓", "ticket.channel_missing": "⚠️",
  "event.updated": "📅", "event.attendance": "📝", "event.ended": "🏁", "event.cancelled": "❌", "giveaway.ended": "🎉",
  "finance.credit": "💰", "finance.payout": "💸", "sanction.created": "⚖️", "sanction.applied": "➖", "sanction.refunded": "↩️", "sanction.void": "🚫", "automod.action": "🛡️",
};

const DETAIL_NAMES = {
  category: "Kategorie", kind: "Antragstyp", reason: "Grund", note: "Kommentar", caseRef: "Fallbezug",
  rule: "Regel", action: "Maßnahme", entries: "Teilnahmen", transcriptMessages: "Nachrichten im Transkript",
  cents: "Betrag", grossCents: "Brutto", deductionCents: "Sanktionsabzug", netCents: "Netto ausgezahlt",
  remainingCents: "Offener Rest", startsAt: "Beginn", name: "Name", status: "Status", channelId: "Channel",
  transactionId: "Buchungs-ID", sanctionId: "Sanktions-ID", payoutId: "Auszahlungs-ID", eventId: "Event-ID", ticketId: "Ticket-ID",
};

function formatDetail(key, value) {
  if (value == null || value === "") return "—";
  if (["cents", "grossCents", "deductionCents", "netCents", "remainingCents"].includes(key) && Number.isFinite(Number(value))) {
    return `${(Number(value) / 100).toLocaleString("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  }
  if (key === "channelId") return `<#${value}>`;
  if (key === "kind") return value === "rang" ? "Rang-Antrag" : value === "bewerbung" ? "Familienbewerbung" : String(value).slice(0, 1000);
  if (key === "category") return ({ support: "Support", beschwerde: "Beschwerde", leitung: "Leitung" })[value] ?? String(value).slice(0, 1000);
  if (key === "rule") return ({ message_spam: "Nachrichten-Spam", blocked_term: "Gesperrter Begriff", unapproved_link: "Nicht erlaubter Link", join_raid: "Möglicher Join-Raid" })[value] ?? String(value).slice(0, 1000);
  if (key === "status") return ({ present: "Anwesend", absent: "Abwesend", signed_up: "Angemeldet", left: "Abgemeldet" })[value] ?? value;
  if (key === "startsAt") { const time = Math.floor(new Date(value).getTime() / 1000); return Number.isFinite(time) ? `<t:${time}:F>` : String(value); }
  if (["transactionId", "sanctionId", "payoutId", "eventId", "ticketId"].includes(key)) return `\`${String(value).slice(0, 12)}\``;
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ").slice(0, 1000) : "Keine";
  if (typeof value === "object") return JSON.stringify(value).slice(0, 1000);
  if (key === "action" && value === "message_deleted") return "Nachricht gelöscht";
  return String(value).slice(0, 1000);
}

export function auditLogPayload(item) {
  const details = JSON.parse(item.details || "{}");
  const action = item.action;
  const color = action.startsWith("automod.") || action.includes("rejected") || action.includes("void") ? COLORS.error
    : action.startsWith("finance.") || action.includes("accepted") || action.includes("refunded") ? COLORS.success
      : action.startsWith("sanction.") ? COLORS.warning : BRAND_COLOR;
  const targetIsPerson = ["application.submitted", "application.claimed", "application.accepted", "application.rejected", "application.withdrawn"].includes(action)
    ? false
    : !["ticket.created", "giveaway.ended"].includes(action) && Boolean(item.target_id);
  const target = !item.target_id ? "—"
    : targetIsPerson ? `<@${item.target_id}>`
      : `\`${String(item.target_id).slice(0, 12)}\``;
  const fields = [
    { name: "👤 Verantwortlich", value: `<@${item.actor_id}>`, inline: true },
    { name: targetIsPerson ? "🎯 Betroffenes Mitglied" : "🧾 Referenz", value: target, inline: true },
  ];
  for (const [key, value] of Object.entries(details)) {
    if (key === "winnerIds") { fields.push({ name: "Gewinner", value: value.length ? value.map(id => `<@${id}>`).join(", ").slice(0, 1000) : "Keine", inline: false }); continue; }
    fields.push({ name: DETAIL_NAMES[key] ?? "Weitere Angabe", value: formatDetail(key, value), inline: ["kind", "category", "entries", "cents", "status"].includes(key) });
  }
  fields.push({ name: "🕒 Zeitpunkt", value: `<t:${Math.floor(new Date(item.created_at).getTime() / 1000)}:f>`, inline: false });
  const title = ACTIONS[action] ?? `Serveraktion · ${String(action).split(".").at(-1).replaceAll("_", " ")}`;
  return { embeds: [new EmbedBuilder().setColor(color).setAuthor({ name: "GAMBINOS  •  AKTIONS-PROTOKOLL" })
    .setTitle(`${ACTION_EMOJI[action] ?? "📌"} ${title}`)
    .addFields(fields.slice(0, 25)).setFooter({ text: "GAMBINOS  •  Nachvollziehbar protokolliert" })
    .setTimestamp(new Date(item.created_at))] };
}

export function logEmbed(title, description, tone = "info") {
  return new EmbedBuilder().setColor(COLORS[tone] ?? BRAND_COLOR)
    .setAuthor({ name: "GAMBINOS  •  SERVER-LOG" }).setTitle(title)
    .setDescription(String(description).slice(0, 4096)).setFooter({ text: "GAMBINOS  •  Serverprotokoll" }).setTimestamp();
}
