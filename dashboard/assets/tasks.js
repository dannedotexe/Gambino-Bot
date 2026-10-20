// Aufgaben-Logs: Prüf-Warteschlange mit Screenshots, Bestenliste, Preisliste und Verlauf. Nutzt Hilfsfunktionen aus app.js.
const taskState = { data: null, proofs: new Map() };
const taskMedals = ["🥇", "🥈", "🥉"];
const taskStatus = { pending: ["Offen", "status-open"], approved: ["Bestätigt", "status-accepted"], rejected: ["Abgelehnt", "status-rejected"] };
const taskTitle = l => `${l.type}${l.perUnit ? ` ×${l.quantity} ${l.unit}` : ""}`;
const taskReward = t => t.reward_cents ? `${money(t.reward_cents)}${t.per_unit ? ` pro ${t.unit}` : ""}` : "ohne Geld";

async function loadTasks() {
  const data = await api("/api/tasks");
  taskState.data = data;
  const s = data.summary;
  $("tasks-stats").innerHTML = [
    myStat("Wartet auf Prüfung", escapeHtml(s.pending)),
    myStat("Bestätigt diese Woche", escapeHtml(s.weekApproved)),
    myStat("Ausgezahlt diese Woche", money(s.weekPaid)),
    myStat("Aktive Aufgaben", escapeHtml(data.types.filter(t => t.active).length)),
  ].join("");
  renderTaskQueue(); renderTaskBoard(); renderTaskTypes(); renderTaskHistory();
  loadLogbooks().catch(error => { $("logbook-info").textContent = error.message; });
  if ((state.badges?.tasks ?? 0) !== s.pending) { state.badges = { ...state.badges, tasks: s.pending }; renderTabs(); }
}

function renderTaskQueue() {
  const { pending, me, owner } = taskState.data;
  $("tasks-pending").innerHTML = pending.map(l => {
    const own = l.user_id === me && !owner;
    const buttons = own ? '<span class="muted">Dein eigenes Log – prüft jemand anderes</span>'
      : btn(l.reward_cents ? `✓ Bestätigen · ${money(l.reward_cents)}` : "✓ Bestätigen", "task-approve", { id: l.id }, "approve") + (l.perUnit ? btn("Menge ändern", "task-quantity", { id: l.id }) : "") + btn("Ablehnen", "task-reject", { id: l.id }, "reject");
    return `<article class="task-card ${l.duplicate_of ? "flagged" : ""}" data-task="${escapeHtml(l.id)}">
      <button type="button" class="task-shot" data-action="task-proof" data-id="${escapeHtml(l.id)}" aria-label="Screenshot vergrößern"><span>${l.hasProof ? "Screenshot lädt …" : "Kein Screenshot"}</span>${l.reward_cents ? `<b class="task-reward">+${money(l.reward_cents)}</b>` : ""}</button>
      <div class="task-body"><h3>${escapeHtml(taskTitle(l))}</h3>
        <div class="manage-meta">${plink(l.user_id)} · ${date(l.created_at)}</div>
        ${l.note ? `<div class="desc">„${escapeHtml(l.note)}“</div>` : ""}
        ${l.duplicate_of ? '<div class="task-flag">⚠️ Gleicher Screenshot wie ein früheres Log – bitte genau prüfen.</div>' : ""}
        <div class="actions">${buttons}</div></div></article>`;
  }).join("") || '<div class="all-done"><b>Alles geprüft 🎉</b><small>Gerade wartet kein Aufgaben-Log.</small></div>';
  pending.filter(l => l.hasProof).forEach(l => loadTaskProof(l.id));
}

/** Screenshot-Link frisch vom Server holen (Discord-Links laufen ab) und als Vorschau einsetzen. */
async function loadTaskProof(id) {
  const box = document.querySelector(`[data-task="${CSS.escape(id)}"] .task-shot span`);
  try {
    const url = taskState.proofs.get(id) ?? (await api(`/api/tasks/${id}/proof`)).url;
    taskState.proofs.set(id, url);
    if (!box?.isConnected) return;
    const img = document.createElement("img"); img.alt = "Screenshot"; img.loading = "lazy"; img.src = url;
    img.addEventListener("error", () => { box.textContent = "Screenshot nicht ladbar"; img.remove(); });
    box.replaceWith(img);
  } catch (error) { if (box) box.textContent = error.message; }
}

