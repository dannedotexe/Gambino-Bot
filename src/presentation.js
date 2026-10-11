import { EmbedBuilder } from "discord.js";

export const BRAND_COLOR = 0xd4af37;
const COLORS = { success: 0x2ecc71, error: 0xe74c3c, warning: 0xf39c12, info: BRAND_COLOR };

function responseTone(text) {
  if (/^(Dafür brauchst du|Du hast bereits|Bitte |Nur |Dieser |Diese |Das Event ist bereits|Offener .* nicht|Keine |Nicht |Ungültig|Unbekannter|Ticket konnte|Der Bot ist|Aktion fehlgeschlagen|Diese Aktion)/i.test(text)) return "error";
  if (/(wurde(n)? (erstellt|gespeichert|verbucht|aktualisiert|angenommen|abgelehnt|abgeschlossen|gestartet|beendet|abgesagt|zurückgezogen)|Du bist (angemeldet|abgemeldet)|Du nimmst am Giveaway teil|Pong!)/i.test(text)) return "success";
  return "info";
}

export function brandedTextEmbed(text, title = null) {
  const tone = responseTone(text);
  const names = { success: "✅ Erledigt", error: "⚠️ Hinweis", info: "GAMBINOS" };
  return new EmbedBuilder()
    .setColor(COLORS[tone])
    .setAuthor({ name: "GAMBINOS  •  BOT" })
    .setTitle(title ?? names[tone])
    .setDescription(String(text).slice(0, 4096))
    .setFooter({ text: "GAMBINOS  •  Familienverwaltung" });
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
    .addFields({ name: "Referenz", value: `\`${applicationId}\``, inline: true });
  if (!accepted) embed.addFields({ name: "Begründung", value: String(reason || "Kein Grund angegeben.").slice(0, 1024), inline: false });
  return { embeds: [embed.setFooter({ text: "GAMBINOS  •  Private Nachricht" }).setTimestamp()] };
}

export function applicationInReviewDm({ kind, applicationId, reviewerId }) {
  const label = kind === "rang" ? "Dein Rang-Antrag" : "Deine Familienbewerbung";
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({ name: "GAMBINOS  •  FAMILIENBÜRO" })
    .setTitle("🔎 Antrag wird bearbeitet")
    .setDescription(`${label} wurde von unserem Team übernommen und ist jetzt in Bearbeitung. Wir prüfen deine Angaben und melden uns, sobald es Neuigkeiten gibt.`)
    .addFields({ name: "Referenz", value: `\`${applicationId}\``, inline: true });
  if (reviewerId) embed.addFields({ name: "Zuständig", value: `<@${reviewerId}>`, inline: true });
  return { embeds: [embed.setFooter({ text: "GAMBINOS  •  Wir halten dich auf dem Laufenden" }).setTimestamp()] };
}

const ACTIONS = {
  "application.submitted": "Neuer Antrag eingereicht",
  "application.claimed": "Antrag zur Bearbeitung übernommen",
  "application.accepted": "Antrag angenommen",
  "application.rejected": "Antrag abgelehnt",
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
  const targetIsPerson = ["application.submitted", "application.claimed", "application.accepted", "application.rejected"].includes(action)
    ? false
    : !["ticket.created", "giveaway.ended"].includes(action) && Boolean(item.target_id);
  const target = !item.target_id ? "—"
    : targetIsPerson ? `<@${item.target_id}>`
      : `\`${String(item.target_id).slice(0, 12)}\``;
  const fields = [
    { name: "Ausgeführt von", value: `<@${item.actor_id}>`, inline: true },
    { name: targetIsPerson ? "Betroffene Person" : "Vorgang", value: target, inline: true },
    { name: "Zeitpunkt", value: `<t:${Math.floor(new Date(item.created_at).getTime() / 1000)}:F>`, inline: false },
  ];
  for (const [key, value] of Object.entries(details)) {
    if (key === "winnerIds") { fields.push({ name: "Gewinner", value: value.length ? value.map(id => `<@${id}>`).join(", ").slice(0, 1000) : "Keine", inline: false }); continue; }
    fields.push({ name: DETAIL_NAMES[key] ?? key, value: formatDetail(key, value), inline: ["kind", "category", "entries", "cents"].includes(key) });
  }
  return { embeds: [new EmbedBuilder().setColor(color).setAuthor({ name: "GAMBINOS  •  AUDIT-PROTOKOLL" })
    .setTitle(ACTIONS[action] ?? action.replaceAll(".", " · "))
    .addFields(fields.slice(0, 25)).setFooter({ text: "GAMBINOS  •  Aktion dauerhaft protokolliert" })
    .setTimestamp(new Date(item.created_at))] };
}

export function logEmbed(title, description, tone = "info") {
  return new EmbedBuilder().setColor(COLORS[tone] ?? BRAND_COLOR)
    .setAuthor({ name: "GAMBINOS  •  SERVER-LOG" }).setTitle(title)
    .setDescription(String(description).slice(0, 4096)).setFooter({ text: "GAMBINOS  •  Serverprotokoll" }).setTimestamp();
}
