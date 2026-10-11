const $ = id => document.getElementById(id);
const login = $("login"), dashboard = $("dashboard"), message = $("message");
const escapeHtml = value => String(value ?? "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const date = value => new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Vienna" }).format(new Date(value));
const labels = { "application.submitted": "Antrag eingereicht", "application.claimed": "Antrag übernommen", "application.accepted": "Antrag angenommen", "application.rejected": "Antrag abgelehnt", "ticket.created": "Ticket eröffnet", "ticket.claimed": "Ticket übernommen", "ticket.closed": "Ticket geschlossen", "event.created": "Event veröffentlicht", "event.updated": "Event geändert", "event.ended": "Event beendet", "event.cancelled": "Event abgesagt", "finance.credit": "Gutschrift verbucht", "finance.payout": "Auszahlung gebucht", "sanction.created": "Sanktion vorgemerkt", "sanction.applied": "Sanktion verrechnet", "giveaway.ended": "Giveaway ausgelost" };
const answerLabels = { name: "Ingame-Name", alter: "Alter", erfahrung: "Grand-RP-Erfahrung", motivation: "Motivation", aktivitaet: "Aktivität", aktueller_rang: "Aktueller Rang", ziel_rang: "Beantragter Rang", begruendung: "Begründung" };
const empty = '<div class="empty">Zurzeit nichts offen.</div>';
const row = (title, sub, badge = "") => `<div class="row"><div><div class="row-title">${escapeHtml(title)}</div><div class="row-sub">${escapeHtml(sub)}</div></div>${badge ? `<span class="badge">${escapeHtml(badge)}</span>` : ""}</div>`;
let busy = false, rejectingApplication = null, toastTimer;

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers ?? {}) } });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (response.status === 401) { location.reload(); throw new Error("Bitte melde dich erneut an."); }
  if (!response.ok) throw new Error(data.error || "Die Aktion konnte nicht ausgeführt werden.");
  return data;
}
function notify(text, kind = "success") {
  const toast = $("toast"); toast.textContent = text; toast.dataset.kind = kind; toast.classList.add("visible");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("visible"), 4200);
}
async function perform(button, action) {
  if (busy) return;
  busy = true; button.disabled = true;
  try { const result = await action(); notify(result.message || "Erledigt."); await load(); }
  catch (error) { notify(error.message, "error"); button.disabled = false; }
  finally { busy = false; }
}

