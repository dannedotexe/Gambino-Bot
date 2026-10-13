/** Reine AutoMod-Logik ohne Discord-Zugriff, damit Regeln isoliert testbar sind. */

export const RULE_LABELS = {
  message_spam: "Nachrichten-Spam",
  duplicate_message: "Wiederholte Nachricht",
  blocked_term: "Gesperrter Begriff",
  unapproved_link: "Nicht erlaubter Link",
  join_raid: "Möglicher Join-Raid",
  message_flood: "Nachrichtenflut im Server",
  escalation: "Wiederholte Verstöße",
};

export function actionsForRule(rule, config) {
  return {
    message_spam: config.AUTOMOD_SPAM_ACTIONS,
    duplicate_message: config.AUTOMOD_DUPLICATE_ACTIONS,
    blocked_term: config.AUTOMOD_TERM_ACTIONS,
    unapproved_link: config.AUTOMOD_LINK_ACTIONS,
  }[rule] ?? ["alert"];
}

/** Ausnahmen: Moderatoren (Nachrichten verwalten), Staff-Rollen, konfigurierte Rollen und Channels. */
export function exemptionReason({ memberRoleIds = [], canManageMessages = false, channelId, parentId }, config, staffRoles = []) {
  if (canManageMessages) return "moderator_permission";
  if (staffRoles.some(id => memberRoleIds.includes(id))) return "staff_role";
  if ((config.AUTOMOD_EXEMPT_ROLES ?? []).some(id => memberRoleIds.includes(id))) return "exempt_role";
  if ((config.AUTOMOD_EXEMPT_CHANNELS ?? []).some(id => id === channelId || id === parentId)) return "exempt_channel";
  return null;
}

const normalize = text => String(text ?? "").toLocaleLowerCase("de-AT").replace(/\s+/g, " ").trim();

export function linkAllowed(raw, allowedDomains) {
  try {
    const host = new URL(raw.startsWith("www.") ? `https://${raw}` : raw).hostname.toLowerCase();
    return allowedDomains.some(domain => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`));
  } catch { return false; }
}

/**
 * Bewertet eine Nachricht. history ist die (bereits gefilterte) Liste früherer Nachrichten derselben Person
 * im Spam-Fenster: [{ at, content }]. Gibt die erste zutreffende Regel oder null zurück.
 */
export function evaluateMessage({ content, history = [] }, config) {
  if (history.length + 1 >= config.AUTOMOD_SPAM_COUNT) return "message_spam";
  const text = normalize(content);
  if (text && history.filter(entry => normalize(entry.content) === text).length + 1 >= config.AUTOMOD_DUPLICATE_COUNT) return "duplicate_message";
  if (text && config.AUTOMOD_BLOCKED_TERMS.some(term => term && text.includes(normalize(term)))) return "blocked_term";
  const urls = String(content ?? "").match(/(?:https?:\/\/|www\.)[^\s<>]+/gi) ?? [];
  if (urls.length && !urls.every(url => linkAllowed(url, config.AUTOMOD_ALLOWED_DOMAINS))) return "unapproved_link";
  return null;
}

/** Gleitendes Zeitfenster für Zähler (Joins, Nachrichten, Verstöße). */
export function slidingWindow(store, key, windowMs, now = Date.now(), value = null) {
  const entries = (store.get(key) ?? []).filter(entry => entry.at > now - windowMs);
  entries.push({ at: now, value });
  store.set(key, entries);
  return entries;
}
