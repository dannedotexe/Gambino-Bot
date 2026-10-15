const $ = id => document.getElementById(id);
const login = $("login"), dashboard = $("dashboard"), message = $("message");
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const state = { me: null, tab: "overview", names: {}, timezone: "Europe/Vienna", cache: {} };
const date = value => value ? new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeStyle: "short", timeZone: state.timezone }).format(new Date(value)) : "—";
const money = cents => `${cents < 0 ? "−" : ""}$${(Math.abs(Number(cents) || 0) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const who = id => id ? escapeHtml(state.names[id] || `Mitglied …${String(id).slice(-4)}`) : "—";
const empty = (text = "Zurzeit nichts offen.") => `<div class="empty">${escapeHtml(text)}</div>`;
const row = (title, sub, badge = "") => `<div class="row"><div><div class="row-title">${escapeHtml(title)}</div><div class="row-sub">${escapeHtml(sub)}</div></div>${badge ? `<span class="badge">${escapeHtml(badge)}</span>` : ""}</div>`;
const btn = (label, action, data = {}, kind = "") => `<button type="button" class="action ${kind}" data-action="${action}" ${Object.entries(data).map(([k, v]) => `data-${k}="${escapeHtml(v)}"`).join(" ")}>${escapeHtml(label)}</button>`;
const uuid = () => crypto.randomUUID();
/** Buttons zum Zurücknehmen (zählt nicht mehr, bleibt sichtbar) und endgültigen Löschen (nur Leitung) einer Verwarnung. */
function warningActions(w) {
  const caps = state.me.capabilities, me = state.me.member.id;
  // Eigene Verwarnungen darf nur jemand anderes entfernen – außer Bot-Owner (z. B. für Testeinträge).
  const own = w.user_id === me && !state.me.member.owner;
  if (own && caps.warnings) return '<span class="muted">Eigene Verwarnung – kann nur jemand anderes entfernen</span>';
  const revoke = caps.warnings && w.state === "active" && (caps.sanctions || w.actor_id === me);
  const remove = caps.leaders || state.me.member.owner;
  return `${revoke ? btn("Zurücknehmen", "warning-revoke", { id: w.id }) : ""}${remove ? btn("Löschen", "warning-delete", { id: w.id }, "reject") : ""}`;
}
/** Klickbarer Name, öffnet das Mitgliederprofil. */
const plink = id => id ? `<button type="button" class="name-link" data-action="profile" data-user="${escapeHtml(id)}">${who(id)}</button>` : "—";
let toastTimer;

const labels = {
  "application.submitted": "Antrag eingereicht", "application.claimed": "Antrag übernommen", "application.accepted": "Antrag angenommen", "application.rejected": "Antrag abgelehnt", "application.withdrawn": "Antrag zurückgezogen", "application.commented": "Antragsnotiz", "application.role_granted": "Rang-Rolle vergeben", "application.role_failed": "Rollenvergabe fehlgeschlagen", "application.role_skipped": "Keine Rang-Rolle vergeben",
  "ticket.created": "Ticket eröffnet", "ticket.claimed": "Ticket übernommen", "ticket.closed": "Ticket geschlossen", "ticket.reopened": "Ticket wieder geöffnet", "ticket.channel_missing": "Ticket-Channel gelöscht",
  "event.created": "Event veröffentlicht", "event.updated": "Event geändert", "event.ended": "Event beendet", "event.cancelled": "Event abgesagt", "event.attendance": "Anwesenheit erfasst", "event.participation": "Event-Teilnahme",
  "finance.credit": "Gutschrift verbucht", "finance.account_opened": "Familienkonto angelegt", "finance.account_closed": "Familienkonto gelöscht", "finance.closure_requested": "Konto-Löschung angefragt", "finance.closure_dismissed": "Konto behalten", "finance.payout": "Auszahlung gebucht", "finance.correction": "Korrekturbuchung", "finance.failed": "Buchung fehlgeschlagen",
  "sanction.created": "Sanktion vorgemerkt", "sanction.applied": "Sanktion teilweise verrechnet", "sanction.settled": "Sanktion beglichen", "sanction.void": "Sanktion aufgehoben", "sanction.corrected": "Sanktion korrigiert", "sanction.refunded": "Sanktion erstattet", "sanction.warning": "Verwarnung", "sanction.warning_revoked": "Verwarnung zurückgenommen", "sanction.warning_deleted": "Verwarnung gelöscht", "sanction.warning_timeout": "Timeout nach Verwarnungen", "sanction.warning_timeout_failed": "Timeout nach Verwarnungen fehlgeschlagen",
  "giveaway.created": "Giveaway gestartet", "giveaway.ended": "Giveaway ausgelost", "giveaway.cancelled": "Giveaway abgebrochen", "giveaway.draw_requested": "Giveaway vorzeitig ausgelost", "giveaway.entry": "Giveaway-Teilnahme",
  "absence.created": "Abmeldung eingetragen", "absence.ended": "Abmeldung beendet", "activity.reminder": "Inaktivitäts-Erinnerung",
  "moderation.timeout": "Timeout", "moderation.untimeout": "Timeout aufgehoben", "moderation.kick": "Kick", "moderation.ban": "Bann", "moderation.unban": "Entbannt",
  "moderation.timeout_failed": "Timeout fehlgeschlagen", "moderation.kick_failed": "Kick fehlgeschlagen", "moderation.ban_failed": "Bann fehlgeschlagen", "moderation.unban_failed": "Entbannen fehlgeschlagen", "moderation.untimeout_failed": "Timeout-Aufhebung fehlgeschlagen",
  "automod.action": "AutoMod-Maßnahme", "admin.override": "Bot-Owner-Override", "admin.data_reset": "Testdaten zurückgesetzt", "admin.export": "Daten exportiert", "announcement.created": "Ankündigung gesendet", "announcement.scheduled": "Ankündigung geplant", "announcement.cancelled": "Ankündigung abgebrochen", "event.min_not_reached": "Zu wenige Anmeldungen", "event.noshow_limit": "No-Show-Grenze erreicht", "poll.created": "Abstimmung gestartet", "poll.closed": "Abstimmung beendet", "poll.cancelled": "Abstimmung abgebrochen", "rank.promotion": "Beförderung", "rank.demotion": "Degradierung", "rank.change": "Rangänderung", "config.changed": "Einstellung geändert", "config.panel_published": "Dashboard-Panel veröffentlicht", "config.automod_synced": "AutoMod synchronisiert",
};
const statusLabels = { open: "Offen", review: "In Prüfung", accepted: "Angenommen", rejected: "Abgelehnt", withdrawn: "Zurückgezogen", partial: "Teilweise verrechnet", paid: "Beglichen", void: "Aufgehoben", scheduled: "Geplant", ended: "Beendet", cancelled: "Abgesagt", active: "Aktiv", closed: "Geschlossen", signed_up: "Angemeldet", present: "Anwesend", absent: "Abwesend" };
const answerLabels = { name: "Ingame-Name", alter: "Alter", erfahrung: "Grand-RP-Erfahrung", motivation: "Motivation", aktivitaet: "Aktivität", aktueller_rang: "Aktueller Rang", ziel_rang: "Beantragter Rang", begruendung: "Begründung" };
const txLabels = { credit: "Gutschrift", payout: "Auszahlung", correction_credit: "Korrektur (+)", correction_debit: "Korrektur (−)", sanction_refund: "Sanktions-Erstattung" };
const TABS = [
  ["overview", "Übersicht", c => c.team], ["mine", "Mein Bereich", c => c.mine], ["applications", "Anträge", c => c.applications], ["tickets", "Tickets", c => c.tickets],
  ["events", "Events", c => c.staff], ["members", "Mitglieder", c => c.staff], ["activity", "Aktivität", c => c.staff], ["finance", "Familienkonto", c => c.financeView], ["payouts", "Auszahlungen", c => c.financeView], ["sanctions", "Sanktionen", c => c.sanctionsView],
  ["announcements", "Ankündigungen", c => c.announcements], ["polls", "Abstimmungen", c => c.polls], ["giveaways", "Giveaways", c => c.giveaways], ["stats", "Statistik", c => c.staff], ["audit", "Protokoll", c => c.staff], ["status", "Status", c => c.admin], ["settings", "Einstellungen", c => c.settings],
];

const ICONS = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z",
  applications: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8",
  tickets: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z M13 5v2 M13 17v2 M13 11v2",
  events: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M16 2v4 M8 2v4 M3 10h18",
  finance: "M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  payouts: "M2 7h20v12H2z M2 11h20 M6 15h4 M16 3l3 4 M8 3L5 7",
  sanctions: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M12 8v4 M12 16h.01",
  giveaways: "M20 12v10H4V12 M2 7h20v5H2z M12 22V7 M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z",
  stats: "M3 3v18h18 M18 17V9 M13 17V5 M8 17v-3",
  audit: "M12 8v4l3 3 M3.05 11a9 9 0 1 1 .5 4 M3 4v5h5",
  members: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0 .01 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  announcements: "M3 11l18-8v18L3 13z M11.6 16.8a3 3 0 1 1-5.8-1.6",
  polls: "M4 20V10 M10 20V4 M16 20v-7 M22 20H2",
  status: "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20 M9 12l2 2 4-4",
  mine: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8",
  settings: "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6",
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] ?? ICONS.overview}"/></svg>`;
const NAV_GROUPS = [["", ["overview", "mine"]], ["Familie", ["members", "activity", "applications", "events"]], ["Support", ["tickets"]], ["Finanzen", ["finance", "payouts", "sanctions"]], ["Community", ["announcements", "polls", "giveaways"]], ["Auswertung", ["stats", "audit"]], ["Verwaltung", ["status", "settings"]]];

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers ?? {}) } });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (response.status === 401) { location.reload(); throw new Error("Bitte melde dich erneut an."); }
  if (response.status === 403 && path !== "/api/me") recheckAccess();
  if (!response.ok) throw new Error(data.error || "Die Aktion konnte nicht ausgeführt werden.");
  if (data.names) Object.assign(state.names, data.names);
  return data;
}
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
function notify(text, kind = "success") {
  const toast = $("toast"); toast.textContent = text; toast.dataset.kind = kind; toast.classList.add("visible");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("visible"), 5200);
}

