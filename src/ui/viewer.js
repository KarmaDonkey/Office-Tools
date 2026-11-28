// Sidvisaren: rendering, zoom, verktyg, sökträffar och formulärfält.
import { app } from "../store.js";
import { h, showError, hexToRgb } from "./dom.js";

const PX_PER_PT = 96 / 72;
const MAX_PIXELS = 16_000_000;
const GAP = 16;

let root; // scrollbar container
let pagesEl;
let pageEls = [];
let visible = new Set();
let observer;
let renderTimer = 0;
let lastLayoutRev = -1;
const widgetCache = new Map(); // `${rev}:${i}` -> widgets
const annotCache = new Map(); // `${rev}:${i}` -> annots

export const cssScale = () => app.zoom * PX_PER_PT;

export function initViewer(el) {
  root = el;
  pagesEl = h("div", { class: "pages" });
  root.append(pagesEl);

  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const i = Number(e.target.dataset.index);
        if (e.isIntersecting) visible.add(i);
        else {
          visible.delete(i);
          releasePage(i);
        }
      }
      scheduleRender();
      refreshOverlays();
    },
    { root, rootMargin: "100% 0px" },
  );

  root.addEventListener("scroll", onScroll, { passive: true });
  root.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0025);
      setZoom(app.zoom * factor, { x: e.clientX, y: e.clientY });
    },
    { passive: false },
  );
  new ResizeObserver(() => {
    if (app.fit) applyFit();
  }).observe(root);

  pagesEl.addEventListener("pointerdown", onPointerDown);
  pagesEl.addEventListener("click", onClick);

  app.on("doc", ({ prev, state }) => onDoc(prev, state));
  app.on("tool", () => {
    root.dataset.tool = app.tool;
    clearPreview();
    refreshOverlays();
  });
  app.on("search", () => refreshOverlays());
  root.dataset.tool = app.tool;
}

// ---------- Layout ----------

function onDoc(prev, state) {
  if (!state.open) {
    pagesEl.replaceChildren();
    pageEls = [];
    visible.clear();
    widgetCache.clear();
    annotCache.clear();
    return;
  }
  const newDoc = !prev.open || app.freshDoc;
  if (newDoc) {
    app.freshDoc = false;
    pageEls.forEach((_, i) => releasePage(i));
    root.scrollTop = 0;
  }
  const n = state.pageCount;
  // Lägg till eller ta bort sidelement så att antalet stämmer.
  while (pageEls.length < n) {
    const i = pageEls.length;
    const canvas = h("canvas", { class: "page-canvas" });
    const overlay = h("div", { class: "page-overlay" });
    const el = h("div", { class: "page", dataset: { index: i } }, canvas, overlay);
    pagesEl.append(el);
    observer.observe(el);
    pageEls.push({ el, canvas, overlay, key: null, pending: null });
  }
  while (pageEls.length > n) {
    const pe = pageEls.pop();
    observer.unobserve(pe.el);
    visible.delete(pageEls.length);
    pe.el.remove();
  }
  for (const k of widgetCache.keys()) if (!k.startsWith(state.rev + ":")) widgetCache.delete(k);
  for (const k of annotCache.keys()) if (!k.startsWith(state.rev + ":")) annotCache.delete(k);
  if (newDoc || lastLayoutRev === -1) {
    app.fit = "width";
    applyFit();
    root.scrollTop = 0;
    root.scrollLeft = 0;
    app.currentPage = 0;
    app.emit("page", 0);
  } else layout();
  lastLayoutRev = state.rev;
  scheduleRender(0);
  refreshOverlays();
}

function layout() {
  const s = cssScale();
  pagesEl.style.setProperty("--z", s);
  const pages = app.doc.pages ?? [];
  pageEls.forEach((pe, i) => {
    const p = pages[i];
    pe.el.style.width = `${Math.round(p.w * s)}px`;
    pe.el.style.height = `${Math.round(p.h * s)}px`;
  });
}

function applyFit() {
  if (!app.doc.open || !app.fit || !app.doc.pageCount) return;
  const pages = app.doc.pages;
  const availW = root.clientWidth - 2 * GAP - 4;
  const availH = root.clientHeight - 2 * GAP;
  const cur = pages[app.currentPage] ?? pages[0];
  const maxW = Math.max(...pages.map((p) => p.w));
  let z = availW / (maxW * PX_PER_PT);
  if (app.fit === "page") z = Math.min(availW / (cur.w * PX_PER_PT), availH / (cur.h * PX_PER_PT));
  setZoom(z, null, true);
}

