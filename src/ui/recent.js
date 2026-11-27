// Senaste filer. Endast en referens (filhandtag) sparas i webbläsaren, aldrig filens innehåll.
import { settings } from "../store.js";

const DB = "pdf-verktyg";
const STORE = "recent";
const MAX = 12;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export const recentEnabled = () => settings.get("recentEnabled", true);

export async function listRecent() {
  if (!recentEnabled()) return [];
  try {
    const all = await tx("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.opened - a.opened);
  } catch {
    return [];
  }
}

export async function addRecent(handle, name, size) {
  if (!recentEnabled() || !handle) return;
  try {
    const list = await listRecent();
    for (const r of list) {
      if (await r.handle.isSameEntry?.(handle)) await tx("readwrite", (s) => s.delete(r.id));
    }
    await tx("readwrite", (s) => s.put({ id: crypto.randomUUID(), handle, name, size, opened: Date.now() }));
    const after = await listRecent();
    for (const r of after.slice(MAX)) await tx("readwrite", (s) => s.delete(r.id));
  } catch (e) {
    console.warn("Kunde inte spara senaste fil", e);
  }
}

export async function removeRecent(id) {
  await tx("readwrite", (s) => s.delete(id));
}

export async function clearRecent() {
  try {
    await tx("readwrite", (s) => s.clear());
  } catch {
    /* ignore */
  }
}
