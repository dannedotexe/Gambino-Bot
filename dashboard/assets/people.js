// Mitgliederprofil, Abmeldungen/Inaktivität/Rangliste und Systemstatus. Nutzt die Hilfsfunktionen aus app.js.
const day = value => value ? value.split("-").reverse().join(".") : "—";
const ago = iso => {
  if (!iso) return "nie";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "heute" : days === 1 ? "gestern" : `vor ${days} Tagen`;
};
const bytes = n => n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const duration = seconds => { const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60); return d ? `${d} T ${h} Std` : h ? `${h} Std ${m} Min` : `${m} Min`; };
const MEDAL = [];
const modLabels = { timeout: "Timeout", untimeout: "Timeout aufgehoben", kick: "Kick", ban: "Bann", unban: "Entbannt" };
const warnStateLabels = { active: "Aktiv", expired: "Abgelaufen", revoked: "Zurückgenommen" };

// ------------------------------------------------------------------ Aktivität
async function loadActivity() {
  const data = await api("/api/activity"), caps = state.me.capabilities;
  state.cache.activity = data;
  document.querySelectorAll(".needs-absences").forEach(el => el.classList.toggle("hidden", !caps.absences));
  const s = data.settings;
  $("activity-stats").innerHTML = [["Gerade abgemeldet", data.current.length, ""], ["Geplante Abmeldungen", data.upcoming.length, ""], [`Inaktiv (≥ ${s.days} Tage)`, data.inactive.length, ""], ["Erfasste Mitglieder", data.population, ""]]
    .map(([label, value, symbol]) => `<div class="stat"><span class="symbol">${symbol}</span><div class="label">${escapeHtml(label)}</div><div class="value small">${escapeHtml(value)}</div></div>`).join("");
  const absenceRow = (a, actions = true) => `<div class="row"><div><div class="row-title">${plink(a.user_id)} · ${day(a.starts_on)} – ${day(a.ends_on)}</div><div class="row-sub">${escapeHtml(a.reason)}${a.created_by !== a.user_id ? ` · eingetragen von ${who(a.created_by)}` : ""}${a.ended_at ? ` · beendet ${date(a.ended_at)}${a.ended_by && a.ended_by !== a.user_id ? ` von ${who(a.ended_by)}` : ""}` : ""}</div></div>${actions && caps.absences && !a.ended_at ? `<div class="actions tight">${btn(a.starts_on > data.today ? "Stornieren" : "Beenden", "absence-end", { id: a.id }, "reject")}</div>` : ""}</div>`;
  const shortRows = (data.short ?? []).map(a => `<div class="row"><div><div class="row-title">⏱️ ${plink(a.user_id)} · kurz weg</div><div class="row-sub">bis ${escapeHtml(new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: state.timezone }).format(new Date(a.ends_at)))} Uhr${a.reason ? ` · ${escapeHtml(a.reason)}` : ""}</div></div></div>`);
  $("absences-current").innerHTML = [...shortRows, ...data.current.map(a => absenceRow(a))].join("") || empty("Niemand ist gerade abgemeldet.");
  $("absences-upcoming").innerHTML = data.upcoming.map(a => absenceRow(a)).join("") || empty("Keine geplanten Abmeldungen.");
  $("absences-recent").innerHTML = data.recent.map(a => absenceRow(a, false)).join("") || empty("Noch keine beendeten Abmeldungen.");
  renderLeaderboard();
  const base = s.membersRole ? "Gezählt werden alle mit der Familienmitglieder-Rolle." : "Gezählt werden alle mit Familienkonto (keine Familienmitglieder-Rolle eingestellt).";
  $("inactive-title").textContent = `Inaktive Mitglieder (${data.inactive.length})`;
  $("inactive-info").textContent = `Kein Chat und keine Event-Teilnahme seit ${s.days} Tagen; Abgemeldete zählen nicht. ${base} Nachrichten werden seit ${date(s.trackingSince)} erfasst. Automatische DM: ${s.dm ? "an" : "aus"} · tägliche Meldung: ${s.alert ? "an" : "aus"} (Einstellungen → Abmeldungen & Aktivität).`;
  $("inactive-list").innerHTML = data.inactive.length ? `<div class="table-row table-head inactive-row"><span>Mitglied</span><span>Letzte Nachricht</span><span>Letztes Event</span><span>Inaktiv seit</span><span></span></div>` + data.inactive.map(r => `<div class="table-row inactive-row"><span><b>${plink(r.userId)}</b>${r.notifiedAt ? `<small class="block">erinnert ${ago(r.notifiedAt)}</small>` : ""}</span><span data-label="Letzte Nachricht">${ago(r.lastMessage)}</span><span data-label="Letztes Event">${ago(r.lastEvent)}</span><span data-label="Inaktiv"><b>${r.inactiveDays} Tagen</b></span><span class="actions tight">${caps.absences ? btn("Erinnern", "activity-remind", { user: r.userId, days: r.inactiveDays }) : ""}</span></div>`).join("") : empty("Niemand ist inaktiv. ");
  document.querySelectorAll("#tab-activity .search").forEach(filterList);
}
function renderLeaderboard() {
  const data = state.cache.activity; if (!data) return;
  const rows = data.leaderboard[$("leaderboard-filter").value] ?? [];
  $("leaderboard").innerHTML = rows.map((r, n) => `<div class="row"><div><div class="row-title">${MEDAL[n] ?? `${n + 1}.`} ${plink(r.userId)}</div><div class="row-sub">${r.present} davon als anwesend bestätigt</div></div><span class="badge">${r.count} ${r.count === 1 ? "Teilnahme" : "Teilnahmen"}</span></div>`).join("") || empty("Noch keine Event-Teilnahmen in diesem Zeitraum.");
}
$("leaderboard-filter").addEventListener("change", renderLeaderboard);

