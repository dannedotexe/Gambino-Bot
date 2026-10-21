/**
 * Staatliche Kontrolle erkennen: per 🚩-Knopf angelegt (fester Ort) oder als normales Event mit
 * „Staatliche Kontrolle“ im Namen. Solche Events enden automatisch und ihre Posts werden danach gelöscht.
 */
export const CONTROL_LOCATION = "Staatliche Kontrolle";
export const isControlEvent = event => Boolean(event) && !event.series_id && (event.location === CONTROL_LOCATION || /staatliche\s*kontrolle/i.test(event.name ?? ""));
/** Gleiche Regel als SQL-Bedingung (Tabelle events, ohne Alias). */
export const CONTROL_SQL = "(series_id IS NULL AND (location='Staatliche Kontrolle' OR lower(name) LIKE '%staatliche kontrolle%'))";
