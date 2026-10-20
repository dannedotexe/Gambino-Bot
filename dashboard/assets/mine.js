// „Mein Bereich“: eigene Daten für jedes Familienmitglied. Nutzt die Hilfsfunktionen aus app.js.
const myDay = value => value ? value.split("-").reverse().join(".") : "—";
const myStat = (label, value, symbol = "") => `<div class="stat"><span class="symbol">${symbol}</span><div class="label">${escapeHtml(label)}</div><div class="value small">${value}</div></div>`;
const myRow = (title, sub) => `<div class="row"><div><div class="row-title">${title}</div><div class="row-sub">${sub}</div></div></div>`;
const myParticipation = { signed_up: "Angemeldet", present: "Anwesend", absent: "Abwesend", left: "nicht angemeldet" };
const myRankKinds = { promotion: "⬆️ Beförderung", demotion: "⬇️ Degradierung", change: "↔️ Rangwechsel" };
const myWarnStates = { active: "Aktiv", expired: "Abgelaufen", revoked: "Zurückgenommen" };

async function loadMine() {
  const d = await api("/api/my");
  state.cache.mine = d;
  const a = d.account, e = d.events;
  $("my-stats").innerHTML = [
    myStat("Guthaben", a.hasAccount ? money(a.gross) : "kein Konto", "$"),
    myStat("Offene Sanktionen", money(a.openSanctions)),
    myStat("Bei Auszahlung netto", money(a.net), "→"),
    ...(a.minimum ? [myStat("Auszahlung ab", a.gross >= a.minimum ? `${money(a.minimum)} <small class="ok">✓ erreicht</small>` : `${money(a.minimum)} <small>noch ${money(a.minimum - a.gross)}</small>`, "⌁")] : []),
    myStat("Rang", escapeHtml(d.rank.current ?? "—"), "★"),
    myStat("Event-Teilnahmen", escapeHtml(e.stats.participations), "#"),
    myStat("Event-Bilanz", `${e.record.wins} Win · ${e.record.losses} Lose`, "🏆"),
    myStat("Durch Events verdient", money(e.earned), "$"),
    ...(e.kills?.kills ? [myStat("Kills", `${e.kills.kills} <small>Bestwert ${e.kills.best} in einem Event</small>`)] : []),
    myStat("No-Shows", e.noShowLimit ? `${e.noShows} von ${e.noShowLimit} <small>(${e.noShowWindow} Tage)</small>` : escapeHtml(e.noShows)),
  ].join("");
  renderMyTasks(d.tasks);
  $("my-absence-label").textContent = d.absences.open ? "Abmeldung beenden" : "Abmelden";
  const short = d.shortAbsence;
  $("my-short-label").textContent = short ? `Zurück (kurz weg bis ${new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: state.timezone }).format(new Date(short.ends_at))})` : "⏱️ Kurz weg";
  $("my-transactions").innerHTML = a.transactions.map(t => myRow(`${txLabels[t.type] ?? t.type} · ${t.type === "payout" ? `${money(t.net_cents)} ausgezahlt${t.deduction_cents ? ` (Abzug ${money(t.deduction_cents)})` : ""}` : `${["payout", "correction_debit"].includes(t.type) ? "−" : "+"}${money(t.amount_cents)}`}`, `${date(t.created_at)} · ${escapeHtml(t.reason)}`)).join("") || empty("Noch keine Buchungen.");
  $("my-discipline").innerHTML = [
    ...d.sanctions.map(s => myRow(`Sanktion ${money(s.amount_cents)} · ${statusLabels[s.status] ?? s.status}`, `${escapeHtml(s.reason)} · offen ${money(s.remaining_cents)} · ${date(s.created_at)}`)),
    ...d.warnings.map(w => myRow(`Verwarnung · ${myWarnStates[w.state] ?? w.state}`, `${escapeHtml(w.reason)} · ${date(w.created_at)}${w.revoke_reason ? ` · zurückgenommen: ${escapeHtml(w.revoke_reason)}` : ""}`)),
  ].join("") || empty("Keine Sanktionen oder Verwarnungen. 👍");
  $("my-events").innerHTML = [
    ...e.upcoming.map(ev => myRow(`${escapeHtml(ev.name)} · ${ev.status ? myParticipation[ev.status] ?? ev.status : "nicht angemeldet"}`, `${date(ev.starts_at)}${ev.location ? ` · ${escapeHtml(ev.location)}` : ""} · Anmeldung über Discord`)),
    ...e.past.map(ev => myRow(`${escapeHtml(ev.name)} · ${ev.event_status === "cancelled" ? "abgesagt" : myParticipation[ev.status] ?? ev.status}${ev.outcome === "win" ? " · 🏆 Win" : ev.outcome === "lose" ? " · ❌ Lose" : ""}`, `${date(ev.starts_at)}${ev.won_cents ? ` · +${money(ev.won_cents)} verdient` : " · vergangen"}`)),
  ].join("") || empty("Keine Events.");
  $("my-ranks").innerHTML = d.rank.history.map(r => myRow(`${myRankKinds[r.kind] ?? r.kind}: ${escapeHtml(r.from ?? "—")} → ${escapeHtml(r.to ?? "—")}`, date(r.created_at))).join("") || empty("Noch keine Rangänderung erfasst.");
  $("my-absences").innerHTML = d.absences.list.map(x => myRow(`${myDay(x.starts_on)} – ${myDay(x.ends_on)}${x.ended_at ? " · beendet" : d.absences.open?.id === x.id ? " · läuft" : ""}`, escapeHtml(x.reason))).join("") || empty("Keine Abmeldungen.");
  renderMyBoard();
  loadCalendar("my").catch(() => {});
}
const nLogs = n => `${n} ${n === 1 ? "Log" : "Logs"}`;
const myTaskIcons = { pending: "⏳", approved: "✅", rejected: "❌" };
function renderMyTasks(t) {
  if (!t) { $("my-tasks-panel").hidden = true; return; }
  const p = t.profile, lvl = p.level;
  $("my-level-badge").textContent = lvl.emoji;
  $("my-level-title").textContent = `Stufe: ${lvl.name}`;
  // Breite per CSSOM (Inline-Styles sind durch die Content-Security-Policy gesperrt).
  requestAnimationFrame(() => { $("my-level-fill").style.width = `${Math.round(lvl.progress * 100)}%`; });
  $("my-level-next").textContent = lvl.next ? `${lvl.count} von ${lvl.next.min} bestätigten Logs – noch ${lvl.next.missing} bis ${lvl.next.emoji} ${lvl.next.name}` : `${lvl.count} Logs – höchste Stufe erreicht 👑`;
  $("my-tasks-stats").innerHTML = [
    myStat("Serie", p.streak ? `🔥 ${p.streak} ${p.streak === 1 ? "Tag" : "Tage"}` : "—"),
    myStat("Diese Woche", `${nLogs(p.week.logs)}${p.week.place ? ` <small>Platz ${p.week.place} von ${p.week.of}</small>` : ""}`),
    myStat("Woche verdient", money(p.week.earned)),
    myStat("Gesamt verdient", `${money(p.total.earned)} <small>${nLogs(p.total.logs)}</small>`),
    ...(p.pending ? [myStat("Wartet auf Prüfung", escapeHtml(p.pending))] : []),
  ].join("");
  $("my-tasks").innerHTML = t.recent.map(l => myRow(`${myTaskIcons[l.status] ?? ""} ${escapeHtml(l.type)}${l.perUnit ? ` ×${l.quantity} ${escapeHtml(l.unit)}` : ""}${l.status === "approved" && l.reward_cents ? ` · <span class="ok">+${money(l.reward_cents)}</span>` : ""}`, `${date(l.created_at)}${l.status === "pending" ? " · wird geprüft" : l.status === "rejected" ? ` · abgelehnt: ${escapeHtml(l.reject_reason ?? "—")}` : ""}`)).join("") || empty("Noch keine Aufgaben-Logs. Reiche erledigte Aufgaben in Discord mit /log und Screenshot ein.");
}
function renderMyBoard() {
  const d = state.cache.mine;
  if (!d) return;
  const rows = d.leaderboard[$("my-board-period").value] ?? [];
  $("my-board").innerHTML = rows.map((r, n) => myRow(`${["🥇", "🥈", "🥉"][n] ?? `${n + 1}.`} ${who(r.userId)}${r.userId === d.userId ? " <em class=\"ok\">du</em>" : ""}`, `${r.count} Teilnahmen · ${r.present} anwesend`)).join("") || empty("Noch keine Teilnahmen in diesem Zeitraum.");
}
$("my-board-period").addEventListener("change", renderMyBoard);