// ------------------------------------------------------------------ Dialog
let dialogHandler = null;
function fieldHtml(field, index) {
  const id = `f-${index}`, required = field.required ? "required" : "", value = escapeHtml(field.value ?? "");
  const hint = field.hint ? ` <small>${escapeHtml(field.hint)}</small>` : "";
  if (field.type === "textarea") return `<label for="${id}">${escapeHtml(field.label)}${hint}<textarea id="${id}" name="${field.name}" rows="${field.rows ?? 3}" maxlength="${field.max ?? 1000}" ${required} placeholder="${escapeHtml(field.placeholder ?? "")}">${value}</textarea></label>`;
  if (field.type === "select") return `<label for="${id}">${escapeHtml(field.label)}${hint}<select id="${id}" name="${field.name}" ${required}>${field.options.map(([v, l]) => `<option value="${escapeHtml(v)}" ${String(v) === String(field.value ?? "") ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select></label>`;
  if (field.type === "checks") return `<fieldset class="checks" data-name="${field.name}"><legend>${escapeHtml(field.label)}${hint}</legend>${field.options.map(([v, l]) => `<label class="check"><input type="checkbox" value="${escapeHtml(v)}" ${(field.value ?? []).map(String).includes(String(v)) ? "checked" : ""}> ${escapeHtml(l)}</label>`).join("")}</fieldset>`;
  if (field.type === "member") return `<label for="${id}">${escapeHtml(field.label)}${hint}<div class="member-picker"><input id="${id}" name="${field.name}" data-member data-id="${escapeHtml(field.memberId ?? "")}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list" autocomplete="off" spellcheck="false" ${required} placeholder="Name, Ingame-ID oder @Benutzer eingeben …" value="${value}"><div id="${id}-list" class="suggest" role="listbox" hidden></div></div></label>`;
  const type = { money: "text", number: "number", datetime: "datetime-local" }[field.type] ?? "text";
  const extra = field.type === "money" ? 'inputmode="decimal" placeholder="z. B. 2500000 oder 12,50"' : field.type === "number" ? `min="${field.min ?? 1}" max="${field.maxValue ?? 100000}"` : `maxlength="${field.max ?? 200}" placeholder="${escapeHtml(field.placeholder ?? "")}"`;
  return `<label for="${id}">${escapeHtml(field.label)}${hint}<input id="${id}" name="${field.name}" type="${type}" ${extra} ${required} value="${value}"></label>`;
}
/** Öffnet einen Formular-Dialog. onSubmit bekommt die Werte; ein Fehler bleibt im Dialog sichtbar. */
function openForm({ eyebrow = "GAMBINOS", title, intro = "", fields = [], submit = "Speichern", danger = false, onSubmit, wide = false }) {
  $("dialog").classList.toggle("wide", wide);
  $("dialog-eyebrow").textContent = eyebrow; $("dialog-title").textContent = title; $("dialog-intro").innerHTML = intro;
  $("dialog-fields").innerHTML = fields.map(fieldHtml).join(""); $("dialog-error").textContent = "";
  const submitButton = $("dialog-submit"); submitButton.textContent = submit; submitButton.className = danger ? "danger" : "primary-btn"; submitButton.hidden = !onSubmit; submitButton.disabled = false;
  $("dialog-cancel").textContent = onSubmit ? "Abbrechen" : "Schließen";
  dialogHandler = onSubmit ? { onSubmit, fields } : null;
  $("dialog").showModal();
  $("dialog-fields").querySelector("input,textarea,select")?.focus();
}
const openInfo = (title, html, eyebrow = "DETAILS", wide = false) => openForm({ eyebrow, title, intro: html, wide });
function memberValue(input) {
  if (input.dataset.id) return input.dataset.id;
  const match = /(\d{17,20})\s*\)?\s*$/.exec(input.value.trim());
  return match ? match[1] : "";
}
$("dialog-form").addEventListener("submit", async event => {
  if (event.submitter?.value !== "ok" || !dialogHandler) return;
  event.preventDefault();
  const form = event.currentTarget, values = {};
  for (const field of dialogHandler.fields) {
    if (field.type === "checks") { values[field.name] = [...form.querySelectorAll(`fieldset[data-name="${field.name}"] input:checked`)].map(box => box.value); if (field.required && !values[field.name].length) { $("dialog-error").textContent = `${field.label}: bitte mindestens eine Auswahl treffen.`; return; } continue; }
    const input = form.elements[field.name];
    values[field.name] = field.type === "member" ? memberValue(input) : input.value.trim();
    if (field.required && !values[field.name]) { $("dialog-error").textContent = field.type === "member" ? `${field.label}: bitte ein Mitglied aus der Vorschlagsliste wählen.` : `${field.label} ist erforderlich.`; input.focus(); return; }
  }
  const button = $("dialog-submit"); button.disabled = true; $("dialog-error").textContent = "";
  try {
    const result = await dialogHandler.onSubmit(values);
    if (result?.keepOpen) { button.disabled = false; return; }
    $("dialog").close(); if (result?.message) notify(result.message); await refresh();
  } catch (error) { $("dialog-error").textContent = error.message; button.disabled = false; }
});
// ------------------------------------------------------------------ Mitglieder-Vorschläge
let memberTimer, memberRequest = 0;
const suggestBox = input => document.getElementById(input.getAttribute("aria-controls"));
function closeSuggest(input) { const box = suggestBox(input); if (box) { box.hidden = true; box.innerHTML = ""; } input.setAttribute("aria-expanded", "false"); }
function chooseMember(input, item) {
  input.value = item.dataset.name; input.dataset.id = item.dataset.id; state.names[item.dataset.id] = item.dataset.name;
  closeSuggest(input); input.classList.add("picked");
}
async function loadSuggestions(input) {
  const q = input.value.trim(), request = ++memberRequest, box = suggestBox(input);
  if (!q) return closeSuggest(input);
  box.hidden = false; input.setAttribute("aria-expanded", "true");
  box.innerHTML = '<div class="suggest-empty">Suche …</div>';
  try {
    const data = await api(`/api/members?q=${encodeURIComponent(q)}`);
    if (request !== memberRequest) return;
    box.innerHTML = data.members.length ? data.members.map((m, index) => `<button type="button" role="option" class="suggest-item ${index === 0 ? "active" : ""}" data-id="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}">${m.avatar ? `<img src="${escapeHtml(m.avatar)}" alt="" referrerpolicy="no-referrer">` : `<span class="suggest-initial">${escapeHtml((m.name.match(/\p{L}/u)?.[0] ?? "?").toUpperCase())}</span>`}<span><b>${escapeHtml(m.name)}</b><small>@${escapeHtml(m.tag)}</small></span></button>`).join("")
      : '<div class="suggest-empty">Kein Mitglied gefunden.</div>';
  } catch (error) { if (request === memberRequest) box.innerHTML = `<div class="suggest-empty">${escapeHtml(error.message)}</div>`; }
}
document.addEventListener("input", event => {
  const input = event.target;
  if (input.matches?.("input[data-member]")) {
    input.dataset.id = ""; input.classList.remove("picked");
    clearTimeout(memberTimer); memberTimer = setTimeout(() => loadSuggestions(input), 150);
  }
  if (input.matches?.("input.search")) filterList(input);
});
document.addEventListener("keydown", event => {
  const input = event.target;
  if (!input.matches?.("input[data-member]")) return;
  const box = suggestBox(input), items = box && !box.hidden ? [...box.querySelectorAll(".suggest-item")] : [];
  if (event.key === "Escape" && !box.hidden) { event.preventDefault(); event.stopPropagation(); return closeSuggest(input); }
  if (!items.length) return;
  const current = items.findIndex(item => item.classList.contains("active"));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((item, index) => item.classList.toggle("active", index === next)); items[next].scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" || event.key === "Tab") {
    if (event.key === "Enter") event.preventDefault();
    chooseMember(input, items[Math.max(0, current)]);
  }
});
document.addEventListener("mousedown", event => {
  const item = event.target.closest?.(".suggest-item");
  if (item) { event.preventDefault(); chooseMember(item.closest(".member-picker").querySelector("input"), item); return; }
  document.querySelectorAll("input[data-member][aria-expanded=true]").forEach(input => { if (!input.closest(".member-picker").contains(event.target)) closeSuggest(input); });
});
function filterList(input) {
  const term = input.value.trim().toLocaleLowerCase("de-AT"), target = $(input.dataset.target);
  target?.querySelectorAll(".manage-card,.table-row,.setting").forEach(card => { card.hidden = Boolean(term) && !card.textContent.toLocaleLowerCase("de-AT").includes(term); });
}
const confirmAction = (title, intro, submit, action, danger = true) => openForm({ eyebrow: "BESTÄTIGUNG", title, intro: `<p>${intro}</p>`, submit, danger, onSubmit: action });
const memberField = (value = "", label = "Mitglied") => ({ name: "userId", label, type: "member", required: true, value: value ? state.names[value] ?? `Mitglied …${String(value).slice(-4)}` : "", memberId: value || "" });

// ------------------------------------------------------------------ Tabs
function renderTabs() {
  const caps = state.me.capabilities, allowed = new Map(TABS.filter(([, , ok]) => ok(caps)).map(([id, label]) => [id, label]));
  const badge = id => { const n = state.badges?.[id]; return n ? `<span class="nav-badge">${n > 99 ? "99+" : n}</span>` : ""; };
  $("tabs").innerHTML = NAV_GROUPS.map(([group, ids]) => {
    const items = ids.filter(id => allowed.has(id));
    if (!items.length) return "";
    return `${group ? `<div class="nav-group">${escapeHtml(group)}</div>` : ""}${items.map(id => `<button type="button" class="nav-item ${state.tab === id ? "active" : ""}" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ""}>${icon(id)}<span>${escapeHtml(allowed.get(id))}</span>${badge(id)}</button>`).join("")}`;
  }).join("");
  $("page-title").textContent = allowed.get(state.tab) ?? "Übersicht";
  document.title = `${allowed.get(state.tab) ?? "Übersicht"} · Gambinos`;
  for (const [id] of TABS) $(`tab-${id}`).classList.toggle("hidden", id !== state.tab);
  document.querySelectorAll(".needs-staff").forEach(el => el.classList.toggle("hidden", !caps.staff));
  document.querySelectorAll(".needs-events").forEach(el => el.classList.toggle("hidden", !caps.events));
  document.querySelectorAll(".needs-finance").forEach(el => el.classList.toggle("hidden", !caps.finance));
  document.querySelectorAll(".needs-sanctions").forEach(el => el.classList.toggle("hidden", !caps.sanctions));
  document.querySelectorAll(".needs-warnings").forEach(el => el.classList.toggle("hidden", !caps.warnings));
}
async function showTab(id) {
  state.tab = id; history.replaceState(null, "", `#${id}`); closeMenu(); renderTabs(); window.scrollTo({ top: 0 }); await refresh();
}
let loadingCount = 0;
async function refresh() {
  loadingCount++; document.body.classList.add("is-loading");
  try { await (loaders[state.tab] ?? loadOverview)(); }
  catch (error) { notify(error.message, "error"); }
  finally { if (--loadingCount === 0) document.body.classList.remove("is-loading"); }
}
function openMenu() { document.body.classList.add("menu-open"); $("menu-toggle").setAttribute("aria-expanded", "true"); }
function closeMenu() { document.body.classList.remove("menu-open"); $("menu-toggle").setAttribute("aria-expanded", "false"); }
/** Zähler offener Arbeit in der Navigation. */
function applyBadges(data) {
  state.badges = { tickets: data.stats.tickets, applications: data.stats.applications, finance: (data.todo?.payoutsDue ?? 0) + (data.todo?.accountClosures ?? 0) };
  renderTabs();
}

// ------------------------------------------------------------------ Übersicht
async function loadOverview() {
  const data = await api("/api/overview"), caps = state.me.capabilities, todo = data.todo ?? {};
  applyBadges(data);
  // formatToParts statt format: „de-AT“ liefert sonst „18 Uhr“ und daraus wird keine Zahl.
  const hour = Number(new Intl.DateTimeFormat("de-AT", { hour: "numeric", hourCycle: "h23", timeZone: state.timezone }).formatToParts(new Date()).find(p => p.type === "hour")?.value);
  const firstName = String(state.me.member.name ?? "").replace(/^\d+\s*\|\s*/, "").split(" ")[0] || state.me.member.name;
  $("greeting").textContent = `${hour >= 5 && hour < 11 ? "Guten Morgen" : hour >= 11 && hour < 18 ? "Guten Tag" : hour >= 18 && hour < 23 ? "Guten Abend" : "Hallo"}, ${firstName}`;
  const quick = [
    caps.events && ["event-create", "Event planen", "events"], caps.finance && ["credit", "Gutschrift", "finance"],
    caps.sanctions && ["sanction-create", "Sanktion", "sanctions"], caps.giveaways && ["giveaway-create", "Giveaway", "giveaways"],
  ].filter(Boolean);
  $("quick-actions").innerHTML = quick.map(([action, label, ic]) => `<button type="button" class="quick-btn" data-action="${action}">${icon(ic)}<span>${escapeHtml(label)}</span></button>`).join("");
  const cards = [
    ["Mitglieder", data.stats.members ?? "—", "overview", null], ["Offene Tickets", data.stats.tickets, "tickets", caps.tickets && "tickets"],
    ["Offene Anträge", data.stats.applications, "applications", caps.applications && "applications"], ["Kommende Events", data.stats.events, "events", caps.staff && "events"],
    ["Aktive Giveaways", data.stats.giveaways, "giveaways", caps.giveaways && "giveaways"], ...(data.stats.sanctions == null ? [] : [["Offene Sanktionen", data.stats.sanctions, "sanctions", caps.sanctionsView && "sanctions"]]),
  ];
  $("stats").innerHTML = cards.map(([label, value, ic, tab]) => `<${tab ? `button type="button" data-tab="${tab}"` : "div"} class="stat ${tab ? "clickable" : ""}"><span class="symbol">${icon(ic)}</span><div class="label">${label}</div><div class="value">${escapeHtml(value)}</div></${tab ? "button" : "div"}>`).join("");
  const todoItems = [
    [todo.unclaimedTickets, "Tickets ohne Bearbeiter", "Jemand wartet auf eine Antwort.", "tickets", caps.tickets],
    [todo.openApplications, "Neue Anträge", "Noch von niemandem übernommen.", "applications", caps.applications],
    [todo.reviewApplications, "Anträge in Prüfung", "Warten auf eine Entscheidung.", "applications", caps.applications],
    [todo.overdueEvents, "Events nicht beendet", "Startzeit ist über 3 Stunden vorbei – beenden und Anwesenheit eintragen.", "events", caps.events],
    [todo.accountClosures, "Konto-Löschungen bestätigen", "Mitglieder haben die Familie verlassen – Konto löschen oder behalten?", "finance", caps.financeView],
    [todo.attendanceOpen, "Anwesenheit eintragen", "Beendete Events ohne abgeschlossene Anwesenheit – erst danach zählen No-Shows.", "events", caps.events],
    [todo.payoutsDue, "Auszahlungen möglich", "Mitglieder mit auszahlbarem Familienguthaben.", "finance", caps.financeView],
    [todo.eventsNext24h, "Events in den nächsten 24 Std.", "Teilnehmerliste prüfen.", "events", caps.staff],
  ].filter(([n, , , , ok]) => ok && n > 0);
  $("todo").innerHTML = todoItems.length ? todoItems.map(([n, title, sub, tab]) => `<button type="button" class="todo-item" data-tab="${tab}"><span class="todo-count">${n}</span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(sub)}</small></span><span class="todo-arrow">→</span></button>`).join("")
    : '<div class="all-done"><b>Alles erledigt</b><small>Gerade wartet nichts auf dich.</small></div>';
  $("events").innerHTML = data.events.map(event => row(event.name, `${date(event.starts_at)}${event.location ? ` · ${event.location}` : ""}`)).join("") || empty("Keine anstehenden Events.");
  let activity = data.activity.map(item => row(labels[item.action] || item.action, date(item.created_at)));
  if (caps.staff) {
    const audit = await api("/api/audit").catch(() => null);
    if (audit) activity = audit.entries.slice(0, 7).map(e => row(labels[e.action] ?? e.action, `${state.names[e.actor_id] ?? "Bot"} · ${date(e.created_at)}`));
  }
  $("activity").innerHTML = activity.join("") || empty("Noch keine Aktionen.");
  $("updated-at").textContent = new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: state.timezone }).format(new Date());
  if (data.finance) { $("finance-panel").classList.remove("hidden"); $("finance").innerHTML = `<div class="finance-item"><span>Familienkonten</span><b>${data.finance.balances}</b></div><div class="finance-item"><span>Offene Sanktionsreste</span><b>${money(data.finance.openSanctions)}</b></div>`; }
}

