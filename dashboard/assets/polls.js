// Abstimmungen: anlegen, Zwischenstand ansehen, vorzeitig beenden oder abbrechen. Nutzt Hilfsfunktionen aus app.js.
const pollState = { items: [], channels: [], roles: [], defaultChannel: null };
const pollStatus = { open: ["Läuft", "status-open"], closed: ["Beendet", "status-ended"], cancelled: ["Abgebrochen", "status-cancelled"] };

async function loadPolls() {
  const [data, channels, roles] = await Promise.all([api("/api/polls"), api("/api/channels"), api("/api/roles")]);
  Object.assign(pollState, { items: data.polls, defaultChannel: data.defaultChannel, channels: channels.channels, roles: roles.roles });
  if (!$("poll-form").dataset.ready) renderPollForm();
  renderPollList();
}

function renderPollForm() {
  const tomorrow = toLocalInput(new Date(Date.now() + 86_400_000).toISOString());
  $("poll-form").innerHTML = `
    <label>Frage<input name="question" maxlength="250" placeholder="z. B. Wann soll das nächste Familientreffen sein?"></label>
    <label>Antworten <small>(eine pro Zeile, 2–10)</small><textarea name="options" rows="4" maxlength="900" placeholder="Freitag 20 Uhr&#10;Samstag 20 Uhr&#10;Sonntag 18 Uhr"></textarea></label>
    <div class="form-grid">
      <label>Channel<select name="channelId">${pollState.defaultChannel ? "" : '<option value="">– Channel wählen –</option>'}${pollState.channels.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === pollState.defaultChannel ? "selected" : ""}>${escapeHtml(c.parent ? `${c.parent} / ` : "")}#${escapeHtml(c.name)}</option>`).join("")}</select></label>
      <label>Endet am <small>(${escapeHtml(state.timezone)})</small><input name="endsAt" type="datetime-local" value="${tomorrow}"></label>
    </div>
    <label>Nur diese Rolle darf abstimmen <small>(optional)</small><select name="requiredRoleId"><option value="">Alle im Channel</option>${pollState.roles.map(r => `<option value="${escapeHtml(r.id)}">@${escapeHtml(r.name)}</option>`).join("")}</select></label>
    <div class="checks"><label class="check"><input type="checkbox" name="anonymous"> Anonym – niemand sieht, wer was gewählt hat</label><label class="check"><input type="checkbox" name="hideResults"> Zwischenstand erst am Ende zeigen</label></div>
    <p id="poll-error" class="form-error" role="alert"></p>
    <div class="actions start"><button type="button" class="primary-btn" data-action="poll-create">Abstimmung starten</button></div>`;
  $("poll-form").dataset.ready = "1";
}

function renderPollList() {
  $("poll-list").innerHTML = pollState.items.map(p => {
    const [label, cls] = pollStatus[p.status] ?? [p.status, ""];
    const { counts, total } = p.results, max = Math.max(...counts);
    const channel = pollState.channels.find(c => c.id === p.channel_id)?.name ?? "Channel";
    const rows = p.options.map((option, i) => {
      const share = total ? Math.round(counts[i] / total * 100) : 0;
      const voters = p.voters ? p.voters.filter(v => v.option_index === i).map(v => who(v.user_id)).join(", ") : "";
      return `<div class="poll-option ${p.status !== "open" && total && counts[i] === max ? "lead" : ""}"><div class="poll-option-head"><span>${escapeHtml(option)}</span><b>${counts[i]} · ${share} %</b></div><div class="poll-bar"><i data-share="${share}"></i></div>${voters ? `<small>${voters}</small>` : ""}</div>`;
    }).join("");
    const actions = p.status === "open" ? btn("Jetzt beenden", "poll-close", { id: p.id }) + btn("Abbrechen", "poll-cancel", { id: p.id }, "reject") : "";
    return `<article class="manage-card compact"><div class="manage-card-head"><div><span class="type-pill">#${escapeHtml(channel)}</span><h3>${escapeHtml(p.question)}</h3></div><span class="badge ${cls}">${label}</span></div>
      <p class="manage-meta">${total} ${total === 1 ? "Stimme" : "Stimmen"} · ${p.status === "open" ? `endet ${date(p.ends_at)}` : `beendet ${date(p.closed_at ?? p.ends_at)}`} · von ${who(p.created_by)}${p.anonymous ? " · anonym" : ""}${p.hide_results ? " · Zwischenstand verdeckt" : ""}</p>
      <div class="poll-options">${rows}</div><div class="actions">${actions}</div></article>`;
  }).join("") || empty("Noch keine Abstimmungen.");
  // Balkenbreite per CSSOM (Inline-Styles sind durch die Content-Security-Policy gesperrt).
  document.querySelectorAll("#poll-list .poll-bar i").forEach(bar => { bar.style.width = `${bar.dataset.share}%`; });
}

loaders.polls = loadPolls;
Object.assign(actions, {
  "poll-create": async () => {
    const f = $("poll-form"), v = name => f.elements[name]?.value ?? "";
    $("poll-error").textContent = "";
    const body = { question: v("question"), options: v("options").split("\n"), channelId: v("channelId"), endsAt: v("endsAt"), requiredRoleId: v("requiredRoleId"), anonymous: f.elements.anonymous.checked, hideResults: f.elements.hideResults.checked };
    try {
      const result = await post("/api/polls", body);
      notify(result.message); delete f.dataset.ready; renderPollForm(); await loadPolls();
    } catch (error) { $("poll-error").textContent = error.message; }
  },
  "poll-close": ({ id }) => confirmAction("Abstimmung jetzt beenden?", "Die Buttons werden entfernt und das Ergebnis im Channel gepostet.", "Beenden", () => post(`/api/polls/${id}/close`), false),
  "poll-cancel": ({ id }) => confirmAction("Abstimmung abbrechen?", "Die Abstimmung wird ohne Ergebnis geschlossen.", "Abbrechen", () => post(`/api/polls/${id}/cancel`)),
});
