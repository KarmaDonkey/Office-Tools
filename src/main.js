import "./styles.css";
import { app, settings } from "./store.js";
import { PdfClient } from "./client.js";
import { h, iconButton, toast, showError, dialog, busy } from "./ui/dom.js";
import { icon } from "./ui/icons.js";
import { initViewer, setZoom, zoomBy, setFit, goToPage } from "./ui/viewer.js";
import { initThumbs, toggleGrid } from "./ui/thumbs.js";
import { initSearch, toggleSearch } from "./ui/search.js";
import { pickFiles, openFiles, openPdf, appendFiles, save, confirmDiscard } from "./ui/files.js";
import { listRecent, removeRecent, recentEnabled } from "./ui/recent.js";
import * as D from "./ui/dialogs.js";

const VERSION = __APP_VERSION__;

app.client = new PdfClient();
app.client.ready.catch((e) => showError(new Error("PDF-motorn kunde inte starta: " + e.message)));

// ---------- Tema ----------

function applyTheme(mode) {
  settings.set("theme", mode);
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}
applyTheme(settings.get("theme", "auto"));

// ---------- Hjälp ----------

const needDoc = () => {
  if (!app.doc.open) {
    toast("Öppna en PDF först.");
    return false;
  }
  return true;
};
const guarded = (fn) => () => needDoc() && fn();
const targetPages = () => (app.selection.size ? [...app.selection].sort((a, b) => a - b) : [app.currentPage]);

async function run(method, ...args) {
  try {
    app.setDoc(await app.client.call(method, ...args));
  } catch (e) {
    showError(e);
  }
}

const pageActions = {
  rotate: (delta) => needDoc() && run("rotate", targetPages(), delta),
  remove: async () => {
    if (!needDoc()) return;
    const pages = targetPages();
    if (pages.length >= app.doc.pageCount) return toast("Du kan inte ta bort alla sidor.", { type: "error" });
    await run("deletePages", pages);
    app.selection.clear();
    app.emit("selection");
  },
  extract: () => needDoc() && D.extractPages(targetPages()),
};

async function closeDocument() {
  if (!(await confirmDiscard())) return;
  app.file = { name: "", handle: null, size: 0 };
  app.setDoc(await app.client.call("close"));
  app.emit("file");
}

async function openDialog() {
  const items = await pickFiles();
  if (items.length) openFiles(items);
}

// ---------- Menyer ----------

let openMenu = null;
function closeMenus() {
  openMenu?.menu.remove();
  openMenu?.button.setAttribute("aria-expanded", "false");
  openMenu = null;
}
document.addEventListener("pointerdown", (e) => {
  if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.button.contains(e.target)) closeMenus();
});