export function setFit(mode) {
  app.fit = mode;
  applyFit();
}

export function setZoom(z, anchor = null, keepFit = false) {
  if (!app.doc.open) return;
  z = Math.min(6, Math.max(0.1, z));
  if (!keepFit) app.fit = null;
  const rect = root.getBoundingClientRect();
  const ax = anchor ? anchor.x - rect.left : root.clientWidth / 2;
  const ay = anchor ? anchor.y - rect.top : root.clientHeight / 2;
  const fx = (root.scrollLeft + ax) / Math.max(1, pagesEl.scrollWidth);
  const fy = (root.scrollTop + ay) / Math.max(1, pagesEl.scrollHeight);
  app.zoom = z;
  layout();
  root.scrollLeft = fx * pagesEl.scrollWidth - ax;
  root.scrollTop = fy * pagesEl.scrollHeight - ay;
  app.emit("zoom", z);
  scheduleRender();
}

let zoomAnim = 0;
export function zoomBy(factor) {
  animateZoom(app.zoom * factor);
}

// Mjuk zoom till en ny nivå.
export function animateZoom(target) {
  cancelAnimationFrame(zoomAnim);
  target = Math.min(6, Math.max(0.1, target));
  const from = app.zoom;
  const t0 = performance.now();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const step = (t) => {
    const k = reduce ? 1 : Math.min(1, (t - t0) / 160);
    const e = 1 - Math.pow(1 - k, 3);
    setZoom(from * Math.pow(target / from, e));
    if (k < 1) zoomAnim = requestAnimationFrame(step);
  };
  zoomAnim = requestAnimationFrame(step);
}

// Flyttar redan renderade sidbilder till sina nya platser direkt efter en omordning,
// så att visningen inte blinkar medan sidorna renderas om.
export function applyOrder(order) {
  const canvases = pageEls.map((pe) => pe.canvas);
  canvases.forEach((c) => c.remove());
  order.forEach((from, to) => {
    if (pageEls[to] && canvases[from]) pageEls[to].canvas = canvases[from];
  });
  pageEls.forEach((pe) => {
    pe.el.prepend(pe.canvas);
    pe.el.classList.toggle("rendered", pe.canvas.width > 0);
    pe.key = null;
    pe.pending = null;
  });
}

// ---------- Rendering ----------

function scheduleRender(delay = 120) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderVisible, delay);
}

function renderVisible() {
  if (!app.doc.open) return;
  const pages = app.doc.pages;
  const dpr = window.devicePixelRatio || 1;
  const noWidgets = app.doc.hasForms;
  app.client.cancelRenders((k) => k.startsWith("main:") && !visible.has(Number(k.slice(5))));
  for (const i of visible) {
    const pe = pageEls[i];
    const p = pages[i];
    if (!pe || !p) continue;
    const scale = Math.min(cssScale() * dpr, Math.sqrt(MAX_PIXELS / (p.w * p.h)));
    const key = `${app.doc.rev}:${scale.toFixed(4)}:${noWidgets ? 0 : 1}`;
    if (pe.key === key || pe.pending === key) continue;
    pe.pending = key;
    app.client
      .render("main:" + i, Math.abs(i - app.currentPage), i, scale, !noWidgets)
      .then((res) => {
        if (!res) return;
        if (pe.pending !== key || pageEls[i] !== pe) return res.bitmap.close();
        pe.canvas.width = res.width;
        pe.canvas.height = res.height;
        pe.canvas.getContext("2d").drawImage(res.bitmap, 0, 0);
        res.bitmap.close();
        pe.key = key;
        pe.pending = null;
        pe.el.classList.add("rendered");
      })
      .catch((e) => {
        pe.pending = null;
        console.error(e);
      });
  }
}

function releasePage(i) {
  const pe = pageEls[i];
  if (!pe || !pe.key) return;
  pe.canvas.width = 0;
  pe.canvas.height = 0;
  pe.key = null;
  pe.pending = null;
  pe.el.classList.remove("rendered");
}

// ---------- Navigering ----------

function onScroll() {
  if (!pageEls.length) return;
  const line = root.scrollTop + root.clientHeight * 0.35;
  let lo = 0;
  let hi = pageEls.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const el = pageEls[mid].el;
    if (el.offsetTop + el.offsetHeight + GAP / 2 < line) lo = mid + 1;
    else hi = mid;
  }
  if (lo !== app.currentPage) {
    app.currentPage = lo;
    app.emit("page", lo);
  }
}