// ------------------------------------------------------------------ Anträge
async function loadApplications() {
  const status = $("applications-filter").value;
  const data = await api(`/api/applications?status=${status}`);
  state.cache.applications = Object.fromEntries(data.applications.map(a => [a.id, a]));
  const caps = state.me.capabilities, rankRoles = state.me.settings.rankRoles;
  $("applications-list").innerHTML = data.applications.map(item => {
    let answers = {}; try { answers = JSON.parse(item.answers); } catch { /* Altbestand */ }
    const facts = Object.entries(answers).map(([key, value]) => `<div class="answer"><span>${escapeHtml(answerLabels[key] || key.replaceAll("_", " "))}</span><b>${escapeHtml(value)}</b></div>`).join("");
    const notes = item.notes.length ? `<div class="notes">${item.notes.map(n => `<div class="note"><b>${who(n.author_id)}</b> · ${date(n.created_at)}<p>${escapeHtml(n.note)}</p></div>`).join("")}</div>` : "";
    const open = ["open", "review"].includes(item.status);
    const actions = [
      item.status === "open" ? btn("Übernehmen", "app-claim", { id: item.id }, "primary-action") : "",
      open ? btn("Annehmen", "app-accept", { id: item.id }, "accept") : "", open ? btn("Ablehnen", "app-reject", { id: item.id }, "reject") : "",
      btn("Notiz", "app-note", { id: item.id }),
      item.kind === "rang" && item.status === "accepted" && caps.leaders && rankRoles.length && !item.granted_role ? btn("Rang-Rolle vergeben", "app-role", { id: item.id }, "primary-action") : "",
    ].join("");
    return `<article class="manage-card"><div class="manage-card-head"><div><span class="type-pill">${item.kind === "rang" ? "Rang-Antrag" : "Bewerbung"}</span><h3>${who(item.user_id)}</h3></div><span class="badge status-${item.status}">${statusLabels[item.status] ?? item.status}</span></div>
      <p class="manage-meta">Eingereicht ${date(item.created_at)}${item.reviewer_id ? ` · Bearbeitung: <b>${who(item.reviewer_id)}</b>` : ""}${item.review_note ? ` · Begründung: ${escapeHtml(item.review_note)}` : ""}${item.granted_role ? ` · Rolle vergeben` : ""}</p>
      <div class="answers">${facts || "Keine Angaben gespeichert."}</div>${notes}<div class="actions">${actions}</div></article>`;
  }).join("") || empty(status === "open" ? "Keine offenen Anträge." : "Keine abgeschlossenen Anträge.");
  document.querySelectorAll("#tab-applications .search").forEach(filterList);
}

