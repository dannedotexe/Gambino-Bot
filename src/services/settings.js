import { audit } from "../database.js";
import { loadConfig } from "../config.js";

/**
 * Über Website/Discord bearbeitbare Einstellungen. Werte werden im .env-Format in guild_settings gespeichert,
 * mit derselben Validierung wie beim Start geprüft und sofort auf die laufende Konfiguration angewendet.
 * Bewusst NICHT bearbeitbar: Token, Client-ID/Secret, Guild-ID, Bot-Owner, Datenbankpfad und Webdashboard-Zugang.
 */
const ACTIONS = [["warn", "Hinweis"], ["delete", "Löschen"], ["timeout", "Timeout"], ["alert", "Staff-Meldung"]];
export const SETTINGS = [
  { key: "ROLE_LEADERS", group: "Rollen", label: "Leitung", type: "roles", help: "Alle Rechte: Korrekturen, Aufhebungen, Löschungen. Die Verwaltung (Status, Einstellungen) sehen nur Bot-Owner." },
  { key: "ROLE_FULL_ACCESS", group: "Rollen", label: "Voller Zugriff (z. B. ab Rang 8)", type: "roles", help: "Alle Rollen ab dem Rang anhaken, der alles sehen und bearbeiten darf (also Rang 8 und jeder höhere Rang). Gleiche Rechte wie die Leitung – außer der Verwaltung, die nur Bot-Owner sehen." },
  { key: "DASHBOARD_MEMBER_AREA", group: "Rollen", label: "„Mein Bereich“ für Familienmitglieder", type: "bool", help: "Mitglieder mit der Familienmitglieder-Rolle können sich auf der Website anmelden und sehen dort nur ihre eigenen Daten (Konto, Sanktionen, Verwarnungen, Events, Rang, Abmeldung) und die Rangliste." },
  { key: "ACCESS_LOG_DAYS", group: "Rollen", label: "Website-Zugriffe (IP-Adressen) aufbewahren – Tage", type: "number", min: 1, max: 365, help: "Wer die Website öffnet oder sich anmeldet, wird mit IP-Adresse protokolliert (nur für Bot-Owner unter Verwaltung → Status sichtbar). Ältere Einträge werden automatisch gelöscht." },
  { key: "ROLE_SNAPSHOT_KEEP", group: "Rollen", label: "Tägliche Rollen-Sicherungen aufbewahren", type: "number", min: 3, max: 90, help: "Der Bot sichert jeden Tag, wer welche Rollen hat (Verwaltung → Status). So viele automatische Sicherungen bleiben erhalten; manuelle Sicherungen werden nie automatisch gelöscht." },
  { key: "ROLE_STAFF", group: "Rollen", label: "Staff", type: "roles", help: "Tickets, Sanktionen, Giveaways." },
  { key: "ROLE_MODERATORS", group: "Rollen", label: "Moderation", type: "roles", help: "Optional: darf verwarnen (/warn) und Verwarnungen zurücknehmen (/unwarn) – ohne weitere Staff-Rechte." },
  { key: "ROLE_FINANCE", group: "Rollen", label: "Finanzen", type: "roles", help: "Gutschriften und Auszahlungen buchen." },
  { key: "ROLE_FINANCE_VIEWERS", group: "Rollen", label: "Finanz-Einsicht", type: "roles", help: "Kontostände nur ansehen." },
  { key: "ROLE_REVIEWERS", group: "Rollen", label: "Reviewer", type: "roles", help: "Bewerbungen und Rang-Anträge prüfen." },
  { key: "ROLE_TASK_REVIEWERS", group: "Rollen", label: "Aufgaben-Prüfer", type: "roles", help: "Dürfen Aufgaben-Logs (Invite, Plantage …) bestätigen oder ablehnen – Bestätigen bucht die Belohnung aufs Familienkonto. Leitung und Finanzen dürfen das immer." },
  { key: "ROLE_EVENT_TEAM", group: "Rollen", label: "Event-Team", type: "roles", help: "Events und Aktivitäten verwalten." },
  { key: "ROLE_MEMBERS", group: "Rollen", label: "Familienmitglieder", type: "roles", help: "Die allgemeine Familienrolle (z. B. „| Gambino“). Wer sie oder eine Rang-Rolle hat, gehört zur Familie: Familienkonto, Abmeldung, Events, Rang-Anträge und „Mein Bereich“ auf der Website." },
  { key: "ROLE_VERIFIED", group: "Rollen", label: "Rolle nach Verifizierung", type: "roles", help: "Optional: wird nach erfolgreicher Verifizierung vergeben. Die Bot-Rolle muss darüber stehen." },
  { key: "ROLE_ABSENT", group: "Rollen", label: "Rolle während einer Abmeldung", type: "roles", help: "Optional: wird automatisch vergeben, solange jemand abgemeldet ist, und danach wieder entfernt. Die Bot-Rolle muss darüber stehen." },
  { key: "CHANNEL_WELCOME", group: "Channels", label: "Willkommensnachricht (öffentlich)", type: "channel", help: "Neue Spieler werden hier begrüßt, mit Hinweis und Button zur Verifizierung. Leer = keine Begrüßung. Empfohlen: INFORMATION・willkommen." },
  { key: "CHANNEL_VERIFICATION_PANEL", group: "Channels", label: "Verifizierungs-Panel (öffentlich)", type: "channel", help: "Button „Verifizieren“; Name wird zu „Vorname Nachname | ID“. Empfohlen: INFORMATION・neue-spieler." },
  { key: "CHANNEL_ACCOUNT_PANEL", group: "Channels", label: "„Mein Konto“-Panel (öffentlich)", type: "channel", help: "Buttons für eigenes Guthaben, Buchungen und Sanktionen – Antworten sieht nur die Person selbst. Empfohlen: eigener Channel, z. B. Familie・konto." },
  { key: "CHANNEL_TICKET_PANEL", group: "Channels", label: "Ticket-Panel (öffentlich)", type: "channel", help: "Hier steht das Auswahlmenü zum Ticket-Öffnen; wird automatisch gepostet. Empfohlen: SUPPORT・ticket." },
  { key: "CHANNEL_TICKET_CATEGORY", group: "Channels", label: "Ticket-Kategorie", type: "category", help: "Unter dieser Kategorie entstehen die privaten Ticket-Channels." },
  { key: "CHANNEL_TICKET_CLOSED_CATEGORY", group: "Channels", label: "Kategorie für geschlossene Tickets", type: "category", help: "Geschlossene Tickets werden hierher verschoben, beim Wiederöffnen zurück. Discord erlaubt max. 50 Channels pro Kategorie." },
  { key: "CHANNEL_TICKET_LOG", group: "Channels", label: "Ticket-Log (Staff)", type: "channel", help: "Neue/geschlossene Tickets inkl. Transkript-Datei. Empfohlen: STAFF・ticket-logs." },
  { key: "CHANNEL_APPLICATION_PANEL", group: "Channels", label: "Bewerbungs-Panel (öffentlich)", type: "channel", help: "Buttons für Bewerbung und Rang-Antrag; wird automatisch gepostet. Empfohlen: SUPPORT・bewerbungen." },
  { key: "CHANNEL_APPLICATION_REVIEW", group: "Channels", label: "Bewerbungen prüfen (Staff)", type: "channel", help: "Empfohlen: STAFF・bewerbungen." },
  { key: "CHANNEL_RANK_REVIEW", group: "Channels", label: "Rang-Anträge prüfen (Staff)", type: "channel", help: "Muss ein Staff-Channel sein. Empfohlen: STAFF・rang-anträge." },
  { key: "CHANNEL_EVENT_ANNOUNCEMENTS", group: "Channels", label: "Event-Ankündigungen (öffentlich)", type: "channel", help: "Kurze Ankündigung mit Button „Zur Anmeldung“. Empfohlen: EVENTS・event-ankündigungen." },
  { key: "CHANNEL_EVENT_SIGNUP", group: "Channels", label: "Event-Anmeldung (öffentlich)", type: "channel", help: "Event-Karte mit Teilnehmen/Abmelden und Erinnerungen. Empfohlen: EVENTS・event-anmeldung. Leer = alles im Ankündigungs-Channel." },
  { key: "CHANNEL_ANNOUNCEMENTS", group: "Channels", label: "Ankündigungen (öffentlich)", type: "channel", help: "Standard-Channel für Ankündigungen von der Website. Empfohlen: INFORMATION・ankündigungen." },
  { key: "CHANNEL_POLLS", group: "Channels", label: "Abstimmungen (öffentlich)", type: "channel", help: "Standard-Channel für Abstimmungen von Website und /umfrage. Empfohlen: COMMUNITY・abstimmungen." },
  { key: "CHANNEL_SANCTION_LIST", group: "Channels", label: "Öffentliche Sanktionsliste", type: "channel", help: "Automatisch aktualisierte Liste offener Sanktionen. Empfohlen: INFORMATION・sanktionsliste." },
  { key: "CHANNEL_WEEKLY_REPORT", group: "Channels", label: "Wochenbericht (nur Leitung)", type: "channel", help: "Jeden Montag eine Zusammenfassung der Vorwoche inkl. Finanzen – nur in einen Channel, den ausschließlich die Leitung sieht. Leer = kein Bericht." },
  { key: "CHANNEL_ABSENCES", group: "Channels", label: "Abmeldungen (öffentlich)", type: "channel", help: "Panel mit „Abmelden“/„Wieder da“; neue Abmeldungen werden hier kurz angezeigt. Empfohlen: SUPPORT・abmeldungen." },
  { key: "CHANNEL_ACTIVITY_LOG", group: "Channels", label: "Abmeldungs- & Inaktivitäts-Log (Staff)", type: "channel", help: "Abmeldungen mit Grund und tägliche Inaktivitäts-Meldung. Leer = Audit-Log." },
  { key: "CHANNEL_LEADERBOARD", group: "Channels", label: "Rangliste (öffentlich)", type: "channel", help: "Dauerhafte Rangliste der aktivsten Mitglieder (Woche/Monat); aktualisiert sich automatisch." },
  { key: "CHANNEL_ACTIVITY_BOARD", group: "Channels", label: "Aktivitäten-Übersicht (öffentlich)", type: "channel", help: "Dauerhafter Aktivitätenplan; wird automatisch gepostet. Empfohlen: EVENTS・event-infos." },
  { key: "CHANNEL_EVENT_RESULTS", group: "Channels", label: "Event-Ergebnisse (öffentlich)", type: "channel", help: "Zusammenfassung beim Beenden eines Events. Empfohlen: EVENTS・event-ergebnisse." },
  { key: "CHANNEL_BOT_COMMANDS", group: "Channels", label: "Befehls-Channel (Mitglieder)", type: "channel", help: "Mitglieder können Bot-Befehle (/abwesend, /rangliste …) nur hier nutzen; Staff und Leitung überall. Leer = überall erlaubt." },
  { key: "BOT_COMMANDS_CLEANUP", group: "Logs & Panels", label: "Befehls-Channel sauber halten", type: "bool", help: "Normale Nachrichten von Mitgliedern im Befehls-Channel werden automatisch gelöscht (kurzer Hinweis erscheint). Braucht „Nachrichten verwalten“ für den Bot." },
  { key: "CHANNEL_EVENT_CHECK", group: "Channels", label: "Event-Check (Anwesenheit)", type: "channel", help: "Staff-Channel: Bei jedem Event-Start kommt hier „Event vorbei? – wer war da?“ mit Button. Erst nach dem Abschließen ist das Event fertig. Leer = Event-Log." },
  { key: "CHANNEL_EVENT_LOG", group: "Channels", label: "Event-Log", type: "channel", help: "Protokoll aller Event-Aktionen. Empfohlen: EVENTS・event-logs. Leer = Audit-Log." },
  { key: "CHANNEL_GIVEAWAYS", group: "Channels", label: "Giveaways (öffentlich)", type: "channel", help: "Standard-Channel für neue Giveaways. Empfohlen: COMMUNITY・giveaway." },
  { key: "CHANNEL_STAFF_DASHBOARD", group: "Channels", label: "Staff-Dashboard-Panel (Staff)", type: "channel", help: "Panel wird automatisch gepostet. Empfohlen: STAFF・staff-dashboard." },
  { key: "CHANNEL_SANCTION_LOG", group: "Channels", label: "Sanktions-Log (Staff)", type: "channel", help: "Alle Sanktionen und Verwarnungen. Empfohlen: STAFF・sanktions-logs. Leer = Audit-Log." },
  { key: "CHANNEL_PAYOUT_LIST", group: "Channels", label: "Auszahlungsliste (immer aktuell)", type: "channel", help: "Der Bot hält hier eine Nachricht aktuell: wer wie viel bekommt (netto, Sanktionsabzug, Mindestbetrag). Achtung: Wer den Channel sieht, sieht alle Guthaben." },
  { key: "CHANNEL_TASK_REVIEW", group: "Channels", label: "Aufgaben-Logs prüfen (Staff)", type: "channel", help: "Jedes eingereichte Aufgaben-Log (Screenshot im Logbuch oder /log) erscheint hier mit Screenshot und Buttons Bestätigen / Menge ändern / Ablehnen. Leer = Audit-Log." },
  { key: "CHANNEL_TASK_BOARD", group: "Channels", label: "Aufgaben-Board (öffentlich)", type: "channel", help: "Eine Nachricht, die der Bot aktuell hält: alle Aufgaben mit Belohnung, Top-Farmer der Woche und wie man loggt. Empfohlen: normaler Text-Channel (kein Forum)." },
  { key: "CHANNEL_TASK_FORUM", group: "Channels", label: "Logbücher (Forum)", type: "forum", help: "Forum, in dem jedes neue Familienmitglied automatisch sein Logbuch bekommt (Titel „Vorname Nachname | ID“, Text aus dem Post „Vorlage …“, Person wird markiert). Empfohlen: Familie・aufgaben-logs." },
  { key: "CHANNEL_FINANCE_LOG", group: "Channels", label: "Auszahlungs-/Finanz-Log (Staff)", type: "channel", help: "Gutschriften, Auszahlungen, Korrekturen. Empfohlen: STAFF・auszahlungen. Leer = Audit-Log." },
  { key: "CHANNEL_STATS", group: "Channels", label: "Statistik", type: "channel", help: "Automatische Statistik ohne Finanzdaten. Empfohlen: STAFF・server-statistik." },
  { key: "CHANNEL_AUDIT_LOG", group: "Channels", label: "Allgemeines Audit-Log (Staff)", type: "channel", help: "Alle übrigen Aktionen (Tickets, Anträge, Einstellungen …). Empfohlen: eigener Channel STAFF・bot-logs." },
  { key: "CHANNEL_AUTOMOD_LOG", group: "Channels", label: "AutoMod-/Raid-Log (Staff)", type: "channel", help: "Empfohlen: STAFF・bot-logs oder eigener mod-log." },
  { key: "TICKET_CATEGORIES_JSON", group: "Tickets", label: "Ticket-Kategorien", type: "ticketCategories" },
  { key: "TICKET_MAX_OPEN_PER_USER", group: "Tickets", label: "Max. offene Tickets pro Person", type: "number", min: 1, max: 20 },
  { key: "TICKET_COOLDOWN_SECONDS", group: "Tickets", label: "Wartezeit zwischen Tickets (Sekunden)", type: "number", min: 1, max: 86400 },
  { key: "TICKET_TRANSCRIPT_LIMIT", group: "Tickets", label: "Nachrichten im Transkript", type: "number", min: 100, max: 1000 },
  { key: "ACCOUNT_AUTO_OPEN_FOR_MEMBERS", group: "Familienkonto", label: "Konto automatisch für neue Familienmitglieder", type: "bool", help: "Familienkonto (0 $) wird angelegt, sobald eine Familienbewerbung angenommen wird oder jemand die Familienmitglieder-Rolle bekommt. Die Verifizierung allein legt kein Konto an." },
  { key: "LOGBOOK_AUTO_CREATE", group: "Familienkonto", label: "Logbuch automatisch anlegen", type: "bool", help: "Bekommt jemand die Familienmitglieder-Rolle, legt der Bot im Logbücher-Forum einen Post für die Person an. Gibt es schon einen Post mit ihrem Namen bzw. ihrer ID, wird keiner doppelt angelegt." },
  { key: "LOGBOOK_ARCHIVE", group: "Familienkonto", label: "Logbuch archivieren, wenn jemand die Familie verlässt", type: "bool", help: "Familienrolle weg oder Server verlassen → Post wird geschlossen und gesperrt (nichts wird gelöscht). Kommt die Person zurück, wird er wieder geöffnet." },
  { key: "LOGBOOK_REMIND_DAYS", group: "Familienkonto", label: "Erinnerung nach Tagen ohne Log (0 = aus)", type: "number", min: 0, max: 90, help: "Wer so lange nichts geloggt hat, bekommt einmal eine DM mit Link zu seinem Logbuch. Abgemeldete werden nicht erinnert; nach dem nächsten Log beginnt die Zählung neu." },
  { key: "LOGBOOK_IMAGES_ONLY", group: "Familienkonto", label: "Logbücher: nur Bilder erlaubt", type: "bool", help: "Nachrichten ohne Bild von Mitgliedern werden in den Logbuch-Posts automatisch gelöscht (kurzer Hinweis erscheint). Team-Rollen dürfen schreiben. Braucht „Nachrichten verwalten“ im Forum." },
  { key: "TASK_REJECT_REASONS", group: "Familienkonto", label: "Aufgaben-Logs: Ablehnungsgründe zum Anklicken", type: "list", help: "Kommagetrennt. Erscheinen beim Ablehnen in Discord und auf der Website als Auswahl; ein eigener Grund bleibt immer möglich." },
  { key: "TASK_DM_ENABLED", group: "Familienkonto", label: "Aufgaben-Logs: Ergebnis per DM", type: "bool", help: "Wer ein Log einreicht, bekommt nach der Prüfung eine private Nachricht mit Belohnung, Serie und Wochenplatz bzw. dem Ablehnungsgrund." },
  { key: "PAYOUT_MINIMUM_CENTS", group: "Familienkonto", label: "Auszahlungs-Mindestbetrag ($)", type: "money", help: "Optional. Erst ab diesem Guthaben kann ausgezahlt werden (Website und Discord sperren kleinere Auszahlungen). Mitglieder sehen im Kontostand und in „Mein Bereich“, wie viel noch fehlt. Leer = jeder Betrag ist auszahlbar." },
  { key: "SANCTION_LIST_SHOW_AMOUNTS", group: "Sanktionsliste & Wochenbericht", label: "Beträge in der öffentlichen Sanktionsliste zeigen", type: "bool" },
  { key: "SANCTION_LIST_SHOW_REASONS", group: "Sanktionsliste & Wochenbericht", label: "Gründe in der öffentlichen Sanktionsliste zeigen", type: "bool" },
  { key: "WEEKLY_REPORT_HOUR", group: "Sanktionsliste & Wochenbericht", label: "Wochenbericht montags ab (Uhr)", type: "number", min: 0, max: 23, help: "Stunde in der Server-Zeitzone, z. B. 9 = Montag ab 9:00 Uhr." },
  { key: "ABSENCE_MAX_DAYS", group: "Abmeldungen & Aktivität", label: "Längste Abmeldung (Tage)", type: "number", min: 1, max: 365, help: "Längere Pausen laufen über ein Ticket an die Leitung oder werden auf der Website eingetragen." },
  { key: "ABSENCE_SHOW_REASON", group: "Abmeldungen & Aktivität", label: "Grund im öffentlichen Abmeldungs-Channel zeigen", type: "bool", help: "Aus = öffentlich steht nur der Zeitraum; der Grund ist nur für Staff sichtbar." },
  { key: "INACTIVITY_DAYS", group: "Abmeldungen & Aktivität", label: "Inaktiv nach (Tagen)", type: "number", min: 3, max: 365, help: "Ohne Nachricht und ohne Event-Teilnahme. Abgemeldete zählen nicht als inaktiv." },
  { key: "INACTIVITY_DM_ENABLED", group: "Abmeldungen & Aktivität", label: "Inaktive automatisch per DM erinnern", type: "bool", help: "Höchstens einmal pro Inaktivitätszeitraum und Person." },
  { key: "INACTIVITY_ALERT_ENABLED", group: "Abmeldungen & Aktivität", label: "Tägliche Inaktivitäts-Meldung an die Leitung", type: "bool", help: "Liste neu inaktiver Mitglieder im Abmeldungs-/Inaktivitäts-Log." },
  { key: "WELCOME_DM_ENABLED", group: "Abmeldungen & Aktivität", label: "Neue Spieler zusätzlich per DM begrüßen", type: "bool", help: "Text unter Panel-Texte → Willkommensnachricht." },
  { key: "WARN_DM_ENABLED", group: "Verwarnungen", label: "Verwarnte Person per DM informieren", type: "bool", help: "Grund und Anzahl aktiver Verwarnungen kommen als private Nachricht." },
  { key: "WARN_EXPIRE_DAYS", group: "Verwarnungen", label: "Verwarnungen verfallen nach (Tagen, 0 = nie)", type: "number", min: 0, max: 3650, help: "Abgelaufene Verwarnungen bleiben sichtbar, zählen aber nicht mehr als aktiv." },
  { key: "WARN_TIMEOUT_AT", group: "Verwarnungen", label: "Automatischer Timeout ab aktiven Verwarnungen (0 = aus)", type: "number", min: 0, max: 50, help: "Z. B. 3: ab der dritten aktiven Verwarnung wird die Person stummgeschaltet. Die Bot-Rolle muss über der Person stehen." },
  { key: "WARN_TIMEOUT_MINUTES", group: "Verwarnungen", label: "Timeout-Dauer (Minuten)", type: "number", min: 1, max: 40320 },
  { key: "WARN_ALERT_AT", group: "Verwarnungen", label: "Leitung benachrichtigen ab aktiven Verwarnungen (0 = aus)", type: "number", min: 0, max: 50, help: "Meldung mit Erwähnung der Leitungsrolle im Sanktions-Log." },
  { key: "TIMEZONE", group: "Events", label: "Zeitzone", type: "text", help: "IANA-Name, z. B. Europe/Vienna." },
  { key: "EVENT_REMINDER_MINUTES", group: "Events", label: "Erinnerungen (Minuten vorher)", type: "numberList", help: "Kommagetrennt, z. B. 60, 15. Leer = Standard." },
  { key: "EVENT_PING_ROLES", group: "Events", label: "Rollen bei Event-Ankündigung erwähnen", type: "roles", help: "Optional, z. B. Familienrolle. Leer = niemand wird erwähnt." },
  { key: "EVENT_MIN_PARTICIPANTS", group: "Events", label: "Mindestteilnehmer (Standard, 0 = aus)", type: "number", min: 0, max: 500, help: "Gilt für Events und Aktivitäten ohne eigene Mindestzahl. Eigene Werte setzt man beim Event bzw. bei der Aktivität." },
  { key: "EVENT_MIN_CHECK_MINUTES", group: "Events", label: "Mindestteilnehmer prüfen (Minuten vor Start)", type: "number", min: 5, max: 1440 },
  { key: "EVENT_MIN_AUTO_CANCEL", group: "Events", label: "Bei zu wenigen Anmeldungen automatisch absagen", type: "bool", help: "Aus = nur Meldung an das Event-Team. An = Event wird abgesagt und die Angemeldeten werden informiert." },
  { key: "NOSHOW_THRESHOLD", group: "Events", label: "No-Shows bis zur Reaktion (0 = aus)", type: "number", min: 0, max: 50, help: "Angemeldet, aber unentschuldigt nicht erschienen (nur bei Events mit erfasster Anwesenheit; Abgemeldete zählen nicht)." },
  { key: "NOSHOW_WINDOW_DAYS", group: "Events", label: "No-Shows zählen im Zeitraum (Tage)", type: "number", min: 1, max: 365 },
  { key: "NOSHOW_ACTION", group: "Events", label: "Reaktion auf No-Shows", type: "select", options: [["alert", "Meldung an die Leitung"], ["warn", "Automatische Verwarnung"], ["both", "Meldung und Verwarnung"]] },
  { key: "EVENT_SERIES_DELETE_ENDED", group: "Events", label: "Beendete Aktivitäts-Posts löschen", type: "bool", help: "Hält die Channels sauber: Posts automatischer Aktivitäten werden nach Ende gelöscht. Teilnahme bleibt gespeichert, Ergebnisse gehen weiter in den Ergebnis-Channel." },
  { key: "EVENT_SERIES_AUTO_END_MINUTES", group: "Events", label: "Aktivitäten automatisch beenden nach (Minuten)", type: "number", min: 15, max: 1440, help: "Automatisch erstellte Termine werden so lange nach Start geschlossen." },
  { key: "RANK_ROLE_ASSIGNMENT_ENABLED", group: "Anträge", label: "Rang-Rollen nach Annahme vergeben", type: "bool", help: "Nur Leitung, nur nach Bestätigung, mit Hierarchieprüfung." },
  { key: "RANK_ROLES_JSON", group: "Anträge", label: "Rang-Rollen (Rang-Historie, Profil, Vergabe)", type: "rankRoles", help: "Alle Rang-Rollen der Familie. Wechselt jemand die Rang-Rolle, wird das als Beförderung/Degradierung protokolliert (höhere Discord-Rolle = höherer Rang)." },
  { key: "APPLICATION_QUESTIONS_JSON", group: "Anträge", label: "Eigene Antragsfragen (JSON, optional)", type: "json", help: '{"rang":[{"id":"name","label":"Ingame-Name","style":"short"}]} – max. 5 Fragen, Beschriftung max. 45 Zeichen. {} = Standardfragen.' },
  { key: "AUTOMOD_ENABLED", group: "AutoMod", label: "AutoMod aktiv", type: "bool" },
  { key: "AUTOMOD_BLOCKED_TERMS", group: "AutoMod", label: "Gesperrte Begriffe", type: "list" },
  { key: "AUTOMOD_ALLOWED_DOMAINS", group: "AutoMod", label: "Erlaubte Link-Domains", type: "list" },
  { key: "AUTOMOD_SPAM_COUNT", group: "AutoMod", label: "Spam: Nachrichten", type: "number", min: 3, max: 50 },
  { key: "AUTOMOD_SPAM_WINDOW_SECONDS", group: "AutoMod", label: "Spam: Zeitfenster (Sekunden)", type: "number", min: 1, max: 600 },
  { key: "AUTOMOD_DUPLICATE_COUNT", group: "AutoMod", label: "Gleiche Nachricht: Anzahl", type: "number", min: 2, max: 50 },
  { key: "AUTOMOD_SPAM_ACTIONS", group: "AutoMod", label: "Aktionen bei Spam", type: "actions", options: ACTIONS },
  { key: "AUTOMOD_DUPLICATE_ACTIONS", group: "AutoMod", label: "Aktionen bei Wiederholung", type: "actions", options: ACTIONS },
  { key: "AUTOMOD_LINK_ACTIONS", group: "AutoMod", label: "Aktionen bei fremden Links", type: "actions", options: ACTIONS },
  { key: "AUTOMOD_TERM_ACTIONS", group: "AutoMod", label: "Aktionen bei gesperrten Begriffen", type: "actions", options: ACTIONS },
  { key: "AUTOMOD_TIMEOUT_MINUTES", group: "AutoMod", label: "Timeout-Dauer (Minuten)", type: "number", min: 1, max: 40320 },
  { key: "AUTOMOD_ESCALATION_COUNT", group: "AutoMod", label: "Eskalation nach Verstößen (0 = aus)", type: "number", min: 0, max: 50 },
  { key: "AUTOMOD_ESCALATION_WINDOW_MINUTES", group: "AutoMod", label: "Eskalations-Zeitfenster (Minuten)", type: "number", min: 1, max: 1440 },
  { key: "AUTOMOD_EXEMPT_ROLES", group: "AutoMod", label: "Ausgenommene Rollen", type: "roles" },
  { key: "AUTOMOD_EXEMPT_CHANNELS", group: "AutoMod", label: "Ausgenommene Channels", type: "channels" },
  { key: "RAID_JOIN_COUNT", group: "Raid-Schutz", label: "Beitritte bis Raid-Alarm", type: "number", min: 3, max: 500 },
  { key: "RAID_WINDOW_SECONDS", group: "Raid-Schutz", label: "Zeitfenster (Sekunden)", type: "number", min: 1, max: 3600 },
  { key: "RAID_ACTIONS", group: "Raid-Schutz", label: "Aktionen bei Raid", type: "actions", options: [["alert", "Staff-Meldung"], ["timeout", "Neue Mitglieder stummschalten"]] },
  { key: "RAID_TIMEOUT_MINUTES", group: "Raid-Schutz", label: "Raid-Timeout (Minuten)", type: "number", min: 1, max: 40320 },
  { key: "FLOOD_MESSAGE_COUNT", group: "Raid-Schutz", label: "Nachrichtenflut ab (0 = aus)", type: "number", min: 0, max: 10000 },
  { key: "FLOOD_WINDOW_SECONDS", group: "Raid-Schutz", label: "Flut-Zeitfenster (Sekunden)", type: "number", min: 1, max: 600 },
  { key: "AUDIT_CHANNEL_IGNORE_ACTIONS", group: "Logs & Panels", label: "Nicht in den Audit-Channel senden", type: "list" },
  { key: "STATS_CHANNEL_UPDATE_MINUTES", group: "Logs & Panels", label: "Statistik-Channel aktualisieren (Minuten, 0 = aus)", type: "number", min: 0, max: 10080 },
  { key: "DASHBOARD_PANEL_REFRESH_MINUTES", group: "Logs & Panels", label: "Discord-Panels aktualisieren (Minuten, 0 = aus)", type: "number", min: 0, max: 1440 },
];
export const SETTING_KEYS = new Set(SETTINGS.map(setting => setting.key));
const SNOWFLAKE = /^\d{17,20}$/;