loaders.mine = loadMine;
Object.assign(actions, {
  "my-short": () => {
    if (state.cache.mine?.shortAbsence) return post("/api/my/short-absence/end").then(r => { notify(r.message); return refresh(); });
    openForm({ eyebrow: "KURZ WEG", title: "Kurz weg", intro: "<p>Für ein paar Minuten oder Stunden – Events in dieser Zeit zählen nicht als No-Show. Für ganze Tage bitte „Abmelden“.</p>",
      fields: [{ name: "until", label: "Wie lange?", required: true, max: 20, placeholder: "30 min, 2h, 1,5 h oder bis 21:30" }, { name: "reason", label: "Grund", hint: "(optional, sieht nur das Team)", max: 200 }],
      submit: "Kurz weg melden", onSubmit: v => post("/api/my/short-absence", v) });
  },
  "my-absence": () => {
    const open = state.cache.mine?.absences.open;
    if (open) return confirmAction("Abmeldung beenden?", `Du bist bis ${myDay(open.ends_on)} abgemeldet. Bist du früher zurück?`, "Ich bin zurück", () => post("/api/my/absence/end"), false);
    openForm({ eyebrow: "ABMELDUNG", title: "Abmelden", intro: `<p>Z. B. Urlaub oder Pause. Höchstens ${state.cache.mine?.absences.maxDays ?? 60} Tage. Den Grund sieht nur das Team.</p>`,
      fields: [{ name: "from", label: "Von", required: true, value: "heute", hint: "heute, morgen, Freitag oder 20.10." }, { name: "until", label: "Bis (inklusive)", required: true, placeholder: "27.10., Sonntag, 3 Tage, 1 Woche" }, { name: "reason", label: "Grund", required: true, max: 300 }],
      submit: "Abmelden", onSubmit: v => post("/api/my/absence", v) });
  },
});