function renderTaskBoard() {
  const rows = taskState.data.board[$("tasks-board-period").value] ?? [];
  $("tasks-board").innerHTML = rows.map((r, n) => myRow(`<span class="medal">${taskMedals[n] ?? `${n + 1}.`}</span>${plink(r.userId)}`, `${nLogs(r.logs)} · ${r.units} Stück · ${money(r.earned)} verdient`)).join("") || empty("Noch keine bestätigten Logs in diesem Zeitraum.");
}

function renderTaskTypes() {
  const edit = state.me.capabilities.taskTypes;
  $("tasks-types").innerHTML = taskState.data.types.map(t => `<div class="row type-row"><div><div class="row-title">${escapeHtml(`${t.emoji} ${t.name}`)}${t.active ? "" : '<span class="off">deaktiviert</span>'}</div><div class="row-sub">${escapeHtml(taskReward(t))}${t.daily_limit ? ` · max. ${t.daily_limit}× pro Tag` : ""}</div></div>${edit ? btn("Bearbeiten", "tasktype-edit", { id: t.id }) : ""}</div>`).join("") || empty("Noch keine Aufgaben – lege die erste an.");
}

function renderTaskHistory() {
  const rows = taskState.data.recent;
  $("tasks-history").innerHTML = rows.length ? `<div class="table-row table-head task-hist"><span>Datum</span><span>Mitglied</span><span>Aufgabe</span><span>Betrag</span><span>Entscheidung</span></div>` + rows.map(l => {
    const [label, cls] = taskStatus[l.status] ?? [l.status, ""];
    return `<div class="table-row task-hist"><span>${date(l.created_at)}</span><span>${plink(l.user_id)}</span><span>${escapeHtml(taskTitle(l))}</span><span>${l.status === "approved" ? money(l.reward_cents) : "—"}</span><span><span class="badge ${cls}">${label}</span> <small>${l.reviewer_id === l.user_id ? "selbst zurückgezogen" : who(l.reviewer_id)}${l.reject_reason && l.reviewer_id !== l.user_id ? ` · ${escapeHtml(l.reject_reason)}` : ""}</small></span></div>`;
  }).join("") : empty("Noch keine entschiedenen Logs.");
}

/** Karte nach der Entscheidung sanft ausblenden, dann neu laden. */
async function decideTask(id, body, action) {
  const result = await post(`/api/tasks/${id}/${action}`, body);
  document.querySelector(`[data-task="${CSS.escape(id)}"]`)?.classList.add("leaving");
  notify(result.message);
  setTimeout(() => refresh(), 250);
}

function taskTypeForm(type = null) {
  openForm({ eyebrow: "AUFGABEN", title: type ? "Aufgabe bearbeiten" : "Neue Aufgabe", intro: "<p>Erscheint bei <b>/log</b> zur Auswahl und auf dem Aufgaben-Board. Änderungen der Belohnung gelten für neue Bestätigungen.</p>",
    fields: [
      { name: "emoji", label: "Emoji", value: type?.emoji ?? "📋", max: 8 },
      { name: "name", label: "Name", required: true, value: type?.name ?? "", max: 60, placeholder: "z. B. Plantage, Waffen craften, Autoklau" },
      { name: "reward", label: "Belohnung", value: type ? String(type.reward_cents / 100) : "", hint: "z. B. 25000 oder 25k – leer/0 = nur zählen", max: 20 },
      { name: "perUnit", label: "Berechnung", type: "select", value: type?.per_unit ? "true" : "false", options: [["false", "Fester Betrag pro Log"], ["true", "Pro Stück (Mitglied gibt Menge an)"]] },
      { name: "unit", label: "Einheit (bei „pro Stück“)", value: type?.unit ?? "Stück", max: 30, placeholder: "Ernte, Panel, Auto …" },
      { name: "dailyLimit", label: "Tageslimit pro Person", value: type?.daily_limit ?? "", hint: "leer = unbegrenzt", max: 3 },
      ...(type ? [{ name: "active", label: "Status", type: "select", value: type.active ? "true" : "false", options: [["true", "Aktiv"], ["false", "Deaktiviert (nicht mehr wählbar)"]] }] : []),
    ],
    submit: "Speichern", onSubmit: v => post("/api/task-types", { ...v, id: type?.id ?? null }) });
}