// ------------------------------------------------------------------ Mitgliederprofil
async function openProfile(userId) {
  const { profile: p } = await api(`/api/members/${userId}/profile`);
  const caps = state.me.capabilities;
  const name = p.verification?.nickname ?? p.discord.name ?? who(userId);
  const section = (title, body) => `<section class="profile-section"><h3>${title}</h3>${body}</section>`;
  const list = items => items.length ? `<div class="rows compact">${items.join("")}</div>` : `<p class="muted">Keine Einträge.</p>`;
  const line = (title, sub, badge = "") => `<div class="row"><div><div class="row-title">${title}</div><div class="row-sub">${sub}</div></div>${badge ? `<span class="badge">${badge}</span>` : ""}</div>`;
  const facts = [
    ["Ingame-ID", p.verification ? escapeHtml(p.verification.ingame_id) : "nicht verifiziert"],
    ["Ingame-Name", p.verification ? escapeHtml(`${p.verification.first_name} ${p.verification.last_name}`) : "—"],
    ["Rang", p.ranks.length ? escapeHtml(p.ranks.join(", ")) : "—"],
    ["Auf dem Server seit", p.discord.joinedAt ? date(p.discord.joinedAt) : p.inGuild ? "—" : "nicht mehr auf dem Server"],
    ["Letzte Nachricht", p.activity.lastMessage ? `${ago(p.activity.lastMessage)} (${p.activity.messages} erfasst)` : "keine erfasst"],
    ["Event-Teilnahmen", `${p.activity.participations}${p.activity.lastEvent ? ` · zuletzt ${ago(p.activity.lastEvent)}` : ""}`],
    ["No-Shows", `${p.noShows.length} in ${p.noShowWindow} Tagen${p.noShows.length ? ` · zuletzt ${escapeHtml(p.noShows[0].name)}` : ""}`],
    ...(p.warnings ? [["Aktive Verwarnungen", String(p.warnings.active)]] : []),
    ...(p.finance ? [["Familienguthaben", p.finance.hasAccount ? `${money(p.finance.plan.gross)} · netto ${money(p.finance.plan.net)}` : "kein Konto"]] : []),
  ];
  const chips = [p.absentNow ? '<span class="chip chip-absent">gerade abgemeldet</span>' : "", p.discord.timeoutUntil ? `<span class="chip chip-absent">Timeout bis ${date(p.discord.timeoutUntil)}</span>` : "", !p.inGuild ? '<span class="chip">nicht auf dem Server</span>' : ""].join("");
  const head = `<div class="profile-head">${p.discord.avatar ? `<img src="${escapeHtml(p.discord.avatar)}" alt="">` : `<div class="avatar-fallback">${escapeHtml(String(name).slice(0, 1).toUpperCase())}</div>`}<div><b>${escapeHtml(name)}</b><small>${escapeHtml(p.discord.username ?? "")} · ID ${escapeHtml(userId)}</small><div class="chips">${chips}${p.roles.slice(0, 8).map(r => `<span class="chip" data-color="${escapeHtml(r.color ?? "")}">${escapeHtml(r.name)}</span>`).join("")}</div></div></div>`;
  const actions = [
    caps.warnings ? btn("Verwarnen", "warning-create-for", { user: userId }) : "",
    caps.absences ? btn("Abmeldung eintragen", "absence-create", { user: userId }) : "",
    caps.leaders ? btn("Rangänderung eintragen", "rank-record", { user: userId, current: p.ranks[0] ?? "" }) : "",
    caps.finance ? btn("+ Gutschrift", "credit", { user: userId }) : "",
    caps.financeView && p.finance?.hasAccount ? btn("Kontodetails", "account-details", { user: userId }) : "",
  ].join("");
  const sections = [
    `<div class="kv profile-facts">${facts.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${v}</b></div>`).join("")}</div>`,
    actions ? `<div class="actions">${actions}</div>` : "",
    section("Rang-Historie", list((p.rankHistory ?? []).map(r => line(`${{ promotion: "Beförderung", demotion: "Degradierung", change: "Rangänderung" }[r.kind]}: ${escapeHtml(r.from_label ?? "—")} → ${escapeHtml(r.to_label ?? "—")}`, `${date(r.created_at)}${r.actor_id ? ` · von ${who(r.actor_id)}` : ""}${r.reason ? ` · ${escapeHtml(r.reason)}` : ""}${r.source === "website" ? " · manuell eingetragen" : ""}`)))),
    section("Events", list(p.events.map(e => line(escapeHtml(e.name), `${date(e.starts_at)}${e.event_status === "cancelled" ? " · abgesagt" : ""}`, e.excused ? "entschuldigt" : e.upcoming && e.status === "signed_up" ? "angemeldet" : statusLabels[e.status] ?? e.status)))),
    section(`No-Shows (${p.noShows.length} in ${p.noShowWindow} Tagen)`, list(p.noShows.map(n => `<div class="row"><div><div class="row-title">${escapeHtml(n.name)}</div><div class="row-sub">${date(n.starts_at)}</div></div>${caps.events ? `<div class="actions tight">${btn("Entfernen", "noshow-remove", { event: n.id, user: userId })}</div>` : ""}</div>`))),
    section("Abmeldungen", list(p.absences.map(a => line(`${day(a.starts_on)} – ${day(a.ends_on)}`, `${escapeHtml(a.reason)}${a.ended_at ? ` · beendet ${date(a.ended_at)}` : ""}`)))),
    p.warnings ? section(`Verwarnungen (${p.warnings.active} aktiv)`, list(p.warnings.items.map(w => { const buttons = warningActions(w); return `<div class="row"><div><div class="row-title">${escapeHtml(w.reason)} <span class="badge">${warnStateLabels[w.state]}</span></div><div class="row-sub">${date(w.created_at)} · von ${who(w.actor_id)}${w.revoked_at ? ` · zurückgenommen: ${escapeHtml(w.revoke_reason ?? "")}` : ""}</div></div>${buttons ? `<div class="actions tight">${buttons}</div>` : ""}</div>`; }))) : "",
    p.moderation ? section("Moderation", list(p.moderation.map(m => line(modLabels[m.action] ?? m.action, `${date(m.created_at)} · ${escapeHtml(m.reason)} · von ${who(m.actor_id)}${m.duration_minutes ? ` · ${m.duration_minutes} Min.` : ""}`, m.result === "applied" ? "" : "fehlgeschlagen")))) : "",
    p.sanctions ? section("Sanktionen", list(p.sanctions.map(s => line(`${money(s.amount_cents)} · ${statusLabels[s.status] ?? s.status}`, `${escapeHtml(s.reason)} · offen ${money(s.remaining_cents)} · ${date(s.created_at)}`)))) : "",
    p.finance ? section("Letzte Buchungen", list(p.finance.transactions.map(t => line(`${txLabels[t.type] ?? t.type} · ${money(t.type === "payout" ? t.net_cents : t.amount_cents)}`, `${date(t.created_at)} · ${escapeHtml(t.reason)}`)))) : "",
    p.applications ? section("Anträge", list(p.applications.map(a => line(a.kind === "rang" ? "Rang-Antrag" : "Bewerbung", `${date(a.created_at)}${a.reviewer_id ? ` · bearbeitet von ${who(a.reviewer_id)}` : ""}`, statusLabels[a.status])))) : "",
    p.tickets ? section("Tickets", list(p.tickets.map(t => line(escapeHtml(t.category_label), `${date(t.created_at)}${t.claimed_by ? ` · ${who(t.claimed_by)}` : ""}`, statusLabels[t.status])))) : "",
  ].join("");
  openInfo(name, `${head}${sections}`, "MITGLIEDERPROFIL", true);
  document.querySelectorAll("#dialog .chip[data-color]").forEach(chip => { if (/^#[0-9a-f]{6}$/i.test(chip.dataset.color)) chip.style.borderColor = chip.dataset.color; });
}

// ------------------------------------------------------------------ Status
async function loadStatus() {
  document.querySelectorAll(".needs-leaders").forEach(el => el.classList.toggle("hidden", !state.me.capabilities.leaders));
  const s = await api("/api/status");
  const card = (label, value, ok, hint) => `<div class="stat status-${ok === true ? "ok" : ok === false ? "bad" : "warn"}"><span class="symbol">${ok === true ? "" : ok === false ? "" : "!"}</span><div class="label">${escapeHtml(label)}</div><div class="value small">${escapeHtml(value)}</div>${hint ? `<small class="muted">${escapeHtml(hint)}</small>` : ""}</div>`;
  const backupAge = s.backups.latest ? (Date.now() - Date.parse(s.backups.latest.at)) / 3_600_000 : null;
  const tickAge = s.scheduler.lastTick ? (Date.now() - Date.parse(s.scheduler.lastTick)) / 1000 : null;
  $("status-cards").innerHTML = [
    card("Discord-Verbindung", s.bot.online ? `Online${s.bot.ping != null && s.bot.ping >= 0 ? ` · ${s.bot.ping} ms` : ""}` : "Getrennt", s.bot.online, s.bot.readySince ? `verbunden seit ${date(s.bot.readySince)}` : ""),
    card("Letztes Update", s.version.update ? ago(s.version.update.at) : "unbekannt", s.version.update ? true : null, `Version ${s.version.commit}${s.version.update ? ` · ${date(s.version.update.at)}` : ""}`),
    card("Letztes Backup", s.backups.latest ? ago(s.backups.latest.at) : "keines gefunden", backupAge == null ? false : backupAge < 36 ? true : null, s.backups.latest ? `${date(s.backups.latest.at)} · ${s.backups.count} Backups` : "Backups entstehen bei jedem Auto-Update oder mit „npm run backup“"),
    card("Hintergrund-Aufgaben", tickAge == null ? "noch nicht gelaufen" : tickAge < 120 ? "laufen" : `seit ${Math.round(tickAge / 60)} Min. still`, tickAge != null && tickAge < 120 ? true : tickAge == null ? null : false, "Erinnerungen, Aktivitäten, Panels, Logs"),
  ].join("");
  const kv = [["Bot", s.bot.tag ?? "—"], ["Mitglieder auf dem Server", s.bot.guildMembers ?? "—"], ["Prozess läuft seit", `${duration(s.process.uptimeSeconds)} (${date(s.process.startedAt)})`], ["Arbeitsspeicher", `${s.process.memoryMb} MB`], ["Node.js", s.process.node], ["Datenbank", `${bytes(s.database.sizeBytes)} · Schema v${s.database.schema}`], ["Letzte Änderung", s.version.update?.message ?? "—"], ["Log-Zustellung (24 h)", s.logs.failedLast24h ? `${s.logs.failedLast24h} fehlgeschlagen` : "ohne Fehler"]];
  $("status-details").innerHTML = kv.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join("");
  $("status-warnings").innerHTML = s.warnings.map(w => row("Hinweis", w)).join("") || empty("Keine offenen Konfigurationspunkte. ");
  await loadSnapshots();
  await loadAccessLog();
}

// ------------------------------------------------------------------ Website-Zugriffe (nur Bot-Owner)
const accessKinds = { visit: "Aufruf", login: "Anmeldung", login_denied: "Abgewiesen" };
const device = ua => {
  const u = String(ua ?? "");
  const browser = /Edg\//.test(u) ? "Edge" : /OPR\/|Opera/.test(u) ? "Opera" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : /discord/i.test(u) ? "Discord" : u ? "Anderer" : "—";
  const os = /iPhone|iPad/.test(u) ? "iOS" : /Android/.test(u) ? "Android" : /Windows/.test(u) ? "Windows" : /Mac OS X/.test(u) ? "macOS" : /Linux/.test(u) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
};
async function loadAccessLog() {
  const d = await api("/api/access-log");
  $("access-info").textContent = `Jeder Aufruf und jede Anmeldung mit IP-Adresse (gleiche Person + IP höchstens einmal pro Stunde). Gespeichert ${d.days} Tage, nur für Bot-Owner sichtbar.`;
  if (d.entries.length && d.entries.every(e => ["127.0.0.1", "::1"].includes(e.ip))) $("access-info").textContent += " ⚠️ Es kommen nur 127.0.0.1-Adressen an: Der Webserver vor dem Bot reicht die echte IP nicht weiter (bei nginx X-Forwarded-For setzen).";
  $("access-shared").innerHTML = d.shared.map(x => row(`⚠️ Mehrere Konten von ${x.ip} (${x.n})`, `${x.users.map(id => state.names[id] || `Mitglied …${id.slice(-4)}`).join(", ")} · zuletzt ${date(x.last)}`)).join("");
  $("access-list").innerHTML = d.entries.length ? `<div class="table-row table-head access-row"><span>Zeit</span><span>Person</span><span>IP-Adresse</span><span>Art</span><span>Gerät</span></div>` + d.entries.map(e => `<div class="table-row access-row"><span data-label="Zeit">${date(e.created_at)}</span><span data-label="Person"><b>${e.user_id ? who(e.user_id) : "nicht angemeldet"}</b></span><span data-label="IP"><code>${escapeHtml(e.ip)}</code></span><span data-label="Art">${e.kind === "login_denied" ? '<em class="warn">Abgewiesen</em>' : accessKinds[e.kind] ?? e.kind}</span><span data-label="Gerät">${escapeHtml(device(e.user_agent))}</span></div>`).join("") : empty("Noch keine Zugriffe protokolliert.");
  document.querySelectorAll("#tab-status .search").forEach(filterList);
}

// ------------------------------------------------------------------ Rollen-Sicherungen (nur Bot-Owner)
const snapshotKinds = { auto: "Automatisch (täglich)", manual: "Manuell", before_restore: "Vor Wiederherstellung" };
async function loadSnapshots() {
  const d = await api("/api/role-snapshots");
  state.cache.snapshots = Object.fromEntries(d.snapshots.map(s => [s.id, s]));
  $("snapshots-info").textContent = `Der Bot sichert jeden Tag, wer welche Rollen hat (die letzten ${d.keep} automatischen bleiben). Vor jeder Wiederherstellung wird der aktuelle Stand zusätzlich gesichert – so lässt sich alles rückgängig machen.`;
  $("snapshots-list").innerHTML = d.snapshots.map(s => `<div class="row"><div><div class="row-title">${date(s.created_at)} · ${escapeHtml(snapshotKinds[s.kind] ?? s.kind)}</div><div class="row-sub">${s.member_count} Mitglieder${s.actor_id ? ` · von ${who(s.actor_id)}` : ""}</div></div><div class="actions tight">${btn("Wiederherstellen …", "roles-restore", { id: s.id })}</div></div>`).join("") || empty("Noch keine Sicherung – die erste entsteht automatisch innerhalb einer Minute oder über „Jetzt sichern“.");
}
function restoreConfirm(id, values, preview) {
  const s = state.cache.snapshots[id];
  const lines = preview.changes.map(c => `<li><b>${who(c.userId)}</b>${c.addNames.length ? ` <span class="ok">+ ${c.addNames.map(escapeHtml).join(", ")}</span>` : ""}${c.removeNames.length ? ` <span class="warn">− ${c.removeNames.map(escapeHtml).join(", ")}</span>` : ""}</li>`).join("");
  const notes = [preview.missing ? `${preview.missing} Mitglied(er) aus der Sicherung sind nicht mehr auf dem Server und werden übersprungen.` : "", preview.skippedRoles.length ? `Nicht vergebbar (gelöscht, verwaltet oder über der Bot-Rolle): ${preview.skippedRoles.map(escapeHtml).join(", ")}.` : ""].filter(Boolean).map(t => `<p class="subtle">${t}</p>`).join("");
  if (!preview.changes.length) return openForm({ eyebrow: "ROLLEN", title: "Nichts zu tun", intro: `<p>Der aktuelle Stand entspricht bereits der Sicherung vom ${date(s.created_at)}.</p>${notes}` });
  openForm({ eyebrow: "ROLLEN WIEDERHERSTELLEN", title: `${preview.changes.length} Mitglied(er) ändern`, danger: true, submit: "Jetzt wiederherstellen",
    intro: `<p>Sicherung vom <b>${date(s.created_at)}</b> · ${values.mode === "exact" ? "exakt (fehlende Rollen vergeben <b>und</b> neue entfernen)" : "nur fehlende Rollen wieder vergeben"}.</p><ul class="alloc scroll">${lines}</ul>${notes}<p class="subtle">Der aktuelle Stand wird vorher automatisch gesichert.</p>`,
    fields: [{ name: "confirm", label: "Zur Bestätigung WIEDERHERSTELLEN eintippen", required: true, max: 20 }],
    onSubmit: v => post(`/api/role-snapshots/${id}/restore`, { ...values, confirm: v.confirm }) });
}
Object.assign(actions, {
  "roles-snapshot": () => confirmAction("Rollen jetzt sichern?", "Der aktuelle Rollenstand aller Mitglieder wird gespeichert.", "Sichern", () => post("/api/role-snapshots"), false),
  "roles-restore": ({ id }) => {
    const s = state.cache.snapshots[id];
    openForm({ eyebrow: "ROLLEN WIEDERHERSTELLEN", title: `Sicherung vom ${date(s.created_at)}`, intro: "<p>Zuerst siehst du eine Vorschau – geändert wird erst nach Bestätigung.</p>", submit: "Vorschau anzeigen",
      fields: [{ name: "mode", label: "Was soll passieren?", type: "select", options: [["add", "Nur fehlende Rollen wieder vergeben (empfohlen)"], ["exact", "Exakt wie damals (auch Rollen entfernen, die neu dazukamen)"]] }, { ...memberField("", "Nur dieses Mitglied (leer = alle)"), required: false }],
      onSubmit: async values => { const preview = await post(`/api/role-snapshots/${id}/preview`, values); setTimeout(() => restoreConfirm(id, values, preview), 60); return {}; } });
  },
});

Object.assign(actions, {
  "noshow-remove": ({ event, user }) => openForm({ eyebrow: "NO-SHOW", title: "No-Show entfernen", intro: "<p>Der No-Show zählt danach nicht mehr (z. B. entschuldigt oder falsch eingetragen). Eine bereits automatisch vergebene Verwarnung bitte separat zurücknehmen.</p>",
    fields: [{ name: "reason", label: "Grund (optional)", max: 300 }], submit: "Entfernen", onSubmit: async v => { const r = await post(`/api/noshows/${event}/${user}/remove`, v); notify(r.message); setTimeout(() => openProfile(user), 60); return {}; } }),
});

loaders.activity = loadActivity;
loaders.status = loadStatus;
Object.assign(actions, {
  "profile": ({ user }) => openProfile(user),
  "profile-find": () => openForm({ eyebrow: "MITGLIEDERPROFIL", title: "Profil öffnen", intro: "<p>Verifizierung, Rang, Konto, Sanktionen, Verwarnungen, Events, Anträge und Tickets auf einen Blick.</p>", fields: [memberField()], submit: "Profil öffnen", onSubmit: async v => { $("dialog").close(); await openProfile(v.userId); return { keepOpen: true }; } }),
  "status-refresh": () => loadStatus(),
  "rank-record": ({ user, current }) => openForm({ eyebrow: "RANG", title: "Rangänderung eintragen", intro: "<p>Für Ränge, die nicht als Discord-Rolle vergeben werden. Wechsel von Rang-Rollen in Discord werden automatisch protokolliert.</p>", fields: [{ name: "kind", label: "Art", type: "select", options: [["promotion", "Beförderung"], ["demotion", "Degradierung"], ["change", "Änderung"]] }, { name: "from", label: "Bisheriger Rang", hint: "(optional)", max: 80, value: current }, { name: "to", label: "Neuer Rang", required: true, max: 80 }, { name: "reason", label: "Grund", hint: "(optional)", max: 300 }], submit: "Eintragen", onSubmit: async v => { const r = await post(`/api/members/${user}/rank`, v); notify(r.message); await openProfile(user); return { keepOpen: true }; } }),
  "absence-create": ({ user } = {}) => openForm({ eyebrow: "ABMELDUNG", title: "Abmeldung eintragen", intro: "<p>Für Mitglieder, die sich nicht selbst abmelden können. Die Person zählt in der Zeit nicht als inaktiv; Fehlen bei Events gilt als entschuldigt.</p>", fields: [memberField(user ?? ""), { name: "from", label: "Von", required: true, placeholder: "heute, morgen, Freitag oder 20.10.", value: "heute", max: 20 }, { name: "until", label: "Bis (inklusive)", required: true, placeholder: "27.10., Sonntag, 3 Tage, 1 Woche", max: 20 }, { name: "reason", label: "Grund", required: true, max: 300 }], submit: "Eintragen", onSubmit: v => post("/api/absences", v) }),
  "absence-end": ({ id }) => confirmAction("Abmeldung beenden?", "Die Person gilt ab sofort wieder als anwesend. Geplante Abmeldungen werden storniert.", "Beenden", () => post(`/api/absences/${id}/end`), false),
  "activity-remind": ({ user, days }) => confirmAction("Per DM erinnern?", `${who(user)} bekommt eine freundliche Nachricht mit dem Hinweis, sich bei einer Pause abzumelden.`, "Erinnerung senden", () => post(`/api/activity/${user}/remind`, { days }), false),
  "warning-create-for": ({ user }) => actions["warning-create"]({ user }),
});
