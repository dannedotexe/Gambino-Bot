/**
 * CSV für Excel/Google Sheets (deutsche Einstellungen): Semikolon als Trenner, Dezimalkomma, UTF-8 mit BOM.
 * Zellen, die mit = + - @ beginnen, werden entschärft, damit Tabellenprogramme sie nicht als Formel ausführen.
 */
const cell = value => {
  let text = value == null ? "" : String(value);
  // Negative Zahlen wie „-123,45“ bleiben Zahlen; alles andere mit Formel-Startzeichen wird entschärft.
  if (/^[=+@\t\r]/.test(text) || (/^-/.test(text) && !/^-\d+(,\d+)?$/.test(text))) text = `'${text}`;
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export const toCsv = (header, rows) => "﻿" + [header, ...rows].map(row => row.map(cell).join(";")).join("\r\n") + "\r\n";
export const csvMoney = cents => (Number(cents ?? 0) / 100).toFixed(2).replace(".", ",");
export const csvDate = (iso, timezone) => iso ? new Intl.DateTimeFormat("de-AT", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "";

export const EXPORTS = {
  accounts: { label: "Kontostände", group: "financeView" },
  transactions: { label: "Buchungen", group: "financeView" },
  sanctions: { label: "Sanktionen", group: "sanctionsView" },
  warnings: { label: "Verwarnungen", group: "moderation" },
  events: { label: "Event-Teilnahmen", group: "anyStaff" },
  members: { label: "Verifizierte Mitglieder", group: "anyStaff" },
  absences: { label: "Abmeldungen", group: "anyStaff" },
  polls: { label: "Abstimmungen", group: "staff" },
};

/** Baut die Tabelle. `name(id)` liefert Anzeigenamen. */
export function buildExport(kind, { db, guildId, timezone, name, finance }) {
  const date = iso => csvDate(iso, timezone);
  const txLabels = { credit: "Gutschrift", payout: "Auszahlung", correction_credit: "Korrektur (+)", correction_debit: "Korrektur (−)", sanction_refund: "Sanktions-Erstattung" };
  const statusLabels = { open: "Offen", partial: "Teilweise verrechnet", paid: "Beglichen", void: "Aufgehoben", signed_up: "Angemeldet", present: "Anwesend", absent: "Abwesend", scheduled: "Geplant", ended: "Beendet", cancelled: "Abgesagt", closed: "Beendet" };
  switch (kind) {
    case "accounts": {
      const rows = db.prepare("SELECT user_id,balance_cents FROM accounts WHERE guild_id=? ORDER BY balance_cents DESC").all(guildId).map(a => {
        const p = finance.previewPayout(guildId, a.user_id);
        return [name(a.user_id), a.user_id, csvMoney(p.gross), csvMoney(p.openCents), csvMoney(p.deduction), csvMoney(p.net)];
      });
      return toCsv(["Mitglied", "Discord-ID", "Guthaben brutto ($)", "Offene Sanktionen ($)", "Abzug bei Auszahlung ($)", "Auszahlung netto ($)"], rows);
    }
    case "transactions":
      return toCsv(["Datum", "Mitglied", "Discord-ID", "Art", "Betrag ($)", "Brutto ($)", "Abzug ($)", "Netto ($)", "Grund", "Gebucht von", "Referenz"],
        db.prepare("SELECT * FROM transactions WHERE guild_id=? ORDER BY created_at DESC,rowid DESC").all(guildId).map(t => [date(t.created_at), name(t.user_id), t.user_id, txLabels[t.type] ?? t.type, csvMoney(["payout", "correction_debit"].includes(t.type) ? -t.amount_cents : t.amount_cents), t.type === "payout" ? csvMoney(t.gross_cents) : "", t.type === "payout" ? csvMoney(t.deduction_cents) : "", t.type === "payout" ? csvMoney(t.net_cents) : "", t.reason, name(t.actor_id), t.id]));
    case "sanctions":
      return toCsv(["Datum", "Mitglied", "Discord-ID", "Betrag ($)", "Noch offen ($)", "Status", "Grund", "Fallbezug", "Eingetragen von", "Referenz"],
        db.prepare("SELECT * FROM sanctions WHERE guild_id=? ORDER BY created_at DESC").all(guildId).map(s => [date(s.created_at), name(s.user_id), s.user_id, csvMoney(s.amount_cents), csvMoney(s.remaining_cents), statusLabels[s.status] ?? s.status, s.reason, s.case_ref ?? "", name(s.actor_id), s.id]));
    case "warnings":
      return toCsv(["Datum", "Mitglied", "Discord-ID", "Grund", "Fallbezug", "Von", "Zurückgenommen am", "Zurückgenommen von", "Grund der Rücknahme"],
        db.prepare("SELECT * FROM member_warnings WHERE guild_id=? ORDER BY created_at DESC").all(guildId).map(w => [date(w.created_at), name(w.user_id), w.user_id, w.reason, w.case_ref ?? "", name(w.actor_id), date(w.revoked_at), w.revoked_by ? name(w.revoked_by) : "", w.revoke_reason ?? ""]));
    case "events":
      return toCsv(["Event", "Beginn", "Event-Status", "Mitglied", "Discord-ID", "Teilnahme"],
        db.prepare("SELECT e.name,e.starts_at,e.status AS event_status,p.user_id,p.status FROM event_participants p JOIN events e ON e.id=p.event_id WHERE e.guild_id=? AND p.status<>'left' ORDER BY e.starts_at DESC").all(guildId).map(r => [r.name, date(r.starts_at), statusLabels[r.event_status] ?? r.event_status, name(r.user_id), r.user_id, statusLabels[r.status] ?? r.status]));
    case "members":
      return toCsv(["Discord-Name", "Discord-ID", "Ingame-ID", "Vorname", "Nachname", "Verifiziert am", "Zuletzt geändert"],
        db.prepare("SELECT * FROM member_verifications WHERE guild_id=? ORDER BY last_name,first_name").all(guildId).map(v => [v.nickname, v.user_id, v.ingame_id, v.first_name, v.last_name, date(v.verified_at), date(v.updated_at)]));
    case "absences":
      return toCsv(["Mitglied", "Discord-ID", "Von", "Bis", "Grund", "Eingetragen am", "Eingetragen von", "Vorzeitig beendet am"],
        db.prepare("SELECT * FROM member_absences WHERE guild_id=? ORDER BY starts_on DESC").all(guildId).map(a => [name(a.user_id), a.user_id, a.starts_on.split("-").reverse().join("."), a.ends_on.split("-").reverse().join("."), a.reason, date(a.created_at), name(a.created_by), date(a.ended_at)]));
    case "polls": {
      const rows = [];
      for (const p of db.prepare("SELECT * FROM polls WHERE guild_id=? ORDER BY created_at DESC").all(guildId)) {
        const options = JSON.parse(p.options), counts = options.map(() => 0);
        for (const v of db.prepare("SELECT option_index, COUNT(*) n FROM poll_votes WHERE poll_id=? GROUP BY option_index").all(p.id)) counts[v.option_index] = v.n;
        options.forEach((option, i) => rows.push([p.question, date(p.created_at), date(p.ends_at), statusLabels[p.status] ?? p.status, p.anonymous ? "ja" : "nein", option, counts[i]]));
      }
      return toCsv(["Frage", "Gestartet", "Ende", "Status", "Anonym", "Antwort", "Stimmen"], rows);
    }
    default: return null;
  }
}
