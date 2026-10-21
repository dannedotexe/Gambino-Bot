// Aufgaben-Logs: Prüf-Warteschlange mit Screenshots, Bestenliste, Preisliste und Verlauf. Nutzt Hilfsfunktionen aus app.js.
const taskState = { data: null, proofs: new Map() };
const taskMedals = ["🥇", "🥈", "🥉"];
const taskStatus = { pending: ["Offen", "status-open"], approved: ["Bestätigt", "status-accepted"], rejected: ["Abgelehnt", "status-rejected"] };
const taskTitle = l => `${l.type}${l.perUnit ? ` ×${l.quantity} ${l.unit}` : ""}`;
/** Fortschritt der Invite-Bedingung als zwei Balken (Tage, Events). */
const inviteMeter = p => {
  if (!p) return "";
  if (!p.inGuild) return '<div class="invite-meter"><div class="task-flag">⚠️ Eingeladene Person ist (noch) nicht auf dem Server.</div></div>';
  const bar = (label, have, need) => need ? `<div class="invite-row ${have >= need ? "ok" : ""}"><span>${label}</span><div class="invite-bar"><i data-pct="${Math.round(Math.min(1, have / need) * 100)}"></i></div><b>${Math.min(have, need)}/${need}${have >= need ? " ✓" : ""}</b></div>` : "";
  return `<div class="invite-meter">${bar("📅 Tage", p.days, p.needDays)}${bar("🎯 Events", p.events, p.needEvents)}<small>${p.met ? "✅ Bedingung erfüllt – Bestätigen zahlt sofort aus." : "⏳ Noch nicht erfüllt – Bestätigen hält die Auszahlung zurück, der Bot zahlt automatisch, sobald erfüllt."}</small></div>`;
};
const fillMeters = root => root.querySelectorAll(".invite-bar i[data-pct]").forEach(el => { el.style.width = `${el.dataset.pct}%`; });
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
  loadLogbooks().catch(error => { $("logbook-forums").innerHTML = empty(error.message); });
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
        ${l.invitee_id ? `<div class="desc">Eingeladen: ${plink(l.invitee_id)}${l.condition ? ` · ${escapeHtml(l.condition)}` : ""}</div>${inviteMeter(l.invite)}` : ""}
        ${l.note ? `<div class="desc">„${escapeHtml(l.note)}“</div>` : ""}
        ${l.duplicate_of ? '<div class="task-flag">⚠️ Gleicher Screenshot wie ein früheres Log – bitte genau prüfen.</div>' : ""}
        <div class="actions">${buttons}</div></div></article>`;
  }).join("") || '<div class="all-done"><b>Alles geprüft 🎉</b><small>Gerade wartet kein Aufgaben-Log.</small></div>';
  pending.filter(l => l.hasProof).forEach(l => loadTaskProof(l.id));
  fillMeters($("tasks-pending"));
  const held = taskState.data.held ?? [];
  $("tasks-held-wrap").hidden = !held.length;
  $("tasks-held").innerHTML = held.map(l => myRow(`${escapeHtml(taskTitle(l))} · ${plink(l.user_id)} → ${plink(l.invitee_id)}`,
    `${escapeHtml(l.condition ?? "")} · bestätigt von ${plink(l.preapproved_by)} ${date(l.preapproved_at)}${l.reward_cents ? ` · ${money(l.reward_cents)} offen` : ""}`)
    + inviteMeter(l.invite) + `<div class="actions held-actions">${btn("Doch ablehnen", "task-reject", { id: l.id }, "reject")}</div>`).join("");
  fillMeters($("tasks-held"));
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
  $("tasks-types").innerHTML = taskState.data.types.map(t => `<div class="row type-row"><div><div class="row-title">${escapeHtml(`${t.emoji} ${t.name}`)}${t.active ? "" : '<span class="off">deaktiviert</span>'}</div><div class="row-sub">${escapeHtml(taskReward(t))}${t.daily_limit ? ` · max. ${t.daily_limit}× pro Tag` : ""}${t.invite_min_days != null || t.invite_min_events != null ? escapeHtml(` · erst nach ${t.invite_min_days ?? 0} Tagen & ${t.invite_min_events ?? 0} Events`) : ""}</div></div>${edit ? btn("Bearbeiten", "tasktype-edit", { id: t.id }) : ""}</div>`).join("") || empty("Noch keine Aufgaben – lege die erste an.");
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
      { name: "inviteMinDays", label: "Invite: Mindest-Tage auf dem Server", value: type?.invite_min_days ?? "", hint: "nur für Invites – leer = keine eingeladene Person nötig", max: 2 },
      { name: "inviteMinEvents", label: "Invite: Mindest-Events dabei", value: type?.invite_min_events ?? "", hint: "Auszahlung erst, wenn beides erfüllt ist", max: 2 },
      ...(type ? [{ name: "active", label: "Status", type: "select", value: type.active ? "true" : "false", options: [["true", "Aktiv"], ["false", "Deaktiviert (nicht mehr wählbar)"]] }] : []),
    ],
    submit: "Speichern", onSubmit: v => post("/api/task-types", { ...v, id: type?.id ?? null }) });
}

// ------------------------------------------------------------------ Schnell-Prüfmodus (J = bestätigen, N = ablehnen, M = Menge, → = überspringen)
const quick = { list: [], index: 0, panel: null, busy: false };
function quickOpen() {
  const { pending, me, owner } = taskState.data ?? {};
  quick.list = (pending ?? []).filter(l => owner || l.user_id !== me); quick.index = 0;
  if (!quick.list.length) return notify("Gerade wartet kein Log, das du prüfen darfst.");
  $("quick").showModal(); $("quick").focus(); quickShow();
}
function quickPanel(name) {
  quick.panel = name;
  $("quick-main").hidden = Boolean(name); $("quick-qty").hidden = name !== "qty"; $("quick-reasons").hidden = name !== "reasons";
  if (name === "qty") { $("quick-qty-input").value = quick.list[quick.index].quantity; $("quick-qty-input").select(); }
  if (name === "reasons") { $("quick-reason-input").value = ""; }
}
async function quickShow() {
  const l = quick.list[quick.index];
  if (!l) { $("quick").close(); notify("Alles geprüft 🎉"); return refresh(); }
  quickPanel(null); $("quick-error").textContent = "";
  $("quick-count").textContent = `${quick.index + 1} von ${quick.list.length}`;
  $("quick-title").textContent = taskTitle(l);
  $("quick-reward").textContent = l.reward_cents ? `+${money(l.reward_cents)}` : "ohne Geld";
  $("quick-meta").innerHTML = `${who(l.user_id)} · ${date(l.created_at)}`;
  $("quick-note").textContent = l.note ? `„${l.note}“` : "";
  $("quick-flag").hidden = !l.duplicate_of;
  $("quick-qty-btn").hidden = !l.perUnit;
  $("quick-reason-list").innerHTML = (taskState.data.rejectReasons ?? []).slice(0, 9).map((r, n) => `<button type="button" class="reason-chip" data-action="quick-reason" data-reason="${escapeHtml(r)}"><kbd>${n + 1}</kbd>${escapeHtml(r)}</button>`).join("");
  const img = $("quick-img"); img.removeAttribute("src"); $("quick-loading").textContent = l.hasProof ? "Screenshot lädt …" : "Kein Screenshot";
  if (!l.hasProof) return;
  try {
    const url = taskState.proofs.get(l.id) ?? (await api(`/api/tasks/${l.id}/proof`)).url;
    taskState.proofs.set(l.id, url);
    if (quick.list[quick.index] !== l) return;
    img.src = url; img.onload = () => { $("quick-loading").textContent = ""; };
  } catch (error) { $("quick-loading").textContent = error.message; }
  // Nächsten Screenshot schon vorladen.
  const next = quick.list[quick.index + 1];
  if (next?.hasProof && !taskState.proofs.has(next.id)) api(`/api/tasks/${next.id}/proof`).then(r => { taskState.proofs.set(next.id, r.url); new Image().src = r.url; }).catch(() => {});
}
function quickNext(step) { quick.index = Math.min(quick.list.length, Math.max(0, quick.index + step)); quickShow(); }
async function quickDecide(action, body) {
  const l = quick.list[quick.index];
  if (!l || quick.busy) return;
  if (action === "reject" && String(body.reason ?? "").trim().length < 3) { $("quick-error").textContent = "Bitte einen Grund wählen oder eingeben."; return; }
  quick.busy = true;
  try {
    const result = await post(`/api/tasks/${l.id}/${action}`, body);
    notify(result.message);
    quick.list.splice(quick.index, 1); taskState.data.pending = taskState.data.pending.filter(x => x.id !== l.id);
    quickShow();
  } catch (error) { $("quick-error").textContent = error.message; }
  finally { quick.busy = false; }
}
$("quick").addEventListener("close", () => { if (state.tab === "tasks") refresh(); });
$("quick").addEventListener("keydown", event => {
  const typing = event.target.matches?.("input,textarea");
  if (event.key === "Escape") { if (quick.panel) { event.preventDefault(); quickPanel(null); } return; }
  if (quick.panel === "qty" && event.key === "Enter") { event.preventDefault(); return quickDecide("approve", { quantity: $("quick-qty-input").value }); }
  if (quick.panel === "reasons") {
    if (event.key === "Enter") { event.preventDefault(); return quickDecide("reject", { reason: $("quick-reason-input").value }); }
    const n = Number(event.key);
    if (!typing && n >= 1 && n <= 9 && taskState.data.rejectReasons?.[n - 1]) { event.preventDefault(); return quickDecide("reject", { reason: taskState.data.rejectReasons[n - 1] }); }
    return;
  }
  if (typing || quick.panel) return;
  const key = event.key.toLowerCase();
  if (key === "j") { event.preventDefault(); quickDecide("approve", {}); }
  else if (key === "n") { event.preventDefault(); quickPanel("reasons"); setTimeout(() => $("quick-reason-input").blur(), 0); }
  else if (key === "m" && quick.list[quick.index]?.perUnit) { event.preventDefault(); quickPanel("qty"); }
  else if (event.key === "ArrowRight") { event.preventDefault(); quickNext(1); }
  else if (event.key === "ArrowLeft") { event.preventDefault(); quickNext(-1); }
});

/** Logbücher (Aufgaben- und Event-Forum): zeigt, warum keine angelegt werden, und wer noch keins hat. */
async function loadLogbooks() {
  const { forums } = await api("/api/logbooks");
  const staff = state.me.capabilities.staff;
  $("logbook-forums").innerHTML = forums.map(d => {
    const info = d.forum ? `#${escapeHtml(d.forum.name)} · ${d.withLogbook} von ${d.family} haben eins${d.running ? " · wird gerade angelegt …" : ""}` : "Kein Forum eingestellt";
    const rows = [
      ...d.problems.map(p => myRow(`⚠️ ${escapeHtml(p)}`, "Das verhindert, dass Logbücher angelegt werden.")),
      ...(d.lastError && d.kind === "tasks" ? [myRow(`Letzter Fehler: ${escapeHtml(d.lastError.message)}`, date(d.lastError.at))] : []),
      ...(d.problems.length ? [] : [myRow("✅ Alles bereit", "Wer neu zur Familie kommt, bekommt automatisch seinen Post. Für alle anderen: „Fehlende anlegen“.")]),
      ...(d.missing.length ? [myRow(`Ohne ${escapeHtml(d.label)} (${d.missing.length})`, d.missing.slice(0, 40).map(m => escapeHtml(m.name)).join(", ") + (d.missing.length > 40 ? " …" : ""))] : []),
    ].join("");
    const button = staff && d.forum ? `<button type="button" class="primary-btn" data-action="logbook-create" data-kind="${escapeHtml(d.kind)}" ${!d.missing.length || d.running ? "disabled" : ""}>${d.missing.length ? `Fehlende anlegen (${d.missing.length})` : "Alle haben eins"}</button>` : "";
    const reset = state.me.capabilities.leaders && d.forum ? `<button type="button" class="action reject" data-action="logbook-reset" data-kind="${escapeHtml(d.kind)}" ${d.running ? "disabled" : ""}>Neu aufsetzen …</button>` : "";
    return `<div class="logbook-forum"><div class="panel-head"><div><h3>${escapeHtml(d.label)}</h3><p class="subtle">${info}</p></div><div class="section-tools">${reset}${button}</div></div><div class="rows">${rows}</div></div>`;
  }).join("");
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
    const l = [...taskState.data.pending, ...(taskState.data.held ?? [])].find(x => x.id === id);
    const chips = (taskState.data.rejectReasons ?? []).map(r => `<button type="button" class="reason-chip" data-action="task-reason-chip" data-reason="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join("");
    openForm({ eyebrow: "AUFGABEN-LOG", title: "Log ablehnen", intro: `<p>${escapeHtml(taskTitle(l))} von ${who(l.user_id)}. Der Grund geht per DM an das Mitglied.</p>${chips ? `<div class="chip-row">${chips}</div>` : ""}`, danger: true,
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
  "logbook-reset": ({ kind }) => openForm({ eyebrow: "LOGBÜCHER", title: "Forum neu aufsetzen", danger: true,
    intro: "<p><b>Alle Posts in diesem Forum werden gelöscht</b> (außer einem Post „Vorlage …“) – auch die Bilder darin. Danach bekommt jedes Familienmitglied einen frischen Post mit dem aktuellen Text. Das lässt sich nicht rückgängig machen.</p>",
    fields: [{ name: "confirm", label: "Zum Bestätigen NEU eintippen", required: true, max: 10 }],
    submit: "Löschen und neu anlegen", onSubmit: v => post("/api/logbooks/reset", { kind, confirm: v.confirm }) }),
  "logbook-create": ({ kind }) => confirmAction("Fehlende Logbücher anlegen?", "Für jedes Familienmitglied ohne Logbuch wird ein Post im Forum erstellt und die Person markiert. Gibt es schon einen Post mit ihrem Namen oder ihrer ID, wird er nur verknüpft.", "Anlegen", () => post("/api/logbooks/create-missing", { kind }), false),
  "task-reason-chip": ({ reason }) => { const box = $("dialog-fields").querySelector("textarea"); if (box) { box.value = reason; box.focus(); } },
  "task-quick": () => quickOpen(),
  "quick-close": () => $("quick").close(),
  "quick-approve": () => quickDecide("approve", {}),
  "quick-skip": () => quickNext(1),
  "quick-qty": () => quickPanel("qty"),
  "quick-reject": () => quickPanel("reasons"),
  "quick-back": () => quickPanel(null),
  "quick-qty-save": () => quickDecide("approve", { quantity: $("quick-qty-input").value }),
  "quick-reason": ({ reason }) => quickDecide("reject", { reason }),
  "quick-reject-save": () => quickDecide("reject", { reason: $("quick-reason-input").value }),
  "tasktype-create": () => taskTypeForm(),
  "tasktype-edit": ({ id }) => taskTypeForm(taskState.data.types.find(t => t.id === id)),
});
