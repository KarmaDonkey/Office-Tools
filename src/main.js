import "@fontsource-variable/inter/wght.css";
import "./styles.css";
import { app, settings } from "./store.js";
import { PdfClient } from "./client.js";
import { h, iconButton, toast, showError, dialog } from "./ui/dom.js";
import { icon } from "./ui/icons.js";
import { initViewer, setZoom, zoomBy, animateZoom, setFit, goToPage } from "./ui/viewer.js";
import { initThumbs, toggleGrid } from "./ui/thumbs.js";
import { initSearch, toggleSearch, searchFor } from "./ui/search.js";
import { initPalette, openPalette, closePalette, isPaletteOpen } from "./ui/palette.js";
import { pickFiles, openFiles, openPdf, appendFiles, save, confirmDiscard } from "./ui/files.js";
import { listRecent, removeRecent, recentEnabled } from "./ui/recent.js";
import * as D from "./ui/dialogs.js";

const VERSION = __APP_VERSION__;

app.client = new PdfClient();
app.client.ready.catch((e) => showError(new Error("PDF-motorn kunde inte starta: " + e.message)));

// ---------- Tema ----------

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme ?? (darkQuery.matches ? "dark" : "light")) === "dark";

function applyTheme(mode) {
  settings.set("theme", mode);
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  app.emit("theme");
}
applyTheme(settings.get("theme", "auto"));
darkQuery.addEventListener("change", () => app.emit("theme"));

// ---------- Hjälp ----------

const needDoc = () => {
  if (!app.doc.open) {
    toast("Öppna en PDF först.");
    return false;
  }
  return true;
};
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

function insertBlank() {
  const p = app.doc.pages[app.currentPage];
  run("insertBlankPage", app.currentPage + 1, p?.w ?? 595, p?.h ?? 842);
}

// ---------- Menyer ----------

let openMenu = null;
function closeMenus() {
  if (!openMenu) return;
  const { menu, button } = openMenu;
  openMenu = null;
  button.setAttribute("aria-expanded", "false");
  menu.classList.add("closing");
  setTimeout(() => menu.remove(), 120);
}
document.addEventListener("pointerdown", (e) => {
  if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.button.contains(e.target)) closeMenus();
});

function attachMenu(button, itemsFn) {
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
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
              { type: "button", role: "menuitem", class: "menu-item", disabled: it.disabled, onclick: () => { closeMenus(); it.action(); } },
              it.icon ? icon(it.icon) : h("span", { class: "icon" }),
              h("span", {}, it.label),
              it.kbd ? h("kbd", {}, it.kbd) : null,
            ),
      ),
    );
    document.body.append(menu);
    const r = button.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const up = r.bottom + mh + 8 > window.innerHeight && r.top - mh - 8 > 0;
    menu.style.top = `${up ? r.top - mh - 8 : r.bottom + 8}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - (up ? mw / 2 : r.width / 2), window.innerWidth - mw - 8))}px`;
    menu.classList.toggle("up", up);
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
    { label: "Öppna …", icon: "folder-open", kbd: "Ctrl O", action: openDialog },
    { label: "Slå ihop filer …", icon: "combine", action: D.mergeDialog },
    { label: "Bilder till PDF …", icon: "images", action: D.imagesToPdf },
    "-",
    { label: "Spara", icon: "save", kbd: "Ctrl S", disabled: d, action: () => save() },
    { label: "Spara som …", icon: "save-all", kbd: "Ctrl ⇧ S", disabled: d, action: () => save({ as: true }) },
    "-",
    { label: "Stäng dokumentet", icon: "file-x", disabled: d, action: closeDocument },
  ];
};

