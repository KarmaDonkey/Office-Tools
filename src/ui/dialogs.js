// Dialoger för verktygen.
import { app, settings } from "../store.js";
import { h, dialog, field, select, radios, toast, showError, busy, setBusyText, formatBytes, parseRanges, hexToRgb, iconButton } from "./dom.js";
import { pickFiles, openFiles, appendFiles, saveBytesAs, saveManyToFolder, baseName, imageBytesForPdf } from "./files.js";
import { clearRecent } from "./recent.js";

const selected = () => [...app.selection].sort((a, b) => a - b);
const pad = (n, total) => String(n).padStart(String(total).length, "0");

function rangeHint() {
  return "Till exempel 1-3, 5, 8-12";
}

function pagesChoice(name = "pages") {
  const sel = selected();
  const opts = [["all", `Alla sidor (${app.doc.pageCount})`]];
  if (sel.length) opts.push(["selected", `Valda sidor (${sel.length})`]);
  opts.push(["range", "Sidintervall"]);
  const range = h("input", { type: "text", name: name + "-range", placeholder: rangeHint(), inputmode: "numeric" });
  const wrap = h("div", { class: "pages-choice" }, radios(name, opts, sel.length > 1 ? "selected" : "all"), range);
  const sync = () => (range.disabled = wrap.querySelector(`input[name=${name}]:checked`).value !== "range");
  wrap.addEventListener("change", sync);
  sync();
  wrap.getPages = () => {
    const v = wrap.querySelector(`input[name=${name}]:checked`).value;
    if (v === "all") return [...Array(app.doc.pageCount).keys()];
    if (v === "selected") return sel;
    const r = parseRanges(range.value, app.doc.pageCount);
    if (!r) {
      toast("Sidintervallet är ogiltigt.", { type: "error" });
      range.focus();
      return null;
    }
    return [...new Set(r.flat())].sort((a, b) => a - b);
  };
  return wrap;
}

// ---------- Dela upp ----------

export async function splitDialog() {
  const n = app.doc.pageCount;
  const mode = radios(
    "mode",
    [
      ["each", "Varje sida blir en egen fil"],
      ["every", "Var N:e sida"],
      ["ranges", "Efter intervall"],
      ["size", "Efter filstorlek"],
    ],
    "every",
  );
  const every = h("input", { type: "number", name: "every", min: 1, max: n, value: Math.min(2, n) });
  const ranges = h("input", { type: "text", name: "ranges", placeholder: "1-3, 4-10, 11-" });
  const size = h("input", { type: "number", name: "size", min: 0.1, step: 0.1, value: 5 });
  const opts = {
    every: field("Sidor per fil", every),
    ranges: field("Intervall (en fil per intervall)", ranges, rangeHint()),
    size: field("Största storlek per fil (MB)", size, "Ungefärligt. En enskild sida som är större än gränsen blir en egen fil."),
  };
  const body = h("div", {}, mode, h("div", { class: "sub-options" }, Object.values(opts)));
  const sync = () => {
    const m = body.querySelector("input[name=mode]:checked").value;
    for (const [k, el] of Object.entries(opts)) el.hidden = k !== m;
  };
  body.addEventListener("change", sync);
  sync();
  let plan = null;
  const ok = await dialog({
    title: "Dela upp",
    body,
    actions: [{ label: "Avbryt" }, { label: "Dela upp", value: true, primary: true }],
    onSubmit: () => {
      const m = body.querySelector("input[name=mode]:checked").value;
      if (m === "each") plan = { ranges: [...Array(n).keys()].map((i) => [i]) };
      else if (m === "every") {
        const k = Math.max(1, parseInt(every.value, 10) || 1);
        const r = [];
        for (let i = 0; i < n; i += k) r.push([...Array(Math.min(k, n - i)).keys()].map((j) => i + j));
        plan = { ranges: r };
      } else if (m === "ranges") {
        const r = parseRanges(ranges.value, n);
        if (!r) {
          toast("Intervallen är ogiltiga.", { type: "error" });
          return false;
        }
        plan = { ranges: r };
      } else {
        const mb = parseFloat(String(size.value).replace(",", "."));
        if (!(mb > 0)) return false;
        plan = { maxBytes: Math.floor(mb * 1024 * 1024) };
      }
      return true;
    },
  });
  if (!ok) return;
  try {
    let parts;
    if (plan.maxBytes) {
      const res = await busy("Delar upp efter storlek …", () => app.client.call("planSplitBySize", plan.maxBytes));
      parts = res.map((r) => ({ pages: r.pages, bytes: r.bytes }));
    } else {
      const bytes = await busy("Delar upp …", () => app.client.call("splitParts", plan.ranges));
      parts = plan.ranges.map((pages, k) => ({ pages, bytes: bytes[k] }));
    }
    const base = baseName();
    const files = parts.map((p, k) => {
      const a = p.pages[0] + 1;
      const b = p.pages[p.pages.length - 1] + 1;
      const label = a === b ? `sida ${pad(a, n)}` : `sidor ${pad(a, n)}-${pad(b, n)}`;
      return { name: `${base} – del ${pad(k + 1, parts.length)} (${label}).pdf`, bytes: p.bytes, type: "application/pdf" };
    });
    if (files.length === 1) await saveBytesAs(files[0].bytes, files[0].name);
    else await saveManyToFolder(files);
  } catch (e) {
    showError(e);
  }
}

