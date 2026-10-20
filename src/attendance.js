import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder } from "discord.js";
import { createFinance, formatMoney } from "./services/finance.js";
import { accessGroups } from "./config.js";
import { audit, getSetting, setSetting } from "./database.js";
import { BRAND_COLOR, numberedMentions } from "./presentation.js";
import { postEventResult } from "./panels.js";
import { refreshEventPosts } from "./event-posts.js";
import { proofsByUser } from "./event-proofs.js";

/**
 * Verbindliche Anwesenheit: Nach dem Event hakt das Event-Team im Auswahlmenü ab, wer da war.
 * Erst „Abschließen“ setzt alle anderen Angemeldeten auf abwesend; ab dann zählen sie als No-Show.
 */
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const PER_MENU = 25, MAX_MENUS = 3;
const participantsOf = (db, eventId) => db.prepare("SELECT user_id,status FROM event_participants WHERE event_id=? AND status IN ('signed_up','present','absent') ORDER BY updated_at,user_id").all(eventId);

export function attendanceEmbed(event, rows, closed = null) {
  const present = rows.filter(r => r.status === "present").map(r => r.user_id), missing = rows.filter(r => r.status !== "present").map(r => r.user_id);
  const embed = new EmbedBuilder().setColor(closed ? 0x2e7d32 : BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  ANWESENHEIT" })
    .setTitle(`${closed ? "✅" : "📋"} ${event.name}`.slice(0, 256))
    .setDescription(closed
      ? `<t:${unix(event.starts_at)}:F>\nAbgeschlossen von <@${closed.by}> · ${present.length} von ${rows.length} anwesend.`
      : `Beginn <t:${unix(event.starts_at)}:t> (<t:${unix(event.starts_at)}:R>)\n**Event vorbei?** Dann eintragen, wer **wirklich da war**. Erst nach „Abschließen“ ist das Event fertig – alle nicht Markierten zählen dann als No-Show.`);
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
    // Ohne Anmeldungen gibt es nichts zu prüfen: Event direkt beenden, damit der Post nicht stehen bleibt
    // (Aktivitäts-Posts werden dabei gelöscht, wenn EVENT_SERIES_DELETE_ENDED an ist).
    const ended = db.transaction(() => {
      db.prepare("UPDATE events SET attendance_closed_at=?,attendance_closed_by=? WHERE id=? AND attendance_closed_at IS NULL").run(new Date().toISOString(), client.user?.id ?? "system", row.id);
      const changed = db.prepare("UPDATE events SET status='ended' WHERE id=? AND status='scheduled'").run(row.id).changes;
      if (changed) audit(db, row.guild_id, client.user?.id ?? "system", "event.ended", row.id, { name: row.name, reason: "keine Anmeldungen" });
      return changed;
    })();
    if (ended) await refreshEventPosts({ db, client, config, event: { ...row, status: "ended" }, state: "ended" }).catch(() => {});
    return false;
  }
  const channelId = config.CHANNEL_EVENT_CHECK || config.CHANNEL_EVENT_LOG || config.CHANNEL_AUDIT_LOG;
  const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (!channel?.send) return false;
  const team = accessGroups(config).events;
  const message = await channel.send({ content: team.length ? team.map(id => `<@&${id}>`).join(" ") : undefined, allowedMentions: { roles: team },
    embeds: [attendanceEmbed(row, rows)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`att:open:${row.id}`).setLabel("📋 Event vorbei – Anwesenheit eintragen").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`att:skip:${row.id}`).setLabel("🚫 Nicht gespielt").setStyle(ButtonStyle.Secondary))] }).catch(() => null);
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

/** Nicht Angemeldete, die trotzdem da waren, direkt als anwesend eintragen. */
export function addPresent(db, { eventId, userIds }) {
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const id of userIds) db.prepare("INSERT INTO event_participants(event_id,user_id,status,updated_at) VALUES(?,?,'present',?) ON CONFLICT(event_id,user_id) DO UPDATE SET status='present',updated_at=excluded.updated_at").run(eventId, id, now);
  })();
}

