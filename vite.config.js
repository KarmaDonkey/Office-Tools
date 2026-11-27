import { defineConfig } from "vite";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const version = `${pkg.version} (${new Date().toISOString().slice(0, 10)})`;

// Skapar en service worker som förhandsladdar alla filer i bygget så att appen fungerar offline.
function serviceWorker() {
  let outDir;
  return {
    name: "offline-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const files = [];
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk(outDir);
      const hash = createHash("sha256");
      const urls = [];
      for (const f of files.sort()) {
        const rel = relative(outDir, f).split("\\").join("/");
        if (rel === "sw.js" || rel.endsWith(".map")) continue;
        hash.update(rel).update(readFileSync(f));
        urls.push(rel === "index.html" ? "./" : "./" + rel);
      }
      const cacheName = "pdf-verktyg-" + hash.digest("hex").slice(0, 12);
      const template = readFileSync(new URL("./src/sw.js", import.meta.url), "utf8");
      writeFileSync(join(outDir, "sw.js"), template.replace("__CACHE_NAME__", cacheName).replace("__PRECACHE__", JSON.stringify(urls, null, 2)));
    },
  };
}

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    target: "esnext",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { external: ["node:fs"] },
  },
  worker: {
    format: "es",
    rollupOptions: { external: ["node:fs"] },
  },
  optimizeDeps: { exclude: ["mupdf"] },
  plugins: [serviceWorker()],
});
