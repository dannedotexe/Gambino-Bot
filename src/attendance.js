import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder } from "discord.js";
import { accessGroups } from "./config.js";
import { audit, getSetting, setSetting } from "./database.js";
import { BRAND_COLOR, numberedMentions } from "./presentation.js";
import { postEventResult } from "./panels.js";
import { refreshEventPosts } from "./event-posts.js";

/**
 * Verbindliche Anwesenheit: Nach dem Event hakt das Event-Team im Auswahlmenü ab, wer da war.
 * Erst „Abschließen“ setzt alle anderen Angemeldeten auf abwesend; ab dann zählen sie als No-Show.
 */
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const PER_MENU = 25, MAX_MENUS = 4;
const participantsOf = (db, eventId) => db.prepare("SELECT user_id,status FROM event_participants WHERE event_id=? AND status IN ('signed_up','present','absent') ORDER BY updated_at,user_id").all(eventId);

export function attendanceEmbed(event, rows, closed = null) {
  const present = rows.filter(r => r.status === "present").map(r => r.user_id), missing = rows.filter(r => r.status !== "present").map(r => r.user_id);
  const embed = new EmbedBuilder().setColor(closed ? 0x2e7d32 : BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  ANWESENHEIT" })
    .setTitle(`${closed ? "✅" : "📋"} ${event.name}`.slice(0, 256))
    .setDescription(closed
      ? `<t:${unix(event.starts_at)}:F>\nAbgeschlossen von <@${closed.by}> · ${present.length} von ${rows.length} anwesend.`
      : `<t:${unix(event.starts_at)}:F>\nBitte eintragen, wer **wirklich da war**. Erst nach „Abschließen“ ist das Event fertig – alle nicht Markierten zählen dann als No-Show.`);
  if (closed) embed.addFields({ name: `✅ Anwesend (${present.length})`, value: numberedMentions(present).slice(0, 1024) }, { name: `❌ Nicht da (${missing.length})`, value: numberedMentions(missing).slice(0, 1024) });
  else embed.addFields({ name: `🙋 Angemeldet (${rows.length})`, value: numberedMentions(rows.map(r => r.user_id)).slice(0, 1024) });
  return embed;
}

/** Postet nach dem Event die Aufforderung mit Button ins Event-Log (einmal pro Event). */
export async function requestAttendance({ db, client, config, event }) {
  const row = db.prepare("SELECT * FROM events WHERE id=?").get(event.id);
  if (!row || row.attendance_closed_at || row.attendance_message_id) return false;
  const rows = participantsOf(db, row.id);
  if (!rows.length) {
    // Ohne Anmeldungen gibt es nichts zu prüfen.
    db.prepare("UPDATE events SET attendance_closed_at=?,attendance_closed_by=? WHERE id=? AND attendance_closed_at IS NULL").run(new Date().toISOString(), client.user?.id ?? "system", row.id);
    return false;
  }
  const channelId = config.CHANNEL_EVENT_LOG || config.CHANNEL_AUDIT_LOG;
  const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (!channel?.send) return false;
  const team = accessGroups(config).events;
  const message = await channel.send({ content: team.length ? team.map(id => `<@&${id}>`).join(" ") : undefined, allowedMentions: { roles: team },
    embeds: [attendanceEmbed(row, rows)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`att:open:${row.id}`).setLabel("📋 Anwesenheit eintragen").setStyle(ButtonStyle.Primary))] }).catch(() => null);
  if (message) db.prepare("UPDATE events SET attendance_channel_id=?,attendance_message_id=? WHERE id=?").run(channel.id, message.id, row.id);
  return Boolean(message);
}

/** Auswahl übernehmen: Ausgewählte = anwesend, nicht Ausgewählte aus diesem Menü wieder offen. */
export function applySelection(db, { eventId, optionIds, selectedIds }) {
  const now = new Date().toISOString(), selected = new Set(selectedIds);
  db.transaction(() => {
    for (const id of optionIds) db.prepare("UPDATE event_participants SET status=?,updated_at=? WHERE event_id=? AND user_id=? AND status IN ('signed_up','present','absent')").run(selected.has(id) ? "present" : "signed_up", now, eventId, id);
  })();
}