/** Logbücher: zeigt, warum keine angelegt werden, und wer noch keins hat. */
async function loadLogbooks() {
  const d = await api("/api/logbooks");
  $("logbook-info").textContent = d.forum ? `Forum #${d.forum.name} · ${d.withLogbook} von ${d.family} Familienmitgliedern haben ein Logbuch${d.running ? " · wird gerade angelegt …" : ""}` : "Kein Forum eingestellt.";
  const create = document.querySelector('[data-action="logbook-create"]');
  if (create) { create.textContent = d.missing.length ? `Fehlende anlegen (${d.missing.length})` : "Alle haben eins"; create.disabled = !d.missing.length || Boolean(d.running) || !d.forum; }
  $("logbook-status").innerHTML = [
    ...d.problems.map(p => myRow(`⚠️ ${escapeHtml(p)}`, "Das verhindert, dass Logbücher angelegt werden.")),
    ...(d.lastError ? [myRow(`Letzter Fehler: ${escapeHtml(d.lastError.message)}`, date(d.lastError.at))] : []),
    ...(d.problems.length ? [] : [myRow("✅ Alles bereit", "Wer neu die Familienrolle bekommt, erhält automatisch sein Logbuch. Bestehende Mitglieder ohne Logbuch: Button „Fehlende anlegen“.")]),
    ...(d.missing.length ? [myRow(`Ohne Logbuch (${d.missing.length})`, d.missing.slice(0, 40).map(m => escapeHtml(m.name)).join(", ") + (d.missing.length > 40 ? " …" : ""))] : []),
  ].join("");
}

$("tasks-board-period").addEventListener("change", () => taskState.data && renderTaskBoard());
loaders.tasks = loadTasks;
Object.assign(actions, {
  "task-approve": ({ id }) => decideTask(id, {}, "approve"),
  "task-quantity": ({ id }) => {
    const l = taskState.data.pending.find(x => x.id === id);
    openForm({ eyebrow: "AUFGABEN-LOG", title: "Menge korrigieren und bestätigen", intro: `<p>${escapeHtml(taskTitle(l))} von ${who(l.user_id)}</p>`,
      fields: [{ name: "quantity", label: `Richtige Anzahl (${l.unit})`, type: "number", required: true, value: l.quantity, min: 1, maxValue: 999 }],
      submit: "Bestätigen", onSubmit: v => post(`/api/tasks/${id}/approve`, v) });
  },
  "task-reject": ({ id }) => {
    const l = taskState.data.pending.find(x => x.id === id);
    openForm({ eyebrow: "AUFGABEN-LOG", title: "Log ablehnen", intro: `<p>${escapeHtml(taskTitle(l))} von ${who(l.user_id)}. Der Grund geht per DM an das Mitglied.</p>`, danger: true,
      fields: [{ name: "reason", label: "Grund", type: "textarea", required: true, max: 300, placeholder: "z. B. Datum und Uhrzeit nicht sichtbar" }],
      submit: "Ablehnen", onSubmit: v => post(`/api/tasks/${id}/reject`, v) });
  },
  "task-proof": async ({ id }) => {
    const url = taskState.proofs.get(id) ?? (await api(`/api/tasks/${id}/proof`)).url;
    taskState.proofs.set(id, url);
    const l = taskState.data.pending.find(x => x.id === id);
    openInfo(l ? taskTitle(l) : "Screenshot", `<img class="lightbox-img" src="${escapeHtml(url)}" alt="Screenshot"><p class="subtle"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">In neuem Tab öffnen</a></p>`, "BEWEIS", true);
  },
  "logbook-check": () => loadLogbooks(),
  "logbook-create": () => confirmAction("Fehlende Logbücher anlegen?", "Für jedes Familienmitglied ohne Logbuch wird ein Post im Forum erstellt und die Person markiert. Gibt es schon einen Post mit ihrem Namen oder ihrer ID, wird er nur verknüpft.", "Anlegen", () => post("/api/logbooks/create-missing"), false),
  "tasktype-create": () => taskTypeForm(),
  "tasktype-edit": ({ id }) => taskTypeForm(taskState.data.types.find(t => t.id === id)),
});
