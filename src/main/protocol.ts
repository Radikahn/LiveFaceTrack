import { app, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Cross-origin isolation, the thing §5.4 says to do on day one.
 *
 * ORT's threaded WASM build needs SharedArrayBuffer, which Chromium only
 * exposes to a cross-origin-isolated document. A `file://` renderer is not
 * isolated, so ORT would quietly fall back to one thread -- a working app at a
 * third of the speed, with no error to tell you why. So production serves the
 * renderer over this scheme with COOP/COEP set; dev gets the same headers from
 * Vite's server (see vite.renderer.config.ts).
 *
 * Verify with `crossOriginIsolated === true` in the console.
 */
export const SCHEME = 'app';
export const HOST = 'overlay';

declare const APP_VITE_DEV_SERVER_URL: string | undefined;
declare const APP_VITE_NAME: string;

/**
 * `wasm-unsafe-eval` is what lets WebAssembly.compile run at all -- without it
 * ORT fails on load. `worker-src blob:` is for ORT's pthread workers, which it
 * spawns from a Blob of its own glue code.
 */
const CSP = [
  "default-src 'self' app:",
  "script-src 'self' app: 'wasm-unsafe-eval'",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: data: blob:",
  "font-src 'self' app:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' app: data: blob:",
  "worker-src 'self' app: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const COI_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
};

/** Must run before `app.whenReady()`. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function rendererRoot(): string {
  return path.join(__dirname, `../renderer/${APP_VITE_NAME}`);
}

/**
 * Served by hand rather than delegated to `net.fetch('file://...')`, for two
 * reasons that both present as a hang rather than an error:
 *
 *  - Electron patches `fs` to read through asar archives and to redirect
 *    `app.asar/x` to `app.asar.unpacked/x`. The file:// network stack does not,
 *    so ORT's wasm and the model would 404 inside a packaged build.
 *  - `.wasm` must be served as `application/wasm` or
 *    `WebAssembly.instantiateStreaming` refuses it.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

export function registerProtocolHandler(): void {
  const root = rendererRoot();

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) {
      return new Response('not found', { status: 404 });
    }

    // Confine every request to the renderer bundle. `path.join` collapses
    // `..`, and the prefix check rejects anything that still escapes.
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = path.join(root, rel);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }

    let data: Buffer;
    try {
      data = await fs.readFile(filePath);
    } catch {
      return new Response('not found', { status: 404 });
    }

    const headers = new Headers(COI_HEADERS);
    headers.set(
      'content-type',
      MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    );
    headers.set('content-length', String(data.byteLength));
    return new Response(new Uint8Array(data), { status: 200, headers });
  });
}

export type Page = 'home' | 'stage' | 'selftest';

/** Where a window should load a page from, in either mode. */
export function pageUrl(page: Page): string {
  const rel = `renderer/${page}/index.html`;
  return APP_VITE_DEV_SERVER_URL
    ? `${APP_VITE_DEV_SERVER_URL}/${rel}`
    : `${SCHEME}://${HOST}/${rel}`;
}

export const isDev = (): boolean => !app.isPackaged;
