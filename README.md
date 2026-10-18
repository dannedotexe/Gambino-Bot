# Gambino Bot

All-in-One-Discord-Bot für die Gambinos-Familie (Grand-RP), gebaut mit discord.js 14 und SQLite (`better-sqlite3`). Secrets stehen nie im Repository: Produktivwerte gehören in die `.env` und die SQLite-Datei auf der Oracle-VM.

## Inhalt

- [Funktionen](#funktionen)
- [Familienkonto und Sanktionsverrechnung](#familienkonto-und-sanktionsverrechnung)
- [Rollen und Berechtigungen](#rollen-und-berechtigungen)
- [Einrichtung](#einrichtung)
- [Konfiguration](#konfiguration)
- [Oracle-VM: Betrieb und Aktualisierung](#oracle-vm-betrieb-und-aktualisierung)
- [Datenbank, Migrationen und Backups](#datenbank-migrationen-und-backups)
- [Tests](#tests)
- [Bekannte Grenzen](#bekannte-grenzen)

## Funktionen

| Bereich | Befehle / Bedienung | Kurzbeschreibung |
| --- | --- | --- |
| Tickets | `/ticket panel`, Auswahlmenü, Buttons *Übernehmen / Schließen / Wieder öffnen*, `/ticket uebernehmen \| schliessen \| wiedereroeffnen` | Private Channels je Ticket; Zugriff für Ersteller, Staff, Leitung und die zuständigen Rollen der Kategorie. Mehrere offene Tickets und schnelle Wiederholungen werden begrenzt. Vor dem Schließen kommt eine Bestätigung. Beim Schließen wird ein Transkript mit bis zu `TICKET_TRANSCRIPT_LIMIT` Nachrichten in der DB gespeichert und als `.txt` in den Ticket-Log gesendet; lässt sich der Verlauf nicht laden, bleibt das Ticket offen. Gelöschte Channels werden erkannt: Das Ticket wird geschlossen und protokolliert, die Daten bleiben erhalten. |
| Events | `/event erstellen \| bearbeiten \| liste \| historie \| teilnehmer \| anwesenheit \| beenden \| absagen`, Buttons *Teilnehmen / Abmelden* | Persistente Events mit Name, Beschreibung, Zeit, Treffpunkt, Veranstalter, Ausrüstung, Hinweisen und Teilnehmerlimit. Die Anmeldung läuft atomar, doppelte Klicks sind wirkungslos. Erinnerungen (`EVENT_REMINDER_MINUTES`) erwähnen die Angemeldeten und überstehen Neustarts. Bei einer Absage werden die Teilnehmenden benachrichtigt. Anwesenheit lässt sich auch ohne vorherige Anmeldung erfassen. |
| Mindestteilnehmer | Event-/Aktivitäts-Formular, `/event erstellen … mindestens`, Einstellung `EVENT_MIN_PARTICIPANTS` | `EVENT_MIN_CHECK_MINUTES` (Standard 30) Minuten vor Start prüft der Bot einmal, ob genug angemeldet sind. Sonst bekommt das Event-Team eine Meldung mit Rollen-Ping im Event-Log – oder das Event wird mit `EVENT_MIN_AUTO_CANCEL` automatisch abgesagt und die Angemeldeten werden informiert. Eigene Mindestzahl pro Event bzw. Aktivität, sonst der Standardwert (0 = aus). |
| Anwesenheit & No-Shows | Button „📋 Anwesenheit eintragen“ im Event-Log, Website *Events → Anwesenheit abschließen* | Verbindlich durch das Event-Team: Für jedes Event postet der Bot **bei Eventbeginn** in `CHANNEL_EVENT_CHECK` (Staff-Channel, sonst Event-Log) „Event vorbei? – wer war da?“ mit Button. Nicht Angemeldete, die trotzdem da waren, lassen sich über ➕ hinzufügen. „🚫 Nicht gespielt“ schließt das Event ohne Anwesenheit ab (keine No-Shows). Einzelne No-Shows lassen sich im Mitgliederprofil auf der Website entfernen. Im Auswahlmenü werden alle Angemeldeten angezeigt; man hakt ab, wer **wirklich da war** („Alle waren da“ als Abkürzung). Erst „Abschließen“ setzt alle anderen auf *nicht da*, beendet das Event und postet das Ergebnis. Danach **🏆 Win / ❌ Lose**: Bei Win gibt man den Betrag pro Person ein (z. B. `25000`, `25.000`, `25k`) – jeder Anwesende bekommt ihn als Gutschrift aufs Familienkonto, je Event genau einmal (Win nur Finanzen/Leitung/Voller Zugriff, Lose auch Event-Team). No-Shows zählen **nur** bei abgeschlossener Anwesenheit und nie während einer Abmeldung. Ab `NOSHOW_THRESHOLD` No-Shows in `NOSHOW_WINDOW_DAYS` Tagen reagiert der Bot (`NOSHOW_ACTION`: Meldung, Verwarnung oder beides). Offene Anwesenheiten erscheinen in der Website-Übersicht. |
| Event-Posts | automatisch | Die **Event-Karte** mit *Teilnehmen/Abmelden* steht in `CHANNEL_EVENT_SIGNUP` (z. B. event-anmeldung), eine **kurze Ankündigung** mit Button „Zur Anmeldung“ und optionalem Rollen-Ping (`EVENT_PING_ROLES`) in `CHANNEL_EVENT_ANNOUNCEMENTS`. Ohne Anmelde-Channel steht alles im Ankündigungs-Channel. Die Karte zeigt nur ausgefüllte Angaben, Erinnerungen kommen als Antwort auf die Karte und erwähnen nur Angemeldete. Nach Ende/Absage werden Karte und Ankündigung markiert; automatische Aktivitäts-Posts können danach gelöscht werden (`EVENT_SERIES_DELETE_ENDED`). Texte, Buttons und Farbe unter *Panel-Texte → Event-Karten & Ankündigungen* (Platzhalter `{name}` `{zeit}` `{uhrzeit}` `{relativ}` `{treffpunkt}`). Aufgeräumt: Von den Erinnerungen bleibt nur die neueste stehen, und sie verschwindet bei Eventbeginn. Beendete Aktivitäts-Posts werden gelöscht (`EVENT_SERIES_DELETE_ENDED`, Standard an). Die nächste Aktivität wird erst angekündigt, wenn das vorherige Event begonnen hat (außer sie beginnt in < 30 Minuten). |
| Staatliche Kontrolle | Website *Events → 🚩 Staatliche Kontrolle*, `/staatliche art familie [wann]` | Spontan, als Angriff („Wir greifen an“) oder Verteidigung („Wir werden angegriffen“): „Welche Familie“ und „Wann“ (`jetzt`, `in 20`, `16:30`). Der Bot kündigt sofort ein Event mit Anmeldung an; Anwesenheit im Event-Check und Win/Lose wie bei jedem Event. Für Event-Team (z. B. Turf Leader) und Leitung. |
| Wiederkehrende Aktivitäten | Website (Tab *Events*), `/aktivitaeten liste \| status \| board` | Die 13 Gambinos-Aktivitäten (Cayo Perico, Flugzeugträger, Gefängnis, Ladenraub, RP Fabrik, Banküberfall, Hotel, Waffenfabrik, Drogenlabor, Razzia, Gießerei, Bizwar, Kampf um die Rangfolge) sind vorangelegt und standardmäßig **inaktiv**. Für aktive Aktivitäten mit festen Zeiten legt der Bot jeden Termin automatisch als Event mit Anmeldung und Erinnerungen an: standardmäßig 120 Minuten vorher im Event-Channel, genau einmal je Termin, nach `EVENT_SERIES_AUTO_END_MINUTES` automatisch beendet. Flexible Aktivitäten (z. B. „alle 3 Stunden“) erscheinen nur auf der dauerhaften Aktivitäten-Übersicht. Zeiten gelten in `TIMEZONE`; Termine, die es wegen der Zeitumstellung nicht gibt, werden übersprungen. |
| Verifizierung | Panel mit Button *Verifizieren*, Website-Bereich *Mitglieder* | Für alle Spieler auf dem Discord (Chat-Zugang, keine Familienaufnahme): Sie geben Ingame-ID, Vor- und Nachnamen ein; der Discord-Name wird zu `Vorname Nachname \| ID` (max. 32 Zeichen, Namen werden geprüft und großgeschrieben). Eine Ingame-ID gehört nur einem Konto. Optional vergibt der Bot `ROLE_VERIFIED`. Gespeichert wird erst, wenn Discord den Namen übernommen hat; beim Server-Inhaber (von Discord gesperrt) bekommt die Person den Namen als Hinweis. Die Leitung kann eine Verifizierung auf der Website zurücksetzen. Benötigt die Bot-Berechtigung „Spitznamen verwalten“, und die Bot-Rolle muss über den Mitgliederrollen stehen. |
| Bewerbungen & Rang-Anträge | `/bewerbung-panel`, `/antrag bewerben \| liste \| kommentieren \| entscheiden \| status`, Reviewer-Buttons *Übernehmen / Annehmen / Ablehnen / Notiz* | Modal-Formulare mit konfigurierbaren Fragen. Status: offen → in Prüfung → angenommen/abgelehnt/zurückgezogen. Interne Notizen; Ablehnungen nur mit Grund. Antragsteller bekommen private Rückmeldungen. Pro Typ ist nur ein offener Antrag möglich, neue Einreichungen sind als solche gekennzeichnet. Rollen werden **nie** automatisch vergeben (siehe `RANK_ROLE_ASSIGNMENT_ENABLED`). |
| Familienkonto | `/konto stand \| ansehen \| anlegen \| gutschrift \| auszahlen \| korrektur \| liste \| historie`, „Mein Konto“-Panel | Siehe unten. Konten entstehen automatisch, wenn eine Familienbewerbung angenommen wird oder jemand die Familienmitglieder-Rolle bekommt (`ACCOUNT_AUTO_OPEN_FOR_MEMBERS`), sonst mit `/konto anlegen`, der Website oder der ersten Gutschrift. Die Verifizierung legt bewusst **kein** Konto an, sie ist nur der Chat-Zugang für alle Spieler. Im „Mein Konto“-Panel (`CHANNEL_ACCOUNT_PANEL`) sehen Familienmitglieder privat ihr Guthaben, ihre Buchungen und ihre offenen Sanktionen. Auf der Website erscheinen verifizierte Mitglieder als `Vorname Nachname \| ID`. Verliert jemand die Familienrolle oder verlässt den Server, erscheint im Familienkonto-Tab eine **Löschanfrage**: „Löschung bestätigen“ (Finanzrolle/Leitung) löscht das Konto, bucht Restguthaben als Korrektur aus und hebt offene Sanktionen auf – die Historie bleibt. „Konto behalten“ schließt die Anfrage; bekommt jemand die Rolle zurück, verschwindet sie automatisch. |
| Sanktionen | `/sanktion erstellen \| verwarnung \| offen \| historie \| korrigieren \| aufheben \| rueckerstatten` | Offene Auszahlungsabzüge mit Status, Historie und Rückerstattung. Verwarnungen ohne Geldwirkung. |
| Verwarnungen | `/warn @mitglied grund [fall]`, `/warnings [@mitglied]`, `/unwarn @mitglied grund [warnung]`, Website-Tab *Sanktionen* | Verwarnungen ohne Geldwirkung. Die Person bekommt Grund und Anzahl aktiver Verwarnungen per DM (`WARN_DM_ENABLED`). Jeder sieht mit `/warnings` die eigenen, die Moderation alle. Rücknahmen löschen nichts: Die Verwarnung bleibt in der Historie, zählt aber nicht mehr. Optional verfallen Verwarnungen nach `WARN_EXPIRE_DAYS` Tagen. Eskalation (standardmäßig aus): automatischer Timeout ab `WARN_TIMEOUT_AT` aktiven Verwarnungen für `WARN_TIMEOUT_MINUTES` Minuten und Meldung mit Leitungs-Ping im Sanktions-Log ab `WARN_ALERT_AT`. Niemand kann sich selbst oder Bots verwarnen; Teammitglieder verwarnt nur die Leitung. Reine Moderationsrollen nehmen nur eigene Verwarnungen zurück. |
| Abmeldungen | `/abwesend melden \| beenden \| liste`, Panel *Abmelden / Wieder da* (`CHANNEL_ABSENCES`), Website *Aktivität* | Mitglieder melden sich mit Zeitraum (`heute`, `morgen`, `20.10.`, `20.10.2026`) und Grund ab, höchstens `ABSENCE_MAX_DAYS` Tage. Öffentlich erscheint nur der Zeitraum (Grund nur mit `ABSENCE_SHOW_REASON`). Abgemeldete zählen nicht als inaktiv; wer bei einem Event als abwesend markiert wird, gilt dann als **entschuldigt**. Optional bekommt man während der Abmeldung die Rolle `ROLE_ABSENT`. Staff kann auf der Website Abmeldungen eintragen und beenden. |
| Inaktivität | Website *Aktivität*, optional täglich automatisch | Liste aller Familienmitglieder (`ROLE_MEMBERS`, sonst alle mit Familienkonto) ohne Nachricht und ohne Event-Teilnahme seit `INACTIVITY_DAYS` Tagen. Gespeichert wird nur der Zeitpunkt der letzten Nachricht, nie der Inhalt; gezählt wird ab dem ersten Start dieser Version. Optional DM-Erinnerung (`INACTIVITY_DM_ENABLED`) und tägliche Meldung an die Leitung (`INACTIVITY_ALERT_ENABLED`, in `CHANNEL_ACTIVITY_LOG`). Einzelne Erinnerungen auch per Button. |
| Mitgliederprofil | Website: Klick auf einen Namen oder *Mitglieder → Profil öffnen* | Alles zu einer Person: Verifizierung, Rang, Rollen, Konto, Sanktionen, Verwarnungen, Moderation, Event-Teilnahmen, Abmeldungen, Anträge und Tickets. Jeder Abschnitt erscheint nur mit dem passenden Recht (z. B. Finanzen nur mit Finanzrolle). |
| Rangliste | `/rangliste [zeitraum]`, Panel in `CHANNEL_LEADERBOARD`, Website *Aktivität* | Aktivste Mitglieder nach Event-Teilnahmen für Woche (ab Montag) und Monat. Es zählen „anwesend“ sowie „angemeldet“ bei bereits begonnenen Events, nicht aber Abwesende und abgesagte Events. Das Panel aktualisiert sich automatisch. |
| Moderation | `/timeout` `/untimeout` (Moderation), `/kick` (Staff), `/ban` `/unban` (Leitung) | Immer mit Grund. Die Person bekommt vorher eine DM. Kick und Bann brauchen eine Bestätigung per Button (2 Minuten gültig, nur für die auslösende Person). Selbst-Moderation, Bots und Team-Mitglieder (außer durch die Leitung) sind gesperrt; die Rollen-Hierarchie wird geprüft. Jede Maßnahme landet unveränderlich in der Mitgliederhistorie und im Sanktions-Log. |
| Willkommen | automatisch in `CHANNEL_WELCOME` | Begrüßt neue Spieler mit Erwähnung, Hinweis und Button zur Verifizierung; optional per DM (`WELCOME_DM_ENABLED`). Texte unter *Panel-Texte → Willkommensnachricht* (Platzhalter `{user}` `{name}` `{server}` `{mitglieder}` `{verifizierung}`). |
| Status-Seite | Website *Status* | Discord-Verbindung, letztes Update (Version und Zeitpunkt), letztes Backup, Hintergrund-Aufgaben, Datenbankgröße, fehlgeschlagene Log-Zustellungen und offene Konfigurationshinweise. |
| Testdaten zurücksetzen | Website *Einstellungen → Gefahrenzone* (nur Leitung) | Löscht wählbar Konten, Buchungen, Auszahlungen, Sanktionen, Verwarnungen, Moderation, Tickets, Anträge, Events, Giveaways, Abmeldungen, Statistik und Protokoll (Verifizierungen nur auf Wunsch). Channels, Rollen, Panel-Texte, Panels und Aktivitäten-Vorlagen bleiben. Vorher wird automatisch ein Backup `gambino-vor-reset-….sqlite` angelegt; zur Bestätigung muss `ZURÜCKSETZEN` eingetippt werden. Nachrichten in Discord (alte Event-Karten, Ticket-Channels) werden nicht gelöscht. |
| Abstimmungen | `/umfrage erstellen \| beenden`, Website *Abstimmungen* | Frage mit 2–10 Antworten als Buttons in `CHANNEL_POLLS` (oder gewähltem Channel). Eine Stimme pro Person, bis zum Ende änderbar oder zurückziehbar. Optional anonym (niemand sieht, wer was gewählt hat), Zwischenstand verdeckt oder nur für eine Rolle. Läuft 5 Minuten bis 30 Tage; am Ende werden die Buttons entfernt und das Ergebnis automatisch gepostet. |
| Excel-Export | Website: Buttons „Excel …“ in Familienkonto, Sanktionen, Events, Mitglieder, Aktivität, Abstimmungen | Echte .xlsx-Dateien (ohne Zusatzbibliothek erzeugt): Kontostände, Buchungen, Sanktionen, Verwarnungen, Event-Teilnahmen, Mitglieder, Abmeldungen, Abstimmungsergebnisse. Discord-IDs als Text (keine 6,27E+17), Beträge als Zahlen im $-Format, Datum als Excel-Datum in Server-Zeit, Kopfzeile mit Filter und fixiert, passende Spaltenbreiten. Texte werden nie als Formel ausgeführt. Nur mit passendem Recht; jeder Export wird protokolliert. |
| Ankündigungen | Website *Ankündigungen* | Text und/oder Karte (Titel, Beschreibung, Farbe, Fußzeile, Bild-Link) mit Live-Vorschau schreiben und sofort oder geplant (bis 60 Tage, Server-Zeitzone) in einen beliebigen Channel posten, Standard `CHANNEL_ANNOUNCEMENTS`. Erwähnt werden nur ausgewählte Rollen (max. 5); @everyone nur durch die Leitung. Geplante Posts gehen genau einmal raus und lassen sich abbrechen; frühere Ankündigungen dienen als Vorlage. |
| Öffentliche Sanktionsliste | automatisch in `CHANNEL_SANCTION_LIST` | Offene Sanktionen je Mitglied, höchster Betrag zuerst. Beträge (`SANCTION_LIST_SHOW_AMOUNTS`) und Gründe (`SANCTION_LIST_SHOW_REASONS`) lassen sich ausblenden. Niemand wird angepingt; das Panel aktualisiert sich automatisch. Texte unter *Panel-Texte → Öffentliche Sanktionsliste*. |
| Wochenbericht | automatisch montags in `CHANNEL_WEEKLY_REPORT` | Zusammenfassung der Vorwoche (Mo–So): Events und Teilnahmen, Aktivste, Beitritte/Austritte, Verifizierungen, Bewerbungen, Beförderungen, Abmeldungen, Inaktive, Sanktionen, Verwarnungen, Moderation, Familienkonto und Tickets. Ab `WEEKLY_REPORT_HOUR` Uhr, genau einmal pro Woche; auf der Status-Seite auch „jetzt senden“. Enthält Finanzzahlen – nur in einen Leitungs-Channel legen. |
| Rang-Historie | automatisch + Website-Profil | Wechselt jemand die Rang-Rolle (`RANK_ROLES_JSON`), wird eine Beförderung oder Degradierung gespeichert (höhere Discord-Rolle = höherer Rang), inkl. wer es war und Grund aus dem Discord-Audit-Log, falls der Bot es lesen darf. Die Leitung kann Ränge ohne Discord-Rolle im Profil eintragen. Die Historie ist unveränderlich. |
| Giveaways | `/giveaway erstellen \| abbrechen`, Buttons *Teilnehmen / Abmelden* | Preis, Dauer, Gewinnerzahl, Bedingungen und optional eine Pflichtrolle. Teilnahmen werden gespeichert; die Ziehung läuft auch nach einem Neustart genau einmal. |
| Staff-Dashboard (Discord) | `/dashboard panel`, `/dashboard ansicht [bereich]` | Dauerhaftes Panel mit Zählwerten (aktualisiert sich automatisch und funktioniert nach Neustarts weiter) und privaten Detailansichten: Tickets, Anträge, Events, Sanktionen, Auszahlungen, letzte Aktionen, Statistik. Jede Ansicht prüft serverseitig die Rolle. |
| Statistik | `/statistik [zeitraum]`, optional `CHANNEL_STATS` | Mitglieder-Zu-/Abgänge, Tickets, Events/Teilnahmen, Anträge, Sanktionen, Giveaways, AutoMod und Staff-Aktivität für 7/30/90/365 Tage oder den Gesamtzeitraum. Finanzwerte nur mit Finanzrechten, im Statistik-Channel nie. |
| AutoMod & Raid-Schutz | `/automod status \| sync` | Spam, wiederholte Nachrichten, Begriffe, Links; Aktionen je Regel konfigurierbar (Hinweis/Löschen/Timeout/Staff-Meldung), optionale Eskalation. Erkennt Join-Raids und Nachrichtenfluten. Native Discord-AutoMod-Regel für gesperrte Begriffe per `/automod sync`. |
| Einstellungen | `/einstellungen anzeigen \| kanal` | Prüft die Konfiguration und setzt Funktions-Channels; jede Änderung wird protokolliert. |
| Webdashboard (optional) | HTTPS + Discord-OAuth | Siehe [Staff-Webdashboard](#staff-webdashboard-optional). |

Alle relevanten Aktionen landen in `audit_logs` (Actor, Ziel, Aktion, Details, Zeit) und werden asynchron in `CHANNEL_AUDIT_LOG` gespiegelt. Schlägt das Senden in den Log-Channel fehl, wird die Hauptaktion dadurch nie wiederholt.

## Familienkonto und Sanktionsverrechnung

**Fachliche Bedeutung:** Das Gambinos-Familienguthaben (`accounts.balance_cents`) ist der Betrag, den die Familie einem Mitglied für Grand-RP-Events oder Familienaktivitäten schuldet und noch nicht ausgezahlt hat. Es ist keine Discord-Spielwährung und wird mit keiner Community-Economy verrechnet. Alle Beträge sind Ganzzahlen in Cent; Eingaben erfolgen in Dollar, z. B. `2500000` oder `12,50`.

| Feld | Bedeutung |
| --- | --- |
| `transactions.type` | `credit`, `correction_credit`, `sanction_refund` erhöhen das Guthaben; `payout`, `correction_debit` verringern es |
| `transactions.gross_cents` | Bei Auszahlung: vom Familienguthaben abgebuchter Bruttobetrag (= gesamter Kontostand) |
| `transactions.deduction_cents` | Bei dieser Auszahlung verrechnete Sanktionen |
| `transactions.net_cents` | Tatsächlich an das Mitglied auszuzahlender Betrag (Brutto − Abzug) |
| `sanctions.amount_cents` / `remaining_cents` | Festgesetzter Sanktionsbetrag / davon noch offen |
| `sanctions.status` | `open` (nichts verrechnet), `partial` (teilweise), `paid` (vollständig beglichen), `void` (aufgehoben) |
| `payout_allocations` | Je verrechnetem Teilbetrag: Auszahlungs-ID, Sanktions-ID, Betrag |
| `sanction_changes` | Historie: erstellt, verrechnet, korrigiert, aufgehoben, erstattet, jeweils mit Person und Grund |

Ablauf einer Auszahlung (`/konto auszahlen`):

1. Eine Sanktion belastet das Guthaben bei ihrer Erstellung nicht. Sie bleibt als offener Abzug mit eindeutiger ID stehen.
2. Die Vorschau zeigt Brutto, offene Sanktionen, den jetzt verrechneten Betrag, die tatsächliche Auszahlung und die verbleibenden Sanktionen. Wird das gesamte Guthaben durch Sanktionen aufgebraucht, bestätigt man ausdrücklich eine Verrechnung ohne Auszahlung (netto 0).
3. Nach der Bestätigung läuft alles in **einer** SQLite-Transaktion: Abgleich mit der Vorschau (hat sich etwas geändert, wird nichts gebucht), Guthaben auf 0, Sanktionen in der Reihenfolge ihrer Erstellung (FIFO) bis höchstens zum Bruttobetrag verrechnen, Allocations anlegen, Sanktionsstatus setzen, eine Transaktion und die Audit-Einträge schreiben. Bei einem Fehler wird alles zurückgerollt, und der fehlgeschlagene Versuch wird als `finance.failed` protokolliert.
4. Idempotenz: Die ID der Vorschau-Interaktion ist der eindeutige Buchungsschlüssel. Doppelklicks, Discord-Retries oder parallele Klicks führen zu genau einer Buchung; ein erneuter Klick zeigt nur die bestehende Buchung an.
5. Eine Sanktion kann insgesamt nie mehr als ihren offenen Rest abgezogen bekommen. Aufgehobene oder beglichene Sanktionen werden nie erneut verrechnet. Wurde bereits etwas verrechnet, ist nur noch eine Rückerstattung möglich (Gutschrift plus Aufhebung, mit Grund).
6. Transaktionen, Allocations, Erstattungen, Sanktionsänderungen und Audit-Logs sind per Datenbank-Trigger unveränderlich und lassen sich nicht löschen.

## Channels und ihre Funktionen

Jede Funktion hat einen eigenen, einstellbaren Channel (Website → *Einstellungen* → *Channels* oder `/einstellungen kanal`). Empfohlene Zuordnung zum Gambinos-Layout:

| Funktion | Einstellung | Empfohlen | Sichtbarkeit |
| --- | --- | --- | --- |
| Verifizierungs-Panel (automatisch gepostet) | `CHANNEL_VERIFICATION_PANEL` | INFORMATION・neue-spieler | öffentlich |
| Ticket-Panel (automatisch gepostet) | `CHANNEL_TICKET_PANEL` | SUPPORT・ticket | öffentlich |
| Geschlossene Tickets | `CHANNEL_TICKET_CLOSED_CATEGORY` | Kategorie closed tickets | Staff |
| Private Ticket-Channels | `CHANNEL_TICKET_CATEGORY` | Kategorie SUPPORT | Tickets privat |
| Ticket-Log + Transkripte | `CHANNEL_TICKET_LOG` | STAFF・ticket-logs | Staff |
| Bewerbungs-Panel (automatisch gepostet) | `CHANNEL_APPLICATION_PANEL` | SUPPORT・bewerbungen | öffentlich |
| Bewerbungen prüfen | `CHANNEL_APPLICATION_REVIEW` | STAFF・bewerbungen | Staff |
| Rang-Anträge prüfen | `CHANNEL_RANK_REVIEW` | STAFF・rang-anträge | Staff |
| Event-Ankündigung (kurz, mit Link) | `CHANNEL_EVENT_ANNOUNCEMENTS` | EVENTS・event-ankündigungen | öffentlich |
| Event-Karte mit Anmeldung + Erinnerungen | `CHANNEL_EVENT_SIGNUP` | EVENTS・event-anmeldung | öffentlich |
| „Mein Konto“-Panel | `CHANNEL_ACCOUNT_PANEL` | Familie・konto (neu anlegen) | Familie |
| Aktivitäten-Übersicht (automatisch) | `CHANNEL_ACTIVITY_BOARD` | EVENTS・event-infos | öffentlich |
| Event-Ergebnisse beim Beenden | `CHANNEL_EVENT_RESULTS` | EVENTS・event-ergebnisse | öffentlich |
| Event-Protokoll | `CHANNEL_EVENT_LOG` | EVENTS・event-logs | beliebig |
| Giveaways | `CHANNEL_GIVEAWAYS` | COMMUNITY・giveaway | öffentlich |
| Staff-Dashboard-Panel (automatisch) | `CHANNEL_STAFF_DASHBOARD` | STAFF・staff-dashboard | Staff |
| Sanktions-Protokoll | `CHANNEL_SANCTION_LOG` | STAFF・sanktions-logs | Staff |
| Gutschriften/Auszahlungen | `CHANNEL_FINANCE_LOG` | STAFF・auszahlungen | Staff |
| Statistik (ohne Finanzen) | `CHANNEL_STATS` | STAFF・server-statistik | beliebig |
| Übriges Audit-Log | `CHANNEL_AUDIT_LOG` | STAFF・bot-logs (neu anlegen) | Staff |
| AutoMod-/Raid-Meldungen | `CHANNEL_AUTOMOD_LOG` | STAFF・bot-logs | Staff |

Audit-Einträge werden nach Bereich verteilt: Sanktionen ins Sanktions-Log, Finanzen ins Auszahlungs-Log, Events ins Event-Log, alles andere ins Audit-Log. Ist ein Bereichs-Channel leer, landet der Eintrag im Audit-Log. Panels werden in ihrem Channel automatisch genau einmal gepostet und aktualisiert; nach einem Channel-Wechsel wird das alte Panel entfernt. Ohne eigene Funktion bleiben `willkommen`, `regeln`, `sanktionsliste`, `ankündigungen`, `neue-spieler`, `chat`, `abstimmungen`, `marktplatz`, `kleidung` und `abmeldungen` (manuelle Inhalte).

**Panel-Texte:** Website → *Einstellungen* → „Texte der Discord-Panels bearbeiten“. Für Bewerbungs-Panel, Ticket-Panel, Aktivitäten-Übersicht und Staff-Dashboard lassen sich Kopfzeile, Titel, Beschreibung, Felder, Fußzeile, Button-/Menütexte und Farbe einzeln ändern, mit Live-Vorschau. Die Texte werden geprüft (Discord-Längen, leere Pflichtfelder), gespeichert und die gepostete Nachricht wird sofort aktualisiert. Die Funktion der Buttons bleibt unverändert. Ein früher per Befehl gepostetes Panel des Bots wird im eingestellten Channel automatisch übernommen statt doppelt gepostet. `/bewerbung-panel` und `/ticket panel` stellen den Channel automatisch ein, wenn noch keiner gesetzt ist.

**Live-Prüfung:** Website → *Einstellungen* → „Jetzt prüfen“ oder `/einstellungen pruefen`. Der Bot prüft für jede Funktion, ob der Channel existiert und den richtigen Typ hat, ob er die nötigen Rechte hat, ob Staff-Channels für @everyone unsichtbar und öffentliche für Mitglieder sichtbar sind und ob der Name zur Funktion passt. Außerdem prüft er die nötigen Server-Rechte. Dabei wird nichts verändert.

## Rollen und Berechtigungen

Alle Berechtigungen hängen an Discord-Rollen-IDs aus der `.env`. Jede Aktion wird serverseitig geprüft, egal ob der Button für alle sichtbar ist. Leere Rollenlisten verweigern die Aktion sicher.

| Gruppe | Variablen | Darf |
| --- | --- | --- |
| Bot-Owner | `BOT_OWNER_IDS` | alles, zusätzlich die **Verwaltung** auf der Website (Status, Einstellungen, Panel-Texte, Channel-Prüfung, Testdaten-Reset, Wochenbericht sofort senden) – die sieht sonst niemand |
| Leitung | `ROLE_LEADERS` | alles unten, zusätzlich Korrekturbuchungen, Sanktionen korrigieren/aufheben/erstatten, AutoMod-Sync, Rang-Rollen vergeben |
| Voller Zugriff | `ROLE_FULL_ACCESS` | wie Leitung (z. B. „ab Rang 8“: Rang 8 und alle höheren Rang-Rollen anhaken), ohne Verwaltung |
| Familienmitglied | `ROLE_MEMBERS` (+ `DASHBOARD_MEMBER_AREA`, Standard an) | nur **Mein Bereich** auf der Website: eigenes Guthaben und Buchungen, eigene Sanktionen und Verwarnungen, eigene Events und No-Shows, Rang und Rang-Historie, Abmeldung eintragen/beenden, Rangliste. Keine Daten anderer Mitglieder (außer Namen in der Rangliste). |
| Staff | `ROLE_STAFF` (+ Leitung) | Tickets, Sanktionen und Verwarnungen erstellen, Giveaways, Dashboard-Panel |
| Moderation | `ROLE_MODERATORS` (+ Staff, Leitung) | `/warn`, `/warnings @mitglied`, `/unwarn` (nur eigene Verwarnungen), Sanktionen-Tab der Website ansehen |
| Finanzen | `ROLE_FINANCE` (+ Leitung) | Gutschriften, Auszahlungen, Auszahlungsliste, fremde Konten |
| Finanz-Einsicht | `ROLE_FINANCE_VIEWERS` (+ Finanzen) | nur ansehen: fremde Konten, Auszahlungsliste, Finanzstatistik |
| Reviewer | `ROLE_REVIEWERS` (+ Leitung) | Anträge übernehmen, kommentieren, entscheiden |
| Event-Team | `ROLE_EVENT_TEAM` (+ Leitung) | Events verwalten, Anwesenheit |
| Mitglieder | `ROLE_MEMBERS` | Wenn gesetzt: nur Mitglieder (oder Staff) können sich für Events anmelden und Rang-Anträge stellen |
| Ticket-Kategorie | `roleIds` in `TICKET_CATEGORIES_JSON` | Tickets dieser Kategorie sehen, übernehmen, schließen und wieder öffnen |

`BOT_OWNER_IDS` ist ein eng begrenzter Admin-Override: Ohne passende Rolle wird die Aktion erlaubt, aber als `admin.override` protokolliert. Ist `DISCORD_GUILD_ID` gesetzt, lehnt der Bot Interaktionen aus anderen Servern ab.

## Einrichtung

1. **Discord Developer Portal:** Bot anlegen und unter *Bot → Privileged Gateway Intents* **Server Members Intent** (Join-Raid-Schutz, Mitgliederstatistik) und **Message Content Intent** (Ticket-Transkripte, AutoMod) aktivieren.
2. **Bot-Berechtigungen** (keine Administrator-Rechte vergeben): Kanäle ansehen, Nachrichten senden, Nachrichtenverlauf lesen, Dateien anhängen, Links einbetten, Kanäle verwalten (Ticket-Channels), Nachrichten verwalten (AutoMod-Löschung), Mitglieder moderieren (nur bei Timeout-Aktionen), Server verwalten (nur für `/automod sync`), Rollen verwalten (nur bei `RANK_ROLE_ASSIGNMENT_ENABLED=true`; die Bot-Rolle muss über den Rang-Rollen stehen).
3. `.env.example` nach `.env` kopieren und `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` sowie die echten Rollen- und Channel-IDs eintragen (Entwicklermodus in Discord → Rechtsklick → *ID kopieren*). Das Token gehört nur in die `.env` auf dem Server und nie in einen Chat.
4. Abhängigkeiten installieren, prüfen, Commands registrieren, starten:

   ```sh
   npm install
   npm test
   npm run deploy-commands
   npm start
   ```

Beim Start wird die Konfiguration validiert: Fehlen notwendige Werte oder sind sie ungültig, bricht der Start mit einer verständlichen Meldung ab. Fehlende optionale Werte erscheinen als `Konfigurationshinweis` im Log und unter `/einstellungen anzeigen`.

**Slash-Commands:** `npm run deploy-commands` ersetzt die Command-Liste der Anwendung. Mit `DISCORD_GUILD_ID` werden die Commands nur für diesen Server registriert und sind sofort verfügbar; ohne sie global (das kann bis zu einer Stunde dauern). Der Bot registriert beim Start selbst nichts, deshalb gibt es keine doppelten Registrierungen.

## Konfiguration

**Fast alles lässt sich über die Website einstellen** (Tab *Einstellungen*, nur Bot-Owner). Die Werte werden in der Datenbank gespeichert, mit derselben Prüfung wie beim Start validiert und gelten sofort ohne Neustart. Jede Änderung landet als `config.changed` im Protokoll. Die `.env` liefert nur die Startwerte; mit „Zurücksetzen“ gilt wieder der `.env`-Wert. Ein ungültiger gespeicherter Wert wird beim Start übersprungen und gemeldet. Die Leitung kann sich nicht selbst aussperren (eine eigene Rolle muss in `ROLE_LEADERS` bleiben).

Aus Sicherheitsgründen **nur in der `.env`** und nicht über die Website änderbar: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `BOT_OWNER_IDS`, `DATABASE_PATH` sowie alle `DASHBOARD_*`-Werte und `DISCORD_CLIENT_SECRET`. Website-Einstellungen setzen `DISCORD_GUILD_ID` voraus.


Vollständige Liste mit Kommentaren: [`.env.example`](.env.example). Die wichtigsten Gruppen:

- **Pflicht:** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`. Dringend empfohlen: `DISCORD_GUILD_ID`.
- **Rollen:** `ROLE_LEADERS`, `ROLE_FULL_ACCESS`, `ROLE_STAFF`, `ROLE_FINANCE`, `ROLE_FINANCE_VIEWERS`, `ROLE_MODERATORS`, `ROLE_REVIEWERS`, `ROLE_EVENT_TEAM`, `ROLE_MEMBERS`, `BOT_OWNER_IDS`; jeweils kommaseparierte IDs.
- **Channels:** `CHANNEL_TICKET_CATEGORY` (Kategorie), `CHANNEL_TICKET_LOG`, `CHANNEL_APPLICATION_REVIEW`, `CHANNEL_RANK_REVIEW`, `CHANNEL_EVENT_ANNOUNCEMENTS`, `CHANNEL_AUDIT_LOG`, `CHANNEL_AUTOMOD_LOG`, `CHANNEL_STATS`. Alternativ lassen sie sich mit `/einstellungen kanal` setzen; das wird in der Datenbank gespeichert und hat Vorrang vor der `.env`.
- **Tickets:** `TICKET_CATEGORIES_JSON`, `TICKET_COOLDOWN_SECONDS`, `TICKET_MAX_OPEN_PER_USER`, `TICKET_TRANSCRIPT_LIMIT`.
- **Events:** `EVENT_MIN_PARTICIPANTS`, `EVENT_MIN_CHECK_MINUTES`, `EVENT_MIN_AUTO_CANCEL`, `NOSHOW_THRESHOLD`, `NOSHOW_WINDOW_DAYS`, `NOSHOW_ACTION`, `TIMEZONE` (Standard `Europe/Vienna`; Datumseingaben wie `31.12.2026 19:00` gelten in dieser Zone, gespeichert wird UTC), `EVENT_REMINDER_MINUTES`.
- **Anträge:** `APPLICATION_QUESTIONS_JSON`, `RANK_ROLE_ASSIGNMENT_ENABLED`, `RANK_ROLES_JSON`.
- **Abmeldungen & Aktivität:** `ROLE_ABSENT`, `CHANNEL_ABSENCES`, `CHANNEL_ACTIVITY_LOG`, `ABSENCE_MAX_DAYS`, `ABSENCE_SHOW_REASON`, `INACTIVITY_DAYS`, `INACTIVITY_DM_ENABLED`, `INACTIVITY_ALERT_ENABLED`.
- **Ankündigungen, Sanktionsliste, Wochenbericht:** `CHANNEL_ANNOUNCEMENTS`, `CHANNEL_SANCTION_LIST`, `SANCTION_LIST_SHOW_AMOUNTS`, `SANCTION_LIST_SHOW_REASONS`, `CHANNEL_WEEKLY_REPORT`, `WEEKLY_REPORT_HOUR`.
- **Willkommen & Rangliste:** `CHANNEL_WELCOME`, `WELCOME_DM_ENABLED`, `CHANNEL_LEADERBOARD`.
- **Verwarnungen:** `WARN_DM_ENABLED` (Standard `true`), `WARN_EXPIRE_DAYS`, `WARN_TIMEOUT_AT`, `WARN_TIMEOUT_MINUTES`, `WARN_ALERT_AT` (0 = aus). Auch auf der Website unter *Einstellungen → Verwarnungen*.
- **Konto:** `PAYOUT_MINIMUM_CENTS`; leer bedeutet, alle Kontostände werden ohne Grenzwert angezeigt.
- **AutoMod/Raid:** `AUTOMOD_*`, `RAID_*`, `FLOOD_*`. Die Standardwerte sind bewusst zurückhaltend: Der Bot-AutoMod ist aus, Raids erzeugen nur eine Staff-Meldung, Timeouts gibt es nur, wenn sie ausdrücklich konfiguriert sind. Ausgenommen sind Mitglieder mit „Nachrichten verwalten“, alle Staff-Rollen sowie `AUTOMOD_EXEMPT_ROLES`/`AUTOMOD_EXEMPT_CHANNELS`. Nachrichteninhalte werden nicht gespeichert.
- **Logs:** `AUDIT_CHANNEL_IGNORE_ACTIONS` hält häufige Ereignisse (Event-/Giveaway-Teilnahmen) aus dem Audit-Channel heraus; in der Datenbank bleiben sie trotzdem.

### Staff-Webdashboard (optional)

Aufbau: Navigation in Gruppen mit Zählern für offene Arbeit (am Handy über das Menü-Symbol), Übersicht mit „Zu erledigen“, Schnellaktionen und anklickbaren Kennzahlen, Ladebalken und automatische Aktualisierung jede Minute.

Responsive Staff-Website mit Discord-Login. Man kann dort alles nicht nur ansehen, sondern auch bearbeiten. Jeder Tab erscheint nur mit passender Rolle; jede Aktion prüft serverseitig die aktuelle Discord-Rolle, nutzt dieselben Services wie der Bot und wird protokolliert.

| Tab | Möglichkeiten |
| --- | --- |
| Übersicht | Kennzahlen, kommende Events, offene Anträge, letzte Aktionen |
| Anträge | übernehmen, annehmen, mit Begründung ablehnen, interne Notizen, Rang-Rolle vergeben (Leitung, wenn aktiviert), abgeschlossene Anträge |
| Tickets | übernehmen, schließen (Transkript), wieder öffnen, Transkript lesen; Kategorie-Rollen sehen nur ihre Tickets |
| Events | anlegen, bearbeiten (Discord-Ankündigung wird aktualisiert), Anwesenheit dokumentieren/nachtragen, beenden, absagen, Historie |
| Familienkonto | Brutto/Sanktionen/Netto je Mitglied, Gutschrift, Auszahlung mit Vorschau und Bestätigung, Korrektur (Leitung), Buchungs- und Sanktionsdetails |
| Sanktionen | Sanktion oder Verwarnung eintragen, korrigieren, aufheben, erstatten (Leitung) |
| Giveaways | starten (Channel und optionale Pflichtrolle wählen), vorzeitig auslosen, abbrechen, Gewinner ansehen |
| Statistik | alle Auswertungen nach Zeitraum, Finanzteil nur mit Finanzrechten |
| Protokoll | Audit-Log mit Bereichsfilter; Finanzeinträge nur mit Finanzrechten |
| Einstellungen (Leitung) | alle Rollen, Channels, Ticket-Kategorien inkl. zuständiger Rollen, Mindestbetrag, Zeitzone, Erinnerungen, Rang-Rollen, Antragsfragen, AutoMod, Raid-Schutz und Panels. Gilt sofort, wird protokolliert und lässt sich auf den `.env`-Wert zurücksetzen |

Statt IDs zeigt die Website Namen an, und Mitglieder werden über eine Suche ausgewählt. Gutschriften, Auszahlungen, Korrekturen und Erstattungen tragen eine eindeutige Anfrage-ID: Ein Doppelklick bucht nie doppelt, und eine veraltete Auszahlungsvorschau wird abgelehnt.

**Aktivieren:** `DASHBOARD_ENABLED=true`, `DASHBOARD_PUBLIC_URL` (HTTPS, eine Domain oder die IP der VM, z. B. `https://203.0.113.10`), `DISCORD_CLIENT_SECRET`, `DASHBOARD_SESSION_SECRET` (z. B. `openssl rand -hex 32`, nur in der VM-`.env`). In der OAuth-Anwendung die Redirect-URL `<DASHBOARD_PUBLIC_URL>/oauth/callback` eintragen. Der Dienst bindet nur an `127.0.0.1:3080` und braucht davor einen HTTPS-Reverse-Proxy (z. B. Caddy oder nginx). Session-Cookies sind signiert, HttpOnly, Secure und gelten 7 Tage ab dem letzten Besuch; Rollen werden bei jeder Anfrage live geprüft, schreibende Anfragen müssen vom eigenen Origin kommen.

**Rollen-Sicherungen:** Der Bot speichert täglich, wer welche Rollen hat (Verwaltung → Status, nur Bot-Owner; „Jetzt sichern“ jederzeit). „Wiederherstellen“ zeigt zuerst eine Vorschau: entweder nur fehlende Rollen wieder vergeben oder exakt den alten Stand herstellen (entfernt auch neu hinzugekommene Rollen), für alle oder ein einzelnes Mitglied, Bestätigung mit `WIEDERHERSTELLEN`. Vorher wird der aktuelle Stand automatisch gesichert. Verwaltete Rollen (Bots, Booster) und Rollen über der Bot-Rolle werden nie angefasst. Aufbewahrung `ROLE_SNAPSHOT_KEEP` (Standard 14 automatische Sicherungen).

**Website-Zugriffe (IP-Adressen):** Jeder Seitenaufruf und jede Anmeldung (auch abgewiesene) wird mit IP-Adresse, Discord-Konto und Gerät gespeichert – sichtbar nur für Bot-Owner unter *Verwaltung → Status*. Mehrere Konten von derselben IP werden hervorgehoben. Aufbewahrung `ACCESS_LOG_DAYS` (Standard 30 Tage), danach automatisch gelöscht. Die echte IP muss der Reverse-Proxy im Header `X-Forwarded-For` mitschicken (Caddy macht das automatisch; nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`), sonst steht überall `127.0.0.1`.

**Echtes HTTPS (ohne „Nicht sicher“):** Für eine nackte IP gibt es kein anerkanntes Zertifikat. Domain besorgen (kostenlos z. B. bei duckdns.org) und per A-Eintrag auf die VM-IP zeigen lassen, dann auf der VM `bash deploy/setup-https.sh <domain>` ausführen: installiert Caddy (automatisches Let's-Encrypt-Zertifikat), öffnet Port 80/443 in iptables, leitet die alte IP auf die Domain um, setzt `DASHBOARD_PUBLIC_URL` und startet den Bot neu (Backups von Caddyfile und `.env` werden angelegt). Danach im Discord Developer Portal `https://<domain>/oauth/callback` als Redirect eintragen; in der Oracle-Konsole müssen 80 und 443 in der Security List offen sein.

## Oracle-VM: Betrieb und Aktualisierung

Auf der VM liegt das Repository unter `/home/ubuntu/Gambino-Bot`, der PM2-Prozess heißt `gambino-bot`.

**Automatisch (eingerichteter Timer):** `deploy/gambino-autodeploy.timer` prüft jede Minute `origin/main`. Bei einer neuen Version passiert Folgendes:

1. Fast-Forward-Merge; bei lokalen Änderungen bricht der Dienst ab.
2. `npm install`, falls sich `package.json` oder ein Lockfile geändert hat.
3. Datenbank-Backup über `npm run backup`.
4. Slash-Commands registrieren.
5. `pm2 restart gambino-bot`, danach Prüfung, ob der Bot online ist.

Ein Merge nach `main` ist damit ein Produktiv-Deployment. Einmalige Einrichtung des Timers:

```sh
sudo install -m 644 deploy/gambino-autodeploy.service /etc/systemd/system/gambino-autodeploy.service
sudo install -m 644 deploy/gambino-autodeploy.timer /etc/systemd/system/gambino-autodeploy.timer
sudo systemctl daemon-reload
sudo systemctl enable --now gambino-autodeploy.timer
journalctl -u gambino-autodeploy.service -n 50   # letzte Deploy-Läufe
```

**Manuell:**

```sh
cd /home/ubuntu/Gambino-Bot
npm run backup
git pull --ff-only
npm install
npm test
npm run deploy-commands
pm2 restart gambino-bot --update-env
pm2 logs gambino-bot --lines 100
```

Node: Die VM lief laut früherer Bestandsaufnahme mit Node 20.20.2. Der Code läuft ab Node 20.6. Node 20 ist aber End-of-Life, ein Upgrade auf eine aktuelle LTS-Version (z. B. 22) ist empfohlen; danach `npm rebuild better-sqlite3`.

## Datenbank, Migrationen und Backups

- Beim Start laufen versionierte Migrationen (`MIGRATIONS` in `src/database.js`), jede in einer Transaktion und mit Name und Zeitpunkt in `schema_migrations` festgehalten. Sie sind idempotent; Spalten älterer Installationen werden ohne Datenverlust ergänzt. Neue Schemaänderungen kommen immer als neue Version hinzu.
- Schema: Konten, Transaktionen, Sanktionen, Sanktionsänderungen, Auszahlungs-Allocations, Erstattungen, Verwarnungen, Tickets und Transkripte, Events, Teilnehmer, Erinnerungen, Anträge, Notizen, Rollenvergaben, Giveaways und Teilnahmen, Audit-Logs und deren Zustellstatus, AutoMod-Aktionen, Mitgliederstatistik, Guild-Einstellungen. Dazu Fremdschlüssel, Unique-Constraints und Indizes.
- **Backup:** `npm run backup` erstellt eine konsistente Online-Kopie (SQLite-Backup-API, auch bei laufendem Bot), prüft deren Integrität und behält die letzten `BACKUP_KEEP` Dateien in `BACKUP_DIR` (Rechte 600). Täglich per Cron, z. B. `crontab -e` → `15 4 * * * cd /home/ubuntu/Gambino-Bot && npm run --silent backup >> $HOME/gambino-backup.log 2>&1`. Backups zusätzlich auf ein separates, zugriffsgeschütztes Ziel kopieren, denn Transkripte und Finanzdaten sind vertraulich.
- **Wiederherstellung:** `pm2 stop gambino-bot`; die aktuelle `data/gambino.sqlite` samt `-wal`/`-shm` beiseitelegen; die Backup-Datei als `data/gambino.sqlite` kopieren; `pm2 start gambino-bot`. Am besten vorher mit einer Kopie testen.

## Tests

`npm test` läuft ausschließlich mit In-Memory-Datenbanken und simulierten Discord-Objekten, ohne echte Nutzer, Tokens oder Produktivdaten. `npm run check` prüft Syntax und Command-Definitionen. Abgedeckt sind:

- Konfiguration und Rollenstufen.
- Berechtigungen über den echten Interaktions-Handler, inklusive Owner-Override-Protokoll.
- Gutschrift, Korrektur, Auszahlung, Vorgabebeispiel 2.500.000/500.000/2.000.000, FIFO, Teilverrechnung mit Rest, Auszahlung mit netto 0, kein Doppelabzug bei Retry, parallelem Doppelklick oder zweitem Klick, veraltete Vorschau, Aufhebung, Korrektur, Rückerstattung.
- Atomarer Rollback und Unveränderlichkeit der Buchungen.
- Ticket- und Antragsstatusübergänge, Event-Teilnahme, Giveaway-Ziehung genau einmal nach Neustart.
- Rang-Rollenvergabe, AutoMod-Regeln, Erinnerungen, Statistik, Migrationen, Audit-Darstellung und Webdashboard.

## Bekannte Grenzen

- Discord-Livebetrieb, die echten Discord-Berechtigungen und die konkrete VM-Konfiguration lassen sich nur auf dem Server selbst prüfen. Alle Discord-Zugriffe sind in den Tests simuliert.
- AutoMod-Zähler (Spam-Fenster, Raid-Erkennung) liegen bewusst im Arbeitsspeicher und beginnen nach einem Neustart neu. Alle Maßnahmen werden dauerhaft gespeichert.
- Erinnerungen werden vor dem Senden reserviert. Ist der Event-Channel in diesem Moment nicht erreichbar, wird diese eine Erinnerung nicht nachgeholt (dafür nie doppelt gesendet).
- Antragsfragen sind auf 5 pro Typ begrenzt (Discord-Modal-Limit). Weitere Antragstypen außer Bewerbung/Rang bräuchten zusätzlichen Code.
- Die Mitgliedersuche der Website nutzt die Discord-Mitgliedersuche (Server Members Intent erforderlich).