// ------------------------------------------------------------------ Tickets
async function loadTickets() {
  const status = $("tickets-filter").value;
  const data = await api(`/api/tickets?status=${status}`);
  $("tickets-list").innerHTML = data.tickets.map(t => `<article class="manage-card compact"><div class="manage-card-head"><div><span class="type-pill">${escapeHtml(t.category_label)}</span><h3>${who(t.user_id)}</h3></div><span class="badge">${t.status === "closed" ? "Geschlossen" : t.claimed_by ? "In Bearbeitung" : "Offen"}</span></div>
    <p class="manage-meta">Eröffnet ${date(t.created_at)}${t.claimed_by ? ` · Bearbeiter: <b>${who(t.claimed_by)}</b>` : " · wartet auf Staff"}${t.closed_at ? ` · geschlossen ${date(t.closed_at)} von ${who(t.closed_by)}` : ""}${t.channel_id ? "" : " · Channel gelöscht"}</p>
    <div class="actions">${t.status === "open" && !t.claimed_by ? btn("Übernehmen", "ticket-claim", { id: t.id }, "primary-action") : ""}${t.status === "open" ? btn("Schließen", "ticket-close", { id: t.id }, "reject") : ""}${t.status === "closed" && t.channel_id ? btn("Wieder öffnen", "ticket-reopen", { id: t.id }) : ""}${t.has_transcript ? btn("Transkript", "ticket-transcript", { id: t.id }) : ""}</div></article>`).join("") || empty(status === "open" ? "Keine offenen Tickets." : "Keine geschlossenen Tickets.");
  document.querySelectorAll("#tab-tickets .search").forEach(filterList);
}

// ------------------------------------------------------------------ Events
function toLocalInput(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: state.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function fromLocalInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!match) throw new Error("Bitte Datum und Uhrzeit auswählen.");
  const [, y, m, d, h, min] = match; return `${d}.${m}.${y} ${h}:${min}`;
}
const eventFields = (e = {}) => [
  { name: "name", label: "Eventname", required: true, max: 100, value: e.name, placeholder: "z. B. Familienbesprechung" },
  { name: "startsAt", label: `Datum & Uhrzeit (${state.timezone})`, type: "datetime", required: true, value: e.starts_at ? toLocalInput(e.starts_at) : "" },
  { name: "location", label: "Treffpunkt", required: true, max: 100, value: e.location },
  { name: "description", label: "Beschreibung", type: "textarea", max: 1000, value: e.description },
  { name: "equipment", label: "Ausrüstung", hint: "(optional)", max: 500, value: e.equipment },
  { name: "notes", label: "Hinweise", hint: "(optional)", max: 500, value: e.notes },
  { name: "maximum", label: "Max. Teilnehmer", hint: "(leer = kein Limit)", type: "number", min: 1, maxValue: 500, value: e.max_participants ?? "" },
  { name: "minimum", label: "Mindestteilnehmer", hint: "(leer = Standard aus den Einstellungen)", type: "number", min: 1, maxValue: 500, value: e.min_participants ?? "" },
];
const DAYS = [["1", "Mo"], ["2", "Di"], ["3", "Mi"], ["4", "Do"], ["5", "Fr"], ["6", "Sa"], ["7", "So"]];
const seriesFields = (s = {}) => [
  { name: "name", label: "Name", required: true, max: 100, value: s.name },
  { name: "kind", label: "Art", type: "select", value: s.kind ?? "scheduled", options: [["scheduled", "Feste Termine (automatisch ankündigen)"], ["flexible", "Flexibel verfügbar (nur Übersicht)"]] },
  { name: "weekdays", label: "Wochentage", hint: "(bei festen Terminen)", type: "checks", options: DAYS, value: s.weekdays ? String(s.weekdays).split(",") : ["1", "2", "3", "4", "5", "6", "7"] },
  { name: "times", label: "Uhrzeiten", hint: "(z. B. 20:20 oder 10:30, 16:30, 22:30)", max: 120, value: s.times ? String(s.times).split(",").join(", ") : "" },
  { name: "availability", label: "Verfügbarkeit", hint: "(bei flexibel, z. B. „alle 3 Stunden möglich“)", max: 200, value: s.availability },
  { name: "location", label: "Treffpunkt", hint: "(optional)", max: 100, value: s.location },
  { name: "description", label: "Beschreibung", hint: "(optional)", type: "textarea", rows: 2, max: 1000, value: s.description },
  { name: "maxParticipants", label: "Max. Teilnehmer", hint: "(leer = kein Limit)", type: "number", min: 1, maxValue: 500, value: s.max_participants ?? "" },
  { name: "minParticipants", label: "Mindestteilnehmer", hint: "(leer = Standard aus den Einstellungen)", type: "number", min: 1, maxValue: 500, value: s.min_participants ?? "" },
  { name: "leadMinutes", label: "Ankündigung … Minuten vorher", type: "number", min: 5, maxValue: 1440, value: s.lead_minutes ?? 120 },
];
async function loadSeries() {
  const data = await api("/api/series"), caps = state.me.capabilities;
  state.cache.series = Object.fromEntries(data.series.map(s => [s.id, s]));
  const warn = !data.announcementChannel && data.series.some(s => s.active && s.kind === "scheduled") ? '<p class="warn-text">Kein Event-Ankündigungs-Channel eingestellt – aktive Termine können nicht angekündigt werden (Einstellungen → Channels).</p>' : "";
  $("series-list").innerHTML = warn + (data.series.map(s => `<div class="series ${s.active ? "on" : ""}"><button type="button" class="switch" role="switch" aria-checked="${s.active}" ${caps.events ? "" : "disabled"} data-action="series-toggle" data-id="${escapeHtml(s.id)}" data-active="${s.active ? "1" : "0"}" title="${s.active ? "Aktiv – klicken zum Deaktivieren" : "Inaktiv – klicken zum Aktivieren"}"><span></span></button>
    <div class="series-main"><b>${escapeHtml(s.name)}</b><small>${escapeHtml(s.schedule)}${s.next && s.active ? ` · nächster Termin ${date(s.next)}` : ""}</small></div>
    <span class="badge">${s.kind === "scheduled" ? "Fest" : "Flexibel"}</span>${caps.events ? `<span class="actions tight">${btn("Bearbeiten", "series-edit", { id: s.id })}${btn("Löschen", "series-delete", { id: s.id }, "reject")}</span>` : ""}</div>`).join("") || empty("Keine Aktivitäten angelegt."));
}
async function loadEvents() {
  await loadSeries();
  const scope = $("events-filter").value, caps = state.me.capabilities;
  const data = await api(`/api/events?scope=${scope}`);
  state.cache.events = Object.fromEntries(data.events.map(e => [e.id, e]));
  $("events-list").innerHTML = data.events.map(e => {
    const active = e.participants.filter(p => p.status !== "absent");
    const chips = e.participants.map(p => `<span class="chip chip-${p.status}">${who(p.user_id)}${p.status !== "signed_up" ? ` · ${statusLabels[p.status]}` : ""}</span>`).join("");
    const actions = caps.events ? [
      e.status === "scheduled" ? btn("Bearbeiten", "event-edit", { id: e.id }) : "",
      e.status !== "cancelled" ? btn("Anwesenheit", "event-attendance", { id: e.id }, "primary-action") : "",
      e.status !== "cancelled" && !e.attendance_closed_at && new Date(e.starts_at) <= new Date() ? btn("Anwesenheit abschließen", "event-att-close", { id: e.id }, "accept") : "",
      e.status === "scheduled" && new Date(e.starts_at) > new Date() ? btn("Beenden", "event-end", { id: e.id }, "accept") : "",
      e.status === "scheduled" ? btn("Absagen", "event-cancel", { id: e.id }, "reject") : "",
    ].join("") : "";
    return `<article class="manage-card compact"><div class="manage-card-head"><div><span class="type-pill">${statusLabels[e.status]}</span>${e.status !== "cancelled" && !e.attendance_closed_at && new Date(e.starts_at) <= new Date() ? ' <span class="type-pill warn">Anwesenheit offen</span>' : e.attendance_closed_at ? ' <span class="type-pill">✓ Anwesenheit</span>' : ""}<h3>${escapeHtml(e.name)}</h3></div><span class="badge">${active.length}${e.max_participants ? `/${e.max_participants}` : ""} Teilnehmende</span></div>
      <p class="manage-meta">${date(e.starts_at)} · ${escapeHtml(e.location)} · Veranstalter: <b>${who(e.host_id)}</b>${e.equipment ? ` · Ausrüstung: ${escapeHtml(e.equipment)}` : ""}</p>
      ${e.description ? `<p class="desc">${escapeHtml(e.description)}</p>` : ""}<div class="chips">${chips || '<span class="muted">Noch keine Anmeldungen</span>'}</div><div class="actions">${actions}</div></article>`;
  }).join("") || empty(scope === "upcoming" ? "Keine geplanten Events." : "Keine vergangenen Events.");
}
function attendanceDialog(id) {
  const e = state.cache.events[id];
  const rows = e.participants.map(p => `<div class="row"><div><div class="row-title">${who(p.user_id)}</div><div class="row-sub">${statusLabels[p.status]}</div></div><div class="actions tight">${btn("Anwesend", "att", { event: id, user: p.user_id, status: "present" }, p.status === "present" ? "accept" : "")}${btn("Abwesend", "att", { event: id, user: p.user_id, status: "absent" }, p.status === "absent" ? "reject" : "")}</div></div>`).join("");
  openForm({ eyebrow: "ANWESENHEIT", title: e.name, intro: `<div class="rows">${rows || empty("Noch keine Anmeldungen.")}</div><p class="subtle">Nicht angemeldete Mitglieder unten nachtragen:</p>`, fields: [memberField(), { name: "status", label: "Status", type: "select", options: [["present", "Anwesend"], ["absent", "Abwesend"]] }], submit: "Nachtragen",
    onSubmit: async values => { const result = await post(`/api/events/${id}/attendance`, values); notify(result.message); await loadEvents(); attendanceDialog(id); return { keepOpen: true }; } });
}