/** Abschluss: alle nicht als anwesend Markierten werden abwesend; das Event ist danach fertig. */
/** Event fand nicht statt: abgeschlossen ohne Anwesenheit – niemand bekommt einen No-Show. */
export function markNotPlayed(db, { eventId, actorId }) {
  return db.transaction(() => {
    const event = db.prepare("SELECT * FROM events WHERE id=?").get(eventId);
    if (!event) return { error: "Event nicht gefunden." };
    if (event.attendance_closed_at) return { error: "Die Anwesenheit wurde bereits abgeschlossen.", event };
    const now = new Date().toISOString();
    db.prepare("UPDATE events SET status='cancelled',attendance_closed_at=?,attendance_closed_by=? WHERE id=?").run(now, actorId, eventId);
    audit(db, event.guild_id, actorId, "event.not_played", eventId, { name: event.name });
    return { event: db.prepare("SELECT * FROM events WHERE id=?").get(eventId) };
  })();
}

/** Nach „Nicht gespielt“: Posts als abgesagt markieren bzw. löschen, Event-Check-Nachricht aktualisieren. */
export async function afterNotPlayed({ db, client, config, event, actorId }) {
  await refreshEventPosts({ db, client, config, event, state: "cancelled" }).catch(() => {});
  if (event.attendance_channel_id && event.attendance_message_id) {
    const channel = await client.channels.fetch(event.attendance_channel_id).catch(() => null);
    const message = await channel?.messages?.fetch(event.attendance_message_id).catch(() => null);
    await message?.edit({ content: `🚫 **${event.name}** wurde nicht gespielt · eingetragen von <@${actorId}>. Es zählen keine No-Shows.`, embeds: [], components: [] }).catch(() => {});
  }
}

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
    await message?.edit({ content: "", embeds: [attendanceEmbed(event, rows, { by: actorId })], components: rows.some(r => r.status === "present") ? [outcomeButtons(event.id)] : [] }).catch(() => {});
  }
  await postEventResult({ db, client, config, event }).catch(() => {});
}

// ---------------------------------------------------------------- Ergebnis: Win / Lose
export const outcomeButtons = eventId => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`att:win:${eventId}`).setLabel("🏆 Win").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`att:lose:${eventId}`).setLabel("❌ Lose").setStyle(ButtonStyle.Danger));

/** Betrag aus Eingaben wie „25000“, „25.000“, „25 000“, „25k“, „1,5k“, „$12,50“. */
export function parseAmount(input) {
  let raw = String(input ?? "").trim().toLowerCase().replace(/[$\s]/g, "");
  let factor = 1;
  if (/k$/.test(raw)) { factor = 1000; raw = raw.slice(0, -1); } else if (/mio$|m$/.test(raw)) { factor = 1_000_000; raw = raw.replace(/mio$|m$/, ""); }
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, "");
  if (!/^\d+([.,]\d{1,2})?$/.test(raw)) return null;
  const cents = Math.round(Number(raw.replace(",", ".")) * factor * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100_000_000_000 ? cents : null;
}

/** Ergebnis festhalten; bei Win bekommt jeder Anwesende den Betrag gutgeschrieben (je Person und Event genau einmal). */
export function recordOutcome(db, { eventId, outcome, cents = null, killCents = 0, actorId }) {
  const finance = createFinance(db);
  return db.transaction(() => {
    const event = db.prepare("SELECT * FROM events WHERE id=?").get(eventId);
    if (!event) return { error: "Event nicht gefunden." };
    if (!event.attendance_closed_at) return { error: "Bitte zuerst die Anwesenheit abschließen." };
    if (event.outcome) return { error: `Für dieses Event wurde bereits „${event.outcome === "win" ? "Win" : "Lose"}“ eingetragen.` };
    const present = db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status='present' ORDER BY user_id").all(eventId).map(r => r.user_id);
    // Bei Win: Anfahrt/Pauschale für jeden Anwesenden, plus optional Prämie × eigene Kills.
    const kills = new Map(db.prepare("SELECT user_id,kills FROM event_kills WHERE event_id=?").all(eventId).map(r => [r.user_id, r.kills]));
    let total = 0, killTotal = 0;
    if (outcome === "win") {
      const day = new Date(event.starts_at).toISOString().slice(0, 10).split("-").reverse().join(".");
      for (const userId of present) {
        const k = killCents ? kills.get(userId) ?? 0 : 0, amount = cents + k * killCents;
        if (amount <= 0) continue;
        total += amount; killTotal += k;
        finance.credit({ guildId: event.guild_id, userId, actorId, cents: amount, reason: `Event gewonnen: ${event.name} (${day})${k ? ` – ${k} Kill${k === 1 ? "" : "s"}` : ""}`.slice(0, 300), key: `event-win:${eventId}:${userId}` });
      }
    }
    db.prepare("UPDATE events SET outcome=?,outcome_cents=?,outcome_by=?,outcome_at=? WHERE id=?").run(outcome, outcome === "win" ? cents : null, actorId, new Date().toISOString(), eventId);
    audit(db, event.guild_id, actorId, "event.outcome", eventId, { name: event.name, value: outcome === "win" ? "Win" : "Lose", cents: total, entries: present.length, ...(killCents ? { kills: killTotal } : {}) });
    return { event, present, total, killTotal };
  })();
}

