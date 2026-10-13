/**
 * Verschiebt Ticket-Channels zwischen offener und geschlossener Kategorie. Die eigenen (privaten) Rechte des
 * Tickets bleiben erhalten (lockPermissions:false). Discord erlaubt höchstens 50 Channels pro Kategorie;
 * schlägt das Verschieben fehl, bleibt das Ticket trotzdem korrekt geschlossen bzw. geöffnet.
 */
async function move(channel, parentId, label) {
  if (!channel?.setParent || (channel.parentId ?? null) === (parentId ?? null)) return "unchanged";
  try { await channel.setParent(parentId ?? null, { lockPermissions: false, reason: label }); return "moved"; }
  catch (error) { console.warn(`Ticket-Channel ${channel.id} konnte nicht verschoben werden (${label}):`, error.message); return "failed"; }
}

export const moveTicketToClosed = (channel, config) =>
  config.CHANNEL_TICKET_CLOSED_CATEGORY ? move(channel, config.CHANNEL_TICKET_CLOSED_CATEGORY, "Ticket geschlossen") : Promise.resolve("disabled");

export const moveTicketToOpen = (channel, config) =>
  config.CHANNEL_TICKET_CLOSED_CATEGORY && channel?.parentId === config.CHANNEL_TICKET_CLOSED_CATEGORY
    ? move(channel, config.CHANNEL_TICKET_CATEGORY || null, "Ticket wieder geöffnet")
    : Promise.resolve("unchanged");
