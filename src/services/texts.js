import { audit, getSetting } from "../database.js";

/**
 * Bearbeitbare Texte der Discord-Panels. Gespeichert als JSON in guild_settings (TEXTS_<PANEL>); fehlende Felder
 * fallen auf die Standardtexte zurück. Limits entsprechen den Discord-Grenzen für Embeds und Buttons.
 */
export const PANEL_TEXTS = {
  application: {
    label: "Bewerbungs-Panel", channelKey: "CHANNEL_APPLICATION_PANEL",
    fields: {
      color: { label: "Farbe", type: "color", default: "#d4af37" },
      author: { label: "Kopfzeile", max: 256, default: "GAMBINOS  •  FAMILIENBÜRO" },
      title: { label: "Titel", max: 256, default: "📋  Bewerbungen & Rang-Anträge" },
      description: { label: "Beschreibung", max: 4000, multiline: true, default: "Wähle den passenden Antrag aus. Beide Formulare fragen gezielt die Informationen ab, die das Leitungsteam für die Entscheidung braucht." },
      field1Name: { label: "Feld 1 – Überschrift", max: 256, default: "🤝  Familienbeitritt" },
      field1Value: { label: "Feld 1 – Text", max: 1024, multiline: true, default: "Erzähl uns etwas über dich, deine Grand-RP-Erfahrung und warum du zu Gambinos möchtest." },
      field2Name: { label: "Feld 2 – Überschrift", max: 256, default: "🏅  Rang-Antrag" },
      field2Value: { label: "Feld 2 – Text", max: 1024, multiline: true, default: "Nenne deinen aktuellen Rang, den gewünschten Rang und deine Begründung." },
      field3Name: { label: "Feld 3 – Überschrift", max: 256, default: "🔒  Vertrauliche Prüfung" },
      field3Value: { label: "Feld 3 – Text", max: 1024, multiline: true, default: "Deine Angaben werden an das zuständige Team zur Prüfung weitergeleitet." },
      footer: { label: "Fußzeile", max: 2048, default: "GAMBINOS  •  Danke für dein Interesse" },
      buttonApply: { label: "Button: Bewerbung", max: 80, required: true, default: "🤝  Bei Gambinos bewerben" },
      buttonRank: { label: "Button: Rang-Antrag", max: 80, required: true, default: "🏅  Rang beantragen" },
    },
  },
  verification: {
    label: "Verifizierungs-Panel", channelKey: "CHANNEL_VERIFICATION_PANEL",
    fields: {
      color: { label: "Farbe", type: "color", default: "#d4af37" },
      author: { label: "Kopfzeile", max: 256, default: "GAMBINOS  •  VERIFIZIERUNG" },
      title: { label: "Titel", max: 256, default: "✅  Willkommen bei den Gambinos!" },
      description: { label: "Beschreibung", max: 4000, multiline: true, default: "Bitte verifiziere dich, bevor es losgeht.\n\nKlicke auf **Verifizieren** und gib deine **Ingame-ID**, deinen **Vornamen** und **Nachnamen** aus Grand-RP an. Dein Discord-Name wird automatisch zu `ID | Vorname Nachname` geändert." },
      footer: { label: "Fußzeile", max: 2048, default: "GAMBINOS  •  Deine Angaben sieht nur das Team" },
      button: { label: "Button", max: 80, required: true, default: "✅  Verifizieren" },
    },
  },
  ticket: {
    label: "Ticket-Panel", channelKey: "CHANNEL_TICKET_PANEL",
    fields: {
      color: { label: "Farbe", type: "color", default: "#d4af37" },
      author: { label: "Kopfzeile", max: 256, default: "GAMBINOS  •  SUPPORT CENTER" },
      title: { label: "Titel", max: 256, default: "🎫  Wie können wir dir helfen?" },
      description: { label: "Beschreibung", max: 4000, multiline: true, default: "Wähle unten dein Anliegen. Der Bot öffnet einen privaten Channel für dich und das zuständige Team.\n\n🔒 Nur Beteiligte sehen dein Ticket.\n💬 Beschreibe dein Anliegen direkt im neuen Channel." },
      footer: { label: "Fußzeile", max: 2048, default: "GAMBINOS  •  Wir helfen dir weiter" },
      placeholder: { label: "Auswahlmenü-Platzhalter", max: 150, required: true, default: "🎟️  Wähle dein Anliegen aus …" },
    },
  },
  activityBoard: {
    label: "Aktivitäten-Übersicht", channelKey: "CHANNEL_ACTIVITY_BOARD",
    fields: {
      color: { label: "Farbe", type: "color", default: "#d4af37" },
      author: { label: "Kopfzeile", max: 256, default: "GAMBINOS  •  AKTIVITÄTEN" },
      title: { label: "Titel", max: 256, default: "📆 Familien-Aktivitäten" },
      description: { label: "Beschreibung", max: 3000, multiline: true, default: "Feste Termine werden automatisch als Event mit Anmeldung angekündigt." },
      scheduledTitle: { label: "Überschrift feste Termine", max: 256, default: "🕒 Feste Termine" },
      flexibleTitle: { label: "Überschrift flexible Aktivitäten", max: 256, default: "🔁 Flexibel verfügbar" },
      emptyText: { label: "Text ohne aktive Aktivitäten", max: 1000, default: "Zurzeit sind keine Aktivitäten aktiv." },
    },
  },
  staffDashboard: {
    label: "Staff-Dashboard-Panel", channelKey: "CHANNEL_STAFF_DASHBOARD",
    fields: {
      title: { label: "Titel", max: 256, default: "🧭 Gambinos Staff-Dashboard" },
      description: { label: "Beschreibung", max: 3000, multiline: true, default: "Wähle unten eine Ansicht. Details erscheinen nur privat für dich und nur, wenn deine Rolle sie freigibt." },
    },
  },
};

