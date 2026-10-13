import { EmbedBuilder } from "discord.js";
import { getSetting, setSetting } from "./database.js";
import { BRAND_COLOR } from "./presentation.js";
import { buildApplicationPanelPayload, buildTicketPanelPayload } from "./commands.js";
import { PANEL_SETTING_KEY, buildPanelPayload } from "./staff-panel.js";
import { BOARD_SETTING_KEY, buildActivityBoard } from "./activity-board.js";

/** Dauerhafte Panels: Channel-Einstellung -> gespeicherte Nachricht -> Inhalt. */
// Erst beim Aufruf aufgebaut: vermeidet Probleme mit zirkulären Modul-Importen (commands <-> panels).
const panelDefinitions = () => [
  { channelKey: "CHANNEL_TICKET_PANEL", settingKey: "PANEL_TICKET", label: "Ticket-Panel", build: ctx => buildTicketPanelPayload(ctx.config) },
  { channelKey: "CHANNEL_APPLICATION_PANEL", settingKey: "PANEL_APPLICATION", label: "Bewerbungs-Panel", build: () => buildApplicationPanelPayload() },
  { channelKey: "CHANNEL_STAFF_DASHBOARD", settingKey: PANEL_SETTING_KEY, label: "Staff-Dashboard", build: ctx => buildPanelPayload(ctx.db, ctx.config.DISCORD_GUILD_ID), refresh: true },
  { channelKey: "CHANNEL_ACTIVITY_BOARD", settingKey: BOARD_SETTING_KEY, label: "Aktivitäten-Übersicht", build: ctx => buildActivityBoard(ctx.series.list(ctx.config.DISCORD_GUILD_ID), ctx.config.TIMEZONE), refresh: true, needsSeries: true },
];
export const PANEL_CHANNEL_KEYS = ["CHANNEL_TICKET_PANEL", "CHANNEL_APPLICATION_PANEL", "CHANNEL_STAFF_DASHBOARD", "CHANNEL_ACTIVITY_BOARD"];

/**
 * Stellt sicher, dass jedes Panel genau einmal im eingestellten Channel steht. Gepostet wird nur, wenn noch keines
 * existiert, der Channel gewechselt wurde oder Discord die Nachricht eindeutig als gelöscht meldet (10008);
 * bei Netzwerkfehlern wird nichts doppelt gepostet. Ticket- und Bewerbungs-Panels werden zusätzlich aktualisiert,
 * damit geänderte Kategorien sofort sichtbar sind.
 */
export async function ensurePanels({ db, client, config, series, only = null }) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId) return [];
  const results = [];
  for (const panel of panelDefinitions()) {
    if (only && !only.includes(panel.channelKey)) continue;
    const channelId = config[panel.channelKey];
    if (!channelId || (panel.needsSeries && !series)) continue;
    const [storedChannel, storedMessage] = (getSetting(db, guildId, panel.settingKey) ?? "").split(":");
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) { results.push({ panel: panel.label, status: "channel_unavailable" }); continue; }
    const payload = panel.build({ db, config, series });
    if (storedChannel === channelId && storedMessage) {
      let gone = false;
      const message = await channel.messages.fetch(storedMessage).catch(error => { gone = error?.code === 10008; return null; });
      if (message) { await message.edit(payload).catch(() => {}); results.push({ panel: panel.label, status: "ok" }); continue; }
      if (!gone) { results.push({ panel: panel.label, status: "unknown" }); continue; }
    } else if (storedChannel && storedMessage) {
      // Channel gewechselt: altes Panel des Bots entfernen, damit es nicht doppelt bedienbar bleibt.
      const old = await client.channels.fetch(storedChannel).then(ch => ch?.messages?.fetch(storedMessage)).catch(() => null);
      await old?.delete().catch(() => {});
    }
    const sent = await channel.send(payload).catch(error => { console.warn(`${panel.label} konnte nicht gepostet werden:`, error.message); return null; });
    if (sent) { setSetting(db, guildId, panel.settingKey, `${channel.id}:${sent.id}`); results.push({ panel: panel.label, status: "posted" }); }
    else results.push({ panel: panel.label, status: "failed" });
  }
  return results;
}

/** Ergebnis-Zusammenfassung eines beendeten Events im öffentlichen Ergebnis-Channel. */
export async function postEventResult({ db, client, config, event }) {
  if (!config.CHANNEL_EVENT_RESULTS) return false;
  const channel = await client.channels.fetch(config.CHANNEL_EVENT_RESULTS).catch(() => null);
  if (!channel?.isTextBased?.()) return false;
  const rows = db.prepare("SELECT user_id,status FROM event_participants WHERE event_id=? AND status<>'left' ORDER BY updated_at").all(event.id);
  const list = status => rows.filter(row => row.status === status).map(row => `<@${row.user_id}>`).join(", ");
  const embed = new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  EVENT-ERGEBNIS" }).setTitle(`🏁 ${event.name}`.slice(0, 256))
    .setDescription(`<t:${Math.floor(new Date(event.starts_at).getTime() / 1000)}:F>${event.location ? ` · ${event.location}` : ""}`)
    .addFields(
      { name: `✅ Anwesend (${rows.filter(r => r.status === "present").length})`, value: (list("present") || "—").slice(0, 1024) },
      { name: `🙋 Angemeldet (${rows.filter(r => r.status === "signed_up").length})`, value: (list("signed_up") || "—").slice(0, 1024) },
      { name: `➖ Abwesend (${rows.filter(r => r.status === "absent").length})`, value: (list("absent") || "—").slice(0, 1024) },
    ).setFooter({ text: "GAMBINOS  •  Anwesenheit kann vom Event-Team nachgetragen werden" }).setTimestamp();
  return channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
}
