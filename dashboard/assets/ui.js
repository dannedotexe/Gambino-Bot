// Eigene Auswahlmenüs statt der Browser-Liste (die unter Windows hell/blau gezeichnet wird und sich nicht stylen lässt).
// Das echte <select> bleibt versteckt erhalten: Werte, Formulare und change-Events funktionieren unverändert.
(() => {
  const OPEN = { box: null, select: null, button: null };
  const close = () => { OPEN.box?.remove(); OPEN.button?.setAttribute("aria-expanded", "false"); OPEN.box = OPEN.select = OPEN.button = null; };
  const labelOf = select => select.options[select.selectedIndex]?.textContent ?? "";

  function choose(select, value) {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    select._cselectSync?.();
  }

  function open(select, button) {
    close();
    const box = document.createElement("div");
    box.className = "cselect-list"; box.setAttribute("role", "listbox");
    [...select.options].forEach((option, index) => {
      const item = document.createElement("div");
      item.className = "cselect-option" + (index === select.selectedIndex ? " selected" : "") + (option.disabled ? " disabled" : "");
      item.setAttribute("role", "option"); item.dataset.index = String(index); item.textContent = option.textContent;
      item.addEventListener("mousedown", event => { event.preventDefault(); if (option.disabled) return; choose(select, option.value); close(); button.focus(); });
      box.appendChild(item);
    });
    // In offenen <dialog>-Fenstern (oberste Ebene) muss die Liste im Dialog hängen, sonst liegt sie dahinter.
    (select.closest("dialog") ?? document.body).appendChild(box);
    const rect = button.getBoundingClientRect(), below = window.innerHeight - rect.bottom;
    box.style.minWidth = `${rect.width}px`;
    box.style.left = `${Math.min(rect.left, window.innerWidth - box.offsetWidth - 8)}px`;
    if (below < Math.min(box.offsetHeight, 260) + 12 && rect.top > below) box.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    else box.style.top = `${rect.bottom + 4}px`;
    box.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    Object.assign(OPEN, { box, select, button });
    button.setAttribute("aria-expanded", "true");
  }

  function move(step) {
    const items = [...OPEN.box.querySelectorAll(".cselect-option:not(.disabled)")];
    if (!items.length) return;
    const current = items.findIndex(i => i.classList.contains("active") || (!OPEN.box.querySelector(".active") && i.classList.contains("selected")));
    const next = items[(current + step + items.length) % items.length];
    items.forEach(i => i.classList.toggle("active", i === next)); next.scrollIntoView({ block: "nearest" });
  }

  function enhance(select) {
    if (select._cselect || select.multiple || select.hasAttribute("data-segmented") || select.classList.contains("is-segmented")) return;
    select._cselect = true;
    const wrap = document.createElement("div");
    wrap.className = "cselect" + (select.closest("form, .event-form, .setting, .row-editor, label, .form-grid") ? " full" : "");
    const button = document.createElement("button");
    button.type = "button"; button.className = "cselect-btn"; button.setAttribute("aria-haspopup", "listbox"); button.setAttribute("aria-expanded", "false");
    if (select.getAttribute("aria-label")) button.setAttribute("aria-label", select.getAttribute("aria-label"));
    const text = document.createElement("span"); text.className = "cselect-text";
    button.appendChild(text);
    select._cselectSync = () => { text.textContent = labelOf(select); button.disabled = select.disabled; };
    select.addEventListener("change", select._cselectSync);
    new MutationObserver(select._cselectSync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    button.addEventListener("click", () => (OPEN.select === select ? close() : open(select, button)));
    button.addEventListener("keydown", event => {
      if (!OPEN.box && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); open(select, button); return; }
      if (!OPEN.box) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
      else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const active = OPEN.box.querySelector(".active"); if (active) choose(select, select.options[Number(active.dataset.index)].value); close(); }
      else if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); }
    });
    select.classList.add("cselect-native"); select.tabIndex = -1;
    select.after(wrap); wrap.appendChild(button);
    select._cselectSync();
  }

  const scan = root => (root.matches?.("select") ? [root] : [...(root.querySelectorAll?.("select") ?? [])]).forEach(enhance);
  // Programmatische Änderungen (select.value = …) ohne Event: Beschriftung regelmäßig abgleichen.
  setInterval(() => document.querySelectorAll("select.cselect-native").forEach(s => s._cselectSync?.()), 700);
  document.addEventListener("mousedown", event => { if (OPEN.box && !OPEN.box.contains(event.target) && !event.target.closest?.(".cselect-btn")) close(); });
  window.addEventListener("resize", close);
  document.addEventListener("scroll", event => { if (OPEN.box && !OPEN.box.contains(event.target)) close(); }, true);
  const start = () => { scan(document.body); new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && scan(n)))).observe(document.body, { childList: true, subtree: true }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
