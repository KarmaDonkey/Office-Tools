// Miniatyrer i sidopanelen: välja, dra för att ändra ordning, sidåtgärder.
import { app } from "../store.js";
import { h, iconButton, showError } from "./dom.js";
import { goToPage, applyOrder } from "./viewer.js";
import { icon } from "./icons.js";

let panel;
let list;
let items = [];
let observer;
const visible = new Set();
let anchor = 0;
let dragIndices = null;
let dropMarker;
let countEl;
let pageActions;

const THUMB_W = () => (panel.classList.contains("grid") ? 180 : 132);

export function initThumbs(el, actions) {
  panel = el;
  list = h("div", { class: "thumb-list", role: "listbox", "aria-label": "Sidor", "aria-multiselectable": "true", tabindex: 0 });
  dropMarker = h("div", { class: "drop-marker", hidden: true });
  countEl = h("span", { class: "thumb-count" });
  const toolbar = h(
    "div",
    { class: "thumb-head" },
    h("h4", {}, "Sidor", countEl),
    h(
      "div",
      { class: "thumb-toolbar" },
      iconButton("rotate-ccw", "Rotera valda åt vänster", () => actions.rotate(-90)),
      iconButton("rotate-cw", "Rotera valda åt höger", () => actions.rotate(90)),
      iconButton("trash-2", "Ta bort valda sidor", () => actions.remove()),
      iconButton("file-output", "Plocka ut valda sidor", () => actions.extract()),
      iconButton("layout-grid", "Sidöversikt", () => toggleGrid(), { class: "grid-toggle" }),
    ),
  );
  pageActions = actions;
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
    const quick = h(
      "div",
      { class: "thumb-quick" },
      h("button", { type: "button", title: "Rotera", "aria-label": "Rotera sidan", onclick: (e) => { e.stopPropagation(); quickAction("rotate", Number(el.dataset.index)); } }, icon("rotate-cw")),
      h("button", { type: "button", title: "Ta bort", "aria-label": "Ta bort sidan", onclick: (e) => { e.stopPropagation(); quickAction("remove", Number(el.dataset.index)); } }, icon("trash-2")),
    );
    const el = h("div", { class: "thumb", role: "option", draggable: "true", dataset: { index: i } }, h("div", { class: "thumb-frame" }, canvas, quick), label);
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
  countEl.textContent = String(n);
  layout();
  updateSelection();
  renderVisible();
}

// Snabbknapparna på en miniatyr gäller bara den sidan.
function quickAction(kind, i) {
  app.selection.clear();
  app.selection.add(i);
  updateSelection();
  app.emit("selection");
  if (kind === "rotate") pageActions.rotate(90);
  else pageActions.remove();
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
  const frame = items[i].el.querySelector(".thumb-frame");
  const ghost = frame.cloneNode(true);
  const src = frame.querySelector("canvas");
  const copy = ghost.querySelector("canvas");
  if (src.width && src.height) copy.getContext("2d").drawImage(src, 0, 0);
  ghost.classList.add("drag-ghost");
  if (dragIndices.length > 1) ghost.append(h("span", { class: "drag-count" }, String(dragIndices.length)));
  document.body.append(ghost);
  e.dataTransfer.setDragImage(ghost, frame.offsetWidth / 2, 20);
  setTimeout(() => ghost.remove(), 0);
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
    if (state.rev === app.doc.rev) return;
    const first = items.map((it) => it.el.querySelector(".thumb-frame").getBoundingClientRect());
    // Flytta de redan ritade miniatyrerna och sidbilderna till sina nya platser.
    const canvases = items.map((it) => it.canvas);
    order.forEach((from, to) => {
      const it = items[to];
      it.canvas = canvases[from];
      it.el.querySelector(".thumb-frame").prepend(it.canvas);
      it.key = null;
    });
    applyOrder(order);
    const moved = new Set(indices);
    app.selection.clear();
    order.forEach((orig, pos) => moved.has(orig) && app.selection.add(pos));
    app.setDoc(state);
    app.emit("selection");
    flip(order, first, moved);
  } catch (err) {
    showError(err);
  }
}

// FLIP-animation: varje miniatyr glider från sin gamla plats till den nya.
function flip(order, first, moved) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  order.forEach((from, to) => {
    const frame = items[to]?.el.querySelector(".thumb-frame");
    if (!frame || !first[from]) return;
    const last = frame.getBoundingClientRect();
    const dx = first[from].left - last.left;
    const dy = first[from].top - last.top;
    if (!dx && !dy) return;
    frame.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
    if (moved.has(from)) items[to].el.animate([{ filter: "drop-shadow(0 0 0 transparent)" }, { filter: "drop-shadow(0 0 14px #c64bff)" }, { filter: "drop-shadow(0 0 0 transparent)" }], { duration: 700 });
  });
}