const settingKey = panel => `TEXTS_${panel.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
export const defaultsFor = panel => Object.fromEntries(Object.entries(PANEL_TEXTS[panel].fields).map(([key, field]) => [key, field.default]));
export const colorNumber = hex => Number.parseInt(String(hex).replace("#", ""), 16);

/** Texte eines Panels: gespeicherte Werte über den Standardtexten. Defekte Speicherstände fallen auf Standard zurück. */
export function panelTexts(db, guildId, panel) {
  const defaults = defaultsFor(panel);
  if (!db || !guildId) return defaults;
  let stored = {};
  try { stored = JSON.parse(getSetting(db, guildId, settingKey(panel)) ?? "{}"); } catch { stored = {}; }
  return { ...defaults, ...Object.fromEntries(Object.entries(stored).filter(([key, value]) => key in defaults && typeof value === "string")) };
}

export function validateTexts(panel, input) {
  const definition = PANEL_TEXTS[panel];
  if (!definition) throw new Error("Unbekanntes Panel.");
  const result = {};
  for (const [key, field] of Object.entries(definition.fields)) {
    let value = String(input?.[key] ?? field.default).replace(/\r\n/g, "\n");
    if (!field.multiline) value = value.replace(/\n/g, " ");
    value = value.trim();
    if (field.type === "color") {
      if (!/^#?[0-9a-f]{6}$/i.test(value)) throw new Error(`${field.label}: bitte eine Farbe wie #d4af37 angeben.`);
      value = `#${value.replace("#", "").toLowerCase()}`;
    } else {
      if (field.required && !value) throw new Error(`${field.label} darf nicht leer sein.`);
      if (value.length > field.max) throw new Error(`${field.label}: höchstens ${field.max} Zeichen (aktuell ${value.length}).`);
    }
    result[key] = value;
  }
  if ("title" in result && !result.title && !result.description) throw new Error("Titel oder Beschreibung muss gesetzt sein.");
  return result;
}

export function createTextsService(db, guildId) {
  return {
    describe: () => Object.entries(PANEL_TEXTS).map(([id, definition]) => ({
      id, label: definition.label, channelKey: definition.channelKey,
      fields: Object.entries(definition.fields).map(([key, field]) => ({ key, ...field })),
      values: panelTexts(db, guildId, id), custom: Boolean(getSetting(db, guildId, settingKey(id))),
    })),
    update({ panel, values, actorId }) {
      const texts = validateTexts(panel, values);
      const defaults = defaultsFor(panel);
      const changed = Object.fromEntries(Object.entries(texts).filter(([key, value]) => value !== defaults[key]));
      db.transaction(() => {
        db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(guildId, settingKey(panel), JSON.stringify(changed), new Date().toISOString());
        audit(db, guildId, actorId, "config.changed", settingKey(panel), { setting: settingKey(panel), value: `${Object.keys(changed).length} angepasste Texte` });
      })();
      return panelTexts(db, guildId, panel);
    },
    reset({ panel, actorId }) {
      if (!PANEL_TEXTS[panel]) throw new Error("Unbekanntes Panel.");
      db.transaction(() => {
        db.prepare("DELETE FROM guild_settings WHERE guild_id=? AND key=?").run(guildId, settingKey(panel));
        audit(db, guildId, actorId, "config.changed", settingKey(panel), { setting: settingKey(panel), value: "Standardtexte" });
      })();
      return panelTexts(db, guildId, panel);
    },
  };
}