/** Wandelt einen Wert aus der Website (typisiert) in das gespeicherte .env-Format um. */
export function toRaw(definition, value) {
  const list = v => (Array.isArray(v) ? v : String(v ?? "").split(",")).map(x => String(x).trim()).filter(Boolean);
  switch (definition.type) {
    case "roles": case "channels": {
      const ids = [...new Set(list(value))];
      if (!ids.every(id => SNOWFLAKE.test(id))) throw new Error(`${definition.label}: ungültige ID.`);
      return ids.join(",");
    }
    case "channel": case "category": case "forum": { const id = String(value ?? "").trim(); if (id && !SNOWFLAKE.test(id)) throw new Error(`${definition.label}: ungültige ID.`); return id; }
    case "number": { const n = Number(value); if (!Number.isInteger(n) || n < definition.min || n > definition.max) throw new Error(`${definition.label}: ganze Zahl von ${definition.min} bis ${definition.max}.`); return String(n); }
    case "money": {
      const text = String(value ?? "").trim().replace(/^\$/, "");
      if (!text) return "";
      const match = /^(\d{1,12})(?:[,.](\d{1,2}))?$/.exec(text);
      if (!match) throw new Error(`${definition.label}: Betrag wie 2500000 oder 12,50 angeben.`);
      return String(Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")));
    }
    case "bool": return value === true || value === "true" ? "true" : "false";
    case "list": case "actions": case "numberList": return list(value).join(",");
    case "text": return String(value ?? "").trim();
    case "select": { const v = String(value ?? ""); if (!definition.options.some(([key]) => key === v)) throw new Error(`${definition.label}: ungültige Auswahl.`); return v; }
    case "json": case "ticketCategories": case "rankRoles": {
      if (typeof value === "string") { try { JSON.parse(value || (definition.type === "json" ? "{}" : "[]")); } catch { throw new Error(`${definition.label}: ungültiges JSON.`); } return value.trim() || (definition.type === "json" ? "{}" : "[]"); }
      return JSON.stringify(value ?? (definition.type === "json" ? {} : []));
    }
    default: throw new Error("Unbekannter Einstellungstyp.");
  }
}

export function createSettingsService({ db, config, env, guildId }) {
  const stored = () => Object.fromEntries(db.prepare("SELECT key,value FROM guild_settings WHERE guild_id=?").all(guildId).filter(row => SETTING_KEYS.has(row.key)).map(row => [row.key, row.value]));
  let effectiveEnv = { ...env };

  /** Übernimmt gespeicherte Werte in die laufende Konfiguration; ungültige Werte werden übersprungen und gemeldet. */
  function apply() {
    const candidate = { ...env }, rejected = [];
    for (const [key, value] of Object.entries(stored())) {
      try { loadConfig({ ...candidate, [key]: value }); candidate[key] = value; }
      catch (error) { rejected.push(`${key}: ${error.message.replace(/^Ungültige Konfiguration: /, "")}`); }
    }
    const parsed = loadConfig(candidate);
    for (const key of SETTING_KEYS) config[key] = parsed[key];
    effectiveEnv = candidate;
    return { rejected };
  }

  function describe() {
    const overrides = stored();
    return SETTINGS.map(definition => ({
      ...definition, value: config[definition.key] ?? null,
      source: Object.hasOwn(overrides, definition.key) ? "website" : env[definition.key] != null && env[definition.key] !== "" ? "env" : "standard",
    }));
  }

  /** Speichert eine Einstellung nach vollständiger Validierung. actorRoleIds schützt vor Selbstaussperrung der Leitung. */
  function update({ key, value, actorId, actorRoleIds = [], actorIsOwner = false }) {
    const definition = SETTINGS.find(item => item.key === key);
    if (!definition) throw new Error("Diese Einstellung kann nicht über die Oberfläche geändert werden.");
    const raw = toRaw(definition, value);
    let parsed;
    try { parsed = loadConfig({ ...effectiveEnv, [key]: raw }); }
    catch (error) { throw new Error(error.message.replace(/^Ungültige Konfiguration: /, "Ungültiger Wert – ")); }
    if (key === "ROLE_LEADERS" && !actorIsOwner && !parsed.ROLE_LEADERS.some(id => actorRoleIds.includes(id))) throw new Error("Du würdest dich selbst aus der Leitung aussperren. Behalte mindestens eine deiner Rollen in der Liste.");
    const previous = effectiveEnv[key] ?? "";
    db.transaction(() => {
      db.prepare("INSERT INTO guild_settings(guild_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(guildId, key, raw, new Date().toISOString());
      audit(db, guildId, actorId, "config.changed", key, { setting: key, previous: String(previous).slice(0, 300), value: raw.slice(0, 300) });
    })();
    effectiveEnv = { ...effectiveEnv, [key]: raw };
    config[key] = parsed[key];
    return config[key];
  }

  /** Entfernt den Website-Wert; danach gilt wieder der Wert aus der .env bzw. der Standard. */
  function reset({ key, actorId, actorRoleIds = [], actorIsOwner = false }) {
    if (!SETTING_KEYS.has(key)) throw new Error("Unbekannte Einstellung.");
    const candidate = { ...effectiveEnv }; delete candidate[key];
    if (env[key] != null) candidate[key] = env[key];
    const parsed = loadConfig(candidate);
    if (key === "ROLE_LEADERS" && !actorIsOwner && !parsed.ROLE_LEADERS.some(id => actorRoleIds.includes(id))) throw new Error("Nach dem Zurücksetzen hättest du keine Leitungsrolle mehr.");
    db.transaction(() => {
      db.prepare("DELETE FROM guild_settings WHERE guild_id=? AND key=?").run(guildId, key);
      audit(db, guildId, actorId, "config.changed", key, { setting: key, previous: String(effectiveEnv[key] ?? "").slice(0, 300), value: "(.env/Standard)" });
    })();
    effectiveEnv = candidate;
    config[key] = parsed[key];
    return config[key];
  }

  return { apply, describe, update, reset };
}
