import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Kurzer Git-Commit der laufenden Version (ohne Git-Programm, direkt aus .git gelesen). */
export function currentVersion() {
  try {
    const gitDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head.slice(0, 7);
    const ref = head.slice(5);
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim().slice(0, 7);
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8").split("\n").find(line => line.endsWith(` ${ref}`));
    return packed ? packed.slice(0, 7) : "unbekannt";
  } catch { return "unbekannt"; }
}