/** Abschluss: alle nicht als anwesend Markierten werden abwesend; das Event ist danach fertig. */
export function closeAttendance(db, { eventId, actorId }) {
  return db.transaction(() => {
    const event = db.prepare("SELECT * FROM events WHERE id=?").get(eventId);
    if (!event) return { error: "Event nicht gefunden." };
    if (event.attendance_closed_at) return { error: "Die Anwesenheit wurde bereits abgeschlossen.", event };
    const now = new Date().toISOString();
    db.prepare("UPDATE event_participants SET status='absent',updated_at=? WHERE event_id=? AND status='signed_up'").run(now, eventId);
    if (event.status === "scheduled") db.prepare("UPDATE events SET status='ended' WHERE id=?").run(eventId);
    db.prepare("UPDATE events SET attendance_closed_at=?,attendance_closed_by=? WHERE id=?").run(now, actorId, eventId);
    const rows = participantsOf(db, eventId);
    audit(db, event.guild_id, actorId, "event.attendance_closed", eventId, { name: event.name, entries: rows.filter(r => r.status === "present").length, value: rows.filter(r => r.status === "absent").length });
    return { event: db.prepare("SELECT * FROM events WHERE id=?").get(eventId), rows };
  })();
}

/** Nach dem Abschluss: Log-Nachricht aktualisieren und Ergebnis posten. */
export async function afterClose({ db, client, config, event, rows, actorId }) {
  await refreshEventPosts({ db, client, config, event, state: "ended" }).catch(() => {});
  if (event.attendance_channel_id && event.attendance_message_id) {
    const channel = await client.channels.fetch(event.attendance_channel_id).catch(() => null);
    const message = await channel?.messages?.fetch(event.attendance_message_id).catch(() => null);
    await message?.edit({ content: "", embeds: [attendanceEmbed(event, rows, { by: actorId })], components: [] }).catch(() => {});
  }
  await postEventResult({ db, client, config, event }).catch(() => {});
}

const isEventTeam = (i, config) => (config.BOT_OWNER_IDS ?? []).includes(i.user.id) || accessGroups(config).events.some(id => i.member?.roles?.cache?.has?.(id));

async function pickerPayload({ db, i, event }) {
  const rows = participantsOf(db, event.id);
  const guild = i.guild;
  const ids = rows.map(r => r.user_id);
  const fetched = guild ? await guild.members.fetch({ user: ids.slice(0, 100) }).catch(() => null) : null;
  const nameOf = id => db.prepare("SELECT nickname FROM member_verifications WHERE guild_id=? AND user_id=?").get(event.guild_id, id)?.nickname ?? fetched?.get?.(id)?.displayName ?? `Mitglied …${id.slice(-4)}`;
  const menus = [];
  for (let start = 0; start < rows.length && menus.length < MAX_MENUS; start += PER_MENU) {
    const chunk = rows.slice(start, start + PER_MENU);
    menus.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`att:pick:${event.id}:${start}`)
      .setPlaceholder(rows.length > PER_MENU ? `Wer war da? (${start + 1}–${start + chunk.length})` : "Wer war da? – alle Anwesenden auswählen")
      .setMinValues(0).setMaxValues(chunk.length)
      .addOptions(chunk.map(r => ({ label: nameOf(r.user_id).slice(0, 100), value: r.user_id, default: r.status === "present" })))));
  }
  const present = rows.filter(r => r.status === "present").length;
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`att:close:${event.id}`).setLabel(`✅ Abschließen (${present}/${rows.length} da)`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`att:all:${event.id}`).setLabel("Alle waren da").setStyle(ButtonStyle.Secondary));
  const more = rows.length > PER_MENU * MAX_MENUS ? `\n⚠️ Mehr als ${PER_MENU * MAX_MENUS} Angemeldete – den Rest bitte auf der Website eintragen.` : "";
  return { content: `**${event.name}** – wähle alle aus, die **wirklich da waren**. Die Auswahl wird sofort gespeichert; „Abschließen“ setzt alle anderen auf *nicht da* (No-Show).${more}`, components: [...menus, buttons] };
}