const isFinance = (i, config) => (config.BOT_OWNER_IDS ?? []).includes(i.user.id) || accessGroups(config).finance.some(id => i.member?.roles?.cache?.has?.(id));

/** Ergebnis auch an der Nachricht im Event-Check vermerken und die Buttons entfernen. */
async function markLogMessage(client, event, text) {
  if (!event.attendance_channel_id || !event.attendance_message_id) return;
  const channel = await client.channels.fetch(event.attendance_channel_id).catch(() => null);
  const message = await channel?.messages?.fetch(event.attendance_message_id).catch(() => null);
  if (message) await message.edit({ content: text, components: [] }).catch(() => {});
}

async function handleOutcome({ i, db, client, config, action, event }) {
  if (action === "win" && !isFinance(i, config)) return i.reply({ content: "Geld verteilen darf nur Finanzen, Leitung oder Voller Zugriff. „Lose“ kann das Event-Team eintragen.", flags: MessageFlags.Ephemeral });
  if (event.outcome) return i.reply({ content: `Für dieses Event wurde bereits „${event.outcome === "win" ? "Win" : "Lose"}“ eingetragen.`, flags: MessageFlags.Ephemeral });
  if (action === "win") {
    const present = db.prepare("SELECT COUNT(*) n FROM event_participants WHERE event_id=? AND status='present'").get(event.id).n;
    return i.showModal(new ModalBuilder().setCustomId(`att:winmodal:${event.id}`).setTitle(`🏆 Win – ${event.name}`.slice(0, 45)).addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amount").setLabel(`Anfahrt / Betrag pro Person (${present} da)`.slice(0, 45)).setPlaceholder("z. B. 25000 oder 25k").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("perkill").setLabel("Prämie pro Kill (optional)").setPlaceholder("leer = keine Kill-Prämie, z. B. 25k").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20))));
  }
  let result;
  if (action === "winmodal") {
    if (!isFinance(i, config)) return i.reply({ content: "Geld verteilen darf nur Finanzen, Leitung oder Voller Zugriff.", flags: MessageFlags.Ephemeral });
    const cents = parseAmount(i.fields.getTextInputValue("amount"));
    if (!cents) return i.reply({ content: "Ungültiger Betrag. Beispiele: 25000, 25.000, 25k.", flags: MessageFlags.Ephemeral });
    const perKillRaw = (() => { try { return i.fields.getTextInputValue("perkill"); } catch { return ""; } })();
    if (String(perKillRaw ?? "").trim()) {
      const kill = parseAmount(perKillRaw);
      if (!kill) return i.reply({ content: "Ungültige Kill-Prämie. Beispiele: 25000, 25k – oder leer lassen.", flags: MessageFlags.Ephemeral });
      return i.reply({ ...(await killPanel({ db, i, event, drive: cents, kill })), flags: MessageFlags.Ephemeral });
    }
    result = recordOutcome(db, { eventId: event.id, outcome: "win", cents, actorId: i.user.id });
    if (result.error) return i.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    const text = `🏆 **Win** · je **${formatMoney(cents)}** an ${result.present.length} Anwesende (gesamt ${formatMoney(result.total)}) · eingetragen von <@${i.user.id}>`;
    await markLogMessage(client, event, text);
    return i.message ? i.update({ content: text, components: [] }) : i.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
  if (action === "killsel" || action === "killset" || action === "payout") {
    if (!isFinance(i, config)) return i.reply({ content: "Geld verteilen darf nur Finanzen, Leitung oder Voller Zugriff.", flags: MessageFlags.Ephemeral });
    const [, , , driveRaw, killRaw, userId] = i.customId.split(":");
    const drive = Number(driveRaw), kill = Number(killRaw);
    if (!Number.isSafeInteger(drive) || !Number.isSafeInteger(kill)) return i.reply({ content: "Ungültige Anfrage.", flags: MessageFlags.Ephemeral });
    if (action === "killsel") {
      const target = i.values[0], current = db.prepare("SELECT kills FROM event_kills WHERE event_id=? AND user_id=?").get(event.id, target)?.kills ?? 0;
      const nameOf = await namesFor({ db, i, event, ids: [target] });
      return i.showModal(new ModalBuilder().setCustomId(`att:killset:${event.id}:${drive}:${kill}:${target}`).setTitle(`Kills – ${nameOf(target)}`.slice(0, 45)).addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("kills").setLabel("Anzahl Kills").setValue(String(current)).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3))));
    }
    if (action === "killset") {
      const k = Number(String(i.fields.getTextInputValue("kills")).trim());
      if (!Number.isInteger(k) || k < 0 || k > 999) return i.reply({ content: "Bitte eine Zahl von 0 bis 999 eingeben.", flags: MessageFlags.Ephemeral });
      if (!db.prepare("SELECT 1 FROM event_participants WHERE event_id=? AND user_id=? AND status='present'").get(event.id, userId)) return i.reply({ content: "Diese Person ist nicht als anwesend eingetragen.", flags: MessageFlags.Ephemeral });
      db.prepare("INSERT INTO event_kills(event_id,user_id,kills,updated_at) VALUES(?,?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET kills=excluded.kills,updated_at=excluded.updated_at").run(event.id, userId, k, new Date().toISOString());
      return i.update(await killPanel({ db, i, event, drive, kill }));
    }
    result = recordOutcome(db, { eventId: event.id, outcome: "win", cents: drive, killCents: kill, actorId: i.user.id });
    if (result.error) return i.update({ content: result.error, components: [] });
    const text = `🏆 **Win** · ${formatMoney(drive)} Anfahrt + ${formatMoney(kill)} pro Kill · ${result.killTotal} Kills · gesamt **${formatMoney(result.total)}** an ${result.present.length} Anwesende · eingetragen von <@${i.user.id}>`;
    await markLogMessage(client, event, text);
    return i.update({ content: text, components: [] });
  }
  result = recordOutcome(db, { eventId: event.id, outcome: "lose", actorId: i.user.id });
  if (result.error) return i.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  await markLogMessage(client, event, `❌ **Lose** · eingetragen von <@${i.user.id}>`);
  return i.update({ content: `❌ **Lose** · eingetragen von <@${i.user.id}>`, components: [] });
}