const toolsMenu = () => {
  const d = !app.doc.open;
  return [
    { label: "Infoga filer …", icon: "file-plus", disabled: d, action: D.insertFilesDialog },
    { label: "Infoga tom sida", icon: "plus", disabled: d, action: insertBlank },
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
  { label: "Anpassa till bredd", icon: "move-horizontal", kbd: "Ctrl 0", action: () => setFit("width") },
  { label: "Hel sida", icon: "maximize-2", action: () => setFit("page") },
  "-",
  ...[50, 75, 100, 125, 150, 200, 300, 400].map((p) => ({ label: `${p} %`, action: () => animateZoom(p / 100) })),
];

// ---------- Verktyg ----------

const TOOLS = [
  { id: "select", icon: "mouse-pointer-2", label: "Pekare och formulär", key: "V" },
  { id: "highlight", icon: "highlighter", label: "Markera text", key: "H" },
  { id: "text", icon: "type", label: "Skriv text", key: "T" },
  { id: "draw", icon: "pen-line", label: "Rita", key: "D" },
  { id: "sign", icon: "signature", label: "Signera", key: "S" },
  { id: "redact", icon: "square-dashed", label: "Maskera område", key: "M" },
  { id: "erase", icon: "eraser", label: "Ta bort anteckning", key: "E" },
];

function selectTool(tool) {
  if (!needDoc()) return;
  if (tool === "sign") return D.signatureDialog();
  app.setTool(tool);
}

// ---------- Kommandopalett ----------

const COMMANDS = () => {
  const d = !app.doc.open;
  const c = (id, label, iconName, group, run, extra = {}) => ({ id, label, icon: iconName, group, run, ...extra });
  return [
    c("open", "Öppna PDF", "folder-open", "Arkiv", openDialog, { kbd: "Ctrl O", hint: "öppna en fil" }),
    c("merge", "Slå ihop filer", "combine", "Arkiv", D.mergeDialog, { hint: "kombinera PDF och bilder", keywords: "sammanfoga" }),
    c("images2pdf", "Bilder till PDF", "images", "Arkiv", D.imagesToPdf, { hint: "skapa PDF av foton", keywords: "jpg png konvertera" }),
    c("save", "Spara", "save", "Arkiv", () => save(), { kbd: "Ctrl S", disabled: d }),
    c("saveas", "Spara som", "save-all", "Arkiv", () => save({ as: true }), { kbd: "Ctrl ⇧ S", disabled: d, hint: "spara en kopia" }),
    c("close", "Stäng dokumentet", "file-x", "Arkiv", closeDocument, { disabled: d }),
    ...TOOLS.map((t) => c("tool-" + t.id, t.label, t.icon, "Verktyg", () => selectTool(t.id), { kbd: t.key, disabled: d })),
    c("search", "Sök i texten", "search", "Verktyg", () => toggleSearch(true), { kbd: "Ctrl F", disabled: d, keywords: "hitta" }),
    c("compress", "Komprimera", "file-archive", "Verktyg", D.compressDialog, { disabled: d, hint: "gör filen mindre", keywords: "minska storlek" }),
    c("split", "Dela upp", "scissors", "Sidor", D.splitDialog, { disabled: d, hint: "flera filer", keywords: "separera" }),
    c("extract", "Plocka ut sidor", "file-output", "Sidor", D.extractDialog, { disabled: d, hint: "spara valda sidor som ny fil" }),
    c("insert", "Infoga filer", "file-plus", "Sidor", D.insertFilesDialog, { disabled: d, hint: "lägg till PDF eller bilder" }),
    c("blank", "Infoga tom sida", "plus", "Sidor", insertBlank, { disabled: d }),
    c("rotr", "Rotera åt höger", "rotate-cw", "Sidor", () => pageActions.rotate(90), { disabled: d, hint: "valda sidor" }),
    c("rotl", "Rotera åt vänster", "rotate-ccw", "Sidor", () => pageActions.rotate(-90), { disabled: d, hint: "valda sidor" }),
    c("delete", "Ta bort sidor", "trash-2", "Sidor", pageActions.remove, { disabled: d, hint: "valda sidor" }),
    c("grid", "Sidöversikt", "layout-grid", "Sidor", () => toggleGrid(), { disabled: d, hint: "alla sidor i rutnät" }),
    c("image", "Infoga bild på sidan", "image", "Redigera", D.placeImage, { disabled: d, keywords: "logotyp foto" }),
    c("watermark", "Vattenstämpel", "stamp", "Redigera", D.watermarkDialog, { disabled: d, keywords: "utkast konfidentiellt" }),
    c("pagenumbers", "Sidnummer", "hash", "Redigera", D.pageNumbersDialog, { disabled: d, keywords: "numrera" }),
    c("redact-apply", "Verkställ maskering", "shield-check", "Redigera", D.applyRedactionsDialog, { disabled: d, keywords: "svärta dölj" }),
    c("export", "PDF till bilder", "file-image", "Exportera", D.exportImagesDialog, { disabled: d, keywords: "png jpg konvertera" }),
    c("metadata", "Metadata", "info", "Dokument", D.metadataDialog, { disabled: d, keywords: "titel författare egenskaper" }),
    c("password", "Lösenord", "lock", "Dokument", D.passwordDialog, { disabled: d, keywords: "kryptera skydda lås" }),
    c("undo", "Ångra", "undo-2", "Redigera", () => run("undo"), { kbd: "Ctrl Z", disabled: d || !app.doc.canUndo, hint: app.doc.undoLabel ?? "" }),
    c("redo", "Gör om", "redo-2", "Redigera", () => run("redo"), { kbd: "Ctrl Y", disabled: d || !app.doc.canRedo, hint: app.doc.redoLabel ?? "" }),
    c("fitw", "Anpassa till bredd", "move-horizontal", "Visa", () => setFit("width"), { kbd: "Ctrl 0", disabled: d, keywords: "zoom" }),
    c("fitp", "Hel sida", "maximize-2", "Visa", () => setFit("page"), { disabled: d, keywords: "zoom" }),
    c("theme", isDark() ? "Ljust läge" : "Mörkt läge", isDark() ? "sun" : "moon", "Visa", toggleTheme, { keywords: "tema färg" }),
    c("settings", "Inställningar", "settings", "App", () => D.settingsDialog({ applyTheme }), { keywords: "integritet tema" }),
    c("about", "Om PDF-verktyg", "info", "App", () => D.aboutDialog(VERSION), { keywords: "licens version kortkommandon" }),
  ];
};
initPalette({ commands: COMMANDS, onSearchText: (q) => searchFor(q) });

function toggleTheme() {
  applyTheme(isDark() ? "light" : "dark");
}

// ---------- Övre fältet ----------

const appbar = document.getElementById("appbar");
const undoBtn = iconButton("undo-2", "Ångra", () => run("undo"));
const redoBtn = iconButton("redo-2", "Gör om", () => run("redo"));
const saveBtn = h("button", { type: "button", class: "btn btn-grad save-btn", onclick: () => save(), title: "Spara (Ctrl+S)" }, icon("save"), h("span", { class: "btn-label" }, "Spara"));
const themeBtn = iconButton("sun", "Byt tema", toggleTheme, { class: "theme-btn" });
const fileTitle = h("b", {});
const fileStatus = h("span", { class: "file-status" });
const lockBadge = h("span", { class: "badge-lock", hidden: true }, icon("lock"), h("span", {}, "AES-256"));
lockBadge.addEventListener("click", () => app.doc.open && D.passwordDialog());
const cmdk = h("button", { type: "button", class: "cmdk", onclick: () => openPalette() }, icon("search"), h("span", { class: "cmdk-text" }, "Sök funktion eller text …"), h("kbd", {}, "Ctrl K"));

appbar.append(
  h("div", { class: "brand-mark", "aria-hidden": "true" }, icon("file-text")),
  attachMenu(h("button", { type: "button", class: "ghost-btn file-btn", title: "Arkiv" }, h("span", { class: "fname" }, fileTitle, fileStatus), icon("chevron-down")), fileMenu),
  h("div", { class: "group doc-only" }, iconButton("panel-left", "Visa eller dölj sidorna", toggleSidebar, { class: "sidebar-toggle" }), undoBtn, redoBtn),
  cmdk,
  h("span", { class: "spacer" }),
  lockBadge,
  themeBtn,
  attachMenu(iconButton("settings", "Inställningar"), settingsMenu),
  saveBtn,
);

// ---------- Flytande verktygspanel ----------

const dock = document.getElementById("dock");
const toolButtons = {};
for (const t of TOOLS) {
  const b = h("button", { type: "button", class: "dock-btn", "aria-label": t.label, "aria-pressed": "false", dataset: { tip: t.label, kbd: t.key }, onclick: () => selectTool(t.id) }, icon(t.icon));
  toolButtons[t.id] = b;
}
const gridBtn = h("button", { type: "button", class: "dock-btn dock-extra", "aria-label": "Sidöversikt", dataset: { tip: "Sidöversikt" }, onclick: () => toggleGrid() }, icon("layout-grid"));
const searchBtn = h("button", { type: "button", class: "dock-btn dock-extra", "aria-label": "Sök i texten", dataset: { tip: "Sök", kbd: "Ctrl F" }, onclick: () => toggleSearch() }, icon("search"));
const toolsBtn = attachMenu(h("button", { type: "button", class: "dock-btn", "aria-label": "Fler verktyg", dataset: { tip: "Fler verktyg" } }, icon("wrench")), toolsMenu);
dock.append(...Object.values(toolButtons), h("i", { class: "dock-sep dock-extra" }), gridBtn, searchBtn, toolsBtn);

// Alternativ för aktivt verktyg (visas ovanför panelen)
const toolPop = document.getElementById("tool-pop");
const SWATCHES = {
  highlightColor: ["#ffd400", "#5dff9d", "#5ce1ff", "#ff6bd5", "#ffa94d"],
  inkColor: ["#e0245e", "#7c5cff", "#1d2a8f", "#111111", "#1a9f55"],
  textColor: ["#111111", "#1d2a8f", "#e0245e", "#1a9f55"],
};
const persistOptions = () => settings.set("toolOptions", app.toolOptions);

function swatches(key) {
  const wrap = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Färg" });
  const custom = h("input", { type: "color", value: app.toolOptions[key], title: "Egen färg", "aria-label": "Egen färg" });
  const draw = () =>
    wrap.replaceChildren(
      ...SWATCHES[key].map((c) => h("button", { type: "button", class: "swatch" + (app.toolOptions[key] === c ? " on" : ""), style: { background: c }, title: c, "aria-label": `Färg ${c}`, onclick: () => { app.toolOptions[key] = c; persistOptions(); draw(); } })),
      custom,
    );
  custom.addEventListener("input", () => {
    app.toolOptions[key] = custom.value;
    persistOptions();
    draw();
  });
  draw();
  return wrap;
}

function slider(label, key, min, max, step, fmt) {
  const out = h("output", {}, fmt(app.toolOptions[key]));
  const input = h("input", { type: "range", min, max, step, value: app.toolOptions[key], "aria-label": label });
  const paint = () => input.style.setProperty("--p", `${((input.value - min) / (max - min)) * 100}%`);
  input.addEventListener("input", () => {
    app.toolOptions[key] = Number(input.value);
    out.textContent = fmt(input.value);
    paint();
    persistOptions();
  });
  paint();
  return h("label", { class: "opt" }, h("span", {}, label), input, out);
}

const pct = (v) => `${Math.round(v * 100)} %`;
const pt = (v) => `${v} pt`;

function renderToolPop() {
  const t = app.tool;
  const hint = (text) => h("span", { class: "hint" }, text);
  const sep = () => h("i", { class: "pop-sep" });
  let content = null;
  if (t === "highlight") content = [swatches("highlightColor"), sep(), slider("Opacitet", "highlightOpacity", 0.2, 1, 0.05, pct)];
  else if (t === "draw") content = [swatches("inkColor"), sep(), slider("Tjocklek", "inkWidth", 0.5, 12, 0.5, pt), slider("Opacitet", "inkOpacity", 0.2, 1, 0.05, pct)];
  else if (t === "text") content = [swatches("textColor"), sep(), slider("Storlek", "textSize", 6, 48, 1, pt)];
  else if (t === "redact") content = [hint("Dra en ruta över det som ska döljas."), h("button", { type: "button", class: "btn btn-small btn-danger", onclick: D.applyRedactionsDialog }, icon("shield-check"), "Verkställ maskering")];
  else if (t === "erase") content = [hint("Klicka på en anteckning för att ta bort den.")];
  else if (t === "stamp") content = [hint(`Klicka där ${app.stamp?.label === "Infoga bild" ? "bilden" : "signaturen"} ska stå, eller dra för att välja storlek.`), h("button", { type: "button", class: "btn btn-small", onclick: () => app.setTool("select") }, "Avbryt")];
  toolPop.replaceChildren(...(content ?? []));
  toolPop.classList.toggle("show", !!content);
}

Object.assign(app.toolOptions, settings.get("toolOptions", {}));

// Sidräknare och zoom
const pageInput = h("input", { type: "text", inputmode: "numeric", class: "page-input", "aria-label": "Gå till sida" });
const pageCount = h("span", {});
pageInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const n = parseInt(pageInput.value, 10);
  if (n >= 1 && n <= app.doc.pageCount) goToPage(n - 1, { smooth: true });
  else pageInput.value = app.currentPage + 1;
  pageInput.blur();
});
pageInput.addEventListener("focus", () => pageInput.select());
document.getElementById("pager").append(h("span", {}, "Sida"), pageInput, pageCount);

