// Event-Logs: Bilder aus dem Forum „event-logs“ pro Tag, nach Event gruppiert. Nutzt Hilfsfunktionen aus app.js.
const evlogState = { day: null, today: null, data: null, images: new Map(), queue: [], running: 0 };
const evlogClock = iso => new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: state.timezone }).format(new Date(iso));
const evlogShift = (day, n) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const evlogDayLabel = day => day === evlogState.today ? "Heute" : day === evlogShift(evlogState.today, -1) ? "Gestern"
  : new Intl.DateTimeFormat("de-AT", { weekday: "long", day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));

async function loadEventLogs(day = evlogState.day) {
  const data = await api(`/api/event-logs${day ? `?day=${day}` : ""}`);
  Object.assign(evlogState, { data, day: data.day, today: data.today });
  const total = data.events.reduce((s, e) => s + e.proofs.length, 0) + data.unassigned.length;
  $("evlogs-title").textContent = `📸 Event-Logs · ${evlogDayLabel(data.day)}`;
  $("evlogs-next").disabled = data.day >= data.today;
  // Verschieben (anderes Event des Tages) und Löschen unter jedem Bild.
  const options = current => `<option value="">${current ? "Verschieben …" : "Event zuordnen …"}</option>${data.events.filter(e => e.id !== current).map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(`${e.name} · ${evlogClock(e.startsAt)}`)}</option>`).join("")}`;
  const tools = (p, current) => `<div class="evlog-tools">${data.events.some(e => e.id !== current) ? `<select class="evlog-assign" data-assign="${escapeHtml(p.messageId)}" aria-label="${current ? "Verschieben" : "Event zuordnen"}">${options(current)}</select>` : ""}<button type="button" class="action reject" data-action="evlog-delete" data-id="${escapeHtml(p.messageId)}" title="Event-Log löschen">Löschen</button></div>`;
  const figure = (p, current = null) => `<figure class="evlog" data-proof="${escapeHtml(p.messageId)}"><div class="evlog-imgs"><span class="evlog-wait">lädt …</span></div><figcaption><b>${who(p.userId)}</b> · ${evlogClock(p.createdAt)}${p.images > 1 ? ` · ${p.images} Bilder` : ""}</figcaption>${tools(p, current)}</figure>`;
  const events = data.events.map(e => `<div class="evlog-event"><div class="evlog-head"><div><b>${escapeHtml(e.name)}</b><small>${evlogClock(e.startsAt)} · ${e.proofs.length ? `${e.proofs.length} ${e.proofs.length === 1 ? "Log" : "Logs"} von ${e.people} ${e.people === 1 ? "Person" : "Personen"}` : "noch keine Logs"}${e.closed ? " · Anwesenheit abgeschlossen" : ""}</small></div></div>
    ${e.proofs.length ? `<div class="evlog-grid">${e.proofs.map(p => figure(p, e.id)).join("")}</div>` : ""}
    ${e.missing.length ? `<p class="subtle evlog-missing">Angemeldet, aber ohne Log: ${e.missing.map(who).join(", ")}</p>` : ""}</div>`);
  const unassigned = data.unassigned.length ? `<div class="evlog-event evlog-open"><div class="evlog-head"><div><b>Nicht zugeordnet</b><small>${data.unassigned.length} ${data.unassigned.length === 1 ? "Bild wartet" : "Bilder warten"} auf ein Event</small></div></div><div class="evlog-grid">${data.unassigned.map(p => figure(p)).join("")}</div></div>` : "";
  $("evlogs").innerHTML = total || data.events.length ? unassigned + events.join("") : empty(`${evlogDayLabel(data.day)} gab es keine Events und keine Event-Logs.`);
  evlogState.queue = [...document.querySelectorAll("#evlogs [data-proof]")].map(el => el.dataset.proof);
  for (let n = 0; n < 4; n++) evlogPump();
}

/** Bilder nacheinander laden (max. 4 gleichzeitig), Discord-Links laufen ab – daher frisch vom Server. */
async function evlogPump() {
  const id = evlogState.queue.shift();
  if (!id) return;
  const box = document.querySelector(`#evlogs [data-proof="${CSS.escape(id)}"] .evlog-imgs`);
  try {
    const info = evlogState.images.get(id) ?? await api(`/api/event-logs/${id}`);
    evlogState.images.set(id, info);
    if (box?.isConnected) box.innerHTML = info.missing || !info.images.length ? `<span class="evlog-wait">Bild wurde in Discord gelöscht</span>`
      : info.images.map(url => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(url)}" alt="Event-Log" loading="lazy"></a>`).join("") + `<a class="evlog-link" href="${escapeHtml(info.link)}" target="_blank" rel="noopener noreferrer">in Discord</a>`;
  } catch (error) { if (box) box.innerHTML = `<span class="evlog-wait">${escapeHtml(error.message)}</span>`; }
  evlogPump();
}

$("evlogs").addEventListener("change", async event => {
  const select = event.target.closest("[data-assign]");
  if (!select?.value) return;
  select.disabled = true;
  try { notify((await post(`/api/event-logs/${select.dataset.assign}/assign`, { eventId: select.value })).message); await loadEventLogs(); }
  catch (error) { notify(error.message, "error"); select.disabled = false; }
});
const loadEventsWithLogs = loaders.events;
loaders.events = async () => { await loadEventsWithLogs(); await loadEventLogs().catch(error => { $("evlogs").innerHTML = empty(error.message); }); };
Object.assign(actions, {
  "evlogs-prev": () => loadEventLogs(evlogShift(evlogState.day ?? evlogState.today, -1)),
  "evlogs-next": () => loadEventLogs(evlogShift(evlogState.day ?? evlogState.today, 1)),
  "evlogs-today": () => loadEventLogs(evlogState.today),
  "evlog-delete": ({ id }) => openForm({ eyebrow: "EVENT-LOG", title: "Event-Log löschen", danger: true, intro: "<p>Das Bild wird auch im Forum in Discord gelöscht (samt Bot-Antwort) und zählt nicht mehr als Nachweis. Das lässt sich nicht rückgängig machen.</p>",
    fields: [], submit: "Endgültig löschen", onSubmit: async () => { const r = await post(`/api/event-logs/${id}/delete`); evlogState.images.delete(id); setTimeout(() => loadEventLogs().catch(() => {}), 50); return r; } }),
});