// ---------- Plocka ut ----------

export async function extractPages(indices = selected()) {
  if (!indices.length) return toast("Välj en eller flera sidor i miniatyrerna först.");
  try {
    const bytes = await busy("Plockar ut sidor …", () => app.client.call("extract", indices));
    const label = indices.length === 1 ? `sida ${indices[0] + 1}` : `${indices.length} sidor`;
    await saveBytesAs(bytes, `${baseName()} (${label}).pdf`);
  } catch (e) {
    showError(e);
  }
}

export async function extractDialog() {
  const choice = pagesChoice();
  const ok = await dialog({ title: "Plocka ut sidor", body: h("div", {}, h("p", {}, "Sidorna sparas som en ny PDF. Originalet ändras inte."), choice), actions: [{ label: "Avbryt" }, { label: "Plocka ut", value: true, primary: true }], onSubmit: () => !!choice.getPages() });
  if (ok) extractPages(choice.getPages());
}

// ---------- Slå ihop och infoga ----------

export async function mergeDialog() {
  const items = [];
  const listEl = h("ol", { class: "file-list" });
  const render = () =>
    listEl.replaceChildren(
      ...items.map((it, k) =>
        h(
          "li",
          {},
          h("span", { class: "file-name" }, it.file.name),
          h("span", { class: "file-size" }, formatBytes(it.file.size)),
          iconButton("chevron-up", "Flytta upp", () => {
            if (k > 0) [items[k - 1], items[k]] = [items[k], items[k - 1]];
            render();
          }),
          iconButton("chevron-down", "Flytta ner", () => {
            if (k < items.length - 1) [items[k + 1], items[k]] = [items[k], items[k + 1]];
            render();
          }),
          iconButton("x", "Ta bort", () => {
            items.splice(k, 1);
            render();
          }),
        ),
      ),
      items.length ? null : h("li", { class: "empty" }, "Inga filer valda ännu."),
    );
  const add = async () => {
    items.push(...(await pickFiles()));
    render();
  };
  render();
  const target = app.doc.open ? radios("target", [["new", "Skapa ett nytt dokument"], ["append", "Lägg till sist i det öppna dokumentet"]], "new") : null;
  const fit = select("fit", [["image", "Bildens egen storlek"], ["a4", "A4 (bilden centreras)"]], "a4");
  const body = h("div", {}, h("p", {}, "Välj PDF-filer och bilder i den ordning de ska komma."), listEl, h("button", { type: "button", class: "btn", onclick: add }, "Lägg till filer …"), target, field("Sidstorlek för bilder", fit));
  const ok = await dialog({
    title: "Slå ihop filer",
    body,
    wide: true,
    actions: [{ label: "Avbryt" }, { label: "Slå ihop", value: true, primary: true }],
    onSubmit: () => {
      if (!items.length) {
        toast("Lägg till minst en fil.", { type: "error" });
        return false;
      }
      return true;
    },
  });
  if (!ok) return;
  const mode = target?.querySelector("input:checked").value ?? "new";
  try {
    if (mode === "append") await appendFiles(items, -1, fit.value);
    else await openFilesWithFit(items, fit.value);
  } catch (e) {
    showError(e);
  }
}