export function goToPage(i, { y = null, smooth = false } = {}) {
  const pe = pageEls[i];
  if (!pe) return;
  let top = pe.el.offsetTop - GAP;
  if (y != null) {
    const p = app.doc.pages[i];
    top = pe.el.offsetTop + (y - p.y0) * cssScale() - root.clientHeight / 3;
  }
  root.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
  app.currentPage = i;
  app.emit("page", i);
}

// ---------- Koordinater ----------

function pagePoint(i, clientX, clientY) {
  const r = pageEls[i].el.getBoundingClientRect();
  const p = app.doc.pages[i];
  const s = r.width / p.w;
  return [(clientX - r.left) / s + p.x0, (clientY - r.top) / s + p.y0];
}

function pctBox(i, [x0, y0, x1, y1]) {
  const p = app.doc.pages[i];
  return {
    left: `${((Math.min(x0, x1) - p.x0) / p.w) * 100}%`,
    top: `${((Math.min(y0, y1) - p.y0) / p.h) * 100}%`,
    width: `${(Math.abs(x1 - x0) / p.w) * 100}%`,
    height: `${(Math.abs(y1 - y0) / p.h) * 100}%`,
  };
}

const quadRect = (q) => [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])];

// ---------- Overlager ----------

function layer(pe, name) {
  let l = pe.overlay.querySelector(`:scope > .${name}`);
  if (!l) {
    l = h("div", { class: `layer ${name}` });
    pe.overlay.append(l);
  }
  return l;
}

function refreshOverlays() {
  if (!app.doc.open) return;
  for (const i of visible) {
    const pe = pageEls[i];
    if (!pe) continue;
    drawSearchHits(i, pe);
    if (app.doc.hasForms) drawForms(i, pe);
    else pe.overlay.querySelector(":scope > .forms")?.replaceChildren();
    if (app.tool === "erase") drawAnnotBoxes(i, pe);
    else pe.overlay.querySelector(":scope > .annots")?.replaceChildren();
  }
}

function drawSearchHits(i, pe) {
  const l = layer(pe, "hits");
  const { flat, current } = app.search;
  const items = [];
  flat.forEach((hit, k) => {
    if (hit.page !== i) return;
    for (const q of hit.quads) items.push(h("div", { class: "hit" + (k === current ? " current" : ""), style: pctBox(i, quadRect(q)) }));
  });
  l.replaceChildren(...items);
}

async function drawForms(i, pe) {
  const key = `${app.doc.rev}:${i}`;
  let widgets = widgetCache.get(key);
  if (!widgets) {
    try {
      widgets = await app.client.call("getWidgets", i);
    } catch (e) {
      return console.error(e);
    }
    widgetCache.set(key, widgets);
  }
  if (!key.startsWith(app.doc.rev + ":")) return;
  const l = layer(pe, "forms");
  const existing = new Map([...l.children].map((c) => [c.dataset.key, c]));
  const seen = new Set();
  for (const w of widgets) {
    const k = `${w.idx}:${w.type}:${w.name}`;
    seen.add(k);
    let el = existing.get(k);
    if (!el) {
      el = createWidgetEl(i, w);
      if (!el) continue;
      el.dataset.key = k;
      l.append(el);
    }
    Object.assign(el.style, pctBox(i, w.rect));
    updateWidgetEl(el, w);
  }
  for (const [k, el] of existing) if (!seen.has(k)) el.remove();
}

function createWidgetEl(i, w) {
  const fontPt = Math.max(6, Math.min(14, (w.rect[3] - w.rect[1]) * 0.65));
  const commit = async (value) => {
    try {
      app.setDoc(await app.client.call("setWidget", i, w.idx, value));
    } catch (e) {
      showError(e);
    }
  };
  let el;
  if (w.type === "text") {
    el = w.multiline ? h("textarea", {}) : h("input", { type: w.password ? "password" : "text" });
    if (w.maxLen > 0) el.maxLength = w.maxLen;
    el.addEventListener("change", () => commit(el.value));
    el.style.setProperty("--fpt", w.multiline ? 10 : fontPt);
  } else if (w.type === "checkbox" || w.type === "radio") {
    el = h("input", { type: "checkbox", class: w.type === "radio" ? "is-radio" : "" });
    el.addEventListener("change", () => commit(el.checked));
  } else if (w.type === "combo" || w.type === "list") {
    el = h("select", { size: w.type === "list" ? Math.max(2, Math.min(6, w.options.length)) : null }, w.type === "combo" ? h("option", { value: "" }, "") : null, w.options.map((o) => h("option", { value: o }, o)));
    el.addEventListener("change", () => commit(el.value));
    el.style.setProperty("--fpt", fontPt);
  } else return null;
  el.classList.add("form-field");
  el.title = w.name;
  el.setAttribute("aria-label", w.name);
  el.disabled = w.readOnly;
  return el;
}

