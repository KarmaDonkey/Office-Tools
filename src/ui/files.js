// Öppna, spara och exportera filer.
import { app, settings } from "../store.js";
import { h, dialog, field, toast, showError, busy, confirmDialog, formatBytes } from "./dom.js";
import { addRecent } from "./recent.js";

const PDF_TYPE = { description: "PDF-dokument", accept: { "application/pdf": [".pdf"] } };
const IMAGE_TYPE = { description: "Bilder", accept: { "image/*": [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".avif"] } };

const isPdf = (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);
const isImage = (file) => file.type.startsWith("image/") || /\.(png|jpe?g|gif|bmp|tiff?|webp|avif)$/i.test(file.name);

// ---------- Välja filer ----------

export async function pickFiles({ multiple = true, types = [PDF_TYPE, IMAGE_TYPE] } = {}) {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({ multiple, types, excludeAcceptAllOption: false, id: "open" });
      return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
    } catch (e) {
      if (e.name === "AbortError") return [];
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = h("input", { type: "file", multiple, accept: types.flatMap((t) => Object.values(t.accept).flat()).join(",") });
    input.addEventListener("change", () => resolve([...input.files].map((file) => ({ file, handle: null }))));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

// ---------- Öppna ----------

export async function confirmDiscard() {
  if (!app.doc.open || !app.doc.dirty) return true;
  return confirmDialog("Osparade ändringar", "Dokumentet har ändringar som inte är sparade. Vill du fortsätta och förlora dem?", "Fortsätt utan att spara", true);
}

async function askPassword(name, retry) {
  const input = h("input", { type: "password", name: "pw", autocomplete: "off", required: true });
  const ok = await dialog({
    title: "Lösenordsskyddad fil",
    body: h("div", {}, h("p", {}, `”${name}” är skyddad med lösenord.`), retry ? h("p", { class: "error-text" }, "Fel lösenord, försök igen.") : null, field("Lösenord", input)),
    actions: [{ label: "Avbryt", value: null }, { label: "Öppna", value: true, primary: true }],
  });
  return ok ? input.value : null;
}

// Öppnar en PDF som aktuellt dokument.
export async function openPdf(file, handle = null) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const res = await busy("Öppnar …", () => app.client.callTransfer("open", [bytes], [bytes.buffer]));
  let state = res.state;
  if (res.needsPassword) {
    let retry = false;
    for (;;) {
      const pw = await askPassword(file.name, retry);
      if (pw == null) {
        await app.client.call("cancelPending");
        return false;
      }
      const r = await app.client.call("authenticate", pw);
      if (r.ok) {
        state = r.state;
        break;
      }
      retry = true;
    }
  }
  app.file = { name: file.name, handle, size: file.size };
  app.saveEncryption = { mode: "keep" };
  app.selection.clear();
  app.currentPage = 0;
  app.search = { query: "", results: [], flat: [], current: -1 };
  app.freshDoc = true;
  app.setDoc(state);
  app.emit("search");
  app.emit("file");
  // Ingen förhandsbild för lösenordsskyddade filer: den skulle sparas oskyddad.
  if (handle) (app.doc.encrypted ? Promise.resolve(null) : firstPageThumb()).then((thumb) => addRecent(handle, file.name, file.size, thumb));
  return true;
}

// Liten förhandsbild av första sidan till listan med senaste filer.
async function firstPageThumb() {
  try {
    const p = app.doc.pages[0];
    if (!p) return null;
    const res = await app.client.call("renderBitmap", 0, 220 / Math.max(p.w, p.h), true);
    const canvas = document.createElement("canvas");
    canvas.width = res.width;
    canvas.height = res.height;
    canvas.getContext("2d").drawImage(res.bitmap, 0, 0);
    res.bitmap.close();
    return canvas.toDataURL("image/webp", 0.8);
  } catch {
    return null;
  }
}

// Öppnar en eller flera filer. Flera filer (eller bilder) slås ihop till ett nytt dokument.
export async function openFiles(items, fit = settings.get("imageFit", "a4")) {
  items = items.filter(({ file }) => isPdf(file) || isImage(file));
  if (!items.length) return toast("Inga PDF-filer eller bilder valdes.", { type: "error" });
  if (!(await confirmDiscard())) return;
  try {
    if (items.length === 1 && isPdf(items[0].file)) return await openPdf(items[0].file, items[0].handle);
    const first = items[0];
    let start = 1;
    if (isPdf(first.file)) {
      if (!(await openPdf(first.file, null))) return;
    } else {
      app.freshDoc = true;
      app.file = { name: "Bilder.pdf", handle: null, size: 0 };
      app.setDoc(await app.client.call("newDocument"));
      start = 0;
    }
    await appendFiles(items.slice(start), -1, fit);
    app.file = { name: (isPdf(first.file) ? first.file.name.replace(/\.pdf$/i, "") : "Bilder") + " (sammanslagen).pdf", handle: null, size: 0 };
    app.emit("file");
  } catch (e) {
    showError(e);
  }
}