const isEventTeam = (i, config) => (config.BOT_OWNER_IDS ?? []).includes(i.user.id) || accessGroups(config).events.some(id => i.member?.roles?.cache?.has?.(id));

/** Anzeigenamen (verifiziert „Vorname Nachname | ID“, sonst Discord-Name). */
async function namesFor({ db, i, event, ids }) {
  const fetched = i.guild && ids.length ? await i.guild.members.fetch({ user: ids.slice(0, 100) }).catch(() => null) : null;
  return id => db.prepare("SELECT nickname FROM member_verifications WHERE guild_id=? AND user_id=?").get(event.guild_id, id)?.nickname ?? fetched?.get?.(id)?.displayName ?? `Mitglied …${id.slice(-4)}`;
}

/** Kills eintragen: Auswahl einer Person öffnet ein Feld für ihre Kills; „Auszahlen“ bucht alles. */
async function killPanel({ db, i, event, drive, kill }) {
  const present = db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status='present' ORDER BY updated_at,user_id").all(event.id).map(r => r.user_id);
  const kills = new Map(db.prepare("SELECT user_id,kills FROM event_kills WHERE event_id=?").all(event.id).map(r => [r.user_id, r.kills]));
  const nameOf = await namesFor({ db, i, event, ids: present });
  const total = present.reduce((sum, id) => sum + drive + (kills.get(id) ?? 0) * kill, 0);
  const lines = present.map(id => { const k = kills.get(id) ?? 0; return `• ${nameOf(id)} – ${k} Kill${k === 1 ? "" : "s"} → **${formatMoney(drive + k * kill)}**`; }).join("\n").slice(0, 1700);
  const select = new StringSelectMenuBuilder().setCustomId(`att:killsel:${event.id}:${drive}:${kill}`).setPlaceholder("Kills eintragen – Person wählen").setMinValues(1).setMaxValues(1)
    .addOptions(present.slice(0, 25).map(id => ({ label: nameOf(id).slice(0, 100), value: id, description: `${kills.get(id) ?? 0} Kills` })));
  const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`att:payout:${event.id}:${drive}:${kill}`).setLabel(`✅ Auszahlen (${formatMoney(total)})`).setStyle(ButtonStyle.Success));
  return { content: `🏆 **Win – ${event.name}**\nAnfahrt **${formatMoney(drive)}** pro Person + **${formatMoney(kill)}** pro Kill. Wähle unten eine Person und trag ihre Kills ein, dann „Auszahlen“.${present.length > 25 ? "\n⚠️ Mehr als 25 Anwesende – nur die ersten 25 sind wählbar." : ""}\n\n${lines}`,
    components: present.length ? [new ActionRowBuilder().addComponents(select), buttons] : [buttons] };
}