function updateWidgetEl(el, w) {
  if (document.activeElement === el) return;
  if (el.type === "checkbox") el.checked = w.checked;
  else if (el.value !== w.value) el.value = w.value;
}

async function drawAnnotBoxes(i, pe) {
  const key = `${app.doc.rev}:${i}`;
  let annots = annotCache.get(key);
  if (!annots) {
    annots = await app.client.call("listAnnots", i);
    annotCache.set(key, annots);
  }
  if (app.tool !== "erase") return;
  const l = layer(pe, "annots");
  l.replaceChildren(
    ...annots.map((a) =>
      h("button", {
        type: "button",
        class: "annot-box",
        title: `Ta bort (${annotName(a.type)})`,
        style: pctBox(i, a.rect),
        onclick: async (e) => {
          e.stopPropagation();
          try {
            app.setDoc(await app.client.call("deleteAnnot", i, a.idx));
          } catch (err) {
            showError(err);
          }
        },
      }),
    ),
  );
}

const ANNOT_NAMES = { Highlight: "markering", Ink: "ritning", FreeText: "text", Stamp: "signatur/bild", Redact: "maskering", Text: "kommentar", Square: "rektangel", Circle: "cirkel", Line: "linje", Underline: "understrykning", StrikeOut: "överstrykning" };
const annotName = (t) => ANNOT_NAMES[t] ?? t;

// ---------- Verktyg ----------

let preview = null;

function clearPreview() {
  preview?.remove();
  preview = null;
}

function pageIndexOf(target) {
  const el = target.closest?.(".page");
  return el ? Number(el.dataset.index) : -1;
}