// ------------------------------------------------------------------ Familienkonto
async function loadFinance() {
  const [data, closures] = await Promise.all([api("/api/accounts"), api("/api/account-closures").catch(() => ({ closures: [] }))]), caps = state.me.capabilities;
  state.cache.closures = Object.fromEntries(closures.closures.map(c => [c.id, c]));
  $("closures-panel").classList.toggle("hidden", !closures.closures.length);
  $("closures-list").innerHTML = closures.closures.map(c => `<article class="manage-card compact"><div class="manage-card-head"><div><span class="type-pill">${escapeHtml(c.reasonLabel)}</span><h3>${plink(c.userId)}</h3></div><span class="badge status-open">Offen</span></div>
    <p class="manage-meta">Guthaben <b>${money(c.balance)}</b>${c.openSanctions ? ` · offene Sanktionen <b>${money(c.openSanctions)}</b>` : ""} · seit ${date(c.createdAt)}${c.inGuild ? " · noch auf dem Server" : ""}</p>
    <div class="actions">${closures.canDecide ? `${btn("Löschung bestätigen", "closure-confirm", { id: c.id }, "reject")}${btn("Konto behalten", "closure-dismiss", { id: c.id })}` : '<span class="subtle">Nur die Finanzverwaltung kann entscheiden.</span>'}</div></article>`).join("");
  $("finance-totals").innerHTML = [["Ausstehend (brutto)", money(data.totals.gross), "$"], ["Offene Sanktionen", money(data.totals.open), ""], ["Voraussichtlich netto", money(data.totals.net), "→"], ["Mindestbetrag", data.minimumCents == null ? "keiner" : money(data.minimumCents), "⌁"]]
    .map(([label, value, symbol]) => `<div class="stat"><span class="symbol">${symbol}</span><div class="label">${label}</div><div class="value small">${value}</div></div>`).join("");
  $("accounts-list").innerHTML = data.accounts.length ? `<div class="table-row table-head"><span>Mitglied</span><span>Brutto</span><span>Sanktionen</span><span>Netto</span><span></span></div>` + data.accounts.map(a => `<div class="table-row"><span><b>${plink(a.userId)}</b>${a.eligible ? '<em class="ok">auszahlbar</em>' : a.gross > 0 ? '<em class="warn">unter Mindestbetrag</em>' : ""}</span><span data-label="Brutto">${money(a.gross)}</span><span data-label="Sanktionen">${a.openSanctions ? `${money(a.openSanctions)}${a.remainingAfter ? ` <small>(Rest danach ${money(a.remainingAfter)})</small>` : ""}` : "—"}</span><span data-label="Netto"><b>${money(a.net)}</b></span><span class="actions tight">${btn("Details", "account-details", { user: a.userId })}${caps.finance ? btn("+ Gutschrift", "credit", { user: a.userId }) : ""}${caps.finance && a.gross > 0 ? btn("Auszahlen", "payout", { user: a.userId }, "accept") : ""}${caps.leaders ? btn("Korrektur", "correction", { user: a.userId }) : ""}</span></div>`).join("") : empty("Noch keine Familienkonten.");
  document.querySelectorAll("#tab-finance .search").forEach(filterList);
}
async function loadPayouts() {
  const data = await api(`/api/payouts?days=${$("payouts-filter").value}`), t = data.totals;
  $("payouts-totals").innerHTML = [["Auszahlungen", t.count, "#"], ["Brutto", money(t.gross), "$"], ["Sanktionen verrechnet", money(t.deduction), "−"], ["Ausgezahlt (netto)", money(t.net), "→"]]
    .map(([label, value, symbol]) => `<div class="stat"><span class="symbol">${symbol}</span><div class="label">${label}</div><div class="value small">${value}</div></div>`).join("");
  $("payouts-actors").innerHTML = data.byActor.length > 1 ? data.byActor.map(a => row(`Ausgezahlt von ${state.names[a.actorId] || "Unbekannt"}`, money(a.net))).join("") : "";
  $("payouts-list").innerHTML = data.payouts.length ? `<div class="table-row table-head payout-row"><span>Datum</span><span>Mitglied</span><span>Brutto</span><span>Abzug</span><span>Ausgezahlt</span><span>Von</span></div>` + data.payouts.map(p => `<div class="table-row payout-row"><span data-label="Datum">${date(p.created_at)}<small class="block">${escapeHtml(p.id.slice(0, 8))}</small></span><span data-label="Mitglied"><b>${plink(p.user_id)}</b>${p.sanctions.length ? `<small class="block">${p.sanctions.map(s => `${escapeHtml(s.reason)} −${money(s.amount_cents)}`).join(" · ")}</small>` : ""}</span><span data-label="Brutto">${money(p.gross_cents)}</span><span data-label="Abzug">${p.deduction_cents ? `−${money(p.deduction_cents)}` : "—"}</span><span data-label="Ausgezahlt"><b>${money(p.net_cents)}</b></span><span data-label="Von">${who(p.actor_id)}</span></div>`).join("") : empty("Keine Auszahlungen in diesem Zeitraum.");
  document.querySelectorAll("#tab-payouts .search").forEach(filterList);
}
async function accountDetails(userId) {
  const data = await api(`/api/accounts/${userId}`);
  const tx = data.transactions.map(t => `<div class="row"><div><div class="row-title">${txLabels[t.type] ?? t.type} · ${t.type === "payout" ? `Brutto ${money(t.gross_cents)} · Abzug ${money(t.deduction_cents)} · Netto ${money(t.net_cents)}` : `${["payout", "correction_debit"].includes(t.type) ? "−" : "+"}${money(t.amount_cents)}`}</div><div class="row-sub">${date(t.created_at)} · ${escapeHtml(t.reason)} · durch ${who(t.actor_id)} · ${escapeHtml(t.id.slice(0, 8))}</div></div></div>`).join("");
  const sanctions = data.sanctions.map(s => `<div class="row"><div><div class="row-title">${money(s.amount_cents)} · ${statusLabels[s.status]}</div><div class="row-sub">${escapeHtml(s.reason)} · offen ${money(s.remaining_cents)} · verrechnet ${money(s.collected_cents)}${s.refunded_cents ? ` · erstattet ${money(s.refunded_cents)}` : ""} · ${date(s.created_at)}</div></div></div>`).join("");
  openInfo(who(userId), `<div class="finance"><div class="finance-item"><span>Brutto</span><b>${money(data.plan.gross)}</b></div><div class="finance-item"><span>Netto bei Auszahlung</span><b>${money(data.plan.net)}</b></div></div><h3 class="subhead">Buchungen</h3><div class="rows scroll">${tx || empty("Keine Buchungen.")}</div><h3 class="subhead">Sanktionen</h3><div class="rows scroll">${sanctions || empty("Keine Sanktionen.")}</div>`, "FAMILIENKONTO");
}
async function startPayout(userId) {
  const data = await post(`/api/accounts/${userId}/payout-preview`);
  const p = data.plan;
  if (data.belowMinimum) return notify(`Das Guthaben liegt unter dem Mindestbetrag von ${money(data.minimumCents)}.`, "error");
  const allocations = p.allocations.map(a => `<li>${escapeHtml(a.reason)}: −${money(a.cents)} ${a.remainingAfter ? `(Rest ${money(a.remainingAfter)} bleibt offen)` : "(danach beglichen)"}</li>`).join("");
  openForm({ eyebrow: "AUSZAHLUNG PRÜFEN", title: who(userId), danger: true, submit: p.net === 0 ? "Verrechnung ohne Auszahlung bestätigen" : `${money(p.net)} auszahlen`,
    intro: `<div class="preview"><div><span>Brutto</span><b>${money(p.gross)}</b></div><div><span>Offene Sanktionen</span><b>${money(p.openCents)}</b></div><div><span>Jetzt verrechnet</span><b>−${money(p.deduction)}</b></div><div class="big"><span>Tatsächlicher Auszahlungsbetrag</span><b>${money(p.net)}</b></div><div><span>Verbleibende Sanktionen</span><b>${money(p.remainingAfter)}</b></div></div>${allocations ? `<ul class="alloc">${allocations}</ul>` : ""}${p.net === 0 ? "<p class=\"warn-text\">Das gesamte Guthaben wird durch Sanktionen aufgebraucht. Es wird nichts ausgezahlt; die Verrechnung wird dokumentiert.</p>" : ""}<p class="subtle">Die Buchung ist atomar und kann nicht doppelt ausgeführt werden.</p>`,
    onSubmit: () => post(`/api/accounts/${userId}/payout`, { requestId: data.requestId, expectedGross: p.gross, expectedDeduction: p.deduction }) });
}

// ------------------------------------------------------------------ Sanktionen
async function loadSanctions() {
  const status = $("sanctions-filter").value, caps = state.me.capabilities;
  const data = await api(`/api/sanctions?status=${status}`);
  state.cache.sanctions = Object.fromEntries(data.sanctions.map(s => [s.id, s]));
  $("sanctions-summary").innerHTML = `<div class="stat"><span class="symbol"></span><div class="label">Summe offener Abzüge</div><div class="value small">${money(data.openTotal)}</div></div><div class="stat"><span class="symbol">#</span><div class="label">Einträge angezeigt</div><div class="value small">${data.sanctions.length}</div></div>`;
  $("sanctions-list").innerHTML = data.sanctions.map(s => {
    const refundable = s.collected_cents - s.refunded_cents;
    const actions = caps.leaders ? [s.status !== "void" ? btn("Korrigieren", "sanction-correct", { id: s.id }) : "", ["open", "partial"].includes(s.status) && s.collected_cents === 0 ? btn("Aufheben", "sanction-void", { id: s.id }, "reject") : "", refundable > 0 ? btn("Erstatten", "sanction-refund", { id: s.id }, "reject") : ""].join("") : "";
    return `<article class="manage-card compact"><div class="manage-card-head"><div><span class="type-pill">${money(s.amount_cents)}</span><h3>${plink(s.user_id)}</h3></div><span class="badge status-${s.status}">${statusLabels[s.status]}</span></div>
      <p class="manage-meta">${escapeHtml(s.reason)}${s.case_ref ? ` · Fall: ${escapeHtml(s.case_ref)}` : ""}<br>Offen <b>${money(s.remaining_cents)}</b> · verrechnet ${money(s.collected_cents)}${s.refunded_cents ? ` · erstattet ${money(s.refunded_cents)}` : ""} · von ${who(s.actor_id)} · ${date(s.created_at)}</p><div class="actions">${actions}</div></article>`;
  }).join("") || empty("Keine Sanktionen.");
  const warnState = { active: ["Aktiv", "status-open"], expired: ["Abgelaufen", "status-void"], revoked: ["Zurückgenommen", "status-void"] };
  const showAll = $("warnings-filter").value === "all";
  $("warnings-list").innerHTML = data.warnings.filter(w => showAll || w.state === "active").map(w => {
    const [label, cls] = warnState[w.state] ?? warnState.active;
    return `<article class="manage-card compact"><div class="manage-card-head"><div><span class="type-pill">${w.activeCount} aktiv</span><h3>${plink(w.user_id)}</h3></div><span class="badge ${cls}">${label}</span></div>
      <p class="manage-meta">${escapeHtml(w.reason)}${w.case_ref ? ` · Fall: ${escapeHtml(w.case_ref)}` : ""}<br>von ${who(w.actor_id)} · ${date(w.created_at)}${w.revoked_at ? `<br>Zurückgenommen von ${who(w.revoked_by)} · ${date(w.revoked_at)} · ${escapeHtml(w.revoke_reason ?? "")}` : ""}</p>
      <div class="actions">${warningActions(w)}</div></article>`;
  }).join("") || empty(showAll ? "Keine Verwarnungen." : "Keine aktiven Verwarnungen.");
}

