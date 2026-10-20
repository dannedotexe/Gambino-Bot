import { toXlsx } from "./xlsx.js";
import { localDay } from "./services/absences.js";

/** Exporte für die Website. group = benötigte Rollengruppe. */
export const EXPORTS = {
  accounts: { label: "Kontostände", group: "financeView" },
  transactions: { label: "Buchungen", group: "financeView" },
  payouts: { label: "Auszahlungen", group: "financeView" },
  sanctions: { label: "Sanktionen", group: "sanctionsView" },
  warnings: { label: "Verwarnungen", group: "moderation" },
  events: { label: "Event-Teilnahmen", group: "anyStaff" },
  members: { label: "Mitglieder", group: "anyStaff" },
  absences: { label: "Abmeldungen", group: "anyStaff" },
  polls: { label: "Abstimmungen", group: "staff" },
  tasks: { label: "Aufgaben-Logs", group: "tasks" },
  taskmonths: { label: "Aufgaben-Monatsabrechnung", group: "tasks" },
};

const taskStatus = { pending: "Offen", approved: "Bestätigt", rejected: "Abgelehnt" };
const s_reason = text => String(text ?? "").slice(0, 80);
const money = cents => cents == null ? null : Number(cents) / 100;
const col = (label, type = "text") => ({ label, type });
const txLabels = { credit: "Gutschrift", payout: "Auszahlung", correction_credit: "Korrektur (+)", correction_debit: "Korrektur (−)", sanction_refund: "Sanktions-Erstattung" };
const statusLabels = { open: "Offen", partial: "Teilweise verrechnet", paid: "Beglichen", void: "Aufgehoben", signed_up: "Angemeldet", present: "Anwesend", absent: "Abwesend", scheduled: "Geplant", ended: "Beendet", cancelled: "Abgesagt", closed: "Beendet" };