async function pickerPayload({ db, i, event }) {
  const rows = participantsOf(db, event.id);
  const guild = i.guild;
  const ids = rows.map(r => r.user_id);
  const fetched = guild ? await guild.members.fetch({ user: ids.slice(0, 100) }).catch(() => null) : null;
  const nameOf = id => db.prepare("SELECT nickname FROM member_verifications WHERE guild_id=? AND user_id=?").get(event.guild_id, id)?.nickname ?? fetched?.get?.(id)?.displayName ?? `Mitglied …${id.slice(-4)}`;
  const menus = [], proofs = proofsByUser(db, event.id);
  for (let start = 0; start < rows.length && menus.length < MAX_MENUS; start += PER_MENU) {
    const chunk = rows.slice(start, start + PER_MENU);
    menus.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`att:pick:${event.id}:${start}`)
      .setPlaceholder(rows.length > PER_MENU ? `Wer war da? (${start + 1}–${start + chunk.length})` : "Wer war da? – alle Anwesenden auswählen")
      .setMinValues(0).setMaxValues(chunk.length)
      .addOptions(chunk.map(r => ({ label: nameOf(r.user_id).slice(0, 100), value: r.user_id, default: r.status === "present", ...(proofs.get(r.user_id) ? { description: `📸 ${proofs.get(r.user_id)} ${proofs.get(r.user_id) === 1 ? "Bild" : "Bilder"} im Event-Logbuch` } : {}) })))));
  }
  const present = rows.filter(r => r.status === "present").length;
  const add = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`att:add:${event.id}`)
    .setPlaceholder("➕ Nicht angemeldet, aber da – Mitglieder hinzufügen").setMinValues(1).setMaxValues(25));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`att:close:${event.id}`).setLabel(`✅ Abschließen (${present}/${rows.length} da)`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`att:all:${event.id}`).setLabel("Alle waren da").setStyle(ButtonStyle.Secondary),
    ...(proofs.size ? [new ButtonBuilder().setCustomId(`att:proofs:${event.id}`).setLabel(`📸 Mit Nachweis = da (${proofs.size})`).setStyle(ButtonStyle.Primary)] : []),
    new ButtonBuilder().setCustomId(`att:skip:${event.id}`).setLabel("🚫 Nicht gespielt").setStyle(ButtonStyle.Secondary));
  const more = rows.length > PER_MENU * MAX_MENUS ? `\n⚠️ Mehr als ${PER_MENU * MAX_MENUS} Angemeldete – den Rest bitte auf der Website eintragen.` : "";
  const noProof = proofs.size ? rows.filter(r => !proofs.has(r.user_id)).length : 0;
  return { content: `${proofs.size ? `📸 **${proofs.size}** ${proofs.size === 1 ? "Person hat" : "Personen haben"} Event-Logs gepostet${noProof ? `, ${noProof} Angemeldete ohne Bild` : ""}.\n` : ""}**${event.name}** – wähle alle aus, die **wirklich da waren**. Wer nicht angemeldet war, aber da war, kommt über ➕ dazu. Die Auswahl wird sofort gespeichert; „Abschließen“ setzt alle anderen auf *nicht da* (No-Show).${more}`, components: [...menus, add, buttons] };
}