function menuButton(label, iconName, itemsFn, { showLabel = true } = {}) {
  const button = h("button", { type: "button", class: "menu-btn", "aria-haspopup": "menu", "aria-expanded": "false", title: label }, icon(iconName), showLabel ? h("span", { class: "btn-label" }, label) : null, icon("chevron-down"));
  button.addEventListener("click", () => {
    if (openMenu?.button === button) return closeMenus();
    closeMenus();
    const menu = h(
      "div",
      { class: "menu", role: "menu" },
      itemsFn().map((it) =>
        it === "-"
          ? h("hr", {})
          : h(
              "button",
              {
                type: "button",
                role: "menuitem",
                class: "menu-item",
                disabled: it.disabled,
                onclick: () => {
                  closeMenus();
                  it.action();
                },
              },
              it.icon ? icon(it.icon) : h("span", { class: "icon" }),
              h("span", {}, it.label),
              it.kbd ? h("kbd", {}, it.kbd) : null,
            ),
      ),
    );
    document.body.append(menu);
    const r = button.getBoundingClientRect();
    const mw = menu.offsetWidth;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - mw - 8))}px`;
    button.setAttribute("aria-expanded", "true");
    openMenu = { button, menu };
    menu.querySelector(".menu-item:not([disabled])")?.focus();
    menu.addEventListener("keydown", (e) => {
      const list = [...menu.querySelectorAll(".menu-item:not([disabled])")];
      const k = list.indexOf(document.activeElement);
      if (e.key === "ArrowDown") list[(k + 1) % list.length]?.focus();
      else if (e.key === "ArrowUp") list[(k - 1 + list.length) % list.length]?.focus();
      else if (e.key === "Escape") {
        closeMenus();
        button.focus();
      } else return;
      e.preventDefault();
    });
  });
  return button;
}

const fileMenu = () => {
  const d = !app.doc.open;
  return [
    { label: "Öppna …", icon: "folder-open", kbd: "Ctrl+O", action: openDialog },
    { label: "Slå ihop filer …", icon: "combine", action: D.mergeDialog },
    { label: "Bilder till PDF …", icon: "images", action: D.imagesToPdf },
    "-",
    { label: "Spara", icon: "save", kbd: "Ctrl+S", disabled: d, action: () => save() },
    { label: "Spara som …", icon: "save-all", kbd: "Ctrl+Skift+S", disabled: d, action: () => save({ as: true }) },
    "-",
    { label: "Stäng dokumentet", icon: "file-x", disabled: d, action: closeDocument },
  ];
};

const toolsMenu = () => {
  const d = !app.doc.open;
  return [
    { label: "Infoga filer …", icon: "file-plus", disabled: d, action: D.insertFilesDialog },
    { label: "Infoga tom sida", icon: "plus", disabled: d, action: () => { const p = app.doc.pages[app.currentPage]; run("insertBlankPage", app.currentPage + 1, p?.w ?? 595, p?.h ?? 842); } },
    { label: "Infoga bild på sidan …", icon: "image", disabled: d, action: D.placeImage },
    "-",
    { label: "Dela upp …", icon: "scissors", disabled: d, action: D.splitDialog },
    { label: "Plocka ut sidor …", icon: "file-output", disabled: d, action: D.extractDialog },
    { label: "PDF till bilder …", icon: "file-image", disabled: d, action: D.exportImagesDialog },
    "-",
    { label: "Komprimera …", icon: "file-archive", disabled: d, action: D.compressDialog },
    { label: "Vattenstämpel …", icon: "stamp", disabled: d, action: D.watermarkDialog },
    { label: "Sidnummer …", icon: "hash", disabled: d, action: D.pageNumbersDialog },
    { label: "Metadata …", icon: "info", disabled: d, action: D.metadataDialog },
    { label: "Lösenord …", icon: "lock", disabled: d, action: D.passwordDialog },
    "-",
    { label: "Verkställ maskering …", icon: "shield-check", disabled: d, action: D.applyRedactionsDialog },
  ];
};

const settingsMenu = () => [
  { label: "Inställningar …", icon: "settings", action: () => D.settingsDialog({ applyTheme }) },
  { label: "Om PDF-verktyg …", icon: "info", action: () => D.aboutDialog(VERSION) },
];

const zoomMenu = () => [
  { label: "Anpassa till bredd", icon: "move-horizontal", kbd: "Ctrl+0", action: () => setFit("width") },
  { label: "Hel sida", icon: "maximize-2", action: () => setFit("page") },
  "-",
  ...[50, 75, 100, 125, 150, 200, 300, 400].map((p) => ({ label: `${p} %`, action: () => setZoom(p / 100) })),
];

// ---------- Verktygsfält ----------

const TOOLS = [
  ["select", "mouse-pointer-2", "Pekare och formulär"],
  ["highlight", "highlighter", "Markera text"],
  ["text", "type", "Skriv text"],
  ["draw", "pen-line", "Rita"],
  ["sign", "signature", "Signera"],
  ["redact", "square-dashed", "Maskera område"],
  ["erase", "eraser", "Ta bort anteckning"],
];

function selectTool(tool) {
  if (!needDoc()) return;
  if (tool === "sign") return D.signatureDialog();
  app.setTool(tool);
}

const appbar = document.getElementById("appbar");
const undoBtn = iconButton("undo-2", "Ångra", () => run("undo"));
const redoBtn = iconButton("redo-2", "Gör om", () => run("redo"));
const saveBtn = iconButton("save", "Spara (Ctrl+S)", () => save());
const toolButtons = Object.fromEntries(TOOLS.map(([id, ic, label]) => [id, iconButton(ic, label, () => selectTool(id), { class: "tool-btn", "aria-pressed": "false" })]));
const zoomBtn = menuButton("100 %", "zoom-in", zoomMenu, { showLabel: true });
zoomBtn.classList.add("zoom-btn");
const pageInput = h("input", { type: "text", inputmode: "numeric", class: "page-input", "aria-label": "Sidnummer", value: "" });
const pageCount = h("span", { class: "page-count" });
const fileLabel = h("span", { class: "file-label" });
pageInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const n = parseInt(pageInput.value, 10);
  if (n >= 1 && n <= app.doc.pageCount) goToPage(n - 1);
  else pageInput.value = app.currentPage + 1;
  pageInput.blur();
});
pageInput.addEventListener("focus", () => pageInput.select());

appbar.append(
  h("div", { class: "group" }, iconButton("panel-left", "Visa eller dölj sidpanelen", toggleSidebar, { class: "sidebar-toggle" }), menuButton("Arkiv", "file-text", fileMenu), saveBtn),
  h("div", { class: "group doc-only" }, undoBtn, redoBtn),
  h("div", { class: "group tools doc-only", role: "toolbar", "aria-label": "Verktyg" }, Object.values(toolButtons)),
  h("div", { class: "group doc-only zoom" }, iconButton("zoom-out", "Zooma ut", () => zoomBy(1 / 1.2)), zoomBtn, iconButton("zoom-in", "Zooma in", () => zoomBy(1.2))),
  h("div", { class: "group doc-only pagenav" }, pageInput, pageCount),
  h("span", { class: "spacer" }),
  fileLabel,
  h("div", { class: "group" }, iconButton("search", "Sök (Ctrl+F)", guarded(() => toggleSearch()), { class: "doc-only" }), menuButton("Verktyg", "wrench", toolsMenu), menuButton("Inställningar", "settings", settingsMenu, { showLabel: false })),
);

// Alternativ för aktivt verktyg
const optionsBar = document.getElementById("tool-options");
const SWATCHES = {
  highlightColor: ["#ffd400", "#7cff6b", "#5ce1ff", "#ff8ad8", "#ffa94d"],
  inkColor: ["#d40000", "#0b1f66", "#000000", "#1a7f37", "#ff7a00"],
  textColor: ["#000000", "#0b1f66", "#d40000", "#1a7f37"],
};

function swatches(key) {
  const wrap = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Färg" });
  const custom = h("input", { type: "color", value: app.toolOptions[key], title: "Egen färg", "aria-label": "Egen färg" });
  const draw = () => {
    wrap.replaceChildren(
      ...SWATCHES[key].map((c) => h("button", { type: "button", class: "swatch" + (app.toolOptions[key] === c ? " on" : ""), style: { background: c }, title: c, "aria-label": `Färg ${c}`, onclick: () => { app.toolOptions[key] = c; settings.set("toolOptions", app.toolOptions); draw(); } })),
      custom,
    );
  };
  custom.addEventListener("input", () => {
    app.toolOptions[key] = custom.value;
    settings.set("toolOptions", app.toolOptions);
    draw();
  });
  draw();
  return wrap;
}

function numberOpt(label, key, min, max, step = 1) {
  const input = h("input", { type: "number", min, max, step, value: app.toolOptions[key] });
  input.addEventListener("change", () => {
    app.toolOptions[key] = Math.min(max, Math.max(min, Number(input.value) || min));
    input.value = app.toolOptions[key];
    settings.set("toolOptions", app.toolOptions);
  });
  return h("label", { class: "opt" }, h("span", {}, label), input);
}

function renderToolOptions() {
  const t = app.tool;
  const hint = (text) => h("span", { class: "hint" }, text);
  let content = null;
  if (t === "highlight") content = [hint("Dra över texten du vill markera."), swatches("highlightColor")];
  else if (t === "draw") content = [hint("Rita på sidan. Varje drag blir en egen ritning."), swatches("inkColor"), numberOpt("Tjocklek", "inkWidth", 0.5, 20, 0.5)];
  else if (t === "text") content = [hint("Klicka där texten ska stå. Klicka utanför när du är klar."), swatches("textColor"), numberOpt("Storlek", "textSize", 6, 72)];
  else if (t === "redact") content = [hint("Dra en ruta över det som ska döljas. Inget tas bort förrän du verkställer."), h("button", { type: "button", class: "btn btn-small btn-danger", onclick: D.applyRedactionsDialog }, "Verkställ maskering …")];
  else if (t === "erase") content = [hint("Klicka på en anteckning, markering, ritning, text eller signatur för att ta bort den.")];
  else if (t === "stamp") content = [hint(`${app.stamp?.label === "Infoga bild" ? "Bilden" : "Signaturen"}: klicka på sidan, eller dra för att välja storlek.`), h("button", { type: "button", class: "btn btn-small", onclick: () => app.setTool("select") }, "Avbryt")];
  optionsBar.replaceChildren(...(content ?? []));
  optionsBar.hidden = !content;
}

Object.assign(app.toolOptions, settings.get("toolOptions", {}));

// ---------- Sidpanel ----------

const sidebar = document.getElementById("sidebar");
function toggleSidebar() {
  if (window.matchMedia("(max-width: 900px)").matches) document.body.classList.toggle("sidebar-open");
  else document.body.classList.toggle("sidebar-hidden");
}

// ---------- Startskärm ----------

const start = document.getElementById("start");
async function renderStart() {
  const recents = recentEnabled() && window.showOpenFilePicker ? await listRecent() : [];
  const fmtDate = (t) => new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(t));
  start.replaceChildren(
    h(
      "div",
      { class: "start-inner" },
      h("div", { class: "brand" }, h("img", { src: "icons/icon.svg", alt: "", width: 56, height: 56 }), h("div", {}, h("h1", {}, "PDF-verktyg"), h("p", {}, "Allt sker lokalt på din dator. Inga filer laddas upp."))),
      h("div", { class: "drop-zone" }, icon("upload"), h("p", {}, "Släpp PDF-filer eller bilder här"), h("p", { class: "muted" }, "eller")),
      h(
        "div",
        { class: "start-actions" },
        h("button", { type: "button", class: "btn btn-primary btn-large", onclick: openDialog }, icon("folder-open"), "Öppna PDF"),
        h("button", { type: "button", class: "btn btn-large", onclick: D.mergeDialog }, icon("combine"), "Slå ihop filer"),
        h("button", { type: "button", class: "btn btn-large", onclick: D.imagesToPdf }, icon("images"), "Bilder till PDF"),
      ),
      recents.length
        ? h(
            "section",
            { class: "recent" },
            h("h2", {}, icon("clock"), "Senaste filer"),
            h(
              "ul",
              {},
              recents.map((r) =>
                h(
                  "li",
                  {},
                  h("button", { type: "button", class: "recent-open", onclick: () => openRecent(r) }, icon("file-text"), h("span", { class: "recent-name" }, r.name), h("span", { class: "recent-date" }, fmtDate(r.opened))),
                  iconButton("x", `Ta bort ${r.name} från listan`, async () => {
                    await removeRecent(r.id);
                    renderStart();
                  }),
                ),
              ),
            ),
          )
        : null,
    ),
  );
}

async function openRecent(r) {
  try {
    if ((await r.handle.queryPermission({ mode: "read" })) !== "granted" && (await r.handle.requestPermission({ mode: "read" })) !== "granted") return;
    const file = await r.handle.getFile();
    if (await confirmDiscard()) await openPdf(file, r.handle);
  } catch (e) {
    console.warn(e);
    toast(`”${r.name}” kunde inte öppnas. Den kan ha flyttats eller tagits bort.`, { type: "error" });
    await removeRecent(r.id);
    renderStart();
  }
}

// ---------- Uppdatera gränssnittet ----------

function updateUi() {
  const d = app.doc;
  document.body.classList.toggle("has-doc", !!d.open);
  start.hidden = !!d.open;
  undoBtn.disabled = !d.canUndo;
  redoBtn.disabled = !d.canRedo;
  undoBtn.title = d.undoLabel ? `Ångra: ${d.undoLabel} (Ctrl+Z)` : "Ångra (Ctrl+Z)";
  redoBtn.title = d.redoLabel ? `Gör om: ${d.redoLabel} (Ctrl+Y)` : "Gör om (Ctrl+Y)";
  saveBtn.disabled = !d.open;
  pageCount.textContent = d.open ? `av ${d.pageCount}` : "";
  if (document.activeElement !== pageInput) pageInput.value = d.open ? app.currentPage + 1 : "";
  const name = app.file.name || (d.open ? "Namnlös.pdf" : "");
  const lock = d.open && (app.saveEncryption.mode === "set" || (d.encrypted && app.saveEncryption.mode === "keep"));
  fileLabel.replaceChildren(lock ? icon("lock") : "", h("span", {}, name), d.dirty ? h("span", { class: "dirty", title: "Osparade ändringar" }, "•") : "");
  fileLabel.title = name;
  document.title = d.open ? `${d.dirty ? "• " : ""}${name} – PDF-verktyg` : "PDF-verktyg";
  if (!d.open) renderStart();
}

app.on("doc", updateUi);
app.on("file", updateUi);
app.on("encryption", updateUi);
app.on("recent", () => !app.doc.open && renderStart());
app.on("page", (i) => {
  if (document.activeElement !== pageInput) pageInput.value = i + 1;
});
app.on("zoom", (z) => (zoomBtn.querySelector(".btn-label").textContent = `${Math.round(z * 100)} %`));
app.on("tool", (t) => {
  for (const [id, b] of Object.entries(toolButtons)) {
    const on = id === t || (id === "sign" && t === "stamp" && app.stamp?.label === "Signera");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  renderToolOptions();
});
app.on("notice", (m) => toast(m));

// ---------- Init ----------

initViewer(document.getElementById("viewer"));
initThumbs(sidebar, pageActions);
initSearch(document.getElementById("search-panel"));
app.setTool("select");
updateUi();

// ---------- Tangentbord ----------

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  const k = e.key.toLowerCase();
  if (document.querySelector("dialog[open]")) return;
  if (mod && k === "o") {
    e.preventDefault();
    openDialog();
  } else if (mod && k === "s") {
    e.preventDefault();
    save({ as: e.shiftKey });
  } else if (mod && k === "f") {
    if (!app.doc.open) return;
    e.preventDefault();
    toggleSearch(true);
  } else if (typing) {
    return;
  } else if (mod && k === "z") {
    e.preventDefault();
    if (app.doc.open) run(e.shiftKey ? "redo" : "undo");
  } else if (mod && k === "y") {
    e.preventDefault();
    if (app.doc.open) run("redo");
  } else if (mod && (k === "+" || k === "=")) {
    e.preventDefault();
    zoomBy(1.2);
  } else if (mod && k === "-") {
    e.preventDefault();
    zoomBy(1 / 1.2);
  } else if (mod && k === "0") {
    e.preventDefault();
    setFit("width");
  } else if (e.key === "Escape") {
    closeMenus();
    if (app.tool !== "select") app.setTool("select");
    else if (document.body.classList.contains("grid-mode")) toggleGrid(false);
  }
});

// ---------- Dra och släpp filer ----------

const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add("file-drag");
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("file-drag");
  }
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("file-drag");
  const items = await Promise.all(
    [...e.dataTransfer.items]
      .filter((i) => i.kind === "file")
      .map(async (i) => {
        const handlePromise = i.getAsFileSystemHandle?.();
        const file = i.getAsFile();
        const handle = await handlePromise?.catch(() => null);
        return { file, handle: handle?.kind === "file" ? handle : null };
      }),
  );
  if (!items.length) return;
  if (!app.doc.open) return openFiles(items);
  const choice = await dialog({
    title: "Släppta filer",
    body: h("p", {}, items.map((i) => i.file.name).join(", ")),
    actions: [{ label: "Avbryt" }, { label: "Öppna i stället", value: "open" }, { label: "Lägg till sist", value: "append", primary: true }],
  });
  try {
    if (choice === "append") await appendFiles(items, -1, settings.get("imageFit", "a4"));
    else if (choice === "open") await openFiles(items);
  } catch (err) {
    showError(err);
  }
});

// ---------- Öppna med (installerad app) ----------

if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const items = await Promise.all(params.files.map(async (handle) => ({ file: await handle.getFile(), handle })));
    openFiles(items);
  });
}

window.addEventListener("beforeunload", (e) => {
  if (app.doc.open && app.doc.dirty) e.preventDefault();
});

// ---------- Offline (service worker) ----------

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    const banner = document.getElementById("update-banner");
    const offer = (worker) => {
      banner.hidden = false;
      banner.querySelector("button").onclick = () => worker.postMessage("skipWaiting");
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) offer(w);
        if (w.state === "activated" && !navigator.serviceWorker.controller) toast("Appen fungerar nu även utan internet.", { type: "success" });
      });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  });
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !hadController) return;
    reloading = true;
    if (app.doc.open && app.doc.dirty) {
      toast("Uppdateringen är klar. Ladda om sidan när du har sparat.", { timeout: 10000 });
      return;
    }
    location.reload();
  });
}

window.__app = app; // för felsökning
export { busy };