// ------------------------------------------------------------------ Giveaways
async function loadGiveaways() {
  const data = await api("/api/giveaways");
  $("giveaways-list").innerHTML = data.giveaways.map(g => `<article class="manage-card compact"><div class="manage-card-head"><div><span class="type-pill">${statusLabels[g.status]}</span><h3>${escapeHtml(g.prize)}</h3></div><span class="badge">${g.entries} Teilnahmen</span></div>
    <p class="manage-meta">${g.status === "active" ? `Endet ${date(g.ends_at)}` : `Beendet ${date(g.ended_at)}`} · ${g.winner_count} Gewinner · von ${who(g.created_by)}<br>${escapeHtml(g.conditions)}</p>
    ${g.winners.length ? `<div class="chips">${g.winners.map(id => `<span class="chip chip-present">${who(id)}</span>`).join("")}</div>` : g.status === "ended" ? '<p class="muted">Keine Teilnahmen, kein Gewinner.</p>' : ""}
    <div class="actions">${g.status === "active" ? btn("Jetzt auslosen", "giveaway-draw", { id: g.id }, "accept") + btn("Abbrechen", "giveaway-cancel", { id: g.id }, "reject") : ""}</div></article>`).join("") || empty("Keine Giveaways der letzten 60 Tage.");
}

// ------------------------------------------------------------------ Statistik
async function loadStats() {
  const data = await api(`/api/stats?days=${$("stats-filter").value}`), s = data.stats;
  const block = (title, items) => `<section class="panel"><div class="panel-head"><h2>${title}</h2></div><div class="kv">${items.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join("")}</div></section>`;
  const st = (map, keys) => keys.map(k => [statusLabels[k], map[k] ?? 0]);
  const blocks = [
    block("Mitglieder", [["Aktuell", data.memberCount ?? "—"], ["Beitritte", s.members.joins], ["Austritte", s.members.leaves]]),
    block("Tickets", [["Erstellt", s.tickets.created], ["Geschlossen", s.tickets.closed], ["Aktuell offen", s.tickets.openNow], ["Ohne Bearbeiter", s.tickets.unclaimedNow], ["Ø Bearbeitung", s.tickets.avgCloseHours != null ? `${s.tickets.avgCloseHours.toFixed(1)} h` : "—"]]),
    block("Events", [...st(s.events.byStatus, ["scheduled", "ended", "cancelled"]), ["Anmeldungen", s.events.signups], ["Anwesend", s.events.present], ["Abwesend", s.events.absent]]),
    block("Bewerbungen", st(s.applications.bewerbung, ["open", "review", "accepted", "rejected", "withdrawn"])),
    block("Rang-Anträge", st(s.applications.rang, ["open", "review", "accepted", "rejected", "withdrawn"])),
    block("Sanktionen", [...st(s.sanctions.byStatus, ["open", "partial", "paid", "void"]), ["Verwarnungen", s.sanctions.warnings]]),
    block("Giveaways", [["Erstellt", s.giveaways.created], ["Ausgelost", s.giveaways.ended], ["Teilnahmen", s.giveaways.entries], ["Aktiv", s.giveaways.activeNow]]),
    block("Staff-Aktivität", s.staffActions.length ? s.staffActions.map(a => [state.names[a.actor_id] ?? "Staff", a.n]) : [["Keine Aktionen", "—"]]),
  ];
  if (s.finance) blocks.push(block("Familienkonto (vertraulich)", [["Gutschriften", `${money(s.finance.credited.n)} (${s.finance.credited.c})`], ["Auszahlungen", s.finance.payouts.c], ["Brutto ausgezahlt", money(s.finance.payouts.gross)], ["Sanktionsabzüge", money(s.finance.payouts.deduction)], ["Netto ausgezahlt", money(s.finance.payouts.net)], ["Aktuell ausstehend", money(s.finance.balanceNow)], ["Offene Sanktionen", money(s.finance.openSanctionsNow)]]));
  $("stats-view").innerHTML = `<div class="columns three">${blocks.join("")}</div>`;
}

