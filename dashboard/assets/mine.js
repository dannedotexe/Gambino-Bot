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
    myStat("No-Shows", e.noShowLimit ? `${e.noShows} von ${e.noShowLimit} <small>(${e.noShowWindow} Tage)</small>` : escapeHtml(e.noShows)),
  ].join("");
  $("my-absence-label").textContent = d.absences.open ? "Abmeldung beenden" : "Abmelden";
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
  "my-absence": () => {
    const open = state.cache.mine?.absences.open;
    if (open) return confirmAction("Abmeldung beenden?", `Du bist bis ${myDay(open.ends_on)} abgemeldet. Bist du früher zurück?`, "Ich bin zurück", () => post("/api/my/absence/end"), false);
    openForm({ eyebrow: "ABMELDUNG", title: "Abmelden", intro: `<p>Z. B. Urlaub oder Pause. Höchstens ${state.cache.mine?.absences.maxDays ?? 60} Tage. Den Grund sieht nur das Team.</p>`,
      fields: [{ name: "from", label: "Von", required: true, value: "heute", hint: "heute, morgen, Freitag oder 20.10." }, { name: "until", label: "Bis (inklusive)", required: true, placeholder: "27.10., Sonntag, 3 Tage, 1 Woche" }, { name: "reason", label: "Grund", required: true, max: 300 }],
      submit: "Abmelden", onSubmit: v => post("/api/my/absence", v) });
  },
});
