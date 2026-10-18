import { randomUUID } from "node:crypto";
import { audit } from "./database.js";
import { deleteEventPosts, publishEvent } from "./event-posts.js";

/**
 * Staatliche Kontrolle: spontaner Angriff einer anderen Familie. Wird mit „Welche Familie“ und „Wann“ als normales
 * Event angekündigt (Anmeldung, Erinnerung, Anwesenheit im Event-Check, Win/Lose).
 */
export class ControlError extends Error {}

/** Wiener Uhrzeit (HH:MM) heute als Date; Eingaben: „jetzt“, „sofort“, „in 20“, „in 20 min“, „16:30“, „16.30“, „16“. */
export function parseWhen(input, timezone, reference = new Date()) {
  const raw = String(input ?? "").trim().toLowerCase().replace(/\s+uhr$/, "");
  if (!raw || ["jetzt", "sofort", "now", "gleich"].includes(raw)) return new Date(reference.getTime());
  const rel = /^in\s*(\d{1,3})\s*(m|min|minute|minuten)?$/.exec(raw);
  if (rel) return new Date(reference.getTime() + Number(rel[1]) * 60_000);
  const clock = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(raw);
  if (!clock) throw new ControlError("„Wann“ bitte als „jetzt“, „in 20“ (Minuten) oder Uhrzeit wie „16:30“ angeben.");
  const hour = Number(clock[1]), minute = Number(clock[2] ?? 0);
  if (hour > 23 || minute > 59) throw new ControlError("Ungültige Uhrzeit.");
  // Wanduhrzeit in der Zeitzone → UTC (Versatz über Intl ermitteln).
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(reference).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(reference.getTime() / 60_000) * 60_000;
  let at = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute) - offset);
  // Kurz nach Mitternacht „23:30“ eingegeben o. Ä.: mehr als 12 Std. in der Vergangenheit → morgen.
  if (at.getTime() < reference.getTime() - 12 * 3_600_000) at = new Date(at.getTime() + 86_400_000);
  if (at.getTime() < reference.getTime() - 10 * 60_000) throw new ControlError("Die Uhrzeit liegt schon in der Vergangenheit.");
  return at;
}

export async function announceControl({ db, client, config, actorId, family, when, mode = "defend" }) {
  const enemy = String(family ?? "").trim().replace(/\s+/g, " ");
  if (enemy.length < 2 || enemy.length > 60) throw new ControlError("Bitte die angreifende Familie angeben (2–60 Zeichen).");
  const startsAt = parseWhen(when, config.TIMEZONE);
  const id = randomUUID();
  const attack = mode === "attack";
  const event = { id, guild_id: config.DISCORD_GUILD_ID,
    name: (attack ? `🚩 Staatliche Kontrolle – Angriff auf ${enemy}` : `🛡️ Staatliche Kontrolle – Verteidigung gegen ${enemy}`).slice(0, 100),
    description: attack ? `Wir greifen **${enemy}** an! Alle, die können, anmelden und in den Call kommen.` : `**${enemy}** greift uns an! Alle, die können, sofort anmelden und in den Call kommen.`,
    starts_at: startsAt.toISOString(), location: "Staatliche Kontrolle", host_id: actorId, equipment: "", notes: "", max_participants: null, status: "scheduled" };
  const posted = await publishEvent({ db, client, config, event }).catch(error => { throw new ControlError(error.message); });
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO events(id,guild_id,channel_id,message_id,announce_channel_id,announce_message_id,name,description,starts_at,location,host_id,equipment,notes,max_participants,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',?)")
        .run(id, event.guild_id, posted.channelId, posted.messageId, posted.announceChannelId, posted.announceMessageId, event.name, event.description, event.starts_at, event.location, actorId, "", "", null, new Date().toISOString());
      audit(db, event.guild_id, actorId, "event.created", id, { name: event.name, startsAt: event.starts_at, channelId: posted.channelId, kind: attack ? "staatliche-kontrolle-angriff" : "staatliche-kontrolle-verteidigung" });
    })();
  } catch (error) { await deleteEventPosts({ client, posted }); throw error; }
  return { id, name: event.name, startsAt };
}