async function openFilesWithFit(items, fit) {
  settings.set("imageFit", fit);
  await openFiles(items, fit);
}

export async function insertFilesDialog() {
  const items = await pickFiles();
  if (!items.length) return;
  const n = app.doc.pageCount;
  const pos = select("pos", [["after", `Efter aktuell sida (${app.currentPage + 1})`], ["start", "Först"], ["end", "Sist"]], "after");
  const fit = select("fit", [["image", "Bildens egen storlek"], ["a4", "A4 (bilden centreras)"]], settings.get("imageFit", "a4"));
  const ok = await dialog({
    title: "Infoga filer",
    body: h("div", {}, h("p", {}, items.map((i) => i.file.name).join(", ")), field("Placering", pos), field("Sidstorlek för bilder", fit)),
    actions: [{ label: "Avbryt" }, { label: "Infoga", value: true, primary: true }],
  });
  if (!ok) return;
  settings.set("imageFit", fit.value);
  const at = pos.value === "start" ? 0 : pos.value === "end" ? n : app.currentPage + 1;
  try {
    await appendFiles(items, at, fit.value);
  } catch (e) {
    showError(e);
  }
}

export async function imagesToPdf() {
  const items = await pickFiles({ types: [{ description: "Bilder", accept: { "image/*": [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".avif"] } }] });
  if (!items.length) return;
  const fit = select("fit", [["image", "Bildens egen storlek"], ["a4", "A4 (bilden centreras)"]], settings.get("imageFit", "a4"));
  const ok = await dialog({
    title: "Bilder till PDF",
    body: h("div", {}, h("p", {}, `${items.length} ${items.length === 1 ? "bild" : "bilder"} blir en sida var, i den ordning de valdes.`), field("Sidstorlek", fit)),
    actions: [{ label: "Avbryt" }, { label: "Skapa PDF", value: true, primary: true }],
  });
  if (!ok) return;
  await openFilesWithFit(items, fit.value);
}

// ---------- PDF till bilder ----------

export async function exportImagesDialog() {
  const choice = pagesChoice();
  const format = select("format", [["png", "PNG (skarp, större filer)"], ["jpeg", "JPEG (mindre filer)"]], settings.get("imgFormat", "png"));
  const dpi = select("dpi", [["72", "72 dpi (skärm)"], ["150", "150 dpi (standard)"], ["300", "300 dpi (utskrift)"]], settings.get("imgDpi", "150"));
  const ok = await dialog({
    title: "PDF till bilder",
    body: h("div", {}, choice, field("Format", format), field("Upplösning", dpi)),
    actions: [{ label: "Avbryt" }, { label: "Exportera", value: true, primary: true }],
    onSubmit: () => !!choice.getPages(),
  });
  if (!ok) return;
  const pages = choice.getPages();
  settings.set("imgFormat", format.value);
  settings.set("imgDpi", dpi.value);
  const ext = format.value === "jpeg" ? "jpg" : "png";
  const type = format.value === "jpeg" ? "image/jpeg" : "image/png";
  try {
    const files = await busy("Skapar bilder …", async () => {
      const out = [];
      for (const [k, i] of pages.entries()) {
        setBusyText(`Skapar bild ${k + 1} av ${pages.length} …`);
        const bytes = await app.client.call("exportPageImage", i, Number(dpi.value), format.value, 88);
        out.push({ name: `${baseName()} – sida ${pad(i + 1, app.doc.pageCount)}.${ext}`, bytes, type });
      }
      return out;
    });
    if (files.length === 1) await saveBytesAs(files[0].bytes, files[0].name, { description: "Bild", accept: { [type]: ["." + ext] } });
    else await saveManyToFolder(files);
  } catch (e) {
    showError(e);
  }
}

