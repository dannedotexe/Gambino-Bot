// Wochenkalender (Events, Aktivitäten, Staatliche Kontrollen) und Kill-Bestenliste. Nutzt Hilfsfunktionen aus app.js.
const calState = { offset: { events: 0, my: 0 }, kills: null };
const calTargets = { events: ["calendar", "calendar-title"], my: ["my-calendar", "my-calendar-title"] };
const calKindLabel = { event: "Event", series: "Aktivität", control: "Staatliche Kontrolle" };
const calTime = iso => new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: state.timezone }).format(new Date(iso));
const calDay = day => new Intl.DateTimeFormat("de-AT", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));

async function loadCalendar(target = "events") {
  const [boxId, titleId] = calTargets[target];
  if (!$(boxId)) return;
  const offset = calState.offset[target], d = await api(`/api/calendar?offset=${offset}`);
  $(titleId).textContent = offset === 0 ? "Diese Woche" : offset === 1 ? "Nächste Woche" : offset === -1 ? "Letzte Woche" : `${calDay(d.from)} – ${calDay(d.until)}`;
  $(boxId).innerHTML = d.days.map(day => `<div class="cal-day ${day.day === d.today ? "today" : ""} ${day.day < d.today ? "past" : ""}">
    <div class="cal-head"><span>${escapeHtml(calDay(day.day).split(",")[0])}</span><b>${Number(day.day.slice(8))}</b></div>
    ${day.items.map(item => {
      const kind = `k-${item.status === "planned" ? "planned" : item.kind}`;
      const done = ["ended", "cancelled"].includes(item.status);
      const meta = item.status === "cancelled" ? "abgesagt" : item.outcome === "win" ? "🏆 Win" : item.outcome === "lose" ? "Lose" : item.status === "planned" ? "geplant" : `${item.participants}${item.max ? `/${item.max}` : ""} dabei${item.waiting ? ` · ${item.waiting} warten` : ""}`;
      return `<div class="cal-item ${kind} ${done ? "done" : ""}" title="${escapeHtml(`${calKindLabel[item.kind] ?? ""} · ${item.name}`)}"><time>${calTime(item.startsAt)}</time><span>${escapeHtml(item.name)}</span><small>${escapeHtml(meta)}</small></div>`;
    }).join("") || '<div class="cal-empty">–</div>'}
  </div>`).join("");
  // Heute in Sicht scrollen (mobil horizontal).
  $(boxId).querySelector(".today")?.scrollIntoView?.({ block: "nearest", inline: "center" });
}

async function loadKills() {
  if (!$("kills-board")) return;
  calState.kills = await api("/api/kills");
  renderKills();
}
function renderKills() {
  const rows = calState.kills?.board[$("kills-period").value] ?? [];
  $("kills-board").innerHTML = rows.map((r, n) => myRow(`<span class="medal">${["🥇", "🥈", "🥉"][n] ?? `${n + 1}.`}</span>${plink(r.userId)}`, `${r.kills} Kills · ${r.events} ${r.events === 1 ? "Event" : "Events"} · Bestwert ${r.best}`)).join("") || empty("Noch keine Kills in diesem Zeitraum. Kills werden beim Win mit Kill-Prämie eingetragen.");
}
$("kills-period").addEventListener("change", () => calState.kills && renderKills());

// Events-Tab um Kalender und Kill-Bestenliste ergänzen.
const loadEventsBase = loaders.events;
loaders.events = async () => { await loadEventsBase(); await Promise.all([loadCalendar("events"), loadKills()]).catch(error => notify(error.message, "error")); };
Object.assign(actions, {
  "cal-prev": ({ target = "events" }) => { calState.offset[target]--; return loadCalendar(target); },
  "cal-next": ({ target = "events" }) => { calState.offset[target]++; return loadCalendar(target); },
  "cal-today": ({ target = "events" }) => { calState.offset[target] = 0; return loadCalendar(target); },
});
