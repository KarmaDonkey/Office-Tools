// Miniatyrer i sidopanelen: välja, dra för att ändra ordning, sidåtgärder.
import { app } from "../store.js";
import { h, iconButton, showError } from "./dom.js";
import { goToPage } from "./viewer.js";

let panel;
let list;
let items = [];
let observer;
const visible = new Set();
let anchor = 0;
let dragIndices = null;
let dropMarker;

const THUMB_W = () => (panel.classList.contains("grid") ? 170 : 116);

export function initThumbs(el, actions) {
  panel = el;
  list = h("div", { class: "thumb-list", role: "listbox", "aria-label": "Sidor", "aria-multiselectable": "true", tabindex: 0 });
  dropMarker = h("div", { class: "drop-marker", hidden: true });
  const toolbar = h(
    "div",
    { class: "thumb-toolbar" },
    iconButton("rotate-ccw", "Rotera vänster", () => actions.rotate(-90)),
    iconButton("rotate-cw", "Rotera höger", () => actions.rotate(90)),
    iconButton("trash-2", "Ta bort valda sidor", () => actions.remove()),
    iconButton("file-output", "Plocka ut valda sidor", () => actions.extract()),
    h("span", { class: "spacer" }),
    iconButton("layout-grid", "Sidöversikt", () => toggleGrid(), { class: "grid-toggle" }),
  );
  panel.append(toolbar, h("div", { class: "thumb-scroll" }, list, dropMarker));
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const i = Number(e.target.dataset.index);
        if (e.isIntersecting) visible.add(i);
        else visible.delete(i);
      }
      renderVisible();
    },
    { root: panel.querySelector(".thumb-scroll"), rootMargin: "200px 0px" },
  );

  list.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      actions.remove();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      for (let i = 0; i < items.length; i++) app.selection.add(i);
      updateSelection();
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
      const next = Math.min(items.length - 1, Math.max(0, app.currentPage + d));
      select(next, { shift: e.shiftKey });
      items[next]?.el.scrollIntoView({ block: "nearest" });
    }
  });

  list.addEventListener("dragover", onDragOver);
  list.addEventListener("drop", onDrop);
  list.addEventListener("dragleave", (e) => {
    if (!list.contains(e.relatedTarget)) dropMarker.hidden = true;
  });

  app.on("doc", ({ state }) => onDoc(state));
  app.on("page", (i) => {
    items.forEach((it, k) => it.el.classList.toggle("current", k === i));
    if (!panel.classList.contains("grid")) items[i]?.el.scrollIntoView({ block: "nearest" });
  });
  app.on("selection", updateSelection);
}

export function toggleGrid(force) {
  const on = panel.classList.toggle("grid", force);
  document.body.classList.toggle("grid-mode", on);
  items.forEach((it) => (it.key = null));
  layout();
  renderVisible();
}

