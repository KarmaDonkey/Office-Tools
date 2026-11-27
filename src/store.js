// Appens gemensamma tillstånd och händelser.

const listeners = new Map();

export const app = {
  client: null,
  doc: { open: false, rev: 0 }, // senaste state() från motorn
  file: { name: "", handle: null, size: 0 },
  tool: "select",
  toolOptions: {
    highlightColor: "#ffd400",
    inkColor: "#d40000",
    inkWidth: 2,
    textColor: "#000000",
    textSize: 12,
  },
  stamp: null, // { bytes, width, height, label } för signatur/bild som ska placeras
  zoom: 1,
  fit: "width", // "width" | "page" | null
  currentPage: 0,
  selection: new Set(),
  saveEncryption: { mode: "keep" }, // tillämpas när filen sparas
  search: { query: "", results: [], flat: [], current: -1 },

  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },

  emit(event, data) {
    listeners.get(event)?.forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    });
  },

  // Uppdaterar dokumentets tillstånd efter en operation i motorn.
  setDoc(state) {
    const prev = this.doc;
    this.doc = state;
    if (!state.open) this.selection.clear();
    else for (const i of [...this.selection]) if (i >= state.pageCount) this.selection.delete(i);
    if (this.currentPage >= (state.pageCount ?? 0)) this.currentPage = Math.max(0, (state.pageCount ?? 1) - 1);
    this.emit("doc", { prev, state });
  },

  setTool(tool) {
    this.tool = tool;
    this.emit("tool", tool);
  },
};

export const settings = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("pdfv:" + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("pdfv:" + key, JSON.stringify(value));
    } catch {
      /* lagring kan vara avstängd */
    }
  },
};
