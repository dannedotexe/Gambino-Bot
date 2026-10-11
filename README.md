# Gambino Bot

Modularer Discord-Bot für Gambinos / Grand-RP mit discord.js 14 und SQLite. Das Projekt speichert keine Secrets im Repository. Produktivdaten gehören in die `.env` und SQLite-Datei auf der Oracle-VM.

## Voraussetzungen

- Node.js 20.6 oder neuer; für den laufenden VM-Betrieb ist derzeit Node 20.20.2 dokumentiert. Node 20 ist seit März 2026 End-of-Life; vor dem produktiven Betrieb sollte die VM auf eine unterstützte Node-LTS-Version aktualisiert werden. Das ist eine separate Betriebsänderung und wurde hier nicht ausgeführt.
- Ein Discord-Bot im Developer Portal und ein Discord-Server.
- Auf der VM: PM2, Schreibrechte auf den Datenbankpfad sowie Internetzugang zur Discord API.
- `better-sqlite3` nutzt ein natives Modul. Auf Linux werden passende Prebuilds verwendet, andernfalls braucht der Installationshost Python und einen C++-Compiler.

## Einrichtung

1. `.env.example` nach `.env` kopieren und `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` sowie die tatsächlichen Rollen-, Channel- und Kategorie-IDs des Servers eintragen. Keine Beispiel-ID übernehmen. Das Discord-Token ausschließlich direkt in der VM-Datei hinterlegen und niemals hier senden.
2. Alle Rollenlisten sind kommaseparierte IDs. Leere Staff-Listen verweigern die zugehörige Aktion sicher. `TICKET_CATEGORIES_JSON` konfiguriert Ticket-Kategorien und optionale zuständige Rollen pro Kategorie, z. B. `[ {"id":"support","label":"Support","roleIds":[]} ]`.
3. `DATABASE_PATH` muss auf einen dauerhaften Datenträger zeigen, z. B. `/home/ubuntu/Gambino-Bot/data/gambino.sqlite`. SQLite WAL benötigt Schreibzugriff auf Verzeichnis und Datenbankdatei.
4. Im Discord Developer Portal für den Bot **Server Members Intent** einschalten (Join-Raid-Beobachtung). **Message Content Intent** ist nur für AutoMod erforderlich; die Funktion ist standardmäßig deaktiviert. Bot-Berechtigungen: Slash Commands, Channels verwalten/Channels ansehen, Nachrichten senden und lesen, Nachrichtenverlauf lesen, Nachrichten verwalten (wenn AutoMod aktiv ist), Rollen erwähnen. Keine Administrator-Berechtigung vergeben.
5. Abhängigkeiten installieren, Commands registrieren und starten:

   ```sh
   npm install
   npm run deploy-commands
   npm start
   ```

`DISCORD_GUILD_ID` bewirkt sofortige Guild-Registrierung zum Testen. Ist es leer, werden Commands global registriert; deren Verfügbarkeit kann verzögert sein. Ein späterer Registrierungsaufruf ersetzt die Command-Liste für die konfigurierte Anwendung.

## Module und Befehle

- `/setup channels`: zeigt die in `Gambinos Bot Idee.pdf` definierte Struktur (5 Kategorien, 25 Text-Channels) als Vorschau und legt nach Bestätigung nur Fehlendes an. Nur Server-Administratoren oder die konfigurierte Leitungsrolle dürfen starten und bestätigen. Vorhandene Channels werden weder verschoben noch umbenannt oder gelöscht. Der neue STAFF-Bereich ist privat und erhält die konfigurierten Leitungs-, Staff-, Finanz-, Reviewer- und Event-Team-Rollen; ohne Staff-Rollen bleibt er für Administratoren und den Bot sichtbar. Die erkannten Funktions-Channel-IDs werden in SQLite gespeichert und beim Neustart geladen. Für neue Slash-Commands danach einmal `npm run deploy-commands` ausführen.

### Automatische Aktualisierung auf Oracle

Die VM kann GitHub automatisch prüfen und neue `main`-Änderungen einspielen. Der Timer läuft minütlich; bei einer neuen Version zieht er nur Fast-Forward-Änderungen, registriert die Slash-Commands und startet `gambino-bot` neu. Der Dienst bricht ab, wenn lokale VM-Dateien geändert wurden oder der Bot nach dem Neustart nicht online ist. Einrichtung auf der Oracle-VM:

```sh
sudo install -m 644 deploy/gambino-autodeploy.service /etc/systemd/system/gambino-autodeploy.service
sudo install -m 644 deploy/gambino-autodeploy.timer /etc/systemd/system/gambino-autodeploy.timer
sudo systemctl daemon-reload
sudo systemctl enable --now gambino-autodeploy.timer
```

- `/ticket panel`, `/ticket übernehmen`, `/ticket schliessen`, `/ticket wiedereroeffnen`: private Tickets, zuständige Rollen, Cooldown, Begrenzung offener Tickets und DB-Transkript der letzten 100 Channel-Nachrichten. Geschlossene Channels bleiben zur Prüfung erhalten.
- `/event erstellen`, `/event bearbeiten`, `/event liste`, `/event historie`, `/event anwesenheit`, `/event absagen`, `/event beenden`: persistente Events und An-/Abmeldung per Button. ISO-Zeit mit Offset angeben (z. B. `2026-12-31T19:00:00+01:00`); gespeichert wird UTC, Discord zeigt die Zeit lokal. Reminder bei ungefähr 60 und 15 Minuten.
- `/bewerbung-panel`, `/antrag bewerben`, `/antrag liste`, `/antrag entscheiden`, `/antrag status`: Bewerbungs- und Rang-Formulare mit Status, Reviewer und optionalem Entscheidungskommentar. Rollen werden nie automatisch vergeben.
- `/konto stand`, `/konto ansehen`, `/konto gutschrift`, `/konto auszahlen`, `/konto liste`, `/konto historie`: persönliches Familienguthaben und Leitungsbuchungen. Geld wird als Integer-Cent geführt; Textwerte sind Dollarbeträge, etwa `2500000` oder `12,50`.
- `/sanktion erstellen`, `/sanktion offen`, `/sanktion aufheben`, `/sanktion rueckerstatten`: offene Auszahlungsabzüge. Aufhebung und Rückerstattung verlangen Gründe und bleiben auditierbar.
- `/giveaway erstellen`, `/giveaway abbrechen`: Teilnehmerlisten und Endzeitpunkte werden gespeichert; fällige Giveaways werden beim nächsten Scheduler-Lauf genau einmal beendet.
- `/dashboard`, `/statistik`, `/ping`, `/help`: kompakte Übersichten und Status.

### Konten und Sanktionsverrechnung

Das Familienkonto steht für noch nicht ausgezahltes Geld aus Grand-RP-Events oder anderen Familienaktivitäten. Es ist keine Discord-Spielwährung und wird nicht mit einer Community-Economy verrechnet. Bei einer Auszahlung wird innerhalb einer SQLite-Transaktion der vollständige Kontostand als Brutto ermittelt, offene Sanktionsreste nach FIFO abgezogen, Restbeträge aktualisiert und eine einzige unveränderliche Transaktion mit Auszahlungs- und Sanktionszuordnung erstellt. Die Vorschau wird bei Bestätigung auf Änderungen geprüft; Interaktions-ID und Datenbank-Constraints verhindern Doppelbuchungen. Ein Fehlerschritt rollt den ganzen Vorgang zurück.

## Rollen und Channel-Einstellungen

| Einstellung | Verwendung |
| --- | --- |
| `ROLE_LEADERS` | Leitungsaktionen, Sanktionskorrektur und Rückerstattung |
| `ROLE_STAFF` | Tickets, Sanktionen und Giveaways |
| `ROLE_FINANCE` | Familienkonto, Gutschriften, Auszahlungen und Auszahlungsliste |
| `ROLE_EVENT_TEAM` | Events und Anwesenheit |
| `ROLE_REVIEWERS` | Anträge und Reviewer-Panel |
| `ROLE_MEMBERS` | vorbereitet für Mitgliedsrollen; derzeit keine automatische Rollenvergabe |
| `CHANNEL_TICKET_CATEGORY` | Kategorie, unter der private Ticket-Channels erstellt werden |
| `CHANNEL_TICKET_LOG` | Ticket-Kurzmeldungen |
| `CHANNEL_APPLICATION_REVIEW` | eingereichte Anträge und Reviewer-Buttons |
| `CHANNEL_EVENT_ANNOUNCEMENTS` | Event-Ankündigungen; leer nutzt den Command-Channel |
| `CHANNEL_AUDIT_LOG` | zentrale Weiterleitung von Datenbank-Audit-Logs |
| `CHANNEL_AUTOMOD_LOG` | AutoMod- und Raid-Meldungen |