// ---------- Komprimera ----------

export async function compressDialog() {
  const level = radios(
    "level",
    [
      ["lossless", "Utan kvalitetsförlust – städar och packar filen"],
      ["medium", "Medel – bilder skalas ner till högst 1600 px, JPEG-kvalitet 75"],
      ["strong", "Stark – bilder skalas ner till högst 1000 px, JPEG-kvalitet 55"],
    ],
    "medium",
  );
  const before = await app.client.call("save", { encryption: app.saveEncryption });
  const ok = await dialog({
    title: "Komprimera",
    body: h("div", {}, h("p", {}, `Nuvarande storlek: ${formatBytes(before.length)}.`), level, h("p", { class: "field-hint" }, "Bildkomprimeringen kan ångras. Störst effekt får du på skannade dokument och filer med många foton.")),
    actions: [{ label: "Avbryt" }, { label: "Komprimera", value: true, primary: true }],
  });
  if (!ok) return;
  const lvl = level.querySelector("input:checked").value;
  try {
    let count = 0;
    if (lvl !== "lossless") {
      const r = await busy("Komprimerar bilder …", () => app.client.call("compressImages", lvl));
      app.setDoc(r.state);
      count = r.result;
    }
    const after = await busy("Beräknar storlek …", () => app.client.call("save", { encryption: app.saveEncryption, extra: "compress-fonts,compress-images,garbage=deduplicate" }));
    const diff = before.length - after.length;
    const pct = before.length ? Math.round((diff / before.length) * 100) : 0;
    await dialog({
      title: "Komprimering klar",
      body: h(
        "div",
        {},
        h("p", {}, `Före: ${formatBytes(before.length)}. Efter: ${formatBytes(after.length)}${diff > 0 ? ` (${pct} % mindre)` : ""}.`),
        lvl !== "lossless" ? h("p", {}, count ? `${count} ${count === 1 ? "bild" : "bilder"} komprimerades om.` : "Inga bilder behövde komprimeras om.") : null,
        h("p", { class: "field-hint" }, "Spara filen för att behålla resultatet."),
      ),
    });
  } catch (e) {
    showError(e);
  }
}

// ---------- Vattenstämpel ----------

export async function watermarkDialog() {
  const text = h("input", { type: "text", name: "text", value: settings.get("wmText", "KONFIDENTIELLT"), required: true, maxlength: 80 });
  const size = h("input", { type: "number", name: "size", min: 8, max: 200, value: settings.get("wmSize", 60) });
  const color = h("input", { type: "color", name: "color", value: settings.get("wmColor", "#c00000") });
  const opacity = h("input", { type: "range", name: "opacity", min: 5, max: 100, value: settings.get("wmOpacity", 25) });
  const angle = select("angle", [["45", "Diagonal"], ["0", "Vågrät"], ["90", "Lodrät"]], String(settings.get("wmAngle", 45)));
  const choice = pagesChoice();
  const ok = await dialog({
    title: "Vattenstämpel",
    body: h("div", {}, field("Text", text, "Tecken utanför västeuropeiska alfabet visas som ?."), h("div", { class: "row" }, field("Storlek (pt)", size), field("Färg", color), field("Riktning", angle)), field("Synlighet (%)", opacity), choice),
    actions: [{ label: "Avbryt" }, { label: "Lägg till", value: true, primary: true }],
    onSubmit: () => !!choice.getPages(),
  });
  if (!ok) return;
  settings.set("wmText", text.value);
  settings.set("wmSize", Number(size.value));
  settings.set("wmColor", color.value);
  settings.set("wmOpacity", Number(opacity.value));
  settings.set("wmAngle", Number(angle.value));
  try {
    app.setDoc(await busy("Lägger till vattenstämpel …", () => app.client.call("watermark", { text: text.value, size: Number(size.value), color: hexToRgb(color.value), opacity: Number(opacity.value) / 100, angle: Number(angle.value), pages: choice.getPages() })));
  } catch (e) {
    showError(e);
  }
}

