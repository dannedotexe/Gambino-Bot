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
  const [data, roles, channels] = await Promise.all([api("/api/settings"), api("/api/roles"), api("/api/channels")]);
  Object.assign(settingsState, { settings: data.settings, roles: roles.roles, channels: channels.channels, categories: channels.categories ?? [] });
  renderSettings();
};

Object.assign(actions, {
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