function onDoc(state) {
  if (!state.open) {
    list.replaceChildren();
    items = [];
    return;
  }
  const n = state.pageCount;
  while (items.length < n) {
    const i = items.length;
    const canvas = h("canvas", {});
    const label = h("span", { class: "thumb-label" }, String(i + 1));
    const el = h("div", { class: "thumb", role: "option", draggable: "true", dataset: { index: i } }, h("div", { class: "thumb-frame" }, canvas), label);
    el.addEventListener("click", (e) => select(Number(el.dataset.index), { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
    el.addEventListener("dblclick", () => {
      if (panel.classList.contains("grid")) toggleGrid(false);
      goToPage(Number(el.dataset.index));
    });
    el.addEventListener("dragstart", (e) => onDragStart(e, Number(el.dataset.index)));
    el.addEventListener("dragend", () => {
      dragIndices = null;
      dropMarker.hidden = true;
      list.classList.remove("dragging");
    });
    list.append(el);
    observer.observe(el);
    items.push({ el, canvas, key: null });
  }
  while (items.length > n) {
    const it = items.pop();
    observer.unobserve(it.el);
    visible.delete(items.length);
    it.el.remove();
  }
  layout();
  updateSelection();
  renderVisible();
}

function layout() {
  const pages = app.doc.pages ?? [];
  const W = THUMB_W();
  items.forEach((it, i) => {
    const p = pages[i];
    if (!p) return;
    const scale = Math.min(W / p.w, (W * 1.5) / p.h);
    const frame = it.el.firstChild;
    frame.style.width = `${Math.round(p.w * scale)}px`;
    frame.style.height = `${Math.round(p.h * scale)}px`;
    it.el.classList.toggle("current", i === app.currentPage);
  });
}

function renderVisible() {
  if (!app.doc.open) return;
  const dpr = window.devicePixelRatio || 1;
  const W = THUMB_W();
  app.client.cancelRenders((k) => k.startsWith("thumb:") && !visible.has(Number(k.slice(6))));
  for (const i of visible) {
    const it = items[i];
    const p = app.doc.pages[i];
    if (!it || !p) continue;
    const scale = Math.min(W / p.w, (W * 1.5) / p.h) * dpr;
    const key = `${app.doc.rev}:${scale.toFixed(3)}`;
    if (it.key === key) continue;
    it.key = key;
    app.client
      .render("thumb:" + i, 1000 + i, i, scale, true)
      .then((res) => {
        if (!res) return;
        if (it.key !== key) return res.bitmap.close();
        it.canvas.width = res.width;
        it.canvas.height = res.height;
        it.canvas.getContext("2d").drawImage(res.bitmap, 0, 0);
        res.bitmap.close();
      })
      .catch((e) => {
        it.key = null;
        console.error(e);
      });
  }
}

function select(i, { ctrl = false, shift = false } = {}) {
  if (shift) {
    if (!ctrl) app.selection.clear();
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
    for (let k = a; k <= b; k++) app.selection.add(k);
  } else if (ctrl) {
    if (app.selection.has(i)) app.selection.delete(i);
    else app.selection.add(i);
    anchor = i;
  } else {
    app.selection.clear();
    app.selection.add(i);
    anchor = i;
  }
  updateSelection();
  if (!panel.classList.contains("grid")) goToPage(i);
  else {
    app.currentPage = i;
    app.emit("page", i);
  }
  app.emit("selection");
}

function updateSelection() {
  items.forEach((it, i) => {
    const on = app.selection.has(i);
    it.el.classList.toggle("selected", on);
    it.el.setAttribute("aria-selected", on ? "true" : "false");
  });
}

// ---------- Dra och släpp ----------

function onDragStart(e, i) {
  if (!app.selection.has(i)) {
    app.selection.clear();
    app.selection.add(i);
    updateSelection();
  }
  dragIndices = [...app.selection].sort((a, b) => a - b);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("application/x-pdf-pages", dragIndices.join(","));
  list.classList.add("dragging");
}

function dropTarget(e) {
  const grid = panel.classList.contains("grid");
  let best = items.length;
  for (let k = 0; k < items.length; k++) {
    const r = items[k].el.getBoundingClientRect();
    if (grid) {
      if (e.clientY < r.top) {
        best = k;
        break;
      }
      if (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2) {
        best = k;
        break;
      }
    } else if (e.clientY < r.top + r.height / 2) {
      best = k;
      break;
    }
  }
  return best;
}

function onDragOver(e) {
  if (!dragIndices) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const before = dropTarget(e);
  const grid = panel.classList.contains("grid");
  const ref = items[Math.min(before, items.length - 1)].el;
  const r = ref.getBoundingClientRect();
  const host = dropMarker.parentElement.getBoundingClientRect();
  const scroll = dropMarker.parentElement;
  const atEnd = before >= items.length;
  dropMarker.hidden = false;
  dropMarker.classList.toggle("vertical", grid);
  if (grid) {
    Object.assign(dropMarker.style, { left: `${(atEnd ? r.right + 4 : r.left - 6) - host.left + scroll.scrollLeft}px`, top: `${r.top - host.top + scroll.scrollTop}px`, height: `${r.height}px`, width: "" });
  } else {
    Object.assign(dropMarker.style, { top: `${(atEnd ? r.bottom + 4 : r.top - 5) - host.top + scroll.scrollTop}px`, left: `${r.left - host.left}px`, width: `${r.width}px`, height: "" });
  }
}

async function onDrop(e) {
  if (!dragIndices) return;
  e.preventDefault();
  dropMarker.hidden = true;
  const before = dropTarget(e);
  const indices = dragIndices;
  dragIndices = null;
  try {
    const { state, order } = await app.client.call("movePages", indices, before);
    const moved = new Set(indices);
    app.selection.clear();
    order.forEach((orig, pos) => moved.has(orig) && app.selection.add(pos));
    app.setDoc(state);
    app.emit("selection");
  } catch (err) {
    showError(err);
  }
}
