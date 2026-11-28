// Kommandopalett (Ctrl+K): sök bland alla funktioner och i dokumentets text.
import { app, settings } from "../store.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";

let getCommands = () => [];
let searchText = () => {};
let el = null;

export function initPalette({ commands, onSearchText }) {
  getCommands = commands;
  searchText = onSearchText;
}

const norm = (s) => s.toLowerCase().normalize("NFC");

function score(cmd, q) {
  if (!q) return 1;
  const label = norm(cmd.label);
  const hay = norm(`${cmd.label} ${cmd.hint ?? ""} ${cmd.keywords ?? ""}`);
  if (label.startsWith(q)) return 100 - label.length / 100;
  if (label.split(/[\s/–-]+/).some((w) => w.startsWith(q))) return 80;
  if (label.includes(q)) return 60;
  if (hay.split(/[\s,·/–-]+/).some((w) => w.startsWith(q))) return 40;
  if (hay.includes(q)) return 20;
  return 0;
}

function highlight(text, q) {
  if (!q) return text;
  const i = norm(text).indexOf(q);
  if (i < 0) return text;
  return [text.slice(0, i), h("mark", {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

function remember(id) {
  const list = settings.get("paletteRecent", []).filter((x) => x !== id);
  settings.set("paletteRecent", [id, ...list].slice(0, 4));
}

export function isPaletteOpen() {
  return !!el;
}

export function closePalette() {
  if (!el) return;
  const old = el;
  el = null;
  old.classList.add("closing");
  setTimeout(() => old.remove(), 140);
}

export function openPalette(initial = "") {
  if (el) return el.querySelector("input").focus();
  const input = h("input", { type: "text", placeholder: "Sök funktion eller text …", "aria-label": "Sök funktion eller text", autocomplete: "off", spellcheck: false, value: initial });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const foot = h("div", { class: "pal-foot" }, h("span", {}, h("kbd", {}, "↑↓"), " välj"), h("span", {}, h("kbd", {}, "↵"), " kör"), h("span", {}, h("kbd", {}, "Esc"), " stäng"));
  const box = h("div", { class: "palette", role: "dialog", "aria-label": "Kommandon" }, h("div", { class: "pal-in" }, icon("search"), input), list, foot);
  el = h("div", { class: "pal-wrap", onpointerdown: (e) => e.target === el && closePalette() }, box);
  document.body.append(el);

  let items = [];
  let active = 0;
  let countTimer = 0;
  let countFor = "";
  let count = null;

  const run = (item) => {
    if (!item || item.disabled) return;
    closePalette();
    if (item.id) remember(item.id);
    setTimeout(() => item.run(), 0);
  };

  const render = () => {
    const q = norm(input.value.trim());
    const all = getCommands();
    const groups = [];
    if (!q) {
      const recent = settings.get("paletteRecent", []).map((id) => all.find((c) => c.id === id)).filter((c) => c && !c.disabled);
      if (recent.length) groups.push(["Senast använda", recent]);
      const byGroup = new Map();
      for (const c of all) {
        if (c.disabled) continue;
        if (!byGroup.has(c.group)) byGroup.set(c.group, []);
        byGroup.get(c.group).push(c);
      }
      groups.push(...byGroup);
    } else {
      const hits = all
        .map((c) => ({ c, s: score(c, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => (a.c.disabled === b.c.disabled ? b.s - a.s : a.c.disabled ? 1 : -1))
        .map((x) => x.c);
      if (hits.length) groups.push(["Funktioner", hits.slice(0, 8)]);
      if (app.doc.open && q.length >= 2) {
        const label = `Sök ”${input.value.trim()}” i texten`;
        const hint = countFor === q && count != null ? `${count} ${count === 1 ? "träff" : "träffar"}` : "i dokumentet";
        groups.push(["I dokumentet", [{ label, hint, icon: "search", kbd: "Ctrl F", run: () => searchText(input.value.trim()) }]]);
        scheduleCount(q, input.value.trim());
      }
    }
    items = groups.flatMap(([, list]) => list);
    if (active >= items.length) active = Math.max(0, items.length - 1);
    let k = 0;
    list.replaceChildren(
      ...groups.flatMap(([title, cmds]) => [
        h("div", { class: "pal-group" }, title),
        ...cmds.map((c) => {
          const idx = k++;
          return h(
            "button",
            {
              type: "button",
              class: "pal-item" + (idx === active ? " on" : ""),
              role: "option",
              disabled: c.disabled,
              "aria-selected": idx === active ? "true" : "false",
              onpointermove: () => {
                if (active !== idx) {
                  active = idx;
                  mark();
                }
              },
              onclick: () => run(c),
            },
            h("span", { class: "pal-ic" }, icon(c.icon ?? "chevron-right")),
            h("span", { class: "pal-text" }, h("span", {}, highlight(c.label, q)), c.hint ? h("small", {}, " · ", c.hint) : null),
            c.kbd ? h("kbd", {}, c.kbd) : null,
          );
        }),
      ]),
    );
    if (!items.length) list.append(h("div", { class: "pal-empty" }, app.doc.open ? "Inga funktioner matchar." : "Inga funktioner matchar. Öppna en PDF för fler."));
  };

  const mark = () => {
    list.querySelectorAll(".pal-item").forEach((b, i) => {
      b.classList.toggle("on", i === active);
      b.setAttribute("aria-selected", i === active ? "true" : "false");
      if (i === active) b.scrollIntoView({ block: "nearest" });
    });
  };

  function scheduleCount(q, raw) {
    if (countFor === q) return;
    clearTimeout(countTimer);
    countTimer = setTimeout(async () => {
      try {
        const res = await app.client.call("search", raw);
        countFor = q;
        count = res.reduce((n, r) => n + r.hits.length, 0);
        if (el && norm(input.value.trim()) === q) render();
      } catch {
        /* ignore */
      }
    }, 220);
  }

  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") active = (active + 1) % Math.max(1, items.length);
    else if (e.key === "ArrowUp") active = (active - 1 + items.length) % Math.max(1, items.length);
    else if (e.key === "Enter") return run(items[active]);
    else if (e.key === "Escape") return closePalette();
    else return;
    e.preventDefault();
    mark();
  });
  render();
  input.focus();
  input.select();
}
