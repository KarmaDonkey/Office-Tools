// Kommunikation med PDF-workern samt en prioriterad kö för rendering.

export class PdfClient {
  constructor() {
    this.worker = new Worker(new URL("./worker/pdf.worker.js", import.meta.url), { type: "module" });
    this.nextId = 1;
    this.calls = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.worker.addEventListener("error", (e) => reject(new Error(e.message || "Workern kunde inte starta.")), { once: true });
      this._resolveReady = resolve;
    });
    this.worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.ready) return this._resolveReady();
      const call = this.calls.get(msg.id);
      if (!call) return;
      this.calls.delete(msg.id);
      if (msg.ok) call.resolve(msg.result);
      else {
        const err = new Error(msg.error.message);
        err.code = msg.error.code;
        call.reject(err);
      }
    };
    // Renderingskö
    this.queue = [];
    this.active = 0;
    this.maxActive = 1;
  }

  call(method, ...args) {
    return this._send(method, args, []);
  }

  // Som call, men flyttar ägarskapet för binärdata till workern.
  callTransfer(method, args, transfer) {
    return this._send(method, args, transfer);
  }

  async _send(method, args, transfer) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args }, transfer);
    });
  }

  // Lägg en rendering i kön. Lägre prioritet körs först. Samma nyckel ersätter tidigare förfrågan.
  render(key, priority, page, scale, widgets) {
    // En äldre förfrågan med samma nyckel som inte har startat ersätts.
    const k = this.queue.findIndex((j) => j.key === key);
    if (k >= 0) this.queue.splice(k, 1)[0].resolve(null);
    const job = { key, priority, args: [page, scale, widgets] };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.queue.push(job);
    this._pump();
    return job.promise;
  }

  cancelRenders(predicate) {
    this.queue = this.queue.filter((j) => {
      if (predicate(j.key)) {
        j.resolve(null);
        return false;
      }
      return true;
    });
  }

  _pump() {
    while (this.active < this.maxActive && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const job = this.queue.shift();
      this.active++;
      this.call("renderBitmap", ...job.args)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this._pump();
        });
    }
  }
}