/** Alle Interaktionen mit customId „att:…“ (Button und Auswahlmenü). */
export async function handleAttendanceInteraction({ i, db, client, config }) {
  const [, action, eventId, offset] = i.customId.split(":");
  if (!isEventTeam(i, config) && !(["win", "winmodal", "killsel", "killset", "payout"].includes(action) && isFinance(i, config))) return i.reply({ content: "Die Anwesenheit trägt nur das Event-Team oder die Leitung ein.", flags: MessageFlags.Ephemeral });
  const event = db.prepare("SELECT * FROM events WHERE id=?").get(eventId);
  if (!event) return i.reply({ content: "Dieses Event gibt es nicht mehr.", flags: MessageFlags.Ephemeral });
  if (["win", "lose", "winmodal", "killsel", "killset", "payout"].includes(action)) return handleOutcome({ i, db, client, config, action, event });
  // Ohne Anmeldungen still abgeschlossen: über „Event beenden“ kann das Team trotzdem Anwesende nachtragen.
  if (action === "open" && event.attendance_closed_at && !event.outcome && event.status !== "cancelled" && !participantsOf(db, event.id).length) {
    // Markierung „manuell geöffnet“: die automatische Abfrage schließt es nicht wieder still ab.
    db.prepare("UPDATE events SET attendance_closed_at=NULL,attendance_closed_by=NULL,attendance_message_id=COALESCE(attendance_message_id,'manual') WHERE id=?").run(event.id);
    event.attendance_closed_at = null;
  }
  if (action === "open" && !event.attendance_closed_at && new Date(event.starts_at) > new Date()) return i.reply({ content: `**${event.name}** hat noch nicht begonnen (Start <t:${Math.floor(new Date(event.starts_at).getTime() / 1000)}:R>).`, flags: MessageFlags.Ephemeral });
  if (event.attendance_closed_at) return i.reply({ content: "Die Anwesenheit ist bereits abgeschlossen. Korrekturen gehen auf der Website (Events → Anwesenheit).", flags: MessageFlags.Ephemeral });
  if (action === "open") return i.reply({ ...(await pickerPayload({ db, i, event })), flags: MessageFlags.Ephemeral });
  if (action === "pick") {
    const rows = participantsOf(db, event.id), start = Number(offset) || 0;
    applySelection(db, { eventId: event.id, optionIds: rows.slice(start, start + PER_MENU).map(r => r.user_id), selectedIds: i.values });
    return i.update(await pickerPayload({ db, i, event }));
  }
  if (action === "skip") {
    const result = markNotPlayed(db, { eventId: event.id, actorId: i.user.id });
    if (result.error) return i.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    const text = `🚫 **${event.name}** als „nicht gespielt“ eingetragen. Niemand bekommt einen No-Show.`;
    if (i.message?.flags?.has?.(MessageFlags.Ephemeral)) await i.update({ content: text, components: [] });
    else await i.reply({ content: text, flags: MessageFlags.Ephemeral });
    await afterNotPlayed({ db, client, config, event: result.event, actorId: i.user.id });
    return null;
  }
  if (action === "add") {
    addPresent(db, { eventId: event.id, userIds: i.values.filter(id => !i.users?.get?.(id)?.bot) });
    return i.update(await pickerPayload({ db, i, event }));
  }
  if (action === "proofs") {
    // Alle mit Event-Log-Bild als anwesend – auch wer nicht angemeldet war.
    addPresent(db, { eventId: event.id, userIds: [...proofsByUser(db, event.id).keys()] });
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
    await i.update({ content: `✅ Anwesenheit für **${event.name}** abgeschlossen: ${present} von ${result.rows.length} da. Nicht Anwesende zählen als No-Show (außer sie waren abgemeldet).${present ? "\nWie ist das Event ausgegangen? Bei **Win** gibst du den Betrag ein, den jeder Anwesende aufs Konto bekommt." : ""}`, components: present ? [outcomeButtons(event.id)] : [] });
    await afterClose({ db, client, config, event: result.event, rows: result.rows, actorId: i.user.id });
  }
  return null;
}

/**
 * Fällige Anwesenheits-Abfragen: jedes Event (auch manuelle) ab seinem Beginn, in CHANNEL_EVENT_CHECK.
 * Erst Events ab Einführung dieser Funktion, damit nach dem Update keine Flut alter Abfragen kommt.
 */
export async function requestDueAttendance({ db, client, config, reference = new Date() }) {
  if (!config.DISCORD_GUILD_ID) return 0;
  let since = getSetting(db, config.DISCORD_GUILD_ID, "ATTENDANCE_SINCE");
  if (!since) { since = reference.toISOString(); setSetting(db, config.DISCORD_GUILD_ID, "ATTENDANCE_SINCE", since); }
  // Abfrage schon bei Eventbeginn, damit das Team direkt nach dem Event eintragen kann.
  const cutoff = reference.toISOString();
  const due = db.prepare("SELECT * FROM events WHERE guild_id=? AND status IN ('scheduled','ended') AND attendance_closed_at IS NULL AND attendance_message_id IS NULL AND starts_at>=? AND starts_at<=? ORDER BY starts_at LIMIT 10").all(config.DISCORD_GUILD_ID, since, cutoff);
  let sent = 0;
  for (const event of due) if (await requestAttendance({ db, client, config, event }).catch(() => false)) sent++;
  return sent;
}
