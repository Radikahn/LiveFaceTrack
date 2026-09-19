import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * Both windows are built from one Vite root so they share the module graph
 * (and so `/ort/` + `/models/` resolve identically from either page).
 *
 * Cross-origin isolation (§5.4) is required for ORT's threaded WASM build:
 * without it `SharedArrayBuffer` is undefined and ORT silently falls back to
 * a single thread. Dev gets it from these server headers; production gets it
 * from the `app://` protocol handler in src/main/protocol.ts.
 */
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export default defineConfig({
  root: path.resolve(__dirname, 'src'),
  // Every asset -- the model, ORT's wasm, the font -- is imported from source
  // so Vite emits and fingerprints it. Nothing is resolved from an absolute
  // URL at runtime, so the same code works under the dev server and app://.
  publicDir: false,
  base: './',
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'src/shared') },
  },
  // ORT loads its WASM glue with a dynamic import, which an IIFE worker cannot do.
  worker: { format: 'es' },
  // test/fixtures lives outside `root`; the dev-only self-test imports from it.
  server: { headers: COI_HEADERS, fs: { allow: [path.resolve(__dirname)] } },
  preview: { headers: COI_HEADERS },
  build: {
    target: 'chrome130',
    // `root` is overridden above, and Vite resolves a relative outDir against
    // it -- which would bury the bundle in src/. Forge expects it here.
    outDir: path.resolve(__dirname, '.vite/renderer/app'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        home: path.resolve(__dirname, 'src/renderer/home/index.html'),
        stage: path.resolve(__dirname, 'src/renderer/stage/index.html'),
        // Ships deliberately: `--selftest` is the only way to prove the
        // *packaged* artifact is cross-origin isolated and that ORT can read
        // its asar-unpacked wasm. Roughly 110 KB, and it never loads unless
        // the flag is passed.
        selftest: path.resolve(__dirname, 'src/renderer/selftest/index.html'),
      },
    },
  },
});
