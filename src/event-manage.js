import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder, UserSelectMenuBuilder } from "discord.js";
import { accessGroups } from "./config.js";
import { audit } from "./database.js";
import { BRAND_COLOR } from "./presentation.js";
import { refreshEventPosts } from "./event-posts.js";
import { createEventService } from "./services/events.js";
import { pingSignup, removeSignupPing } from "./event-signup-pings.js";

/**
 * Teilnehmer verwalten (ab Turf Leader): Angemeldete oder Wartende rausnehmen, Mitglieder eintragen.
 * Discord: Knopf „👥 Verwalten“ an der Event-Karte → nur für dich sichtbares Menü. Website: im Anwesenheits-Dialog.
 */
const unix = iso => Math.floor(new Date(iso).getTime() / 1000);
const rankNumber = name => { const m = /^[\s|]*(\d{1,2})\s*-/.exec(name ?? ""); return m ? Number(m[1]) : null; };

/** Darf verwalten: Bot-Owner, Event-Team/Leitung oder eine Rang-Rolle ab EVENT_MANAGE_MIN_RANK (Standard 7 = Turf Leader). */
export function canManageSignups(config, { userId, roleIds, roleName = () => null }) {
  if ((config.BOT_OWNER_IDS ?? []).includes(userId)) return true;
  const roles = [...roleIds];
  if (accessGroups(config).events.some(id => roles.includes(id))) return true;
  const min = config.EVENT_MANAGE_MIN_RANK ?? 7;
  return min > 0 && roles.some(id => (rankNumber(roleName(id)) ?? -1) >= min);
}

/** Person aus Anmeldung oder Warteliste nehmen; Nachrücker rückt nach. */
export function removeParticipant(db, { guildId, eventId, userId, actorId }) {
  return db.transaction(() => {
    const event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=? AND status='scheduled'").get(eventId, guildId);
    if (!event) return { status: "closed" };
    const result = createEventService(db).leave({ guildId, eventId, userId });
    if (result.status === "left" || result.status === "left_waitlist") audit(db, guildId, actorId, "event.participant_removed", userId, { eventId, name: event.name, waitlist: result.status === "left_waitlist" });
    return { ...result, event };
  })();
}

/** Nach Änderungen: Karte, Logbuch-Hinweise, DMs. */
async function afterChange({ db, client, config, event, removed = [], added = [], promoted = [], actorId }) {
  await refreshEventPosts({ db, client, config, event, cardOnly: true }).catch(() => {});
  const dm = (userId, title, text) => client.users.fetch(userId).then(user => user.send({ embeds: [new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: "GAMBINOS  •  EVENTS" }).setTitle(title).setDescription(text).setTimestamp()] })).catch(() => {});
  const when = `**${event.name}** (<t:${unix(event.starts_at)}:F>)`;
  for (const id of removed) { await removeSignupPing({ db, client, eventId: event.id, userId: id }).catch(() => {}); void dm(id, "↩️ Von der Teilnehmerliste genommen", `<@${actorId}> hat dich von ${when} abgemeldet. Bei Fragen melde dich bei ihm/ihr.`); }
  for (const id of added) { void pingSignup({ db, client, config, event, userId: id }).catch(() => {}); void dm(id, "✅ Für ein Event eingetragen", `<@${actorId}> hat dich für ${when} eingetragen.\nKannst du nicht? Dann über die Event-Karte abmelden.`); }
  for (const id of promoted) { void pingSignup({ db, client, config, event, userId: id }).catch(() => {}); void dm(id, "🎉 Du bist nachgerückt!", `Für ${when} ist ein Platz frei geworden – du stehst jetzt auf der Teilnehmerliste.`); }
}

function panel(db, event) {
  const people = db.prepare("SELECT user_id FROM event_participants WHERE event_id=? AND status IN ('signed_up','present') ORDER BY updated_at").all(event.id).map(r => r.user_id);
  const waiting = db.prepare("SELECT user_id FROM event_waitlist WHERE event_id=? ORDER BY created_at,user_id").all(event.id).map(r => r.user_id);
  const rows = [];
  const options = [...people.map(id => ({ id, wait: false })), ...waiting.map(id => ({ id, wait: true }))].slice(0, 25);
  if (options.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`evm:remove:${event.id}`).setPlaceholder("Rausnehmen … (mehrere möglich)").setMinValues(1).setMaxValues(options.length)
    .addOptions(options.map(o => ({ label: `${o.wait ? "⏳ " : ""}Mitglied …${o.id.slice(-5)}`, value: o.id, description: o.wait ? "Warteliste" : "angemeldet" })))));
  rows.push(new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`evm:add:${event.id}`).setPlaceholder("Eintragen … (Mitglied wählen)").setMinValues(1).setMaxValues(10)));
  const list = people.length ? people.map((id, n) => `${n + 1}. <@${id}>`).join("\n") : "—";
  return { content: `👥 **${event.name}** – Teilnehmer verwalten\n\n**Angemeldet (${people.length}${event.max_participants ? `/${event.max_participants}` : ""}):**\n${list}${waiting.length ? `\n\n**Warteliste:** ${waiting.map(id => `<@${id}>`).join(", ")}` : ""}`.slice(0, 2000), components: rows, allowedMentions: { parse: [] } };
}

