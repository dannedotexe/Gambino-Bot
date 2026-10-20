// Darstellung vor dem ersten Zeichnen setzen (kein Aufblitzen): Design (neu/klassisch) und Modus (auto/hell/dunkel).
// Wird synchron im <head> geladen; Inline-Skripte sind durch die Content-Security-Policy gesperrt.
(() => {
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const root = document.documentElement, media = window.matchMedia?.("(prefers-color-scheme: light)");
  const apply = () => {
    const design = read("gambinos-design") === "classic" ? "classic" : "ios";
    const mode = read("gambinos-mode") || "auto";
    // Das klassische Design kennt nur Dunkel.
    const light = design === "ios" && (mode === "light" || (mode === "auto" && media?.matches));
    root.dataset.design = design; root.dataset.theme = light ? "light" : "dark"; root.dataset.mode = mode;
    const link = document.getElementById("theme-css");
    const href = design === "classic" ? "/assets/classic.css" : "/assets/style.css";
    if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#f2f2f7" : "#000000");
  };
  window.gambinosAppearance = {
    get: () => ({ design: read("gambinos-design") === "classic" ? "classic" : "ios", mode: read("gambinos-mode") || "auto" }),
    set: ({ design, mode }) => { try { localStorage.setItem("gambinos-design", design); localStorage.setItem("gambinos-mode", mode); } catch {} apply(); },
  };
  media?.addEventListener?.("change", apply);
  apply();
})();