// ------------------------------------------------------------------ Protokoll
const detailText = details => Object.entries(details).filter(([k]) => !["applicantId", "winnerIds"].includes(k)).map(([k, v]) => /cents$/i.test(k) ? `${k.replace(/Cents$/i, "")}: ${money(v)}` : `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ").slice(0, 300);
async function loadAudit() {
  const data = await api(`/api/audit?action=${encodeURIComponent($("audit-filter").value)}`);
  $("audit-list").innerHTML = data.entries.map(e => row(`${labels[e.action] ?? e.action} · ${state.names[e.actor_id] ?? (e.actor_id?.length > 15 ? "Bot/Staff" : e.actor_id)}${e.details.applicantId || state.names[e.target_id] ? ` → ${state.names[e.details.applicantId ?? e.target_id] ?? ""}` : ""}`, `${date(e.created_at)} · ${detailText(e.details)}`)).join("") || empty("Keine Einträge.");
}

async function loadMembers() {
  const data = await api("/api/verifications"), caps = state.me.capabilities;
  $("members-info").textContent = `${data.total} verifizierte Mitglieder.${data.panelChannel ? "" : " Noch kein Verifizierungs-Channel eingestellt (Einstellungen → Channels)."}${data.roleConfigured ? "" : " Ohne „Rolle nach Verifizierung“ wird nur der Name geändert."}`;
  $("members-list").innerHTML = data.verifications.length ? `<div class="table-row table-head members-row"><span>Discord</span><span>Ingame-ID</span><span>Name (Ingame)</span><span>Verifiziert</span><span></span></div>` + data.verifications.map(v => `<div class="table-row members-row"><span><b>${plink(v.user_id)}</b><small class="block">${escapeHtml(v.nickname)}</small></span><span data-label="Ingame-ID">${escapeHtml(v.ingame_id)}</span><span data-label="Name">${escapeHtml(`${v.first_name} ${v.last_name}`)}</span><span data-label="Verifiziert">${date(v.verified_at)}${v.updated_at !== v.verified_at ? `<small class="block">geändert ${date(v.updated_at)}</small>` : ""}</span><span class="actions tight">${btn("Profil", "profile", { user: v.user_id })}${caps.leaders ? btn("Zurücksetzen", "verification-reset", { user: v.user_id, name: v.nickname }) : ""}</span></div>`).join("") : empty("Noch niemand verifiziert.");
  document.querySelectorAll("#tab-members .search").forEach(filterList);
}

const loaders = { members: loadMembers, overview: loadOverview, applications: loadApplications, tickets: loadTickets, events: loadEvents, finance: loadFinance, payouts: loadPayouts, sanctions: loadSanctions, giveaways: loadGiveaways, stats: loadStats, audit: loadAudit };

// ------------------------------------------------------------------ Aktionen
const actions = {
  "app-claim": ({ id }) => post(`/api/applications/${id}/claim`).then(r => notify(r.message)).then(refresh),
  "app-accept": ({ id }) => confirmAction("Antrag annehmen?", "Der Antragsteller erhält sofort eine private Nachricht.", "Annehmen", () => post(`/api/applications/${id}/decision`, { status: "accepted" }), false),
  "app-reject": ({ id }) => openForm({ eyebrow: "ANTRÄGE", title: "Antrag ablehnen", intro: "<p>Der Antragsteller erhält diesen Grund als private Nachricht.</p>", danger: true, submit: "Mit Begründung ablehnen", fields: [{ name: "reason", label: "Begründung", type: "textarea", required: true, rows: 4 }], onSubmit: v => post(`/api/applications/${id}/decision`, { status: "rejected", reason: v.reason }) }),
  "app-note": ({ id }) => openForm({ eyebrow: "INTERN", title: "Notiz zum Antrag", intro: "<p>Nur für das Team sichtbar; wird zusätzlich im Review-Channel gepostet.</p>", fields: [{ name: "note", label: "Notiz", type: "textarea", required: true }], submit: "Notiz speichern", onSubmit: v => post(`/api/applications/${id}/note`, v) }),
  "app-role": ({ id }) => openForm({ eyebrow: "RANG-ROLLE", title: "Rolle vergeben", intro: "<p>Nur ausdrücklich freigegebene Rang-Rollen. Hierarchie und Rechte werden vor der Vergabe geprüft; die Vergabe wird protokolliert.</p>", fields: [{ name: "roleId", label: "Rolle", type: "select", required: true, options: state.me.settings.rankRoles.map(r => [r.roleId, r.label]) }], submit: "Rolle vergeben", onSubmit: v => post(`/api/applications/${id}/role`, v) }),
  "ticket-claim": ({ id }) => post(`/api/tickets/${id}/claim`).then(r => notify(r.message)).then(refresh),
  "ticket-close": ({ id }) => confirmAction("Ticket schließen?", "Der Verlauf wird als Transkript gespeichert und in den Ticket-Log gesendet. Der Ersteller kann danach nicht mehr schreiben.", "Schließen", () => post(`/api/tickets/${id}/close`)),
  "ticket-reopen": ({ id }) => post(`/api/tickets/${id}/reopen`).then(r => notify(r.message)).then(refresh),
  "ticket-transcript": async ({ id }) => {
    const data = await api(`/api/tickets/${id}/transcript`);
    openInfo(`Transkript · ${data.ticket.category}`, `<div class="transcript">${data.messages.map(m => `<div class="msg"><b>${escapeHtml(m.author)}</b> <small>${date(m.createdAt)}</small><p>${escapeHtml(m.content) || "<i>(ohne Text)</i>"}${m.attachments.length ? `<br><small>${escapeHtml(m.attachments.join(", "))}</small>` : ""}</p></div>`).join("") || empty("Keine Nachrichten gespeichert.")}</div>`, "TICKET");
  },
  "event-create": () => openForm({ eyebrow: "EVENT-TEAM", title: "Event veröffentlichen", intro: "<p>Die Ankündigung erscheint im konfigurierten Event-Channel mit Anmeldebuttons.</p>", fields: eventFields(), submit: "Veröffentlichen", onSubmit: v => post("/api/events", { ...v, startsAt: fromLocalInput(v.startsAt), maximum: v.maximum ? Number(v.maximum) : null, minimum: v.minimum ? Number(v.minimum) : null }) }),
  "event-edit": ({ id }) => { const e = state.cache.events[id]; openForm({ eyebrow: "EVENT BEARBEITEN", title: e.name, intro: "<p>Die Ankündigung in Discord wird automatisch aktualisiert. Bei geänderter Startzeit werden Erinnerungen neu geplant.</p>", fields: eventFields(e), submit: "Speichern", onSubmit: v => post(`/api/events/${id}/update`, { ...v, startsAt: v.startsAt === toLocalInput(e.starts_at) ? "" : fromLocalInput(v.startsAt), maximum: v.maximum ? Number(v.maximum) : null, minimum: v.minimum ? Number(v.minimum) : null }) }); },
  "event-attendance": ({ id }) => attendanceDialog(id),
  "att": async ({ event, user, status }) => { const r = await post(`/api/events/${event}/attendance`, { userId: user, status }); notify(r.message); await loadEvents(); attendanceDialog(event); },
  "event-end": ({ id }) => confirmAction("Event beenden?", "Die Anmeldung wird geschlossen. Danach die Anwesenheit eintragen und abschließen – erst dann ist das Event fertig.", "Beenden", () => post(`/api/events/${id}/end`), false),
  "event-att-close": ({ id }) => { const e = state.cache.events[id], present = e.participants.filter(p => p.status === "present").length, open = e.participants.filter(p => p.status === "signed_up").length;
    confirmAction("Anwesenheit abschließen?", `${present} als anwesend markiert. ${open ? `<b>${open} noch nicht markiert</b> – sie werden auf „nicht da“ gesetzt und zählen als No-Show (außer sie waren abgemeldet).` : "Alle sind markiert."} Danach ist das Event abgeschlossen und das Ergebnis wird gepostet.`, "Abschließen", () => post(`/api/events/${id}/attendance/close`), open > 0); },
  "event-cancel": ({ id }) => confirmAction("Event absagen?", "Die Anmeldung wird geschlossen und die Ankündigung als abgesagt markiert.", "Absagen", () => post(`/api/events/${id}/cancel`)),
  "credit": ({ user }) => openForm({ eyebrow: "FAMILIENKONTO", title: "Gutschrift buchen", intro: "<p>Erhöht das noch auszuzahlende Familienguthaben des Mitglieds.</p>", fields: [memberField(user, "Empfänger"), { name: "amount", label: "Betrag ($)", type: "money", required: true }, { name: "reason", label: "Buchungsgrund", required: true, max: 300, placeholder: "z. B. Event Bankraub 12.10." }], submit: "Gutschrift buchen", onSubmit: (rid => v => post(`/api/accounts/${v.userId}/credit`, { amount: v.amount, reason: v.reason, requestId: rid }))(uuid()) }),
  "account-open": () => openForm({ eyebrow: "FAMILIENKONTO", title: "Familienkonto anlegen", intro: "<p>Legt ein leeres Konto (0 $) an. Das Mitglied erscheint danach in der Auszahlungsliste und kann Gutschriften erhalten.</p>", fields: [memberField(), { name: "note", label: "Notiz", hint: "(optional)", max: 300, placeholder: "z. B. neues Familienmitglied" }], submit: "Konto anlegen", onSubmit: v => post(`/api/accounts/${v.userId}/open`, { note: v.note }) }),
  "correction": ({ user }) => openForm({ eyebrow: "LEITUNG", title: `Korrektur · ${state.names[user] ?? "Mitglied"}`, intro: "<p>Eigene, unveränderliche Korrekturbuchung. Das Guthaben kann nicht unter 0 fallen.</p>", fields: [{ name: "direction", label: "Richtung", type: "select", options: [["credit", "Guthaben erhöhen"], ["debit", "Guthaben verringern"]] }, { name: "amount", label: "Betrag ($)", type: "money", required: true }, { name: "reason", label: "Korrekturgrund", required: true, max: 300 }], submit: "Korrektur buchen", danger: true, onSubmit: (rid => v => post(`/api/accounts/${user}/correction`, { ...v, requestId: rid }))(uuid()) }),
  "payout": ({ user }) => startPayout(user),
  "account-details": ({ user }) => accountDetails(user),
  "closure-confirm": ({ id }) => { const c = state.cache.closures?.[id]; if (!c) return; openForm({ eyebrow: "KONTO LÖSCHEN", title: who(c.userId), danger: true, submit: "Konto endgültig löschen",
    intro: `<p>Das Familienkonto wird gelöscht (${escapeHtml(c.reasonLabel)}).</p><div class="preview"><div><span>Restguthaben – verfällt</span><b>${money(c.balance)}</b></div><div><span>Offene Sanktionen – werden aufgehoben</span><b>${money(c.openSanctions)}</b></div></div>${c.balance > 0 ? '<p class="warn-text">Das Guthaben wird nicht ausgezahlt. Falls noch Geld fällig ist, vorher auszahlen.</p>' : ""}<p class="subtle">Buchungen und Sanktionen bleiben im Verlauf erhalten. Kommt das Mitglied zurück, bekommt es wieder ein neues Konto.</p>`,
    fields: [{ name: "note", label: "Grund (optional)", max: 300 }], onSubmit: v => post(`/api/account-closures/${id}/confirm`, v) }); },
  "closure-dismiss": ({ id }) => { const c = state.cache.closures?.[id]; if (!c) return; confirmAction("Konto behalten?", `Das Konto von ${who(c.userId)} bleibt mit allem Guthaben bestehen und die Anfrage verschwindet.`, "Konto behalten", () => post(`/api/account-closures/${id}/dismiss`, {}), false); },
  "sanction-create": () => openForm({ eyebrow: "SANKTION", title: "Sanktion eintragen", intro: "<p>Wird als offener Auszahlungsabzug gespeichert und belastet das Konto erst bei der nächsten Auszahlung.</p>", fields: [memberField(), { name: "amount", label: "Betrag ($)", type: "money", required: true }, { name: "reason", label: "Grund", required: true, max: 300 }, { name: "caseRef", label: "Fall-/Event-Bezug", hint: "(optional)", max: 100 }], submit: "Sanktion vormerken", danger: true, onSubmit: v => post("/api/sanctions", v) }),
  "warning-delete": ({ id }) => openForm({ eyebrow: "VERWARNUNG", title: "Verwarnung endgültig löschen", intro: "<p>Die Verwarnung wird komplett entfernt und erscheint nirgends mehr – nur im Protokoll bleibt vermerkt, wer sie wann gelöscht hat. Zum bloßen Aufheben lieber „Zurücknehmen“ verwenden.</p>", fields: [{ name: "reason", label: "Grund", required: true, max: 300, placeholder: "z. B. Fehleintrag" }], submit: "Endgültig löschen", danger: true, onSubmit: v => post(`/api/warnings/${id}/delete`, v) }),
  "warning-revoke": ({ id }) => openForm({ eyebrow: "VERWARNUNG", title: "Verwarnung zurücknehmen", intro: "<p>Die Verwarnung bleibt in der Historie sichtbar, zählt aber nicht mehr als aktiv. Die Person wird per DM informiert.</p>", fields: [{ name: "reason", label: "Grund", required: true, max: 300 }], submit: "Zurücknehmen", danger: true, onSubmit: v => post(`/api/warnings/${id}/revoke`, v) }),
  "warning-create": ({ user } = {}) => openForm({ eyebrow: "VERWARNUNG", title: "Verwarnung eintragen", intro: "<p>Ohne Geldabzug. Die Person bekommt den Grund per DM; ab den eingestellten Grenzen folgen automatisch Timeout bzw. Meldung an die Leitung.</p>", fields: [memberField(user ?? ""), { name: "reason", label: "Grund", required: true, max: 300 }, { name: "caseRef", label: "Fall-/Event-Bezug", hint: "(optional)", max: 100 }], submit: "Verwarnung eintragen", onSubmit: v => post("/api/warnings", v) }),
  "sanction-correct": ({ id }) => { const s = state.cache.sanctions[id]; openForm({ eyebrow: "LEITUNG", title: "Sanktion korrigieren", intro: `<p>Bisher ${money(s.amount_cents)}, bereits verrechnet ${money(s.collected_cents)}. Der neue Gesamtbetrag darf das Verrechnete nicht unterschreiten.</p>`, fields: [{ name: "amount", label: "Neuer Gesamtbetrag ($)", type: "money", required: true, value: String(s.amount_cents / 100).replace(".", ",") }, { name: "reason", label: "Korrekturgrund", required: true, max: 300 }], submit: "Korrigieren", onSubmit: v => post(`/api/sanctions/${id}/correct`, v) }); },
  "sanction-void": ({ id }) => openForm({ eyebrow: "LEITUNG", title: "Sanktion aufheben", intro: "<p>Die Sanktion wird nicht gelöscht, sondern als aufgehoben markiert und nie mehr verrechnet.</p>", fields: [{ name: "reason", label: "Grund", required: true, max: 300 }], submit: "Aufheben", danger: true, onSubmit: v => post(`/api/sanctions/${id}/void`, v) }),
  "sanction-refund": ({ id }) => openForm({ eyebrow: "LEITUNG", title: "Sanktion erstatten", intro: "<p>Bereits abgezogene Beträge werden dem Familienkonto gutgeschrieben und die Sanktion aufgehoben.</p>", fields: [{ name: "reason", label: "Grund", required: true, max: 300 }], submit: "Erstatten", danger: true, onSubmit: (rid => v => post(`/api/sanctions/${id}/refund`, { ...v, requestId: rid }))(uuid()) }),
  "giveaway-create": async () => {
    const [channels, roles] = await Promise.all([api("/api/channels"), api("/api/roles")]);
    openForm({ eyebrow: "GIVEAWAY", title: "Giveaway starten", fields: [
      { name: "prize", label: "Preis", required: true, max: 200 },
      { name: "channelId", label: "Channel", type: "select", required: true, value: state.me.settings.giveawayChannel ?? "", options: channels.channels.map(c => [c.id, `#${c.name}${c.parent ? ` · ${c.parent}` : ""}`]) },
      { name: "minutes", label: "Dauer in Minuten", type: "number", required: true, min: 1, maxValue: 43200, value: 1440 },
      { name: "winners", label: "Gewinnerzahl", type: "number", required: true, min: 1, maxValue: 20, value: 1 },
      { name: "roleId", label: "Nur für Rolle", hint: "(optional)", type: "select", options: [["", "Alle dürfen teilnehmen"], ...roles.roles.map(r => [r.id, r.name])] },
      { name: "conditions", label: "Bedingungen", hint: "(optional)", type: "textarea", max: 500 },
    ], submit: "Veröffentlichen", onSubmit: v => post("/api/giveaways", { ...v, minutes: Number(v.minutes), winners: Number(v.winners) }) });
  },
  "series-toggle": async ({ id, active }) => { const r = await post(`/api/series/${id}/toggle`, { active: active !== "1" }); notify(r.message); await loadSeries(); },
  "series-create": () => openForm({ eyebrow: "AKTIVITÄT", title: "Neue Aktivität", fields: seriesFields(), submit: "Anlegen", onSubmit: v => post("/api/series", { ...v, active: false }) }),
  "series-edit": ({ id }) => { const s = state.cache.series[id]; openForm({ eyebrow: "AKTIVITÄT", title: s.name, intro: "<p>Änderungen gelten für künftige Termine. Bereits angekündigte Termine bleiben bestehen.</p>", fields: seriesFields(s), submit: "Speichern", onSubmit: v => post(`/api/series/${id}/update`, v) }); },
  "series-delete": ({ id }) => confirmAction(`${state.cache.series[id].name} löschen?`, "Es werden keine neuen Termine mehr angelegt. Bereits erstellte Events bleiben in der Historie. Zum Pausieren reicht der Schalter.", "Löschen", () => post(`/api/series/${id}/delete`)),
  "series-board": async () => { const data = await api("/api/channels"); openForm({ eyebrow: "DISCORD", title: "Aktivitäten-Übersicht posten", intro: "<p>Eine dauerhafte Nachricht mit allen aktiven Aktivitäten und dem nächsten Termin. Sie aktualisiert sich automatisch.</p>", fields: [{ name: "channelId", label: "Channel", type: "select", required: true, options: data.channels.map(c => [c.id, `#${c.name}${c.parent ? ` · ${c.parent}` : ""}`]) }], submit: "Posten", onSubmit: v => post("/api/series/board", v) }); },
  "verification-reset": ({ user, name }) => confirmAction(`Verifizierung von ${name} zurücksetzen?`, "Die gespeicherte Ingame-ID wird freigegeben und das Mitglied kann sich neu verifizieren. Name und Rollen in Discord werden nicht verändert.", "Zurücksetzen", () => post(`/api/verifications/${user}/reset`)),
  "giveaway-draw": ({ id }) => confirmAction("Jetzt auslosen?", "Das Giveaway endet sofort; die Gewinner werden in Discord verkündet.", "Auslosen", () => post(`/api/giveaways/${id}/draw`), false),
  "giveaway-cancel": ({ id }) => openForm({ eyebrow: "GIVEAWAY", title: "Giveaway abbrechen", intro: "<p>Es wird kein Gewinner gezogen.</p>", fields: [{ name: "reason", label: "Grund", hint: "(optional)", max: 300 }], submit: "Abbrechen", danger: true, onSubmit: v => post(`/api/giveaways/${id}/cancel`, v) }),
};