Alle IDs sind optional, soweit nicht die Discord-Anwendung selbst betroffen ist. Rollen, die eine Aktion freischalten, müssen explizit eingetragen sein. Wenn `DISCORD_GUILD_ID` gesetzt ist, lehnt der Bot Aktionen in anderen Servern ab.

## Daten, Migrationen und Backups

Beim Start werden SQLite-Tabellen mit `CREATE TABLE IF NOT EXISTS` und eindeutigen Constraints idempotent angelegt; `schema_migrations` hält die angewandte Basisversion fest. Transaktionen und Sanction-Allocations sind append-only. Ticket-Transkripte enthalten bis zu 100 Nachrichten und werden in SQLite gespeichert; Zugriff auf die Datenbank und Backups entsprechend beschränken. Logs speichern IDs und Aktionsmetadaten, keine Tokens.

Beispiel für ein VM-Backup bei gestopptem Bot (Datenbank plus WAL-Dateien zusammen sichern):

```sh
pm2 stop gambino-bot
tar -czf "$HOME/gambino-backup-$(date +%F-%H%M).tar.gz" -C /home/ubuntu/Gambino-Bot data
pm2 start gambino-bot
```

Backups regelmäßig auf ein separates, zugriffsgeschütztes Ziel übertragen und eine Wiederherstellung mit einer Kopie testen. Nie ein laufendes SQLite-Datenbankfile ohne WAL sichern.

## Tests

`npm test` führt ausschließlich In-Memory-Tests aus. Die Suite umfasst Konfiguration/Rollen, Geldbeträge, Gutschrift, Auszahlung, vollständige und teilweise Sanktion, Wiederholungen, Rückerstattung und atomaren Rollback sowie Statusübergänge und doppelte Event-/Giveaway-Teilnahmen.

## Oracle-VM-Workflow

Das Repository liegt auf der VM unter `/home/ubuntu/Gambino-Bot`; PM2-Prozessname ist `gambino-bot`. Es wurden keine VM-Dateien, laufenden Prozesse, Secrets oder produktiven Discord-Commands mit dieser Änderung verändert.

Nach Review und Merge der Änderung kann die bestehende ChatGPT-verwaltete Aktualisierung auf der VM so ausgeführt werden:

```sh
cd /home/ubuntu/Gambino-Bot
git pull --ff-only
npm install
npm test
npm run deploy-commands
pm2 restart gambino-bot --update-env
pm2 save
pm2 logs gambino-bot --lines 100
```

Vor dem ersten Neustart `.env`-Konfiguration und ein Backup prüfen. Die VM läuft laut vorheriger Bestandsaufnahme mit Node 20.20.2; Node 20 ist nicht mehr unterstützt. Node-Version-Upgrade und Deployment sind bewusst nicht Teil dieser lokalen Änderung.

## Bekannte Grenzen des aktuellen Ausbaus

- Der Discord-Livebetrieb, Discord-API-Berechtigungen und Oracle-VM-Installationspfad wurden nicht mit produktiven Zugangsdaten getestet.
- AutoMod ist opt-in und löscht bei Aktivierung Links außerhalb der Allowlist, konfigurierte Begriffe und Spam-Nachrichten; Timeout-Aktionen oder automatische Raid-Lockdowns sind absichtlich nicht aktiv.
- Tickets können gelöschte Channels als geschlossen protokollieren; Transkripte sind auf die letzten 100 Discord-Nachrichten begrenzt.
- Bewerbungsfragen und Event-Reminder-Intervalle sind derzeit Code-Defaults; Rollenzuordnungen und Review-/Announcement-Channels sind konfigurierbar.
- Das Staff-Dashboard ist eine kompakte Textübersicht, kein interaktives mehrseitiges Panel.
