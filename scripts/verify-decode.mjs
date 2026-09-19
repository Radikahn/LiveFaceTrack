#!/usr/bin/env node
// Runs the real src/worker/yunet.ts decode over the tensors dumped by
// scripts/verify-decode.py and diffs it against OpenCV's FaceDetectorYN.
// Any drift here is a decode bug, not an overlay bug.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASE = path.join(ROOT, 'test/fixtures/decode-case.json');
if (!fs.existsSync(CASE)) {
  console.error('missing test/fixtures/decode-case.json -- run scripts/verify-decode.py first');
  process.exit(2);
}

// Compile the TS through esbuild (already present via vite) so we test the
// shipped source, not a transcription of it. The JS API rather than the .bin
// shim: execFileSync cannot run an extensionless shim on Windows.
const tmp = path.join(os.tmpdir(), `yunet-verify-${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/worker/yunet.ts')],
  format: 'esm',
  platform: 'neutral',
  outfile: tmp,
  logLevel: 'warning',
});
// pathToFileURL, not a `file://` template: a Windows path needs escaping.
const { decode, fitLetterbox, unletterbox } = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });

const c = JSON.parse(fs.readFileSync(CASE, 'utf8'));
const tensors = Object.fromEntries(
  Object.entries(c.tensors).map(([k, v]) => [k, Float32Array.from(v)])
);

const mine = decode(tensors, c.inW, c.inH, c.conf, c.nms);
const ref = c.reference;

console.log(`reference ${ref.length} faces | decode() ${mine.length} faces\n`);

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x),
    y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w),
    y2 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return i / (a.w * a.h + b.w * b.h - i);
};

let fail = 0;
const used = new Set();
for (const r of ref) {
  let best = -1,
    bestIoU = 0;
  mine.forEach((m, i) => {
    if (used.has(i)) return;
    const v = iou(r, m);
    if (v > bestIoU) {
      bestIoU = v;
      best = i;
    }
  });
  if (best < 0 || bestIoU < 0.98) {
    console.log(`  MISS box=(${r.x.toFixed(1)},${r.y.toFixed(1)}) best IoU=${bestIoU.toFixed(4)}`);
    fail++;
    continue;
  }
  used.add(best);
  const m = mine[best];
  const kpErr = Math.max(...r.pts.map((p, i) => Math.abs(p - m.pts[i])));
  const scoreErr = Math.abs(r.score - m.score);
  const ok = kpErr < 0.02 && scoreErr < 1e-3;
  if (!ok) fail++;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'} box=(${r.x.toFixed(1)},${r.y.toFixed(1)},${r.w.toFixed(1)},${r.h.toFixed(1)}) ` +
      `IoU=${bestIoU.toFixed(5)} maxKpErr=${kpErr.toFixed(4)}px scoreErr=${scoreErr.toExponential(1)}`
  );
}
const extra = mine.length - used.size;
if (extra > 0) {
  console.log(`  ${extra} unmatched detection(s) from decode()`);
  fail += extra;
}

// unletterbox must be the exact inverse of fitLetterbox.
const lb = fitLetterbox(1280, 720, 320);
console.log(
  `\nletterbox 1280x720 -> ${lb.inW}x${lb.inH} (fit ${lb.fitW}x${lb.fitH}, pad ${lb.padX},${lb.padY})`
);
const probe = [
  { x: lb.padX, y: lb.padY, w: lb.fitW, h: lb.fitH, score: 1, pts: new Array(10).fill(lb.padX) },
];
const back = unletterbox(probe, lb)[0];
const roundTripOk =
  Math.abs(back.x) < 0.51 &&
  Math.abs(back.y) < 0.51 &&
  Math.abs(back.w - 1280) < 2 &&
  Math.abs(back.h - 720) < 2;
console.log(
  `  full-frame box round-trips to (${back.x.toFixed(2)},${back.y.toFixed(2)},${back.w.toFixed(1)},${back.h.toFixed(1)}) ${roundTripOk ? 'OK' : 'FAIL'}`
);
if (!roundTripOk) fail++;

console.log(fail === 0 ? '\nPASS' : `\nFAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