/** Labels im Menü mit echten Namen (soweit im Cache). */
function withNames(payload, i) {
  for (const row of payload.components) for (const c of row.components) if (c.data?.custom_id?.startsWith("evm:remove:")) for (const o of c.options) {
    const m = i.guild?.members?.cache?.get(o.data.value);
    if (m) o.setLabel(`${o.data.label.startsWith("⏳") ? "⏳ " : ""}${m.displayName}`.slice(0, 100));
  }
  return payload;
}

export const manageButton = eventId => new ButtonBuilder().setCustomId(`evm:open:${eventId}`).setLabel("👥 Verwalten").setStyle(ButtonStyle.Secondary);

export async function handleEventManageInteraction({ i, db, client, config }) {
  const [, action, eventId] = i.customId.split(":");
  const roleIds = i.member?.roles?.cache ? [...i.member.roles.cache.keys()] : (i.member?.roles ?? []);
  if (!canManageSignups(config, { userId: i.user.id, roleIds, roleName: id => i.guild?.roles?.cache?.get(id)?.name })) return i.reply({ content: "Teilnehmer verwalten dürfen nur Turf Leader und höher (bzw. Event-Team/Leitung).", flags: MessageFlags.Ephemeral });
  const event = db.prepare("SELECT * FROM events WHERE id=? AND guild_id=?").get(eventId, i.guildId);
  if (!event || event.status !== "scheduled") return i.reply({ content: "Dieses Event ist nicht mehr offen.", flags: MessageFlags.Ephemeral });
  if (action === "open") return i.reply({ ...withNames(panel(db, event), i), flags: MessageFlags.Ephemeral });
  const c = i.client ?? client;
  if (action === "remove") {
    const removed = [], promoted = [];
    for (const userId of i.values ?? []) { const r = removeParticipant(db, { guildId: i.guildId, eventId, userId, actorId: i.user.id }); if (["left", "left_waitlist"].includes(r.status)) { removed.push(userId); promoted.push(...(r.promoted ?? [])); } }
    await afterChange({ db, client: c, config, event, removed, promoted, actorId: i.user.id });
    const fresh = withNames(panel(db, event), i);
    return i.update({ ...fresh, content: `↩️ ${removed.length} rausgenommen${promoted.length ? ` · ${promoted.length} nachgerückt` : ""}.\n\n${fresh.content}`.slice(0, 2000) });
  }
  if (action === "add") {
    const events = createEventService(db), added = [], waiting = [];
    for (const userId of i.values ?? []) {
      const user = i.users?.get?.(userId) ?? i.guild?.members?.cache?.get(userId)?.user;
      if (user?.bot) continue;
      const r = events.join({ guildId: i.guildId, eventId, userId, overlapMinutes: config.EVENT_OVERLAP_MINUTES ?? 0 });
      if (r.status === "joined") { added.push(userId); audit(db, i.guildId, i.user.id, "event.participant_added", userId, { eventId, name: event.name }); }
      else if (r.status === "waitlisted") waiting.push(userId);
      for (const s of r.switched ?? []) await refreshEventPosts({ db, client: c, config, event: s.event, cardOnly: true }).catch(() => {});
    }
    await afterChange({ db, client: c, config, event, added, actorId: i.user.id });
    const fresh = withNames(panel(db, event), i);
    return i.update({ ...fresh, content: `✅ ${added.length} eingetragen${waiting.length ? ` · ${waiting.length} auf die Warteliste (voll)` : ""}.\n\n${fresh.content}`.slice(0, 2000) });
  }
  return i.reply({ content: "Unbekannte Aktion.", flags: MessageFlags.Ephemeral });
}

export { afterChange as afterParticipantChange };