// ---------- Sidnummer ----------

export async function pageNumbersDialog() {
  const format = select(
    "format",
    [
      ["{n}", "1"],
      ["Sida {n}", "Sida 1"],
      ["Sida {n} av {total}", "Sida 1 av 10"],
      ["{n} / {total}", "1 / 10"],
      ["– {n} –", "– 1 –"],
    ],
    settings.get("pnFormat", "Sida {n} av {total}"),
  );
  const position = select(
    "position",
    [
      ["bottom-center", "Nederkant, mitten"],
      ["bottom-right", "Nederkant, höger"],
      ["bottom-left", "Nederkant, vänster"],
      ["top-center", "Överkant, mitten"],
      ["top-right", "Överkant, höger"],
      ["top-left", "Överkant, vänster"],
    ],
    settings.get("pnPos", "bottom-center"),
  );
  const start = h("input", { type: "number", name: "start", min: 0, value: 1 });
  const size = h("input", { type: "number", name: "size", min: 6, max: 36, value: settings.get("pnSize", 10) });
  const margin = h("input", { type: "number", name: "margin", min: 0, max: 200, value: settings.get("pnMargin", 10) });
  const skip = h("input", { type: "checkbox", name: "skip" });
  const ok = await dialog({
    title: "Sidnummer",
    body: h("div", {}, h("div", { class: "row" }, field("Format", format), field("Placering", position)), h("div", { class: "row" }, field("Börja på", start), field("Storlek (pt)", size), field("Marginal (mm)", margin)), h("label", { class: "check" }, skip, h("span", {}, "Hoppa över första sidan (till exempel en försättssida)"))),
    actions: [{ label: "Avbryt" }, { label: "Lägg till", value: true, primary: true }],
  });
  if (!ok) return;
  settings.set("pnFormat", format.value);
  settings.set("pnPos", position.value);
  settings.set("pnSize", Number(size.value));
  settings.set("pnMargin", Number(margin.value));
  try {
    app.setDoc(await busy("Lägger till sidnummer …", () => app.client.call("pageNumbers", { format: format.value, position: position.value, start: Number(start.value), size: Number(size.value), margin: (Number(margin.value) * 72) / 25.4, skipFirst: skip.checked })));
  } catch (e) {
    showError(e);
  }
}

// ---------- Metadata ----------

function pdfDate(s) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || "");
  if (!m) return s || "–";
  return `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}${m[4] ? ` ${m[4]}:${m[5] ?? "00"}` : ""}`;
}

export async function metadataDialog() {
  const md = await app.client.call("getMetadata");
  const keys = [
    ["Title", "Titel"],
    ["Author", "Författare"],
    ["Subject", "Ämne"],
    ["Keywords", "Nyckelord"],
    ["Creator", "Skapad med"],
    ["Producer", "PDF-producent"],
  ];
  const inputs = Object.fromEntries(keys.map(([k]) => [k, h("input", { type: "text", name: k, value: md[k] })]));
  const ok = await dialog({
    title: "Metadata",
    body: h(
      "div",
      {},
      keys.map(([k, l]) => field(l, inputs[k])),
      h("dl", { class: "meta-info" }, h("dt", {}, "Skapad"), h("dd", {}, pdfDate(md.CreationDate)), h("dt", {}, "Ändrad"), h("dd", {}, pdfDate(md.ModDate)), h("dt", {}, "Format"), h("dd", {}, md.format || "–"), h("dt", {}, "Sidor"), h("dd", {}, String(app.doc.pageCount)), h("dt", {}, "Kryptering"), h("dd", {}, app.doc.encrypted ? app.doc.encryption : "Ingen")),
    ),
    actions: [{ label: "Avbryt" }, { label: "Rensa allt", value: "clear", danger: true }, { label: "Spara metadata", value: true, primary: true }],
  });
  if (!ok) return;
  const values = {};
  for (const [k] of keys) values[k] = ok === "clear" ? "" : inputs[k].value;
  try {
    app.setDoc(await app.client.call("setMetadata", values));
    toast(ok === "clear" ? "Metadata rensades." : "Metadata uppdaterades.", { type: "success" });
  } catch (e) {
    showError(e);
  }
}