const zoomLabel = h("span", {}, "100 %");
document.getElementById("zoombox").append(
  iconButton("zoom-out", "Zooma ut (Ctrl −)", () => zoomBy(1 / 1.25)),
  attachMenu(h("button", { type: "button", class: "zoom-level", title: "Zoomnivå" }, zoomLabel), zoomMenu),
  iconButton("zoom-in", "Zooma in (Ctrl +)", () => zoomBy(1.25)),
);

// ---------- Sidpanel ----------

const sidebar = document.getElementById("sidebar");
function toggleSidebar() {
  if (window.matchMedia("(max-width: 900px)").matches) document.body.classList.toggle("sidebar-open");
  else document.body.classList.toggle("sidebar-hidden");
}
document.querySelector(".sidebar-scrim").addEventListener("click", () => document.body.classList.remove("sidebar-open"));

// ---------- Startskärm ----------

const start = document.getElementById("start");
async function renderStart() {
  const recents = recentEnabled() && window.showOpenFilePicker ? await listRecent() : [];
  const fmtDate = (t) => {
    const d = new Date(t);
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 864e5);
    const time = new Intl.DateTimeFormat("sv-SE", { timeStyle: "short" }).format(d);
    if (days === 0) return `I dag ${time}`;
    if (days === 1) return `I går ${time}`;
    return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short" }).format(d);
  };
  start.replaceChildren(
    h(
      "div",
      { class: "start-inner" },
      h("h1", { class: "hero" }, "Allt du gör med PDF.", h("br", {}), h("em", {}, "Utan att något lämnar datorn.")),
      h("p", { class: "lead" }, icon("shield-check"), "Fungerar offline · Inga uppladdningar · Ingen spårning"),
      h(
        "div",
        { class: "dropz" },
        h(
          "div",
          { class: "dropz-in" },
          h("div", { class: "dropz-icon" }, icon("upload")),
          h("h2", {}, "Släpp PDF-filer eller bilder här"),
          h(
            "div",
            { class: "start-actions" },
            h("button", { type: "button", class: "btn btn-grad btn-large", onclick: openDialog }, icon("folder-open"), "Öppna PDF"),
            h("button", { type: "button", class: "btn btn-large", onclick: D.mergeDialog }, icon("combine"), "Slå ihop"),
            h("button", { type: "button", class: "btn btn-large", onclick: D.imagesToPdf }, icon("images"), "Bilder till PDF"),
          ),
          h("p", { class: "muted" }, "Tips: tryck ", h("kbd", {}, "Ctrl K"), " för att hitta alla funktioner."),
        ),
      ),
      recents.length
        ? h(
            "section",
            { class: "recent" },
            h("h3", {}, icon("clock"), "Senaste filer"),
            h(
              "div",
              { class: "rgrid" },
              recents.slice(0, 8).map((r) =>
                h(
                  "div",
                  { class: "rcard" },
                  h(
                    "button",
                    { type: "button", class: "rcard-open", onclick: () => openRecent(r), title: `Öppna ${r.name}` },
                    h("div", { class: "rprev" }, r.thumb ? h("img", { src: r.thumb, alt: "" }) : h("div", { class: "rprev-empty" }, icon(r.thumb === null ? "lock" : "file-text"))),
                    h("div", { class: "rmeta" }, h("b", {}, r.name), h("small", {}, fmtDate(r.opened))),
                  ),
                  iconButton("x", `Ta bort ${r.name} från listan`, async () => {
                    await removeRecent(r.id);
                    renderStart();
                  }, { class: "rcard-x" }),
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
  saveBtn.hidden = !d.open;
  pageCount.textContent = d.open ? `av ${d.pageCount}` : "";
  if (document.activeElement !== pageInput) pageInput.value = d.open ? app.currentPage + 1 : "";
  const name = app.file.name || (d.open ? "Namnlös.pdf" : "PDF-verktyg");
  fileTitle.textContent = name;
  const pages = d.open ? `${d.pageCount} ${d.pageCount === 1 ? "sida" : "sidor"}` : "Arkiv";
  fileStatus.replaceChildren(d.open && d.dirty ? h("i", { class: "dirty-dot" }) : "", d.open ? (d.dirty ? `Osparade ändringar · ${pages}` : `Sparad · ${pages}`) : "Öppna, slå ihop, skapa");
  const mode = app.saveEncryption.mode;
  const locked = d.open && (mode === "set" || (d.encrypted && mode === "keep"));
  lockBadge.hidden = !d.open || !(locked || (d.encrypted && mode === "none"));
  lockBadge.classList.toggle("off", d.open && d.encrypted && mode === "none");
  lockBadge.title = locked ? (mode === "set" ? "Lösenord sätts när du sparar" : "Lösenordsskyddad") : "Lösenordet tas bort när du sparar";
  lockBadge.lastChild.textContent = locked ? "AES-256" : "Utan lösenord";
  document.title = d.open ? `${d.dirty ? "• " : ""}${name} – PDF-verktyg` : "PDF-verktyg";
  if (!d.open) renderStart();
}

app.on("doc", updateUi);
app.on("file", updateUi);
app.on("encryption", updateUi);
app.on("recent", () => !app.doc.open && renderStart());
app.on("theme", () => {
  themeBtn.replaceChildren(icon(isDark() ? "sun" : "moon"));
  themeBtn.title = isDark() ? "Byt till ljust läge" : "Byt till mörkt läge";
});
app.on("page", (i) => {
  if (document.activeElement !== pageInput) pageInput.value = i + 1;
});
app.on("zoom", (z) => (zoomLabel.textContent = `${Math.round(z * 100)} %`));
app.on("tool", (t) => {
  for (const [id, b] of Object.entries(toolButtons)) {
    const on = id === t || (id === "sign" && t === "stamp" && app.stamp?.label === "Signera");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  renderToolPop();
});
app.on("notice", (m) => toast(m));

// ---------- Init ----------

initViewer(document.getElementById("viewer"));
initThumbs(sidebar, pageActions);
initSearch(document.getElementById("search-panel"));
app.setTool("select");
app.emit("theme");
updateUi();

// ---------- Tangentbord ----------

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  const k = e.key.toLowerCase();
  if (mod && k === "k") {
    e.preventDefault();
    if (isPaletteOpen()) closePalette();
    else if (!document.querySelector("dialog[open]")) openPalette();
    return;
  }
  if (document.querySelector("dialog[open]") || isPaletteOpen()) return;
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
    zoomBy(1.25);
  } else if (mod && k === "-") {
    e.preventDefault();
    zoomBy(1 / 1.25);
  } else if (mod && k === "0") {
    e.preventDefault();
    setFit("width");
  } else if (e.key === "Escape") {
    closeMenus();
    if (app.tool !== "select") app.setTool("select");
    else if (document.body.classList.contains("grid-mode")) toggleGrid(false);
  } else if (!mod && !e.altKey && app.doc.open && !e.target.closest?.(".thumb-list")) {
    const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
    if (tool) {
      e.preventDefault();
      selectTool(tool.id);
    }
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
export { setZoom };