/** Alle Interaktionen mit customId „att:…“ (Button und Auswahlmenü). */
export async function handleAttendanceInteraction({ i, db, client, config }) {
  const [, action, eventId, offset] = i.customId.split(":");
  if (!isEventTeam(i, config)) return i.reply({ content: "Die Anwesenheit trägt nur das Event-Team oder die Leitung ein.", flags: MessageFlags.Ephemeral });
  const event = db.prepare("SELECT * FROM events WHERE id=?").get(eventId);
  if (!event) return i.reply({ content: "Dieses Event gibt es nicht mehr.", flags: MessageFlags.Ephemeral });
  if (event.attendance_closed_at) return i.reply({ content: "Die Anwesenheit ist bereits abgeschlossen. Korrekturen gehen auf der Website (Events → Anwesenheit).", flags: MessageFlags.Ephemeral });
  if (action === "open") return i.reply({ ...(await pickerPayload({ db, i, event })), flags: MessageFlags.Ephemeral });
  if (action === "pick") {
    const rows = participantsOf(db, event.id), start = Number(offset) || 0;
    applySelection(db, { eventId: event.id, optionIds: rows.slice(start, start + PER_MENU).map(r => r.user_id), selectedIds: i.values });
    return i.update(await pickerPayload({ db, i, event }));
  }
  if (action === "all") {
    const rows = participantsOf(db, event.id);
    applySelection(db, { eventId: event.id, optionIds: rows.map(r => r.user_id), selectedIds: rows.map(r => r.user_id) });
    return i.update(await pickerPayload({ db, i, event }));
  }
  if (action === "close") {
    const result = closeAttendance(db, { eventId: event.id, actorId: i.user.id });
    if (result.error) return i.update({ content: result.error, components: [] });
    const present = result.rows.filter(r => r.status === "present").length;
    await i.update({ content: `✅ Anwesenheit für **${event.name}** abgeschlossen: ${present} von ${result.rows.length} da. Nicht Anwesende zählen als No-Show (außer sie waren abgemeldet).`, components: [] });
    await afterClose({ db, client, config, event: result.event, rows: result.rows, actorId: i.user.id });
  }
  return null;
}

/**
 * Fällige Anwesenheits-Abfragen: jedes Event (auch vergessene manuelle) ab EVENT_SERIES_AUTO_END_MINUTES nach Beginn.
 * Erst Events ab Einführung dieser Funktion, damit nach dem Update keine Flut alter Abfragen kommt.
 */
export async function requestDueAttendance({ db, client, config, reference = new Date() }) {
  if (!config.DISCORD_GUILD_ID) return 0;
  let since = getSetting(db, config.DISCORD_GUILD_ID, "ATTENDANCE_SINCE");
  if (!since) { since = reference.toISOString(); setSetting(db, config.DISCORD_GUILD_ID, "ATTENDANCE_SINCE", since); }
  const cutoff = new Date(reference.getTime() - (config.EVENT_SERIES_AUTO_END_MINUTES ?? 120) * 60_000).toISOString();
  const due = db.prepare("SELECT * FROM events WHERE guild_id=? AND status IN ('scheduled','ended') AND attendance_closed_at IS NULL AND attendance_message_id IS NULL AND starts_at>=? AND starts_at<=? ORDER BY starts_at LIMIT 10").all(config.DISCORD_GUILD_ID, since, cutoff);
  let sent = 0;
  for (const event of due) if (await requestAttendance({ db, client, config, event }).catch(() => false)) sent++;
  return sent;
}
