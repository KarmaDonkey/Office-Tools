import { test } from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import { createEngine } from "../src/core/engine.js";

function makePdf(pages = 3, { image = false } = {}) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  let imgref = null;
  if (image) {
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2400, 1800], false);
    pm.clear(180);
    imgref = doc.addImage(new mupdf.Image(pm));
  }
  for (let i = 0; i < pages; i++) {
    const res = doc.addObject({ Font: { F1: font }, ...(imgref ? { XObject: { Im0: imgref } } : {}) });
    const img = imgref ? "q 400 0 0 300 100 100 cm /Im0 Do Q " : "";
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, `${img}BT /F1 24 Tf 72 700 Td (Sida ${i + 1} hemlig) Tj ET`));
  }
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

const textOf = (bytes, i = 0) => mupdf.Document.openDocument(bytes, "application/pdf").loadPage(i).toStructuredText("").asText().trim();

test("öppna, rotera, ångra och gör om", () => {
  const e = createEngine(mupdf);
  const r = e.open(makePdf(3));
  assert.equal(r.needsPassword, false);
  assert.equal(r.state.pageCount, 3);
  let s = e.rotate([0], 90);
  assert.equal(s.pages[0].w, 842);
  assert.equal(s.undoLabel, "Rotera");
  s = e.undo();
  assert.equal(s.pages[0].w, 595);
  assert.equal(s.canRedo, true);
  s = e.redo();
  assert.equal(s.pages[0].w, 842);
});

test("flytta, ta bort och plocka ut sidor", () => {
  const e = createEngine(mupdf);
  e.open(makePdf(4));
  const { order } = e.movePages([3], 0);
  assert.deepEqual(order, [3, 0, 1, 2]);
  assert.match(e.pageText(0), /Sida 4/);
  const s = e.deletePages([1, 2]);
  assert.equal(s.pageCount, 2);
  assert.throws(() => e.deletePages([0, 1]), /Minst en sida/);
  const out = e.extract([1]);
  assert.match(textOf(out), /Sida 3/);
});

test("dela upp och slå ihop", () => {
  const e = createEngine(mupdf);
  e.open(makePdf(5));
  const parts = e.splitParts([[0, 1], [2, 3, 4]]);
  assert.equal(parts.length, 2);
  assert.equal(mupdf.Document.openDocument(parts[1], "application/pdf").countPages(), 3);
  const s = e.insertPdf(parts[0], 5);
  assert.equal(s.pageCount, 7);
  assert.match(e.pageText(6), /Sida 2/);
  const bySize = e.planSplitBySize(1);
  assert.equal(bySize.length, 7);
});

test("lösenord: öppna, ta bort och sätta nytt", () => {
  const e = createEngine(mupdf);
  e.open(makePdf(1));
  const locked = e.save({ encryption: { mode: "set", user: "hemligt" } });
  const e2 = createEngine(mupdf);
  assert.equal(e2.open(locked).needsPassword, true);
  assert.equal(e2.authenticate("fel").ok, false);
  const ok = e2.authenticate("hemligt");
  assert.equal(ok.ok, true);
  assert.equal(ok.state.encrypted, true);
  // Behåll skyddet
  assert.equal(mupdf.Document.openDocument(e2.save(), "application/pdf").needsPassword(), true);
  // Ta bort
  const open = e2.save({ encryption: { mode: "none" } });
  assert.equal(mupdf.Document.openDocument(open, "application/pdf").needsPassword(), false);
  assert.throws(() => e2.save({ encryption: { mode: "set", user: "a,b" } }), /kommatecken/);
});

test("anteckningar, maskering och formulärfria sidor", () => {
  const e = createEngine(mupdf);
  e.open(makePdf(1));
  const hits = e.search("hemlig");
  assert.equal(hits.length, 1);
  e.addHighlight(0, hits[0].hits[0]);
  e.addInk(0, [[[100, 100], [150, 150]]]);
  e.addText(0, [72, 300, 300, 330], "Åäö text", 14);
  const types = e.listAnnots(0).map((a) => a.type);
  assert.deepEqual(types, ["Highlight", "Ink", "FreeText"]);
  e.addRedactionsForHits(hits);
  assert.equal(e.countRedactions(), 1);
  e.applyRedactions();
  assert.equal(e.countRedactions(), 0);
  assert.doesNotMatch(e.pageText(0), /hemlig/);
  assert.match(e.pageText(0), /Sida 1/);
  assert.equal(e.getWidgets(0).length, 0);
});

