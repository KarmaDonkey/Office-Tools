// PDF-motor ovanpå MuPDF.js. Körs i en Web Worker i appen och direkt i Node i testerna.
// All bearbetning sker lokalt; ingen data lämnar datorn.
//
// Koordinater: alla rektanglar och punkter som går in och ut ur motorn är i MuPDF:s
// sidrymd (origo uppe till vänster, y nedåt, enhet punkt = 1/72 tum, rotation inräknad).

export const SAVE_BASE = "garbage=compact,compress,objstms";

const ANNOT_SKIP = new Set(["Widget", "Link", "Popup"]);

// resolve() fungerar inte på saknade (null) objekt.
const R = (o) => (o.isNull() ? o : o.resolve());

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createEngine(mupdf) {
  let doc = null; // PDFDocument
  let pending = null; // dokument som väntar på lösenord
  let rev = 0;
  let dirty = false;
  let nameCounter = 0;
  let helvetica = null;

  const font = () => (helvetica ??= new mupdf.Font("Helvetica"));
  const uniq = (p) => `${p}${Date.now().toString(36)}${(nameCounter++).toString(36)}`;

  function requireDoc() {
    if (!doc) throw new EngineError("nodoc", "Inget dokument är öppet.");
    return doc;
  }

  function openBytes(bytes) {
    let d;
    try {
      d = mupdf.Document.openDocument(bytes, "application/pdf");
    } catch (e) {
      throw new EngineError("invalid", "Filen kunde inte läsas som PDF.");
    }
    const pdf = d.asPDF();
    if (!pdf) throw new EngineError("invalid", "Filen är inte en PDF.");
    return pdf;
  }

  function adopt(d) {
    doc = d;
    pending = null;
    doc.enableJournal();
    rev++;
    dirty = false;
  }

  function mutate(label, fn) {
    const d = requireDoc();
    d.beginOperation(label);
    let result;
    try {
      result = fn(d);
      d.endOperation();
    } catch (e) {
      try {
        d.endOperation();
        if (d.canUndo()) d.undo();
      } catch {
        /* ignore */
      }
      throw e;
    }
    rev++;
    dirty = true;
    return { result, state: state() };
  }

  function pageBounds(i) {
    const p = doc.loadPage(i);
    const b = p.getBounds();
    p.destroy?.();
    return b;
  }

  function hasForms(d) {
    try {
      const f = R(d.getTrailer().get("Root", "AcroForm", "Fields"));
      if (f.isArray() && f.length > 0) return true;
      // Fältlistan kan saknas trots att sidorna har formulärfält.
      for (let i = 0; i < Math.min(d.countPages(), 50); i++) if (d.loadPage(i).getWidgets().length) return true;
      return false;
    } catch {
      return false;
    }
  }

  function state() {
    if (!doc) return { open: false, rev };
    const n = doc.countPages();
    const pages = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = pageBounds(i);
      pages[i] = { x0: b[0], y0: b[1], w: b[2] - b[0], h: b[3] - b[1] };
    }
    const j = doc.getJournal();
    const enc = doc.getMetaData("encryption") || "None";
    return {
      open: true,
      rev,
      dirty,
      pageCount: n,
      pages,
      encrypted: enc !== "None",
      encryption: enc,
      hasForms: hasForms(doc),
      canUndo: doc.canUndo(),
      canRedo: doc.canRedo(),
      undoLabel: doc.canUndo() ? j.steps[j.position - 1] : null,
      redoLabel: doc.canRedo() ? j.steps[j.position] : null,
    };
  }

  // ---------- Hjälpfunktioner för innehåll ----------

  function pdfString(text) {
    let out = "(";
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
      else if (c >= 0x20 && c < 0x7f) out += ch;
      else if (c >= 0xa0 && c <= 0xff) out += "\\" + c.toString(8).padStart(3, "0");
      else out += "?";
    }
    return out + ")";
  }

  function textWidthEm(text) {
    const f = font();
    let w = 0;
    for (const ch of text) w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)));
    return w;
  }

  const num = (v) => (Math.abs(v) < 1e-9 ? "0" : Number(v.toFixed(4)).toString());

  // Lägger till innehåll på en sida. Befintligt innehåll kapslas in i q/Q.
  function appendContent(d, pageIndex, content, resources) {
    const pageObj = d.findPage(pageIndex);
    let res = pageObj.get("Resources");
    if (res.isNull()) {
      const inh = pageObj.getInheritable("Resources");
      res = d.newDictionary();
      if (!inh.isNull()) inh.resolve().forEach((v, k) => res.put(k, v));
      pageObj.put("Resources", res);
    }
    res = res.resolve();
    for (const [cat, entries] of Object.entries(resources)) {
      let sub = res.get(cat);
      if (sub.isNull()) {
        sub = d.newDictionary();
        res.put(cat, sub);
      }
      sub = sub.resolve();
      for (const [name, value] of Object.entries(entries)) sub.put(name, value);
    }
    const arr = d.newArray();
    arr.push(d.addStream("q\n", {}));
    const c = pageObj.get("Contents");
    const cr = c.isNull() ? c : c.resolve();
    if (cr.isArray()) cr.forEach((v) => arr.push(v));
    else if (!c.isNull()) arr.push(c);
    arr.push(d.addStream("\nQ\n" + content + "\n", {}));
    pageObj.put("Contents", arr);
  }

  // Bygger en textoperation som ritas upprätt i den visuella sidrymden.
  function textOp(page, { text, x, y, size, angle = 0, align = "center", vcenter = false, color, fontName, gsName }) {
    const wem = textWidthEm(text);
    const dx = align === "center" ? -wem / 2 : align === "right" ? -wem : 0;
    const dy = vcenter ? -0.35 : 0;
    const M = mupdf.Matrix;
    const inv = M.invert(page.getTransform());
    let m = M.translate(dx, dy);
    m = M.concat(m, M.scale(size, -size));
    m = M.concat(m, M.rotate(-angle));
    m = M.concat(m, M.translate(x, y));
    m = M.concat(m, inv);
    const [r, g, b] = color;
    return `q /${gsName} gs ${num(r)} ${num(g)} ${num(b)} rg BT /${fontName} 1 Tf ${m.map(num).join(" ")} Tm ${pdfString(text)} Tj ET Q`;
  }

  function addImagePage(d, at, bytes, fit) {
    let image;
    try {
      image = new mupdf.Image(bytes);
    } catch {
      throw new EngineError("image", "Bilden kunde inte läsas.");
    }
    const pw = image.getWidth();
    const ph = image.getHeight();
    const xres = image.getXResolution() || 96;
    const yres = image.getYResolution() || 96;
    let iw = (pw * 72) / xres;
    let ih = (ph * 72) / yres;
    let W, H, x, y;
    if (fit === "a4") {
      const land = iw > ih;
      W = land ? 842 : 595;
      H = land ? 595 : 842;
      const margin = 28;
      const s = Math.min((W - 2 * margin) / iw, (H - 2 * margin) / ih, 1);
      iw *= s;
      ih *= s;
      x = (W - iw) / 2;
      y = (H - ih) / 2;
    } else {
      // Bildens storlek, men aldrig större än 200 tum (PDF-gräns).
      const s = Math.min(1, 14400 / Math.max(iw, ih));
      iw *= s;
      ih *= s;
      W = iw;
      H = ih;
      x = 0;
      y = 0;
    }
    const ref = d.addImage(image);
    const res = d.addObject({ XObject: { Im0: ref } });
    const obj = d.addPage([0, 0, W, H], 0, res, `q ${num(iw)} 0 0 ${num(ih)} ${num(x)} ${num(y)} cm /Im0 Do Q`);
    d.insertPage(at, obj);
  }

  // Tar bort formulärfält vars widgetar inte längre finns på någon sida.
  function pruneFields(d, acroForm) {
    const fields = R(acroForm.get("Fields"));
    if (!fields.isArray()) return;
    const alive = new Set();
    for (let i = 0; i < d.countPages(); i++) {
      const annots = R(d.findPage(i).get("Annots"));
      if (annots.isArray()) annots.forEach((a) => a.isIndirect() && alive.add(a.asIndirect()));
    }
    const isAlive = (f) => {
      if (f.isIndirect() && alive.has(f.asIndirect())) return true;
      const kids = R(R(f).get("Kids"));
      let any = false;
      if (kids.isArray()) kids.forEach((k) => (any ||= isAlive(k)));
      return any;
    };
    const keep = d.newArray();
    fields.forEach((f) => isAlive(f) && keep.push(f));
    acroForm.put("Fields", keep);
  }

  // rearrangePages tar bort formulärdefinitionen (AcroForm). Den sparas och läggs tillbaka.
  function rearrangeKeepingForms(d, order) {
    const root = d.getTrailer().get("Root");
    let af = root.get("AcroForm");
    if (!af.isNull() && !af.isIndirect()) af = d.addObject(af);
    d.rearrangePages(order);
    if (!af.isNull() && root.get("AcroForm").isNull()) {
      pruneFields(d, af.resolve());
      root.put("AcroForm", af);
    }
  }

  function graftInto(dest, src, at, indices) {
    const map = dest.newGraftMap();
    const start = at < 0 ? dest.countPages() : at;
    indices.forEach((srcIndex, k) => {
      const to = start + k;
      map.graftPage(to, src, srcIndex);
      // graftPage tar inte med anteckningar och formulärfält; kopiera dem.
      const srcAnnots = R(src.findPage(srcIndex).get("Annots"));
      if (srcAnnots.isArray() && srcAnnots.length) {
        const destPage = dest.findPage(to);
        const arr = dest.newArray();
        srcAnnots.forEach((a) => {
          const sub = R(a).get("Subtype");
          if (sub.isName() && sub.asName() === "Popup") return;
          const g = map.graftObject(a);
          const gr = R(g);
          if (gr.isDictionary()) {
            gr.put("P", destPage);
            gr.delete("Popup");
          }
          arr.push(g);
        });
        destPage.put("Annots", arr);
      }
    });
    // Behåll formulärfält från källan.
    try {
      const fields = src.getTrailer().get("Root", "AcroForm", "Fields");
      if (fields.isArray() && fields.length > 0) {
        const root = dest.getTrailer().get("Root");
        let af = root.get("AcroForm");
        if (af.isNull()) {
          af = dest.addObject(dest.newDictionary());
          root.put("AcroForm", af);
        }
        af = af.resolve();
        let destFields = af.get("Fields");
        if (destFields.isNull()) {
          destFields = dest.newArray();
          af.put("Fields", destFields);
        }
        destFields = destFields.resolve();
        const g = map.graftObject(fields).resolve();
        g.forEach((f) => destFields.push(f));
        pruneFields(dest, af);
        if (af.get("NeedAppearances").isNull()) af.put("NeedAppearances", true);
      }
    } catch {
      /* formulär är best effort */
    }
  }

  function savedBytes(d, options) {
    const buf = d.saveToBuffer(options);
    const out = buf.asUint8Array().slice();
    buf.destroy?.();
    return out;
  }

  function partFromPages(indices) {
    const part = new mupdf.PDFDocument();
    graftInto(part, doc, -1, indices);
    return part;
  }

  function renderPixmap(i, scale, { widgets = true, alpha = true } = {}) {
    const page = doc.loadPage(i);
    const m = mupdf.Matrix.scale(scale, scale);
    const bbox = mupdf.Rect.transform(page.getBounds(), m).map((v, k) => (k < 2 ? Math.floor(v) : Math.ceil(v)));
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, alpha);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    page.runPageContents(dev, m);
    page.runPageAnnots(dev, m);
    if (widgets) page.runPageWidgets(dev, m);
    dev.close();
    dev.destroy?.();
    page.destroy?.();
    return pix;
  }

  // ---------- Publikt API ----------

  const api = {
    state,

    open(bytes) {
      const d = openBytes(bytes);
      if (d.needsPassword()) {
        pending = d;
        return { needsPassword: true };
      }
      adopt(d);
      return { needsPassword: false, state: state() };
    },

    authenticate(password) {
      if (!pending) throw new EngineError("nopending", "Inget låst dokument väntar.");
      const ok = pending.authenticatePassword(password);
      if (!ok) return { ok: false };
      adopt(pending);
      return { ok: true, state: state() };
    },

    cancelPending() {
      pending = null;
      return state();
    },

    newDocument() {
      adopt(new mupdf.PDFDocument());
      return state();
    },

    close() {
      doc = null;
      pending = null;
      rev++;
      dirty = false;
      return state();
    },

    markSaved() {
      dirty = false;
      return state();
    },

    undo() {
      const d = requireDoc();
      if (d.canUndo()) {
        d.undo();
        rev++;
        dirty = true;
      }
      return state();
    },

    redo() {
      const d = requireDoc();
      if (d.canRedo()) {
        d.redo();
        rev++;
        dirty = true;
      }
      return state();
    },

    // Renderar en sida till RGBA-pixlar.
    render(i, scale, widgets = true) {
      requireDoc();
      const pix = renderPixmap(i, scale, { widgets, alpha: true });
      const width = pix.getWidth();
      const height = pix.getHeight();
      const pixels = new Uint8ClampedArray(pix.getPixels());
      pix.destroy?.();
      return { width, height, pixels };
    },

    exportPageImage(i, dpi, format = "png", quality = 85) {
      requireDoc();
      const pix = renderPixmap(i, dpi / 72, { widgets: true, alpha: false });
      const bytes = format === "jpeg" ? pix.asJPEG(quality) : pix.asPNG();
      const out = bytes.slice();
      pix.destroy?.();
      return out;
    },

    // ---------- Text ----------

    search(needle, maxPerPage = 500) {
      const d = requireDoc();
      const out = [];
      if (!needle) return out;
      for (let i = 0; i < d.countPages(); i++) {
        const page = d.loadPage(i);
        const hits = page.search(needle, "").slice(0, maxPerPage);
        if (hits.length) out.push({ page: i, hits });
        page.destroy?.();
      }
      return out;
    },

    highlightQuads(i, p, q) {
      const page = requireDoc().loadPage(i);
      const st = page.toStructuredText("");
      const quads = st.highlight(p, q, 1000);
      st.destroy?.();
      return quads;
    },

    pageText(i) {
      const page = requireDoc().loadPage(i);
      const st = page.toStructuredText("");
      const t = st.asText();
      st.destroy?.();
      return t;
    },

    // ---------- Sidor ----------

    rotate(indices, delta) {
      return mutate("Rotera", (d) => {
        for (const i of indices) {
          const obj = d.findPage(i);
          const cur = obj.getInheritable("Rotate");
          const n = cur.isNumber() ? cur.asNumber() : 0;
          obj.put("Rotate", (((n + delta) % 360) + 360) % 360);
        }
      }).state;
    },

    deletePages(indices) {
      const d = requireDoc();
      if (indices.length >= d.countPages()) throw new EngineError("allpages", "Minst en sida måste finnas kvar.");
      return mutate("Ta bort sidor", (d) => {
        [...new Set(indices)].sort((a, b) => b - a).forEach((i) => d.deletePage(i));
      }).state;
    },

    // Flyttar de valda sidorna så att de hamnar före sidan "before" (index i ursprunglig ordning).
    movePages(indices, before) {
      const d = requireDoc();
      const n = d.countPages();
      const sel = new Set(indices);
      const rest = [];
      let insertAt = 0;
      for (let i = 0; i < n; i++) {
        if (i === before) insertAt = rest.length;
        if (!sel.has(i)) rest.push(i);
      }
      if (before >= n) insertAt = rest.length;
      const moved = [...sel].sort((a, b) => a - b);
      const order = [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];
      if (order.every((v, k) => v === k)) return { state: state(), order };
      const s = mutate("Flytta sidor", (d) => rearrangeKeepingForms(d, order)).state;
      return { state: s, order };
    },

    reorder(order) {
      return mutate("Ändra ordning", (d) => rearrangeKeepingForms(d, order)).state;
    },

    // Plockar ut sidor till en ny fil. Hela dokumentet klonas så att länkar och formulär följer med.
    extract(indices) {
      const d = requireDoc();
      const clone = new mupdf.PDFDocument(savedBytes(d, "encrypt=none"));
      rearrangeKeepingForms(clone, [...indices].sort((a, b) => a - b));
      return savedBytes(clone, SAVE_BASE + ",encrypt=none");
    },

    splitParts(ranges) {
      requireDoc();
      return ranges.map((r) => savedBytes(partFromPages(r), SAVE_BASE));
    },

    // Delar upp så att varje del blir högst maxBytes (ungefärligt).
    planSplitBySize(maxBytes) {
      const d = requireDoc();
      const n = d.countPages();
      const sizes = [];
      for (let i = 0; i < n; i++) sizes.push(savedBytes(partFromPages([i]), SAVE_BASE).length);
      const groups = [];
      let cur = [];
      let acc = 0;
      for (let i = 0; i < n; i++) {
        if (cur.length && acc + sizes[i] > maxBytes) {
          groups.push(cur);
          cur = [];
          acc = 0;
        }
        cur.push(i);
        acc += sizes[i];
      }
      if (cur.length) groups.push(cur);
      // Gemensamma resurser (typsnitt) räknas flera gånger ovan; kontrollera och dela vid behov.
      const result = [];
      const check = (g) => {
        const bytes = savedBytes(partFromPages(g), SAVE_BASE);
        if (bytes.length > maxBytes && g.length > 1) {
          const mid = Math.ceil(g.length / 2);
          check(g.slice(0, mid));
          check(g.slice(mid));
        } else result.push({ pages: g, bytes });
      };
      groups.forEach(check);
      return result;
    },

    insertPdf(bytes, at, password) {
      const src = openBytes(bytes);
      if (src.needsPassword()) {
        if (!password) throw new EngineError("password", "Filen är lösenordsskyddad.");
        if (!src.authenticatePassword(password)) throw new EngineError("badpassword", "Fel lösenord.");
      }
      const count = src.countPages();
      const indices = [...Array(count).keys()];
      return mutate("Infoga PDF", (d) => graftInto(d, src, at, indices)).state;
    },

    insertImages(images, at, fit = "image") {
      return mutate("Infoga bilder", (d) => {
        let pos = at < 0 ? d.countPages() : at;
        for (const bytes of images) addImagePage(d, pos++, bytes, fit);
      }).state;
    },

    insertBlankPage(at, w = 595, h = 842) {
      return mutate("Infoga tom sida", (d) => {
        d.insertPage(at, d.addPage([0, 0, w, h], 0, {}, ""));
      }).state;
    },

    // ---------- Anteckningar ----------

    addHighlight(i, quads, color = [1, 0.85, 0]) {
      return mutate("Markera", (d) => {
        const page = d.loadPage(i);
        const a = page.createAnnotation("Highlight");
        a.setColor(color);
        a.setQuadPoints(quads);
        a.update();
      }).state;
    },

    addHighlightsForHits(results, color = [1, 0.85, 0]) {
      return mutate("Markera sökträffar", (d) => {
        for (const { page: i, hits } of results) {
          const page = d.loadPage(i);
          for (const quads of hits) {
            const a = page.createAnnotation("Highlight");
            a.setColor(color);
            a.setQuadPoints(quads);
            a.update();
          }
        }
      }).state;
    },

    addInk(i, strokes, color = [0.85, 0, 0], width = 2) {
      return mutate("Rita", (d) => {
        const page = d.loadPage(i);
        const a = page.createAnnotation("Ink");
        a.setInkList(strokes);
        a.setColor(color);
        a.setBorderWidth(width);
        a.update();
      }).state;
    },

    addText(i, rect, text, size = 12, color = [0, 0, 0]) {
      return mutate("Text", (d) => {
        const page = d.loadPage(i);
        const a = page.createAnnotation("FreeText");
        a.setRect(rect);
        a.setContents(text);
        a.setDefaultAppearance("Helv", size, color);
        a.setBorderWidth(0);
        a.update();
      }).state;
    },

    measureText(text, size) {
      const lines = text.split("\n");
      return { width: Math.max(...lines.map((l) => textWidthEm(l))) * size, lines: lines.length };
    },

    addImageStamp(i, rect, bytes, label = "Signera") {
      return mutate(label, (d) => {
        const page = d.loadPage(i);
        const a = page.createAnnotation("Stamp");
        a.setRect(rect);
        a.setStampImage(new mupdf.Image(bytes));
        a.update();
      }).state;
    },

    addRedaction(i, rect) {
      return mutate("Maskera område", (d) => {
        const page = d.loadPage(i);
        const a = page.createAnnotation("Redact");
        a.setRect(rect);
        a.update();
      }).state;
    },

    addRedactionsForHits(results) {
      return mutate("Maskera sökträffar", (d) => {
        for (const { page: i, hits } of results) {
          const page = d.loadPage(i);
          for (const quads of hits) {
            const a = page.createAnnotation("Redact");
            a.setQuadPoints(quads);
            a.update();
          }
        }
      }).state;
    },

    countRedactions() {
      const d = requireDoc();
      let n = 0;
      for (let i = 0; i < d.countPages(); i++) {
        const page = d.loadPage(i);
        n += page.getAnnotations().filter((a) => a.getType() === "Redact").length;
      }
      return n;
    },

    applyRedactions() {
      return mutate("Verkställ maskering", (d) => {
        let n = 0;
        for (let i = 0; i < d.countPages(); i++) {
          const page = d.loadPage(i);
          if (page.getAnnotations().some((a) => a.getType() === "Redact")) {
            page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
            n++;
          }
        }
        return n;
      });
    },

    listAnnots(i) {
      const page = requireDoc().loadPage(i);
      return page
        .getAnnotations()
        .map((a, idx) => ({ idx, type: a.getType(), rect: a.getBounds() }))
        .filter((a) => !ANNOT_SKIP.has(a.type));
    },

    deleteAnnot(i, idx) {
      return mutate("Ta bort anteckning", (d) => {
        const page = d.loadPage(i);
        const a = page.getAnnotations()[idx];
        if (a) page.deleteAnnotation(a);
      }).state;
    },

    // ---------- Formulär ----------

    getWidgets(i) {
      const page = requireDoc().loadPage(i);
      return page.getWidgets().map((w, idx) => {
        const type = w.isCheckbox() ? "checkbox" : w.isRadioButton() ? "radio" : w.isPushButton() ? "button" : w.isComboBox() ? "combo" : w.isListBox() ? "list" : w.isText() ? "text" : w.getFieldType();
        const o = { idx, type, rect: w.getBounds(), name: w.getName(), readOnly: w.isReadOnly(), value: w.getValue() };
        if (type === "text") {
          o.multiline = w.isMultiline();
          o.password = w.isPassword();
          o.maxLen = w.getMaxLen();
        }
        if (type === "combo" || type === "list") o.options = w.getOptions();
        if (type === "checkbox" || type === "radio") o.checked = o.value !== "Off" && o.value !== "";
        return o;
      });
    },

    setWidget(i, idx, value) {
      return mutate("Fyll i fält", (d) => {
        const page = d.loadPage(i);
        const w = page.getWidgets()[idx];
        if (!w) return;
        if (w.isCheckbox() || w.isRadioButton()) {
          const on = w.getValue() !== "Off" && w.getValue() !== "";
          if (on !== !!value) w.toggle();
        } else if (w.isChoice()) {
          w.setChoiceValue(String(value));
        } else {
          w.setTextValue(String(value));
        }
        w.update();
        page.update();
      }).state;
    },

    // ---------- Vattenstämpel och sidnummer ----------

    watermark({ text, size = 60, color = [0.8, 0, 0], opacity = 0.25, angle = 45, pages }) {
      if (!text) throw new EngineError("input", "Ange en text.");
      return mutate("Vattenstämpel", (d) => {
        const fontRef = d.addSimpleFont(font(), "Latin");
        const gs = d.addObject({ Type: "ExtGState", ca: opacity, CA: opacity });
        const fname = uniq("OTF");
        const gname = uniq("OTG");
        const list = pages ?? [...Array(d.countPages()).keys()];
        for (const i of list) {
          const page = d.loadPage(i);
          const b = page.getBounds();
          const op = textOp(page, { text, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, size, angle, align: "center", vcenter: true, color, fontName: fname, gsName: gname });
          appendContent(d, i, op, { Font: { [fname]: fontRef }, ExtGState: { [gname]: gs } });
        }
      }).state;
    },

    pageNumbers({ format = "{n}", position = "bottom-center", start = 1, size = 10, margin = 28, skipFirst = false, color = [0, 0, 0] }) {
      return mutate("Sidnummer", (d) => {
        const fontRef = d.addSimpleFont(font(), "Latin");
        const gs = d.addObject({ Type: "ExtGState", ca: 1, CA: 1 });
        const fname = uniq("OTF");
        const gname = uniq("OTG");
        const n = d.countPages();
        const first = skipFirst ? 1 : 0;
        const total = n - first + start - 1;
        for (let i = first; i < n; i++) {
          const page = d.loadPage(i);
          const b = page.getBounds();
          const label = format.replaceAll("{n}", String(i - first + start)).replaceAll("{total}", String(total));
          const [vert, horiz] = position.split("-");
          const y = vert === "top" ? b[1] + margin + size * 0.75 : b[3] - margin;
          const x = horiz === "left" ? b[0] + margin : horiz === "right" ? b[2] - margin : (b[0] + b[2]) / 2;
          const align = horiz === "left" ? "left" : horiz === "right" ? "right" : "center";
          const op = textOp(page, { text: label, x, y, size, angle: 0, align, color, fontName: fname, gsName: gname });
          appendContent(d, i, op, { Font: { [fname]: fontRef }, ExtGState: { [gname]: gs } });
        }
      }).state;
    },

    // ---------- Metadata ----------

    getMetadata() {
      const d = requireDoc();
      const keys = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"];
      const out = {};
      for (const k of keys) out[k] = d.getMetaData("info:" + k) || "";
      out.format = d.getMetaData("format") || "";
      return out;
    },

    setMetadata(values) {
      return mutate("Metadata", (d) => {
        for (const [k, v] of Object.entries(values)) d.setMetaData("info:" + k, v ?? "");
      }).state;
    },

    // ---------- Komprimering ----------

    // Skalar ner och komprimerar om bilder. level: "medium" | "strong".
    compressImages(level) {
      const params = level === "strong" ? { maxDim: 1000, quality: 55 } : { maxDim: 1600, quality: 75 };
      return mutate("Komprimera", (d) => {
        const n = d.countObjects();
        const masks = new Set();
        for (let i = 1; i < n; i++) {
          const o = d.newIndirect(i);
          if (!o.isStream()) continue;
          const sm = o.get("SMask");
          if (sm.isIndirect()) masks.add(sm.asIndirect());
          const mk = o.get("Mask");
          if (mk.isIndirect()) masks.add(mk.asIndirect());
        }
        let changed = 0;
        for (let i = 1; i < n; i++) {
          if (masks.has(i)) continue;
          const o = d.newIndirect(i);
          if (!o.isStream()) continue;
          const st = o.resolve();
          if (st.get("Subtype").asName?.() !== "Image") continue;
          if (st.get("ImageMask").asBoolean?.()) continue;
          const bpc = st.get("BitsPerComponent");
          if (bpc.isNumber() && bpc.asNumber() < 8) continue;
          const filter = st.get("Filter");
          const isDct = filter.isName() ? filter.asName() === "DCTDecode" : filter.isArray() && filter.length === 1 && filter.get(0).asName() === "DCTDecode";
          let image;
          try {
            image = d.loadImage(o);
          } catch {
            continue;
          }
          const w = image.getWidth();
          const h = image.getHeight();
          const tooBig = Math.max(w, h) > params.maxDim;
          if (!tooBig && !isDct) continue;
          if (w * h < 128 * 128) continue;
          let pix;
          try {
            pix = image.toPixmap();
          } catch {
            continue;
          }
          if (pix.getAlpha()) continue;
          const cs = pix.getColorSpace();
          if (!cs) continue;
          if (!cs.isRGB() && !cs.isGray()) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
          const s = tooBig ? params.maxDim / Math.max(w, h) : 1;
          const nw = Math.max(1, Math.round(w * s));
          const nh = Math.max(1, Math.round(h * s));
          const out = s < 1 ? pix.warp([[0, 0], [w, 0], [w, h], [0, h]], nw, nh) : pix;
          const jpg = out.asJPEG(params.quality);
          const oldLen = o.readRawStream().getLength();
          if (jpg.length >= oldLen) continue;
          o.writeRawStream(jpg);
          st.put("Filter", d.newName("DCTDecode"));
          st.delete("DecodeParms");
          st.delete("Decode");
          st.put("Width", nw);
          st.put("Height", nh);
          st.put("BitsPerComponent", 8);
          st.put("ColorSpace", d.newName(out.getColorSpace().isGray() ? "DeviceGray" : "DeviceRGB"));
          changed++;
        }
        return changed;
      });
    },

    // ---------- Spara ----------

    // encryption: { mode: "keep" | "none" | "set", user, owner }, extra: ytterligare skrivflaggor
    save({ encryption = { mode: "keep" }, extra = "" } = {}) {
      const d = requireDoc();
      let enc;
      if (encryption.mode === "none") enc = "encrypt=none";
      else if (encryption.mode === "set") {
        const user = encryption.user ?? "";
        const owner = encryption.owner || user || uniq("o");
        for (const pw of [user, owner]) {
          if (/[,]/.test(pw)) throw new EngineError("input", "Lösenordet får inte innehålla kommatecken.");
        }
        enc = `encrypt=aes-256,user-password=${user},owner-password=${owner}`;
      } else enc = state().encrypted ? "encrypt=keep" : "encrypt=none";
      // Slå ihop flaggor; senare värden ersätter tidigare (t.ex. garbage).
      const opts = new Map();
      for (const part of [SAVE_BASE, enc, extra].join(",").split(",").filter(Boolean)) {
        const [k, ...v] = part.split("=");
        opts.set(k, v.length ? `${k}=${v.join("=")}` : k);
      }
      return savedBytes(d, [...opts.values()].join(","));
    },
  };

  return api;
}
