// Små DOM-hjälpare, dialoger och notiser.
import { icon } from "./icons.js";

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function iconButton(name, label, onClick, props = {}) {
  const { class: cls = "", text, ...rest } = props;
  return h("button", { type: "button", class: `icon-btn ${cls}`.trim(), title: label, "aria-label": label, onclick: onClick, ...rest }, icon(name), text ? h("span", { class: "btn-label" }, text) : null);
}

// ---------- Notiser ----------

export function toast(message, { type = "info", timeout = 4000 } = {}) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  const t = h("div", { class: `toast toast-${type}` }, message);
  host.append(t);
  setTimeout(() => {
    t.classList.add("hide");
    setTimeout(() => t.remove(), 300);
  }, timeout);
}

export function showError(e) {
  console.error(e);
  toast(e?.message ?? String(e), { type: "error", timeout: 6000 });
}

// ---------- Upptagen-indikator ----------

let busyCount = 0;
export async function busy(message, fn) {
  const el = document.getElementById("busy");
  busyCount++;
  el.querySelector(".busy-text").textContent = message;
  el.hidden = false;
  try {
    return await fn();
  } finally {
    busyCount--;
    if (busyCount === 0) el.hidden = true;
  }
}

export function setBusyText(message) {
  document.querySelector("#busy .busy-text").textContent = message;
}

// ---------- Dialoger ----------

// Öppnar en modal dialog. actions: [{ label, value, primary, danger }].
// body kan vara ett element eller en funktion som får (close) och returnerar ett element.
// Resultatet är värdet för den knapp som trycktes, eller null om dialogen stängdes.
export function dialog({ title, body, actions = [{ label: "Stäng", value: null }], wide = false, onSubmit }) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "dlg" + (wide ? " dlg-wide" : "") });
    let result = null;
    const close = (value) => {
      result = value;
      dlg.close();
    };
    const content = typeof body === "function" ? body(close) : body;
    const form = h(
      "form",
      { method: "dialog", class: "dlg-form" },
      h("header", { class: "dlg-head" }, h("h2", {}, title), iconButton("x", "Stäng", () => close(null), { class: "dlg-x" })),
      h("div", { class: "dlg-body" }, content),
      h(
        "footer",
        { class: "dlg-foot" },
        actions.map((a) =>
          h("button", {
            type: a.primary ? "submit" : "button",
            class: "btn" + (a.primary ? " btn-primary" : "") + (a.danger ? " btn-danger" : ""),
            value: a.value ?? "",
            onclick: a.primary
              ? null
              : (e) => {
                  e.preventDefault();
                  close(a.value ?? null);
                },
          }, a.label),
        ),
      ),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const primary = actions.find((a) => a.primary);
      if (onSubmit) {
        const ok = await onSubmit(form);
        if (ok === false) return;
      }
      close(primary?.value ?? true);
    });
    dlg.append(form);
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(result);
    });
    dlg.addEventListener("cancel", () => (result = null));
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector("[autofocus], .dlg-body input:not([type=hidden]), .dlg-body select, .dlg-body textarea");
    first?.focus();
  });
}

export function confirmDialog(title, message, okLabel = "OK", danger = false) {
  return dialog({ title, body: h("p", {}, message), actions: [{ label: "Avbryt", value: null }, { label: okLabel, value: true, primary: true, danger }] });
}

export function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input, hint ? h("span", { class: "field-hint" }, hint) : null);
}

export function select(name, options, value) {
  return h("select", { name }, options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
}

export function radios(name, options, value) {
  return h("div", { class: "radios", role: "radiogroup" }, options.map(([v, l]) => h("label", { class: "radio" }, h("input", { type: "radio", name, value: v, checked: v === value }), h("span", {}, l))));
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",")} MB`;
}

// Tolkar "1-3, 5, 8-" till nollbaserade index. Returnerar null vid fel.
export function parseRanges(text, pageCount) {
  const out = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
    if (!m || (!m[1] && !m[3])) return null;
    const a = m[1] ? parseInt(m[1], 10) : 1;
    const b = m[2] ? (m[3] ? parseInt(m[3], 10) : pageCount) : a;
    if (a < 1 || b > pageCount || a > b) return null;
    const r = [];
    for (let i = a; i <= b; i++) r.push(i - 1);
    out.push(r);
  }
  return out.length ? out : null;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
