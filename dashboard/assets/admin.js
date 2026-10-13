/* Einstellungen (nur Leitung). Nutzt die Hilfsfunktionen aus app.js. */
const settingsState = { settings: [], roles: [], channels: [], categories: [] };
const SOURCE_LABELS = { website: "über Website gesetzt", env: "aus .env", standard: "Standard" };
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function pickList(items, selected, kind) {
  const chosen = new Set((selected ?? []).map(String));
  const known = new Set(items.map(item => item.id));
  const unknown = [...chosen].filter(id => !known.has(id)).map(id => ({ id, name: `Unbekannt (${id})` }));
  return `<div class="pick" data-kind="${kind}"><input class="pick-filter" type="search" placeholder="${kind === "roles" ? "Rollen filtern …" : "Channels filtern …"}" aria-label="Filtern"><div class="pick-list">${[...unknown, ...items].map(item => `<label class="check"><input type="checkbox" value="${escapeHtml(item.id)}" ${chosen.has(item.id) ? "checked" : ""}> ${kind === "roles" ? "@" : "#"}${escapeHtml(item.name)}</label>`).join("") || '<span class="muted">Keine Einträge gefunden.</span>'}</div><small class="pick-count">${chosen.size} ausgewählt</small></div>`;
}
const select = (items, value, empty = "— nicht gesetzt —", prefix = "#") => `<select class="setting-input"><option value="">${empty}</option>${items.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === value ? "selected" : ""}>${prefix}${escapeHtml(item.name)}${item.parent ? ` · ${escapeHtml(item.parent)}` : ""}</option>`).join("")}${value && !items.some(item => item.id === value) ? `<option value="${escapeHtml(value)}" selected>Unbekannt (${escapeHtml(value)})</option>` : ""}</select>`;
const roleSelect = value => select(settingsState.roles, value, "— Rolle wählen —", "@");

function categoryRow(category = {}) {
  return `<div class="row-editor cat-row"><div class="form-grid four"><label>ID<input data-f="id" value="${escapeHtml(category.id ?? "")}" placeholder="support" maxlength="25"></label><label>Name<input data-f="label" value="${escapeHtml(category.label ?? "")}" placeholder="Support" maxlength="100"></label><label>Emoji<input data-f="emoji" value="${escapeHtml(category.emoji ?? "")}" placeholder="🎫" maxlength="20"></label><label>Beschreibung<input data-f="description" value="${escapeHtml(category.description ?? "")}" maxlength="100"></label></div><div class="sub-label">Zuständige Rollen (sehen und bearbeiten diese Tickets zusätzlich zu Staff)</div>${pickList(settingsState.roles, category.roleIds ?? [], "roles")}<button type="button" class="action reject" data-action="row-remove">Kategorie entfernen</button></div>`;
}
const rankRow = (item = {}) => `<div class="row-editor rank-row"><div class="form-grid"><label>Bezeichnung<input data-f="label" value="${escapeHtml(item.label ?? "")}" placeholder="Rang 2" maxlength="80"></label><label>Rolle${roleSelect(item.roleId ?? "")}</label></div><button type="button" class="action reject" data-action="row-remove">Entfernen</button></div>`;

function control(def) {
  const v = def.value;
  switch (def.type) {
    case "roles": return pickList(settingsState.roles, v, "roles");
    case "channels": return pickList(settingsState.channels, v, "channels");
    case "channel": return select(settingsState.channels, v ?? "");
    case "category": return select(settingsState.categories, v ?? "", "— keine Kategorie —", "📁 ");
    case "number": return `<input class="setting-input" type="number" min="${def.min}" max="${def.max}" value="${escapeHtml(v ?? "")}">`;
    case "money": return `<input class="setting-input" inputmode="decimal" placeholder="leer = kein Mindestbetrag" value="${v == null ? "" : escapeHtml(String(v / 100).replace(".", ","))}">`;
    case "bool": return `<select class="setting-input"><option value="true" ${v ? "selected" : ""}>Ja</option><option value="false" ${v ? "" : "selected"}>Nein</option></select>`;
    case "list": case "numberList": return `<input class="setting-input" value="${escapeHtml((v ?? []).join(", "))}" placeholder="kommagetrennt">`;
    case "actions": return `<div class="checks inline">${def.options.map(([key, label]) => `<label class="check"><input type="checkbox" value="${key}" ${(v ?? []).includes(key) ? "checked" : ""}> ${escapeHtml(label)}</label>`).join("")}</div>`;
    case "text": return `<input class="setting-input" value="${escapeHtml(v ?? "")}">`;
    case "json": return `<textarea class="setting-input mono" rows="6">${escapeHtml(JSON.stringify(v ?? {}, null, 2))}</textarea>`;
    case "ticketCategories": return `<div class="rows-editor">${(v ?? []).map(categoryRow).join("")}</div><button type="button" class="secondary" data-action="row-add" data-template="category">+ Kategorie</button>`;
    case "rankRoles": return `<div class="rows-editor">${(v ?? []).map(rankRow).join("")}</div><button type="button" class="secondary" data-action="row-add" data-template="rank">+ Rang-Rolle</button>`;
    default: return "";
  }
}
const checked = root => [...root.querySelectorAll(":scope input[type=checkbox]:checked")].map(box => box.value);
function readValue(def, root) {
  const input = root.querySelector(".setting-input");
  switch (def.type) {
    case "roles": case "channels": return checked(root.querySelector(".pick"));
    case "actions": return checked(root.querySelector(".checks"));
    case "number": return Number(input.value);
    case "bool": return input.value === "true";
    case "ticketCategories": return [...root.querySelectorAll(".cat-row")].map(row => {
      const field = name => row.querySelector(`[data-f=${name}]`).value.trim();
      return { id: field("id"), label: field("label"), ...(field("emoji") ? { emoji: field("emoji") } : {}), ...(field("description") ? { description: field("description") } : {}), roleIds: checked(row.querySelector(".pick")) };
    });
    case "rankRoles": return [...root.querySelectorAll(".rank-row")].map(row => ({ label: row.querySelector("[data-f=label]").value.trim(), roleId: row.querySelector("select").value }));
    default: return input.value;
  }
}

function renderSettings() {
  const groups = [...new Set(settingsState.settings.map(def => def.group))];
  $("settings-groups").innerHTML = groups.map(group => `<button type="button" class="chip" data-action="settings-jump" data-group="${slug(group)}">${escapeHtml(group)}</button>`).join("");
  $("settings-view").innerHTML = groups.map(group => `<section class="panel settings-group" id="sg-${slug(group)}"><div class="panel-head"><div><div class="eyebrow">EINSTELLUNGEN</div><h2>${escapeHtml(group)}</h2></div></div>${settingsState.settings.filter(def => def.group === group).map(def => `
    <div class="setting" data-key="${def.key}"><div class="setting-head"><div><b>${escapeHtml(def.label)}</b>${def.help ? `<small>${escapeHtml(def.help)}</small>` : ""}<code>${def.key}</code></div><span class="source source-${def.source}">${SOURCE_LABELS[def.source]}</span></div>
    <div class="setting-control">${control(def)}</div>
    <div class="actions tight start"><button type="button" class="action primary-action" data-action="setting-save" data-key="${def.key}">Speichern</button>${def.source === "website" ? `<button type="button" class="action" data-action="setting-reset" data-key="${def.key}">Auf .env/Standard zurücksetzen</button>` : ""}</div></div>`).join("")}</section>`).join("");
  document.querySelectorAll("#tab-settings .search").forEach(filterList);
}

loaders.settings = async () => {
  const [data, roles, channels, textData] = await Promise.all([api("/api/settings"), api("/api/roles"), api("/api/channels"), api("/api/texts").catch(() => ({ panels: [] }))]);
  Object.assign(settingsState, { settings: data.settings, roles: roles.roles, channels: channels.channels, categories: channels.categories ?? [] });
  textsState.panels = textData.panels;
  renderSettings(); renderTexts();
};

// ------------------------------------------------------------------ Panel-Texte
const textsState = { panels: [], current: "application" };
const markdown = text => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<u>$1</u>").replace(/\n/g, "<br>");
function currentTexts() {
  const panel = textsState.panels.find(p => p.id === textsState.current);
  const values = { ...panel.values };
  document.querySelectorAll("#texts-form [data-text]").forEach(input => { values[input.dataset.text] = input.value; });
  return { panel, values };
}
function renderPreview() {
  const { panel, values } = currentTexts();
  const fields = [1, 2, 3].map(n => [values[`field${n}Name`], values[`field${n}Value`], n < 3]).filter(([name, value]) => name && value);
  const extras = panel.id === "activityBoard" ? [[values.scheduledTitle, "**Bizwar** · täglich · 01:05, 19:05 Uhr · nächstes in 2 Stunden", false], [values.flexibleTitle, "**Ladenraub** · alle 3 Stunden möglich", false]].filter(([n]) => n)
    : panel.id === "staffDashboard" ? [["🎫 Offene Tickets", "3 · davon 1 ohne Bearbeiter", true], ["📨 Offene Anträge", "2", true]] : [];
  if (panel.id === "events") return renderEventPreview(values);
  const buttons = panel.id === "verification" ? `<div class="dc-buttons"><span class="dc-btn ok">${escapeHtml(values.button)}</span><span class="dc-btn">${escapeHtml(values.buttonRename)}</span></div>`
    : panel.id === "application" ? `<div class="dc-buttons"><span class="dc-btn primary">${escapeHtml(values.buttonApply)}</span><span class="dc-btn">${escapeHtml(values.buttonRank)}</span></div>`
    : panel.id === "ticket" ? `<div class="dc-select">${escapeHtml(values.placeholder)}<span>⌄</span></div>` : panel.id === "staffDashboard" ? '<div class="dc-select">📂 Ansicht wählen …<span>⌄</span></div>' : "";
  $("texts-preview").innerHTML = `<div class="dc-head"><img src="/assets/gambinos-profile.gif" alt=""><b>Gambino Helper</b><span class="dc-app">APP</span></div><div class="dc-embed">${values.author ? `<div class="dc-author">${escapeHtml(values.author)}</div>` : ""}${values.title ? `<div class="dc-title">${escapeHtml(values.title)}</div>` : ""}${values.description ? `<div class="dc-desc">${markdown(values.description)}</div>` : ""}<div class="dc-fields">${[...fields, ...extras].map(([name, value, inline]) => `<div class="dc-field ${inline ? "inline" : ""}"><b>${escapeHtml(name)}</b><div>${markdown(value)}</div></div>`).join("")}</div>${values.footer ? `<div class="dc-footer">${escapeHtml(values.footer)}</div>` : ""}</div>${buttons}`;
  const embed = $("texts-preview").querySelector(".dc-embed");
  if (embed) embed.style.borderLeftColor = /^#[0-9a-f]{6}$/i.test(values.color ?? "") ? values.color : "#d4af37";
  document.querySelectorAll("#texts-form [data-text]").forEach(input => { const counter = input.parentElement.querySelector(".counter"); if (counter && input.maxLength > 0) counter.textContent = `${input.value.length}/${input.maxLength}`; });
}
function renderEventPreview(values) {
  const fill = text => markdown(String(text ?? "").replaceAll("{name}", "Bizwar").replaceAll("{zeit}", "Mittwoch, 14. Oktober 2026 19:05").replaceAll("{uhrzeit}", "19:05").replaceAll("{relativ}", "in 2 Stunden").replaceAll("{treffpunkt}", "Hauptquartier").replaceAll("{anmeldung}", "#event-anmeldung"));
  const head = '<div class="dc-head"><img src="/assets/gambinos-profile.gif" alt=""><b>Gambino Helper</b><span class="dc-app">APP</span></div>';
  const author = values.author ? `<div class="dc-author">${escapeHtml(values.author)}</div>` : "";
  $("texts-preview").innerHTML = `<div class="sub-label">#event-ankündigungen</div>${head}<div class="dc-embed">${author}<div class="dc-desc">${fill(values.announceText)}</div></div><div class="dc-buttons"><span class="dc-btn">${escapeHtml(values.announceButton)} ↗</span></div>
    <div class="sub-label spaced">#event-anmeldung</div>${head}<div class="dc-embed">${author}<div class="dc-title">📅 Bizwar</div><div class="dc-fields"><div class="dc-field inline"><b>🕒 Beginn</b><div>Mittwoch, 14. Oktober 2026 19:05<br>in 2 Stunden</div></div><div class="dc-field"><b>🙋 ${escapeHtml(values.participantsLabel)} (0)</b><div>${escapeHtml(values.emptyParticipants)}</div></div></div><div class="dc-footer">${escapeHtml(values.seriesFooter)} · täglich · 01:05, 19:05 Uhr</div></div><div class="dc-buttons"><span class="dc-btn ok">${escapeHtml(values.joinButton)}</span><span class="dc-btn">${escapeHtml(values.leaveButton)}</span></div>
    <div class="sub-label spaced">Erinnerung (Antwort auf die Karte)</div>${head}<div class="dc-embed"><div class="dc-desc">${fill(values.reminderText)}</div></div>`;
  $("texts-preview").querySelectorAll(".dc-embed").forEach(embed => { embed.style.borderLeftColor = /^#[0-9a-f]{6}$/i.test(values.color ?? "") ? values.color : "#d4af37"; });
  document.querySelectorAll("#texts-form [data-text]").forEach(input => { const counter = input.parentElement.querySelector(".counter"); if (counter && input.maxLength > 0) counter.textContent = `${input.value.length}/${input.maxLength}`; });
}
function renderTexts() {
  if (!textsState.panels.length) { $("texts-form").innerHTML = '<p class="muted">Panel-Texte sind nicht verfügbar.</p>'; return; }
  const panel = textsState.panels.find(p => p.id === textsState.current) ?? textsState.panels[0];
  textsState.current = panel.id;
  $("texts-tabs").innerHTML = textsState.panels.map(p => `<button type="button" class="chip ${p.id === panel.id ? "active" : ""}" data-action="texts-select" data-panel="${p.id}">${escapeHtml(p.label)}${p.custom ? " ✎" : ""}</button>`).join("");
  $("texts-form").innerHTML = panel.fields.map(field => {
    const value = escapeHtml(panel.values[field.key] ?? "");
    const input = field.type === "color" ? `<input data-text="${field.key}" type="color" value="${value}">`
      : field.multiline ? `<textarea data-text="${field.key}" rows="${field.max > 1100 ? 5 : 3}" maxlength="${field.max}">${value}</textarea>`
      : `<input data-text="${field.key}" maxlength="${field.max}" value="${value}">`;
    return `<label>${escapeHtml(field.label)}${field.type === "color" ? "" : ' <small class="counter"></small>'}${input}</label>`;
  }).join("");
  $("texts-hint").textContent = panel.id === "events" ? "Platzhalter: {name} {zeit} {uhrzeit} {relativ} {treffpunkt}. Gilt für alle neuen Events; laufende Event-Posts werden beim Speichern aktualisiert." : panel.channelSet ? "Dieses Panel wird automatisch in seinem Channel verwaltet." : "Für dieses Panel ist noch kein Channel eingestellt (Einstellungen → Channels). Ein bereits gepostetes Panel des Bots wird dort automatisch übernommen.";
  renderPreview();
}
document.addEventListener("input", event => { if (event.target.closest?.("#texts-form")) renderPreview(); });

function renderCheck(report) {
  const icon = { ok: "✅", warn: "⚠️", error: "❌", info: "ℹ️" };
  const perms = report.guildPermissions.filter(p => p.needed).map(p => `<div class="check-row ${p.has ? "ok" : "error"}"><span>${p.has ? "✅" : "❌"}</span><div><b>Server-Recht: ${escapeHtml(p.label)}</b><small>${escapeHtml(p.reason)}</small></div></div>`).join("");
  const rows = report.channels.map(r => `<div class="check-row ${r.status}"><span>${icon[r.status]}</span><div><b>${escapeHtml(r.label)}</b>${r.channel ? ` <em>→ ${r.channel.parent ? `${escapeHtml(r.channel.parent)} / ` : ""}${r.channel.category ? "📁 " : "#"}${escapeHtml(r.channel.name)}</em>` : ""}${r.issues.map(x => `<small class="lvl-${x.level}">${icon[x.level]} ${escapeHtml(x.text)}</small>`).join("")}</div><button type="button" class="action" data-action="settings-focus" data-key="${r.key}">Ändern</button></div>`).join("");
  $("channel-check").innerHTML = `<p class="check-summary"><b>${report.summary.ok}</b> passend · <b>${report.summary.warn}</b> mit Hinweis · <b>${report.summary.error}</b> Fehler${report.administrator ? " · ℹ️ Bot hat Administrator-Rechte (nicht nötig)" : ""}</p>${perms}${rows}`;
}

Object.assign(actions, {
  "texts-select": ({ panel }) => { textsState.current = panel; renderTexts(); },
  "texts-save": async () => { const { panel, values } = currentTexts(); const data = await post("/api/texts", { panel: panel.id, values }); textsState.panels = data.panels; notify(data.message); renderTexts(); },
  "texts-reset": () => { const { panel } = currentTexts(); confirmAction(`${panel.label} zurücksetzen?`, "Alle Texte dieses Panels werden auf die Standardtexte zurückgesetzt und in Discord aktualisiert.", "Zurücksetzen", async () => { const data = await post("/api/texts/reset", { panel: panel.id }); textsState.panels = data.panels; renderTexts(); return data; }); },
  "channel-check": async () => { $("channel-check").innerHTML = '<p class="muted">Prüfe …</p>'; renderCheck(await api("/api/channel-check")); },
  "settings-focus": ({ key }) => { const el = document.querySelector(`.setting[data-key="${key}"]`); el?.scrollIntoView({ behavior: "smooth", block: "center" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1600); },
  "setting-save": async ({ key }) => {
    const def = settingsState.settings.find(item => item.key === key), root = document.querySelector(`.setting[data-key="${key}"]`);
    const data = await post("/api/settings", { key, value: readValue(def, root) });
    settingsState.settings = data.settings; notify(data.message); renderSettings();
    document.querySelector(`.setting[data-key="${key}"]`)?.scrollIntoView({ block: "center" });
  },
  "setting-reset": async ({ key }) => {
    const data = await post("/api/settings/reset", { key });
    settingsState.settings = data.settings; notify(data.message); renderSettings();
  },
  "settings-jump": ({ group }) => document.getElementById(`sg-${group}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
  "row-add": ({ template }, button) => {
    const container = button.closest(".setting-control")?.querySelector(".rows-editor") ?? null;
    container?.insertAdjacentHTML("beforeend", template === "category" ? categoryRow() : rankRow());
  },
});
document.addEventListener("click", event => {
  const remove = event.target.closest("[data-action=row-remove]");
  if (remove) remove.closest(".row-editor")?.remove();
});
document.addEventListener("input", event => {
  if (event.target.matches?.(".pick-filter")) {
    const term = event.target.value.trim().toLocaleLowerCase("de-AT");
    event.target.closest(".pick").querySelectorAll(".check").forEach(label => { label.hidden = Boolean(term) && !label.textContent.toLocaleLowerCase("de-AT").includes(term); });
  }
});
document.addEventListener("change", event => {
  const pick = event.target.closest?.(".pick");
  if (pick && event.target.type === "checkbox") pick.querySelector(".pick-count").textContent = `${pick.querySelectorAll("input[type=checkbox]:checked").length} ausgewählt`;
});
