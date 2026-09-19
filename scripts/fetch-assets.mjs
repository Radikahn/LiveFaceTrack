#!/usr/bin/env node
// Populates public/ (served to the renderer) and resources/ (icons) from
// node_modules and the OpenCV model zoo. Idempotent; safe to re-run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { renderIcon, renderRing, encodePNG, encodeICO, TRAY_COLORS } from './icon.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => path.join(ROOT, ...s);
const log = (...a) => console.log('  ', ...a);

const MODEL_URL =
  'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx';

fs.mkdirSync(p('resources/models'), { recursive: true });

// ORT's wasm and the model are imported as URLs from src/worker, so Vite emits
// them; nothing needs copying into a public dir. All this has to do is make
// sure the vendored model is present and real.
console.log('YuNet model');
const model = p('resources/models/yunet.onnx');
if (!fs.existsSync(model)) {
  const upstream = p('resources/models/yunet_2023mar_upstream.onnx');
  if (!fs.existsSync(upstream)) {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`model download failed: ${res.status}`);
    fs.writeFileSync(upstream, Buffer.from(await res.arrayBuffer()));
    log('downloaded upstream export');
  }
  throw new Error(
    'resources/models/yunet.onnx is missing.\n' +
      '   The upstream export pins a 640x640 input; run scripts/make-dynamic.py once to\n' +
      '   relax it (needs python + onnx). See that file for why.'
  );
}
const bytes = fs.readFileSync(model);
if (bytes.length < 100_000 || bytes.subarray(0, 64).includes(Buffer.from('git-lfs'))) {
  throw new Error('yunet.onnx looks like an LFS pointer, not a model');
}
log(`yunet.onnx ${(bytes.length / 1024).toFixed(0)} KB`);

console.log('Icons');
const ICNS = [16, 32, 64, 128, 256, 512, 1024];
const ICO = [16, 24, 32, 48, 64, 128, 256];
const cache = new Map();
const png = (s) => {
  if (!cache.has(s)) cache.set(s, encodePNG(renderIcon(s), s));
  return cache.get(s);
};

// Tray glyphs. The idle one is black+alpha so macOS tints it like any other
// menu-bar item; the live ones carry their mode's accent and must not.
for (const [name, rgb] of Object.entries(TRAY_COLORS)) {
  const file = name === 'idle' ? 'trayTemplate' : `tray-${name}`;
  fs.writeFileSync(p('resources', `${file}.png`), encodePNG(renderRing(22, rgb), 22));
  fs.writeFileSync(p('resources', `${file}@2x.png`), encodePNG(renderRing(44, rgb), 44));
  log(`${file}.png`);
}

fs.writeFileSync(p('resources/icon.ico'), encodeICO(ICO.map((size) => ({ size, png: png(size) }))));
log('icon.ico');

const iconset = p('resources/icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);
for (const s of ICNS) {
  if (s <= 512) fs.writeFileSync(path.join(iconset, `icon_${s}x${s}.png`), png(s));
  if (s >= 32) fs.writeFileSync(path.join(iconset, `icon_${s / 2}x${s / 2}@2x.png`), png(s));
}
fs.writeFileSync(p('resources/icon.png'), png(512));
if (process.platform === 'darwin') {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', p('resources/icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  log('icon.icns');
} else {
  log('skipped icon.icns (needs macOS iconutil)');
}
console.log('\nassets ready');