// ---------- Lösenord ----------

export async function passwordDialog() {
  const cur = app.saveEncryption;
  const status = app.doc.encrypted ? `Filen är skyddad (${app.doc.encryption}).` : "Filen har inget lösenord.";
  const opts = app.doc.encrypted
    ? [
        ["keep", "Behåll nuvarande lösenord"],
        ["none", "Ta bort lösenordet"],
        ["set", "Byt till ett nytt lösenord"],
      ]
    : [
        ["keep", "Inget lösenord"],
        ["set", "Sätt ett lösenord"],
      ];
  const mode = radios("mode", opts, cur.mode === "none" && !app.doc.encrypted ? "keep" : cur.mode);
  const user = h("input", { type: "password", name: "user", autocomplete: "new-password", value: cur.user ?? "" });
  const user2 = h("input", { type: "password", name: "user2", autocomplete: "new-password", value: cur.user ?? "" });
  const owner = h("input", { type: "password", name: "owner", autocomplete: "new-password", value: cur.ownerSet ? cur.owner : "" });
  const setBox = h("div", { class: "sub-options" }, field("Lösenord för att öppna", user), field("Upprepa lösenordet", user2), field("Ägarlösenord (valfritt)", owner, "Ger full behörighet. Lämnas det tomt används samma lösenord."), h("p", { class: "field-hint" }, "Krypteringen blir AES-256. Glömmer du lösenordet går filen inte att öppna."));
  const body = h("div", {}, h("p", {}, status), mode, setBox, h("p", { class: "field-hint" }, "Ändringen gäller när du sparar filen."));
  const sync = () => (setBox.hidden = body.querySelector("input[name=mode]:checked").value !== "set");
  body.addEventListener("change", sync);
  sync();
  const ok = await dialog({
    title: "Lösenord",
    body,
    actions: [{ label: "Avbryt" }, { label: "OK", value: true, primary: true }],
    onSubmit: () => {
      const m = body.querySelector("input[name=mode]:checked").value;
      if (m !== "set") return true;
      if (!user.value) return toast("Ange ett lösenord.", { type: "error" }), false;
      if (user.value !== user2.value) return toast("Lösenorden är inte lika.", { type: "error" }), false;
      if (/,/.test(user.value + owner.value)) return toast("Lösenordet får inte innehålla kommatecken.", { type: "error" }), false;
      return true;
    },
  });
  if (!ok) return;
  const m = body.querySelector("input[name=mode]:checked").value;
  app.saveEncryption = m === "set" ? { mode: "set", user: user.value, owner: owner.value || user.value, ownerSet: !!owner.value } : { mode: m === "keep" && !app.doc.encrypted ? "none" : m };
  app.emit("encryption");
  const msg = m === "set" ? "Lösenordet sätts när du sparar." : m === "none" ? "Lösenordet tas bort när du sparar." : "Lösenordsinställningen är oförändrad.";
  toast(msg, { type: "success" });
}

// ---------- Signatur ----------

const SIG_KEY = "signatures";

function trimCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const m = 6;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(width - 1, x1 + m);
  y1 = Math.min(height - 1, y1 + m);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function dataUrlToBytes(url) {
  const bin = atob(url.split(",")[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function stampFromDataUrl(url, label, defaultWidth) {
  const img = new Image();
  img.src = url;
  await img.decode();
  app.stamp = { bytes: dataUrlToBytes(url), url, width: img.naturalWidth, height: img.naturalHeight, label, defaultWidth };
  app.setTool("stamp");
  toast("Klicka på sidan där den ska placeras, eller dra för att välja storlek.");
}

export async function signatureDialog() {
  const saved = settings.get(SIG_KEY, []);
  const canvas = h("canvas", { class: "sig-pad", width: 1200, height: 400 });
  const ctx = canvas.getContext("2d");
  let color = "#0b1f66";
  let drawing = false;
  let last = null;
  let hasInk = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };
  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    last = pos(e);
    canvas.setPointerCapture(e.pointerId);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    hasInk = true;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    const pressure = e.pressure && e.pointerType === "pen" ? 0.5 + e.pressure : 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 5 * pressure;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    last = p;
  });
  const stop = () => (drawing = false);
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);

  const colorSel = radios("sigcolor", [["#0b1f66", "Blå"], ["#000000", "Svart"]], color);
  colorSel.addEventListener("change", () => (color = colorSel.querySelector("input:checked").value));
  const remember = h("input", { type: "checkbox", name: "remember", checked: settings.get("sigRemember", true) });

  let chosen = null;
  const savedList = h("div", { class: "sig-saved" });
  const renderSaved = () =>
    savedList.replaceChildren(
      ...settings.get(SIG_KEY, []).map((url, k) =>
        h(
          "div",
          { class: "sig-item" },
          h("button", { type: "button", class: "sig-use", title: "Använd den här signaturen", onclick: () => { chosen = url; savedList.closest("dialog").querySelector("form").requestSubmit(); } }, h("img", { src: url, alt: `Sparad signatur ${k + 1}` })),
          iconButton("trash-2", "Ta bort sparad signatur", () => {
            const list = settings.get(SIG_KEY, []);
            list.splice(k, 1);
            settings.set(SIG_KEY, list);
            renderSaved();
          }),
        ),
      ),
    );
  renderSaved();

  const upload = h("button", {
    type: "button",
    class: "btn",
    onclick: async () => {
      const files = await pickFiles({ multiple: false, types: [{ description: "Bild", accept: { "image/*": [".png", ".jpg", ".jpeg"] } }] });
      if (!files.length) return;
      const bmp = await createImageBitmap(files[0].file);
      const s = Math.min(1, canvas.width / bmp.width, canvas.height / bmp.height);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, (canvas.width - bmp.width * s) / 2, (canvas.height - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
      hasInk = true;
    },
  }, "Använd bild …");

  const ok = await dialog({
    title: "Signera",
    wide: true,
    body: h(
      "div",
      {},
      saved.length ? h("div", {}, h("h3", {}, "Sparade signaturer"), savedList, h("h3", {}, "Ny signatur")) : null,
      h("p", { class: "field-hint" }, "Rita din signatur med musen, pekplattan eller en penna."),
      canvas,
      h("div", { class: "row" }, colorSel, h("button", { type: "button", class: "btn", onclick: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; } }, "Rensa"), upload),
      h("label", { class: "check" }, remember, h("span", {}, "Spara signaturen i den här webbläsaren")),
      h("p", { class: "field-hint" }, "Det här är en bild av din signatur, inte en digital (kryptografisk) underskrift."),
    ),
    actions: [{ label: "Avbryt" }, { label: "Placera signatur", value: true, primary: true }],
    onSubmit: () => {
      if (chosen) return true;
      if (!hasInk) return toast("Rita en signatur först.", { type: "error" }), false;
      return true;
    },
  });
  if (!ok) return;
  let url = chosen;
  if (!url) {
    const trimmed = trimCanvas(canvas);
    if (!trimmed) return;
    url = trimmed.toDataURL("image/png");
    settings.set("sigRemember", remember.checked);
    if (remember.checked) settings.set(SIG_KEY, [url, ...settings.get(SIG_KEY, [])].slice(0, 6));
  }
  await stampFromDataUrl(url, "Signera", 150);
}