let busy = false;
document.addEventListener("click", async event => {
  const tab = event.target.closest("button[data-tab]");
  if (tab) return showTab(tab.dataset.tab);
  const button = event.target.closest("button[data-action]");
  if (!button || busy) return;
  const handler = actions[button.dataset.action]; if (!handler) return;
  busy = true; button.disabled = true;
  try { await handler({ ...button.dataset }, button); }
  catch (error) { notify(error.message, "error"); }
  finally { busy = false; button.disabled = false; }
});
for (const [id, tab] of [["applications-filter", "applications"], ["tickets-filter", "tickets"], ["events-filter", "events"], ["sanctions-filter", "sanctions"], ["payouts-filter", "payouts"], ["warnings-filter", "sanctions"], ["stats-filter", "stats"], ["audit-filter", "audit"]]) $(id).addEventListener("change", () => state.tab === tab && refresh());
$("menu-toggle").addEventListener("click", () => (document.body.classList.contains("menu-open") ? closeMenu() : openMenu()));
$("scrim").addEventListener("click", closeMenu);
document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
$("logout").addEventListener("click", async () => { await fetch("/logout", { method: "POST", credentials: "same-origin" }); location.reload(); });

async function start() {
  const loginError = new URLSearchParams(location.search).get("error");
  if (loginError) { message.textContent = loginError; history.replaceState(null, "", location.pathname); }
  try {
    const response = await fetch("/api/me", { credentials: "same-origin" });
    if (response.status === 401) { $("boot").remove(); login.classList.remove("hidden"); dashboard.classList.add("hidden"); return; }
    if (!response.ok) throw new Error("Dashboard konnte nicht geladen werden.");
    state.me = await response.json(); state.timezone = state.me.settings.timezone || state.timezone;
    $("app-version").textContent = state.me.version ?? "–";
    $("boot").remove(); login.classList.add("hidden"); dashboard.classList.remove("hidden");
    // Verifizierte Namen: „Vorname Nachname | ID“ (ältere Einträge noch „ID | Vorname Nachname“). Name groß, ID klein darunter.
    const fullName = String(state.me.member.name || "Staff").trim();
    const newer = /^(.+?)\s*\|\s*(\d+)$/.exec(fullName), older = /^(\d+)\s*\|\s*(.+)$/.exec(fullName);
    const parts = newer ? [null, newer[2], newer[1]] : older;
    const displayName = parts ? parts[2] : fullName;
    $("staff-name").textContent = displayName; $("staff-name").title = fullName;
    $("staff-avatar").textContent = (displayName.match(/\p{L}/u)?.[0] ?? displayName.charAt(0) ?? "G").toUpperCase();
    if (state.me.member.avatar) {
      const img = new Image(); img.alt = ""; img.referrerPolicy = "no-referrer";
      img.onload = () => { $("staff-avatar").textContent = ""; $("staff-avatar").appendChild(img); $("staff-avatar").classList.add("has-image"); };
      img.src = state.me.member.avatar;
    }
    const caps = state.me.capabilities;
    const roleLabel = state.me.member.owner ? "Bot-Owner" : caps.leaders ? "Leitung" : caps.finance ? "Finanzen" : caps.applications ? "Reviewer" : caps.events ? "Event-Team" : caps.team ? "Staff" : "Familienmitglied";
    $("staff-role").textContent = parts ? `${roleLabel} · ID ${parts[1]}` : roleLabel;
    const wanted = location.hash.slice(1);
    state.tab = TABS.some(([id, , allowed]) => id === wanted && allowed(state.me.capabilities)) ? wanted : caps.team ? "overview" : "mine";
    renderTabs(); await refresh(); startLive();
    // Automatische Aktualisierung, solange kein Dialog offen ist.
    setInterval(() => { if (!$("dialog").open && document.visibilityState === "visible") refresh(); }, 60_000);
    if (caps.team && state.tab !== "overview") api("/api/overview").then(applyBadges).catch(() => {});
    if (caps.team) setInterval(() => { if (state.tab !== "overview" && document.visibilityState === "visible") api("/api/overview").then(applyBadges).catch(() => {}); }, 60_000);
  } catch (error) { $("boot")?.remove(); login.classList.remove("hidden"); message.textContent = error.message; }
}
// ------------------------------------------------------------------ Live-Rechte
// Ändern sich die Rollen (Rang weg, neue Rolle), lädt die Seite die Rechte neu und zeigt sofort nur noch das Erlaubte.
// Der Server prüft ohnehin jede Anfrage einzeln; das hier sorgt nur dafür, dass die Anzeige mitzieht.
async function recheckAccess() {
  const response = await fetch("/api/me", { credentials: "same-origin" }).catch(() => null);
  if (!response) return;
  if (response.status === 401) return location.reload();
  if (!response.ok) return;
  const next = await response.json();
  if (JSON.stringify(next.capabilities) === JSON.stringify(state.me.capabilities)) return;
  state.me = next;
  const caps = next.capabilities;
  if ($("dialog").open) $("dialog").close();
  if (!TABS.some(([id, , allowed]) => id === state.tab && allowed(caps))) { state.tab = caps.team ? "overview" : "mine"; history.replaceState(null, "", `#${state.tab}`); }
  const roleLabel = next.member.owner ? "Bot-Owner" : caps.leaders ? "Leitung" : caps.finance ? "Finanzen" : caps.applications ? "Reviewer" : caps.events ? "Event-Team" : caps.team ? "Staff" : "Familienmitglied";
  $("staff-role").textContent = $("staff-role").textContent.replace(/^[^·]+/, `${roleLabel} `).trim();
  renderTabs(); await refresh().catch(() => {});
  notify("Deine Rechte haben sich geändert – die Ansicht wurde angepasst.");
}
function startLive() {
  let source = null;
  const connect = () => {
    if (!window.EventSource) return;
    source = new EventSource("/api/live");
    source.addEventListener("access", () => recheckAccess());
    source.onerror = () => { source.close(); setTimeout(connect, 10_000); };
  };
  connect();
  // Rückfallebene, falls der Live-Kanal unterwegs geblockt wird.
  setInterval(() => { if (document.visibilityState === "visible") recheckAccess(); }, 20_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") recheckAccess(); });
}
document.addEventListener("DOMContentLoaded", start);
