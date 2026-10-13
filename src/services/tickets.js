import { audit } from "../database.js";

const now = () => new Date().toISOString();

/** Darf jemand ein Ticket bearbeiten? Staff/Leitung oder eine für die Kategorie zuständige Rolle. */
export function canHandleTicket({ memberRoleIds = [], isOwner = false }, ticket, config, staffRoles) {
  if (isOwner) return true;
  const categoryRoles = (config.TICKET_CATEGORIES_JSON ?? []).find(category => category.id === ticket.category)?.roleIds ?? [];
  return [...staffRoles, ...categoryRoles].some(id => memberRoleIds.includes(id));
}

/** Statusübergänge für Tickets: open -> (claim) -> closed -> (reopen) -> open. */
export function createTicketService(db) {
  const claim = db.transaction(({ guildId, ticketId, actorId }) => {
    const ts = now();
    const row = db.prepare("UPDATE tickets SET claimed_by=?,claimed_at=?,updated_at=? WHERE id=? AND guild_id=? AND status='open' AND claimed_by IS NULL RETURNING *").get(actorId, ts, ts, ticketId, guildId);
    if (row) audit(db, guildId, actorId, "ticket.claimed", row.user_id, { ticketId, category: row.category });
    return row ?? null;
  });

  const close = db.transaction(({ guildId, ticketId, actorId, transcript = [], reason = "" }) => {
    const ts = now();
    const row = db.prepare("UPDATE tickets SET status='closed',closed_at=?,closed_by=?,updated_at=? WHERE id=? AND guild_id=? AND status='open' RETURNING *").get(ts, actorId, ts, ticketId, guildId);
    if (!row) return null;
    db.prepare("INSERT INTO ticket_transcripts(ticket_id,messages,created_at) VALUES(?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET messages=excluded.messages,created_at=excluded.created_at").run(ticketId, JSON.stringify(transcript), ts);
    audit(db, guildId, actorId, "ticket.closed", row.user_id, { ticketId, channelId: row.channel_id, category: row.category, transcriptMessages: transcript.length, reason });
    return row;
  });

  const reopen = db.transaction(({ guildId, ticketId, actorId }) => {
    const row = db.prepare("UPDATE tickets SET status='open',closed_at=NULL,closed_by=NULL,updated_at=? WHERE id=? AND guild_id=? AND status='closed' AND channel_id IS NOT NULL RETURNING *").get(now(), ticketId, guildId);
    if (row) audit(db, guildId, actorId, "ticket.reopened", row.user_id, { ticketId, category: row.category });
    return row ?? null;
  });

  /** Channel wurde gelöscht: Ticket wird geschlossen, Daten bleiben erhalten und der Vorgang wird protokolliert. */
  const markChannelMissing = db.transaction(({ ticketId, actorId }) => {
    const ts = now();
    const row = db.prepare("UPDATE tickets SET status='closed',closed_at=COALESCE(closed_at,?),closed_by=COALESCE(closed_by,?),updated_at=? WHERE id=? AND (status='open' OR channel_id IS NOT NULL) RETURNING *").get(ts, actorId, ts, ticketId);
    if (!row) return null;
    audit(db, row.guild_id, actorId, "ticket.channel_missing", row.user_id, { ticketId, channelId: row.channel_id });
    db.prepare("UPDATE tickets SET channel_id=NULL WHERE id=?").run(ticketId);
    return row;
  });

  return { claim, close, reopen, markChannelMissing };
}