/** Tabelle als { sheet, columns, rows }. `name(id)` liefert Anzeigenamen. Beträge in Dollar, Datumswerte als ISO. */
export function buildTable(kind, { db, guildId, name, finance, timezone = "Europe/Vienna" }) {
  const all = (sql, ...p) => db.prepare(sql).all(guildId, ...p);
  switch (kind) {
    case "accounts":
      return { sheet: "Kontostände", columns: [col("Mitglied"), col("Guthaben brutto", "money"), col("Offene Sanktionen", "money"), col("Abzug bei Auszahlung", "money"), col("Auszahlung netto", "money"), col("Discord-ID")],
        rows: all("SELECT user_id FROM accounts WHERE guild_id=? ORDER BY balance_cents DESC").map(a => { const p = finance.previewPayout(guildId, a.user_id); return [name(a.user_id), money(p.gross), money(p.openCents), money(p.deduction), money(p.net), a.user_id]; }) };
    case "transactions":
      return { sheet: "Buchungen", columns: [col("Datum", "date"), col("Mitglied"), col("Art"), col("Betrag", "money"), col("Brutto", "money"), col("Sanktionsabzug", "money"), col("Netto", "money"), col("Grund"), col("Gebucht von"), col("Discord-ID"), col("Referenz")],
        rows: all("SELECT * FROM transactions WHERE guild_id=? ORDER BY created_at DESC,rowid DESC").map(t => { const payout = t.type === "payout"; return [t.created_at, name(t.user_id), txLabels[t.type] ?? t.type, money(["payout", "correction_debit"].includes(t.type) ? -t.amount_cents : t.amount_cents), payout ? money(t.gross_cents) : null, payout ? money(t.deduction_cents) : null, payout ? money(t.net_cents) : null, t.reason, name(t.actor_id), t.user_id, t.id.slice(0, 8)]; }) };
    case "payouts":
      return { sheet: "Auszahlungen", columns: [col("Datum", "date"), col("Mitglied"), col("Brutto", "money"), col("Sanktionsabzug", "money"), col("Ausgezahlt (netto)", "money"), col("Verrechnete Sanktionen"), col("Ausgezahlt von"), col("Notiz"), col("Discord-ID"), col("Referenz")],
        rows: all("SELECT * FROM transactions WHERE guild_id=? AND type='payout' ORDER BY created_at DESC,rowid DESC").map(t => [t.created_at, name(t.user_id), money(t.gross_cents), money(t.deduction_cents), money(t.net_cents),
          db.prepare("SELECT a.amount_cents,s.reason FROM payout_allocations a JOIN sanctions s ON s.id=a.sanction_id WHERE a.payout_id=?").all(t.id).map(a => `${s_reason(a.reason)} (−${(a.amount_cents / 100).toFixed(2)} $)`).join("; ") || null,
          name(t.actor_id), t.reason, t.user_id, t.id.slice(0, 8)]) };
    case "sanctions":
      return { sheet: "Sanktionen", columns: [col("Datum", "date"), col("Mitglied"), col("Betrag", "money"), col("Noch offen", "money"), col("Status"), col("Grund"), col("Fallbezug"), col("Eingetragen von"), col("Discord-ID"), col("Referenz")],
        rows: all("SELECT * FROM sanctions WHERE guild_id=? ORDER BY created_at DESC").map(s => [s.created_at, name(s.user_id), money(s.amount_cents), money(s.remaining_cents), statusLabels[s.status] ?? s.status, s.reason, s.case_ref, name(s.actor_id), s.user_id, s.id.slice(0, 8)]) };
    case "warnings":
      return { sheet: "Verwarnungen", columns: [col("Datum", "date"), col("Mitglied"), col("Grund"), col("Fallbezug"), col("Von"), col("Status"), col("Zurückgenommen am", "date"), col("Zurückgenommen von"), col("Grund der Rücknahme"), col("Discord-ID")],
        rows: all("SELECT * FROM member_warnings WHERE guild_id=? ORDER BY created_at DESC").map(w => [w.created_at, name(w.user_id), w.reason, w.case_ref, name(w.actor_id), w.revoked_at ? "Zurückgenommen" : "Aktiv", w.revoked_at, w.revoked_by ? name(w.revoked_by) : null, w.revoke_reason, w.user_id]) };
    case "events":
      return { sheet: "Event-Teilnahmen", columns: [col("Beginn", "date"), col("Event"), col("Event-Status"), col("Mitglied"), col("Teilnahme"), col("Discord-ID")],
        rows: all("SELECT e.name,e.starts_at,e.status AS event_status,p.user_id,p.status FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND p.status<>'left' ORDER BY e.starts_at DESC").map(r => [r.starts_at, r.name, statusLabels[r.event_status] ?? r.event_status, name(r.user_id), statusLabels[r.status] ?? r.status, r.user_id]) };
    case "members":
      return { sheet: "Mitglieder", columns: [col("Name"), col("Vorname"), col("Nachname"), col("Ingame-ID"), col("Verifiziert am", "date"), col("Zuletzt geändert", "date"), col("Discord-ID")],
        rows: all("SELECT * FROM member_verifications WHERE guild_id=? ORDER BY last_name,first_name").map(v => [v.nickname, v.first_name, v.last_name, v.ingame_id, v.verified_at, v.updated_at, v.user_id]) };
    case "absences":
      return { sheet: "Abmeldungen", columns: [col("Mitglied"), col("Von", "day"), col("Bis", "day"), col("Grund"), col("Eingetragen am", "date"), col("Eingetragen von"), col("Vorzeitig beendet", "date"), col("Discord-ID")],
        rows: all("SELECT * FROM member_absences WHERE guild_id=? ORDER BY starts_on DESC").map(a => [name(a.user_id), a.starts_on, a.ends_on, a.reason, a.created_at, name(a.created_by), a.ended_at, a.user_id]) };
    case "polls": {
      const rows = [];
      for (const p of all("SELECT * FROM polls WHERE guild_id=? ORDER BY created_at DESC")) {
        const options = JSON.parse(p.options), counts = options.map(() => 0);
        for (const v of db.prepare("SELECT option_index, COUNT(*) n FROM poll_votes WHERE poll_id=? GROUP BY option_index").all(p.id)) counts[v.option_index] = v.n;
        const total = counts.reduce((a, b) => a + b, 0);
        options.forEach((option, i) => rows.push([p.question, option, counts[i], total ? counts[i] / total : 0, statusLabels[p.status] ?? p.status, p.anonymous ? "ja" : "nein", p.created_at, p.ends_at]));
      }
      return { sheet: "Abstimmungen", columns: [col("Frage"), col("Antwort"), col("Stimmen", "number"), col("Anteil", "percent"), col("Status"), col("Anonym"), col("Gestartet", "date"), col("Ende", "date")], rows };
    }
    case "tasks":
      return { sheet: "Aufgaben-Logs", columns: [col("Eingereicht", "date"), col("Mitglied"), col("Aufgabe"), col("Menge", "number"), col("Belohnung", "money"), col("Status"), col("Geprüft von"), col("Geprüft am", "date"), col("Ablehnungsgrund"), col("Discord-ID")],
        rows: all("SELECT l.*,t.name AS type_name FROM task_logs l JOIN task_types t ON t.id=l.type_id WHERE l.guild_id=? ORDER BY l.created_at DESC").map(l => [l.created_at, name(l.user_id), l.type_name, l.quantity, l.status === "approved" ? money(l.reward_cents) : null, taskStatus[l.status] ?? l.status, l.reviewer_id ? name(l.reviewer_id) : null, l.reviewed_at, l.reject_reason, l.user_id]) };
    case "taskmonths": {
      // Monatsabrechnung: je Monat (Server-Zeitzone) und Mitglied bestätigte Logs, Stück und ausgezahlte Belohnung.
      const map = new Map();
      for (const l of all("SELECT user_id,status,quantity,reward_cents,created_at FROM task_logs WHERE guild_id=?")) {
        const month = localDay(new Date(l.created_at), timezone).slice(0, 7), key = `${month}|${l.user_id}`;
        const e = map.get(key) ?? { month, userId: l.user_id, approved: 0, units: 0, cents: 0, rejected: 0, pending: 0 };
        if (l.status === "approved") { e.approved++; e.units += l.quantity; e.cents += l.reward_cents; } else if (l.status === "rejected") e.rejected++; else e.pending++;
        map.set(key, e);
      }
      const rows = [...map.values()].sort((a, b) => b.month.localeCompare(a.month) || b.cents - a.cents || b.approved - a.approved);
      return { sheet: "Monatsabrechnung", columns: [col("Monat"), col("Mitglied"), col("Bestätigte Logs", "number"), col("Stück", "number"), col("Belohnung", "money"), col("Abgelehnt", "number"), col("Offen", "number"), col("Discord-ID")],
        rows: rows.map(e => [`${e.month.slice(5)}/${e.month.slice(0, 4)}`, name(e.userId), e.approved, e.units, money(e.cents), e.rejected, e.pending, e.userId]) };
    }
    default: return null;
  }
}

export function buildExportFile(kind, options) {
  const table = buildTable(kind, options);
  return table ? toXlsx(table, { timezone: options.timezone }) : null;
}
