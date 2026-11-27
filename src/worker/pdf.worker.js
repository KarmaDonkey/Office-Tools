// Web Worker som håller dokumentet och kör MuPDF utanför huvudtråden.
import * as mupdf from "mupdf";
import { createEngine } from "../core/engine.js";

const engine = createEngine(mupdf);

function transferablesOf(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (value instanceof ImageBitmap) out.push(value);
  else if (ArrayBuffer.isView(value)) out.push(value.buffer);
  else if (Array.isArray(value)) value.forEach((v) => transferablesOf(v, out));
  else if (value.constructor === Object) Object.values(value).forEach((v) => transferablesOf(v, out));
  return out;
}

const extra = {
  async renderBitmap(i, scale, widgets) {
    const { width, height, pixels } = engine.render(i, scale, widgets);
    const bitmap = await createImageBitmap(new ImageData(pixels, width, height));
    return { width, height, bitmap };
  },
};

self.onmessage = async (ev) => {
  const { id, method, args } = ev.data;
  try {
    const fn = extra[method] ?? engine[method];
    if (typeof fn !== "function") throw new Error(`Okänd metod: ${method}`);
    const result = await fn(...args);
    const transfer = [...new Set(transferablesOf(result))];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: { message: e?.message ?? String(e), code: e?.code } });
  }
};

self.postMessage({ ready: true });