export async function placeImage() {
  const files = await pickFiles({ multiple: false, types: [{ description: "Bild", accept: { "image/*": [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"] } }] });
  if (!files.length) return;
  try {
    const bytes = await imageBytesForPdf(files[0].file);
    const blob = new Blob([bytes]);
    const bmp = await createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    app.stamp = { bytes, url, width: bmp.width, height: bmp.height, label: "Infoga bild", defaultWidth: Math.min(300, (bmp.width * 72) / 96) };
    bmp.close();
    app.setTool("stamp");
    toast("Klicka på sidan där bilden ska placeras, eller dra för att välja storlek.");
  } catch (e) {
    showError(e);
  }
}

// ---------- Maskering ----------

export async function applyRedactionsDialog() {
  const n = await app.client.call("countRedactions");
  if (!n) return toast("Det finns inga markerade områden att maskera. Använd maskeringsverktyget eller sökpanelen först.");
  const ok = await dialog({
    title: "Verkställ maskering",
    body: h("div", {}, h("p", {}, `${n} ${n === 1 ? "område" : "områden"} kommer att svärtas. Text, bilder och grafik under dem tas bort permanent från filen.`), h("p", { class: "field-hint" }, "Du kan ångra så länge filen är öppen. Kontrollera resultatet innan du sparar.")),
    actions: [{ label: "Avbryt" }, { label: "Verkställ", value: true, primary: true, danger: true }],
  });
  if (!ok) return;
  try {
    const { state } = await busy("Maskerar …", () => app.client.call("applyRedactions"));
    app.setDoc(state);
    toast("Maskeringen är verkställd.", { type: "success" });
  } catch (e) {
    showError(e);
  }
}

// ---------- Inställningar och om ----------

export async function settingsDialog({ applyTheme }) {
  const theme = radios("theme", [["auto", "Följ systemet"], ["light", "Ljust"], ["dark", "Mörkt"]], settings.get("theme", "auto"));
  theme.addEventListener("change", () => applyTheme(theme.querySelector("input:checked").value));
  const recent = h("input", { type: "checkbox", name: "recent", checked: settings.get("recentEnabled", true) });
  await dialog({
    title: "Inställningar",
    body: h(
      "div",
      {},
      h("h3", {}, "Utseende"),
      theme,
      h("h3", {}, "Integritet"),
      h("label", { class: "check" }, recent, h("span", {}, "Kom ihåg senaste filer")),
      h("p", { class: "field-hint" }, "Bara en hänvisning till filen sparas i webbläsaren, aldrig innehållet. Stäng av på datorer som delas med andra."),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn", onclick: async () => { await clearRecent(); app.emit("recent"); toast("Listan med senaste filer är rensad."); } }, "Rensa senaste filer"),
        h("button", { type: "button", class: "btn", onclick: () => { settings.set(SIG_KEY, []); toast("Sparade signaturer är borttagna."); } }, "Ta bort sparade signaturer"),
      ),
    ),
    actions: [{ label: "Klar", value: true, primary: true }],
  });
  settings.set("recentEnabled", recent.checked);
  if (!recent.checked) await clearRecent();
  app.emit("recent");
}

export async function aboutDialog(version) {
  await dialog({
    title: "Om PDF-verktyg",
    body: h(
      "div",
      { class: "about" },
      h("p", {}, "PDF-verktyg körs helt i din webbläsare. Filerna lämnar aldrig datorn: ingenting laddas upp och ingen statistik samlas in. Efter första besöket fungerar appen även utan internet."),
      h("p", {}, `Version ${version}.`),
      h("p", {}, "Appen är fri programvara under licensen GNU AGPL 3.0. ", h("a", { href: "https://github.com/KarmaDonkey/Office-Tools", target: "_blank", rel: "noopener" }, "Källkoden finns på GitHub"), "."),
      h("p", {}, "PDF-motorn är ", h("a", { href: "https://mupdf.com", target: "_blank", rel: "noopener" }, "MuPDF"), " från Artifex (AGPL). Ikoner från Lucide (ISC)."),
      h("h3", {}, "Kortkommandon"),
      h(
        "dl",
        { class: "shortcuts" },
        [
          ["Ctrl+O", "Öppna"],
          ["Ctrl+S", "Spara"],
          ["Ctrl+Skift+S", "Spara som"],
          ["Ctrl+Z / Ctrl+Y", "Ångra / gör om"],
          ["Ctrl+F", "Sök"],
          ["Ctrl+plus / minus", "Zooma"],
          ["Ctrl+0", "Anpassa till bredd"],
          ["Esc", "Tillbaka till pekaren"],
          ["Delete", "Ta bort valda sidor (i miniatyrerna)"],
        ].map(([k, v]) => [h("dt", {}, h("kbd", {}, k)), h("dd", {}, v)]),
      ),
    ),
  });
}