test("vattenstämpel, sidnummer och metadata", () => {
  const e = createEngine(mupdf);
  e.open(makePdf(3));
  e.rotate([1], 90);
  e.watermark({ text: "UTKAST åäö" });
  e.pageNumbers({ format: "Sida {n} av {total}" });
  assert.match(e.pageText(0), /UTKAST åäö/);
  assert.match(e.pageText(2), /Sida 3 av 3/);
  assert.match(e.pageText(1), /Sida 2 av 3/);
  e.setMetadata({ Title: "Min titel", Author: "Någon" });
  const out = e.save();
  const d = mupdf.Document.openDocument(out, "application/pdf");
  assert.equal(d.getMetaData("info:Title"), "Min titel");
  assert.equal(d.getMetaData("info:Author"), "Någon");
});

test("bilder till PDF, PDF till bild och komprimering", () => {
  const e = createEngine(mupdf);
  e.newDocument();
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 300, 200], false);
  pm.clear(90);
  const png = pm.asPNG().slice();
  let s = e.insertImages([png, png], -1, "a4");
  assert.equal(s.pageCount, 2);
  assert.equal(s.pages[0].w, 842);
  const jpg = e.exportPageImage(0, 72, "jpeg");
  assert.equal(jpg[0], 0xff);
  const png2 = e.exportPageImage(0, 72, "png");
  assert.equal(png2[1], 0x50);

  const e2 = createEngine(mupdf);
  e2.open(makePdf(2, { image: true }));
  const before = e2.save().length;
  const { result } = e2.compressImages("strong");
  assert.equal(result, 1);
  const after = e2.save({ extra: "compress-fonts,compress-images,garbage=deduplicate" }).length;
  assert.ok(after < before, `${after} < ${before}`);
  const r = e2.render(0, 0.5);
  assert.equal(r.pixels.length, r.width * r.height * 4);
});

function makeFormPdf() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  for (let i = 0; i < 3; i++) {
    const res = doc.addObject({ Font: { F1: font } });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, `BT /F1 24 Tf 72 700 Td (Sida ${i + 1}) Tj ET`));
  }
  const page = doc.findPage(0);
  const field = doc.addObject({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: "Namn", Rect: [100, 600, 300, 620], F: 4, DA: "/Helv 11 Tf 0 g", V: "", P: page });
  page.put("Annots", [field]);
  const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
  doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: [field], DA: "/Helv 0 Tf 0 g", DR: { Font: { Helv: helv } } }));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

const fieldCount = (bytes) => {
  const d = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  const f = d.getTrailer().get("Root", "AcroForm", "Fields");
  return f.isNull() ? 0 : f.resolve().length;
};

test("formulär och anteckningar följer med när sidor flyttas, delas och slås ihop", () => {
  const e = createEngine(mupdf);
  e.open(makeFormPdf());
  e.setWidget(0, 0, "Anna");
  e.addHighlight(0, e.search("Sida 1")[0].hits[0]);
  let s = e.movePages([0], 3).state;
  assert.equal(s.hasForms, true);
  assert.equal(e.getWidgets(2)[0].value, "Anna");
  s = e.deletePages([0]);
  assert.equal(s.hasForms, true);
  assert.equal(fieldCount(e.save()), 1);

  const parts = e.splitParts([[0], [1]]);
  assert.equal(fieldCount(parts[0]), 0);
  assert.equal(fieldCount(parts[1]), 1);
  const p1 = mupdf.Document.openDocument(parts[1], "application/pdf").loadPage(0);
  assert.deepEqual(p1.getAnnotations().map((a) => a.getType()), ["Highlight"]);
  assert.equal(p1.getWidgets()[0].getValue(), "Anna");
  assert.equal(fieldCount(e.extract([1])), 1);

  const e2 = createEngine(mupdf);
  e2.open(makePdf(1));
  const m = e2.insertPdf(parts[1], 1);
  assert.equal(m.hasForms, true);
  assert.equal(e2.getWidgets(1)[0].value, "Anna");
  assert.deepEqual(e2.listAnnots(1).map((a) => a.type), ["Highlight"]);
});