function renderApplications(items) {
  $("application-queue").innerHTML = items.map(item => {
    let answers = {};
    try { answers = JSON.parse(item.answers); } catch { /* Ungültiger Altbestand bleibt sichtbar. */ }
    const facts = Object.entries(answers).map(([key, value]) => `<div class="answer"><span>${escapeHtml(answerLabels[key] || key.replaceAll("_", " "))}</span><b>${escapeHtml(value)}</b></div>`).join("");
    return `<article class="manage-card"><div class="manage-card-head"><div><span class="type-pill">${item.kind === "rang" ? "🏅 Rang-Antrag" : "🤝 Bewerbung"}</span><h3>${item.kind === "rang" ? "Rang-Antrag" : "Familienbewerbung"}</h3></div><span class="badge">${item.status === "review" ? "In Prüfung" : "Offen"}</span></div><p class="manage-meta">Von <b>${escapeHtml(item.user_id)}</b> · ${date(item.created_at)}${item.status === "review" ? ` · übernommen von ${escapeHtml(item.reviewer_id)}` : ""}</p><div class="answers">${facts || "Keine Angaben gespeichert."}</div><div class="actions">${item.status === "open" ? `<button class="action primary-action" data-action="claim-app" data-id="${escapeHtml(item.id)}">Übernehmen</button>` : ""}<button class="action accept" data-action="accept-app" data-id="${escapeHtml(item.id)}">Annehmen</button><button class="action reject" data-action="reject-app" data-id="${escapeHtml(item.id)}">Ablehnen</button></div></article>`;
  }).join("") || empty;
}
function renderTickets(items) {
  $("ticket-queue").innerHTML = items.map(item => `<article class="manage-card compact"><div class="manage-card-head"><div><span class="type-pill">🎫 ${escapeHtml(({ support: "Support", beschwerde: "Beschwerde", leitung: "Leitung" })[item.category] || item.category)}</span><h3>Ticket für ${escapeHtml(item.user_id)}</h3></div><span class="badge">${item.claimed_by ? "In Bearbeitung" : "Offen"}</span></div><p class="manage-meta">Eröffnet ${date(item.created_at)}${item.claimed_by ? ` · übernommen von ${escapeHtml(item.claimed_by)}` : " · wartet auf Staff"}</p><div class="actions">${!item.claimed_by ? `<button class="action primary-action" data-action="claim-ticket" data-id="${escapeHtml(item.id)}">Ticket übernehmen</button>` : ""}<button class="action reject" data-action="close-ticket" data-id="${escapeHtml(item.id)}">Schließen</button></div></article>`).join("") || empty;
}
function renderManageEvents(items) {
  $("event-queue").innerHTML = items.map(item => `<article class="manage-card compact"><div class="manage-card-head"><div><span class="type-pill">📅 Geplant</span><h3>${escapeHtml(item.name)}</h3></div><span class="badge">${item.participants} angemeldet</span></div><p class="manage-meta">${date(item.starts_at)} · ${escapeHtml(item.location)} · erstellt von ${escapeHtml(item.host_id)}</p><button class="action reject" data-action="cancel-event" data-id="${escapeHtml(item.id)}">Event absagen</button></article>`).join("") || empty;
}
function filterQueue() {
  const term = $("queue-search").value.trim().toLocaleLowerCase("de-AT");
  document.querySelectorAll(".queue .manage-card").forEach(card => { card.hidden = Boolean(term) && !card.textContent.toLocaleLowerCase("de-AT").includes(term); });
}
async function load() {
  const loginError = new URLSearchParams(location.search).get("error");
  if (loginError) { message.textContent = loginError; history.replaceState(null, "", location.pathname); }
  try {
    const response = await fetch("/api/overview", { credentials: "same-origin" });
    if (response.status === 401) { login.classList.remove("hidden"); dashboard.classList.add("hidden"); return; }
    if (!response.ok) throw new Error("Dashboard konnte nicht geladen werden.");
    const data = await response.json();
    login.classList.add("hidden"); dashboard.classList.remove("hidden"); $("logout").classList.remove("hidden"); $("staff-name").textContent = data.member.name;
    const cards = [["Mitglieder", data.stats.members ?? "—", "♙"], ["Offene Tickets", data.stats.tickets, "▣"], ["Offene Anträge", data.stats.applications, "✳"], ["Kommende Events", data.stats.events, "◷"], ["Giveaways", data.stats.giveaways, "✦"], ...(data.stats.sanctions == null ? [] : [["Offene Sanktionen", data.stats.sanctions, "⚑"]])];
    $("stats").innerHTML = cards.map(([label, value, symbol]) => `<div class="stat"><span class="symbol">${symbol}</span><div class="label">${label}</div><div class="value">${escapeHtml(value)}</div></div>`).join("");
    $("events").innerHTML = data.events.map(event => row(event.name, `${date(event.starts_at)} · ${event.location}`, "Geplant")).join("") || empty;
    $("applications").innerHTML = data.applications.map(item => row(item.kind === "rang" ? "Rang-Antrag" : "Familienbewerbung", `Eingang ${date(item.created_at)}`, item.status === "review" ? "In Prüfung" : "Offen")).join("") || empty;
    $("activity").innerHTML = data.activity.map(item => row(labels[item.action] || item.action, `${date(item.created_at)} · Staff-Aktion`)).join("") || empty;
    $("updated-at").textContent = `· ${new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
    if (data.finance) { $("finance-panel").classList.remove("hidden"); $("finance").innerHTML = `<div class="finance-item"><span>Familienkonten</span><b>${data.finance.balances}</b></div><div class="finance-item"><span>Offene Sanktionsreste</span><b>${(data.finance.openSanctions / 100).toLocaleString("de-AT", { minimumFractionDigits: 2 })} $</b></div>`; }
    await loadManagement();
  } catch (error) { login.classList.remove("hidden"); message.textContent = error.message; }
}
async function loadManagement() {
  const data = await api("/api/manage");
  const caps = data.capabilities, panels = [["application-panel", caps.applications], ["ticket-panel", caps.tickets], ["event-panel", caps.events], ["event-manage-panel", caps.events]];
  let enabled = false;
  for (const [id, active] of panels) { $(id).classList.toggle("hidden", !active); enabled ||= active; }
  $("manage").classList.toggle("hidden", !enabled);
  if (caps.applications) renderApplications(data.applications);
  if (caps.tickets) renderTickets(data.tickets);
  if (caps.events) renderManageEvents(data.events);
    filterQueue();
}

document.addEventListener("click", event => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const { action, id } = button.dataset;
  if (action === "claim-app") return perform(button, () => api(`/api/applications/${encodeURIComponent(id)}/claim`, { method: "POST", body: "{}" }));
  if (action === "accept-app") {
    if (!confirm("Antrag annehmen? Der Antragsteller erhält sofort eine private Nachricht.")) return;
    return perform(button, () => api(`/api/applications/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify({ status: "accepted" }) }));
  }
  if (action === "reject-app") { rejectingApplication = id; $("reject-form").reset(); $("reject-dialog").showModal(); return; }
  if (action === "claim-ticket") return perform(button, () => api(`/api/tickets/${encodeURIComponent(id)}/claim`, { method: "POST", body: "{}" }));
  if (action === "close-ticket") {
    if (!confirm("Ticket schließen und den Verlauf speichern?")) return;
    return perform(button, () => api(`/api/tickets/${encodeURIComponent(id)}/close`, { method: "POST", body: "{}" }));
  }
  if (action === "cancel-event") {
    if (!confirm("Event absagen? Die Anmeldung wird beendet und die Teilnehmenden sehen den Status im Ankündigungskanal.")) return;
    return perform(button, () => api(`/api/events/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }));
  }
});
$("reject-form").addEventListener("submit", async event => {
  if (event.submitter?.value !== "reject") return;
  event.preventDefault();
  const form = event.currentTarget, button = $("reject-submit");
  if (!form.reportValidity() || busy || !rejectingApplication) return;
  busy = true; button.disabled = true;
  try {
    const result = await api(`/api/applications/${encodeURIComponent(rejectingApplication)}/decision`, { method: "POST", body: JSON.stringify({ status: "rejected", reason: form.elements.reason.value.trim() }) });
    $("reject-dialog").close(); rejectingApplication = null; notify(result.message); await load();
  } catch (error) { notify(error.message, "error"); }
  finally { busy = false; button.disabled = false; }
});
$("event-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector("button[type=submit]"), values = Object.fromEntries(new FormData(form));
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(values.startsAt);
  if (!match) { $("event-feedback").textContent = "Bitte Datum und Uhrzeit auswählen."; return; }
  const [, year, month, day, hour, minute] = match;
  const startsAt = `${day}.${month}.${year} ${hour}:${minute}`;
  const payload = { ...values, startsAt, maximum: values.maximum ? Number(values.maximum) : null };
  button.disabled = true; $("event-feedback").textContent = "Wird veröffentlicht …";
  try { const result = await api("/api/events", { method: "POST", body: JSON.stringify(payload) }); form.reset(); $("event-feedback").textContent = result.message; await load(); }
  catch (error) { $("event-feedback").textContent = error.message; }
  finally { button.disabled = false; }
});
$("logout").addEventListener("click", async () => { await fetch("/logout", { method: "POST", credentials: "same-origin" }); location.reload(); });
$("queue-search").addEventListener("input", filterQueue);
load(); setInterval(load, 60_000);