function onClick(e) {
  if (app.tool !== "select") return;
  if (e.target.closest(".form-field")) return;
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const i = pageIndexOf(e.target);
  if (i < 0) return;
  if (e.target.closest(".form-field, .annot-box, .text-editor")) return;
  const tool = app.tool;
  if (tool === "select" || tool === "erase") return;
  e.preventDefault();
  const pe = pageEls[i];
  const start = pagePoint(i, e.clientX, e.clientY);
  const el = pe.el;
  el.setPointerCapture(e.pointerId);

  if (tool === "text") {
    el.releasePointerCapture(e.pointerId);
    return startText(i, start);
  }

  clearPreview();
  let last = start;
  let points = [start];
  let quads = [];
  let hlTimer = 0;
  let hlBusy = false;

  if (tool === "draw") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const p = app.doc.pages[i];
    svg.setAttribute("viewBox", `${p.x0} ${p.y0} ${p.w} ${p.h}`);
    svg.setAttribute("class", "preview-svg");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", app.toolOptions.inkColor);
    line.setAttribute("stroke-width", app.toolOptions.inkWidth);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-opacity", app.toolOptions.inkOpacity ?? 1);
    line.setAttribute("stroke-linejoin", "round");
    svg.append(line);
    pe.overlay.append(svg);
    preview = svg;
    preview.line = line;
  } else if (tool === "highlight") {
    preview = h("div", { class: "layer preview-hl" });
    pe.overlay.append(preview);
  } else {
    preview = h("div", { class: `preview-rect preview-${tool}` });
    if (tool === "stamp" && app.stamp) preview.append(h("img", { src: app.stamp.url, alt: "" }));
    pe.overlay.append(preview);
  }

  const updateHighlight = async () => {
    if (hlBusy) return;
    hlBusy = true;
    try {
      quads = await app.client.call("highlightQuads", i, start, last);
      if (preview?.classList.contains("preview-hl")) preview.replaceChildren(...quads.map((q) => h("div", { class: "hl", style: { ...pctBox(i, quadRect(q)), background: app.toolOptions.highlightColor } })));
    } finally {
      hlBusy = false;
    }
  };

  const move = (ev) => {
    last = pagePoint(i, ev.clientX, ev.clientY);
    if (tool === "draw") {
      points.push(last);
      preview.line.setAttribute("points", points.map((p) => p.join(",")).join(" "));
    } else if (tool === "highlight") {
      clearTimeout(hlTimer);
      hlTimer = setTimeout(updateHighlight, 30);
    } else if (preview) {
      Object.assign(preview.style, pctBox(i, stampRect(tool, start, last)));
    }
  };

  const up = async () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    clearTimeout(hlTimer);
    const dist = Math.hypot(last[0] - start[0], last[1] - start[1]);
    try {
      if (tool === "draw") {
        if (points.length >= 2) app.setDoc(await app.client.call("addInk", i, [simplify(points)], hexToRgb(app.toolOptions.inkColor), Number(app.toolOptions.inkWidth), Number(app.toolOptions.inkOpacity ?? 1)));
      } else if (tool === "highlight") {
        if (dist > 1) {
          quads = await app.client.call("highlightQuads", i, start, last);
          if (quads.length) app.setDoc(await app.client.call("addHighlight", i, quads, hexToRgb(app.toolOptions.highlightColor), Number(app.toolOptions.highlightOpacity ?? 1)));
          else app.emit("notice", "Ingen text hittades där. Dra över texten du vill markera.");
        }
      } else if (tool === "redact") {
        if (dist > 3) app.setDoc(await app.client.call("addRedaction", i, normRect(start, last)));
      } else if (tool === "stamp" && app.stamp) {
        const rect = clampRect(i, stampRect(tool, start, last, dist < 5));
        app.setDoc(await app.client.call("addImageStamp", i, rect, app.stamp.bytes.slice(), app.stamp.label));
        app.setTool("select");
      }
    } catch (err) {
      showError(err);
    } finally {
      clearPreview();
    }
  };

  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function normRect(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

// Rektangel för signatur/bild med bibehållna proportioner.
function stampRect(tool, a, b, click = false) {
  if (tool !== "stamp" || !app.stamp) return normRect(a, b);
  const ratio = app.stamp.height / app.stamp.width;
  if (click) {
    const w = app.stamp.defaultWidth ?? 160;
    return [a[0] - w / 2, a[1] - (w * ratio) / 2, a[0] + w / 2, a[1] + (w * ratio) / 2];
  }
  const w = Math.max(10, Math.abs(b[0] - a[0]));
  const x0 = b[0] < a[0] ? a[0] - w : a[0];
  const y0 = b[1] < a[1] ? a[1] - w * ratio : a[1];
  return [x0, y0, x0 + w, y0 + w * ratio];
}

function clampRect(i, r) {
  const p = app.doc.pages[i];
  const w = r[2] - r[0];
  const hgt = r[3] - r[1];
  const x0 = Math.min(Math.max(r[0], p.x0), p.x0 + p.w - w);
  const y0 = Math.min(Math.max(r[1], p.y0), p.y0 + p.h - hgt);
  return [x0, y0, x0 + w, y0 + hgt];
}

// Glesar ut punkter som ligger väldigt nära varandra.
function simplify(points) {
  const out = [points[0]];
  for (const p of points.slice(1)) {
    const q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.75) out.push(p);
  }
  if (out.length === 1) out.push(points[points.length - 1]);
  return out;
}

function startText(i, at) {
  const pe = pageEls[i];
  pe.overlay.querySelector(".text-editor")?.blur();
  const size = Number(app.toolOptions.textSize);
  const p = app.doc.pages[i];
  const ta = h("textarea", {
    class: "text-editor",
    rows: 1,
    placeholder: "Skriv text …",
    style: {
      left: `${((at[0] - p.x0) / p.w) * 100}%`,
      top: `${((at[1] - p.y0) / p.h) * 100}%`,
      color: app.toolOptions.textColor,
    },
  });
  ta.style.setProperty("--fpt", size);
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const text = ta.value.replace(/\s+$/, "");
    ta.remove();
    if (!commit || !text) return;
    try {
      const m = await app.client.call("measureText", text, size);
      const rect = clampRect(i, [at[0], at[1], at[0] + m.width + size * 0.6, at[1] + m.lines * size * 1.18 + size * 0.5]);
      app.setDoc(await app.client.call("addText", i, rect, text, size, hexToRgb(app.toolOptions.textColor)));
    } catch (e) {
      showError(e);
    }
  };
  const autosize = () => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    ta.style.width = "auto";
    ta.style.width = Math.max(60, ta.scrollWidth + 8) + "px";
  };
  ta.addEventListener("input", autosize);
  ta.addEventListener("blur", () => finish(true));
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") finish(false);
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ta.blur();
  });
  pe.overlay.append(ta);
  // Fokusera direkt så att första tangenten hamnar i textfältet och inte tolkas som kortkommando.
  ta.focus();
  requestAnimationFrame(autosize);
}

export function visiblePages() {
  return [...visible];
}