// Lägger till PDF-filer och bilder i det öppna dokumentet. at = -1 betyder sist.
export async function appendFiles(items, at = -1, fit = "image") {
  let pos = at;
  for (const { file } of items) {
    const before = app.doc.pageCount;
    if (isPdf(file)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let password;
      for (;;) {
        try {
          const state = await busy(`Lägger till ${file.name} …`, () => app.client.call("insertPdf", bytes, pos, password));
          app.setDoc(state);
          break;
        } catch (e) {
          if (e.code === "password" || e.code === "badpassword") {
            password = await askPassword(file.name, e.code === "badpassword");
            if (password == null) break;
          } else throw e;
        }
      }
    } else if (isImage(file)) {
      const bytes = await imageBytesForPdf(file);
      app.setDoc(await busy(`Lägger till ${file.name} …`, () => app.client.callTransfer("insertImages", [[bytes], pos, fit], [bytes.buffer])));
    }
    if (pos >= 0) pos += app.doc.pageCount - before;
  }
}

// JPEG och PNG skickas som de är. Andra format, och JPEG med EXIF-rotation, konverteras till PNG.
export async function imageBytesForPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  if (isPng || (isJpeg && jpegOrientation(bytes) <= 1)) return bytes;
  const bmp = await createImageBitmap(new Blob([bytes], { type: file.type || "image/*" }), { imageOrientation: "from-image" });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: isJpeg ? "image/jpeg" : "image/png", quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
}

function jpegOrientation(b) {
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) return 1;
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78) {
      const t = i + 10;
      const le = b[t] === 0x49;
      const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o) => (le ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return 1;
    }
    if (marker === 0xda) return 1;
    i += 2 + len;
  }
  return 1;
}

// ---------- Spara ----------

async function writeHandle(handle, bytes) {
  if ((await handle.queryPermission?.({ mode: "readwrite" })) !== "granted") {
    if ((await handle.requestPermission?.({ mode: "readwrite" })) !== "granted") throw new Error("Appen fick inte skriva till filen.");
  }
  const w = await handle.createWritable();
  await w.write(bytes);
  await w.close();
}

export function download(bytes, name, type = "application/pdf") {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Sparar data som en ny fil som användaren väljer. Returnerar filhandtaget, om det finns.
export async function saveBytesAs(bytes, suggestedName, type = PDF_TYPE) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: [type], id: "save" });
      await writeHandle(handle, bytes);
      return handle;
    } catch (e) {
      if (e.name === "AbortError") return undefined;
      throw e;
    }
  }
  download(bytes, suggestedName, Object.keys(type.accept)[0]);
  return null;
}

// Sparar flera filer i en mapp som användaren väljer.
export async function saveManyToFolder(files) {
  if (window.showDirectoryPicker) {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: "readwrite", id: "export" });
    } catch (e) {
      if (e.name === "AbortError") return false;
      throw e;
    }
    for (const f of files) {
      const fh = await dir.getFileHandle(f.name, { create: true });
      await writeHandle(fh, f.bytes);
    }
    toast(`${files.length} filer sparades i mappen ”${dir.name}”.`, { type: "success" });
    return true;
  }
  for (const f of files) download(f.bytes, f.name, f.type);
  return true;
}

async function checkRedactions() {
  const n = await app.client.call("countRedactions");
  if (!n) return true;
  const r = await dialog({
    title: "Maskering är inte verkställd",
    body: h("p", {}, `Det finns ${n} markerade områden för maskering som inte är verkställda. Innehållet under dem finns kvar tills du verkställer maskeringen.`),
    actions: [
      { label: "Avbryt", value: null },
      { label: "Spara ändå", value: "keep" },
      { label: "Verkställ och spara", value: "apply", primary: true },
    ],
  });
  if (r === "apply") {
    const { state } = await app.client.call("applyRedactions");
    app.setDoc(state);
  }
  return r != null;
}

async function documentBytes() {
  return app.client.call("save", { encryption: app.saveEncryption });
}

export async function save({ as = false } = {}) {
  if (!app.doc.open) return;
  try {
    if (!(await checkRedactions())) return;
    const bytes = await busy("Sparar …", documentBytes);
    let handle = as ? null : app.file.handle;
    if (handle && handle.createWritable) {
      await busy("Sparar …", () => writeHandle(handle, bytes));
    } else {
      const name = app.file.name || "dokument.pdf";
      handle = await saveBytesAs(bytes, as ? name.replace(/(\.pdf)?$/i, " (kopia).pdf") : name);
      if (handle === undefined) return;
      if (handle) {
        app.file.name = handle.name;
        app.file.handle = handle;
        (app.saveEncryption.mode === "set" || app.doc.encrypted ? Promise.resolve(null) : firstPageThumb()).then((thumb) => addRecent(handle, handle.name, bytes.length, thumb));
      }
    }
    app.file.size = bytes.length;
    app.setDoc(await app.client.call("markSaved"));
    app.emit("file");
    toast(`Sparat (${formatBytes(bytes.length)}).`, { type: "success" });
  } catch (e) {
    showError(e);
  }
}

export function baseName() {
  return (app.file.name || "dokument.pdf").replace(/\.pdf$/i, "");
}
