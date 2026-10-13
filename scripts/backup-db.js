// Online-Backup der SQLite-Datenbank (auch bei laufendem Bot, WAL-sicher über die SQLite-Backup-API).
// Nutzung: npm run backup   (Ziel: BACKUP_DIR, Standard ./backups; behält BACKUP_KEEP Dateien, Standard 14)
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const source = path.resolve(process.env.DATABASE_PATH ?? "./data/gambino.sqlite");
const targetDir = path.resolve(process.env.BACKUP_DIR ?? "./backups");
const keep = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP ?? "14", 10) || 14);

if (!fs.existsSync(source)) {
  // --if-exists: beim allerersten Deployment gibt es noch keine Datenbank; das ist kein Fehler.
  if (process.argv.includes("--if-exists")) { console.log(`Keine Datenbank unter ${source}; kein Backup nötig.`); process.exit(0); }
  console.error(`Datenbank nicht gefunden: ${source}`); process.exit(1);
}
fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(targetDir, `gambino-${stamp}.sqlite`);
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(target);
  fs.chmodSync(target, 0o600);
  const check = new Database(target, { readonly: true });
  const result = check.pragma("integrity_check", { simple: true });
  check.close();
  if (result !== "ok") throw new Error(`Integritätsprüfung fehlgeschlagen: ${result}`);
  console.log(`Backup erstellt: ${target}`);
} catch (error) {
  console.error("Backup fehlgeschlagen:", error.message);
  fs.rmSync(target, { force: true });
  process.exitCode = 1;
} finally { db.close(); }

const backups = fs.readdirSync(targetDir).filter(name => /^gambino-.*\.sqlite$/.test(name)).sort();
for (const old of backups.slice(0, Math.max(0, backups.length - keep))) fs.rmSync(path.join(targetDir, old));
