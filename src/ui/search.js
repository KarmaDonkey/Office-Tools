// Sökpanelen.
import { app } from "../store.js";
import { h, iconButton, showError, busy, toast } from "./dom.js";
import { goToPage } from "./viewer.js";

let panel;
let input;
let countEl;
let listEl;
let timer = 0;
let lastQuery = "";

export function initSearch(el) {
  panel = el;
  input = h("input", { type: "search", placeholder: "Sök i texten …", "aria-label": "Sök i texten", enterkeyhint: "search" });
  countEl = h("span", { class: "search-count", "aria-live": "polite" });
  listEl = h("ol", { class: "search-results" });
  const actions = h(
    "div",
    { class: "search-actions" },
    h("button", { type: "button", class: "btn btn-small", onclick: highlightAll }, "Markera alla"),
    h("button", { type: "button", class: "btn btn-small", onclick: redactAll }, "Maskera alla"),
  );
  panel.append(
    h("div", { class: "panel-head" }, h("h2", {}, "Sök"), iconButton("x", "Stäng sökningen", () => toggleSearch(false))),
    h("div", { class: "search-row" }, input, iconButton("chevron-up", "Föregående träff", () => step(-1)), iconButton("chevron-down", "Nästa träff", () => step(1))),
    countEl,
    actions,
    listEl,
  );
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (input.value !== lastQuery) run();
      else step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") toggleSearch(false);
  });
  app.on("doc", ({ prev, state }) => {
    if (!state.open) return reset();
    if (lastQuery && prev.rev !== state.rev) {
      clearTimeout(timer);
      timer = setTimeout(() => run(true), 400);
    }
  });
}

export function toggleSearch(force) {
  const open = document.body.classList.toggle("search-open", force);
  if (open) {
    input.focus();
    input.select();
  } else {
    app.search = { query: "", results: [], flat: [], current: -1 };
    lastQuery = "";
    app.emit("search");
  }
}

function reset() {
  input.value = "";
  lastQuery = "";
  countEl.textContent = "";
  listEl.replaceChildren();
  app.search = { query: "", results: [], flat: [], current: -1 };
}

async function run(keepPosition = false) {
  const q = input.value.trim();
  lastQuery = input.value;
  if (!q || !app.doc.open) {
    reset();
    input.value = lastQuery;
    app.emit("search");
    return;
  }
  try {
    const results = await app.client.call("search", q);
    const flat = results.flatMap((r) => r.hits.map((quads) => ({ page: r.page, quads })));
    let current = flat.length ? 0 : -1;
    if (keepPosition && app.search.current >= 0) current = Math.min(app.search.current, flat.length - 1);
    else if (flat.length) {
      const k = flat.findIndex((f) => f.page >= app.currentPage);
      current = k >= 0 ? k : 0;
    }
    app.search = { query: q, results, flat, current };
    renderList();
    if (!keepPosition) show();
    app.emit("search");
  } catch (e) {
    showError(e);
  }
}

function renderList() {
  const { results, flat, current } = app.search;
  countEl.textContent = flat.length ? `Träff ${current + 1} av ${flat.length}` : "Inga träffar";
  let k = 0;
  listEl.replaceChildren(
    ...results.map((r) => {
      const first = k;
      k += r.hits.length;
      return h(
        "li",
        {},
        h("button", { type: "button", class: "result" + (current >= first && current < k ? " current" : ""), onclick: () => { app.search.current = first; show(); } }, `Sida ${r.page + 1}`, h("span", { class: "badge" }, String(r.hits.length))),
      );
    }),
  );
}

function step(d) {
  const { flat } = app.search;
  if (!flat.length) return;
  app.search.current = (app.search.current + d + flat.length) % flat.length;
  show();
}

function show() {
  const { flat, current } = app.search;
  const hit = flat[current];
  renderList();
  app.emit("search");
  if (hit) goToPage(hit.page, { y: hit.quads[0][1] });
}

async function highlightAll() {
  const { results } = app.search;
  if (!results.length) return toast("Sök först efter text att markera.");
  try {
    app.setDoc(await busy("Markerar …", () => app.client.call("addHighlightsForHits", results)));
    toast(`${app.search.flat.length} träffar markerades.`, { type: "success" });
  } catch (e) {
    showError(e);
  }
}

async function redactAll() {
  const { results, flat } = app.search;
  if (!results.length) return toast("Sök först efter text att maskera.");
  try {
    app.setDoc(await app.client.call("addRedactionsForHits", results));
    toast(`${flat.length} träffar är markerade för maskering. Välj ”Verkställ maskering” under Verktyg för att ta bort texten.`, { type: "success", timeout: 7000 });
  } catch (e) {
    showError(e);
  }
}
