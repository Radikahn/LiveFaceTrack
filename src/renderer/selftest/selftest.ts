/**
 * Dev-only integration test, run with `npm run selftest`.
 *
 * It exercises the parts that cannot be unit-tested from Node: cross-origin
 * isolation, ORT's threaded WASM actually loading in a worker, and the decode
 * running end to end on a real image. scripts/verify-decode.mjs proves the
 * maths; this proves the plumbing. It also prints the perf baseline that
 * milestone 4 is a go/no-go on.
 *
 * Not in the production entry list, so it is only ever served by the dev
 * server and never ships.
 */
import { WorkerDetector } from '../stage/detector-client';
import { Tracker } from '../stage/track';
import { placementFor, mirrorDetection } from '../stage/compose';
import sceneUrl from '../../../test/fixtures/scene.png?url';
import expected from '../../../test/fixtures/scene-expected.json';

type Box = { x: number; y: number; w: number; h: number };

const threads = Number(new URLSearchParams(location.search).get('threads')) || 0;

const out = document.querySelector('#out')!;
const lines: string[] = [];
let failures = 0;
let checks = 0;

function log(line: string): void {
  lines.push(line);
  out.textContent = lines.join('\n');
  console.log(line);
}

function check(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
};

async function run(): Promise<void> {
  log(`scene ${expected.width}x${expected.height}, ${expected.faces.length} reference faces\n`);

  // --- §5.4: without this, ORT silently runs single-threaded.
  check('crossOriginIsolated', self.crossOriginIsolated === true);
  check('SharedArrayBuffer available', typeof SharedArrayBuffer !== 'undefined');

  const bitmap = await createImageBitmap(await (await fetch(sceneUrl)).blob());
  check(
    'fixture decoded',
    bitmap.width === expected.width && bitmap.height === expected.height,
    `${bitmap.width}x${bitmap.height}`
  );

  // ---------------------------------------------------------------------
  // Pass A: native resolution. The reference boxes were computed by OpenCV at
  // 512x288, so running the same size must reproduce them exactly. This is the
  // geometry check -- letterbox, decode, unletterbox, all the way through.
  // ---------------------------------------------------------------------
  const native = new WorkerDetector(bitmap.width, bitmap.height, { target: bitmap.width, threads });
  const nativeInfo = await native.ready;
  log('');
  log(
    `session    ${nativeInfo.inW}x${nativeInfo.inH} input (fit ${nativeInfo.fitW}x${nativeInfo.fitH})` +
      `${nativeInfo.fixedInput ? '  [model pinned its own size]' : ''}`
  );
  log(
    `runtime    ${nativeInfo.threads} thread(s), simd=${nativeInfo.simd}, isolated=${nativeInfo.isolated}`
  );
  log(`init       ${nativeInfo.initMs.toFixed(0)} ms\n`);
  check('worker reports isolation', nativeInfo.isolated);
  check('threads > 1', nativeInfo.threads > 1, `got ${nativeInfo.threads}`);
  check('simd', nativeInfo.simd);
  check(
    'network input runs at native resolution',
    nativeInfo.inW === 512 && nativeInfo.inH === 288,
    `${nativeInfo.inW}x${nativeInfo.inH}`
  );

  const nativeDets = await native.detect(await createImageBitmap(bitmap));
  check(
    'finds every reference face at native resolution',
    nativeDets.length === expected.faces.length,
    `${nativeDets.length} vs ${expected.faces.length}`
  );

  const iou = (a: Box, b: Box): number => {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return i / (a.w * a.h + b.w * b.h - i);
  };

  let worstIoU = 1;
  let worstOffset = 0;
  for (const ref of expected.faces) {
    const best = nativeDets.reduce(
      (acc, d) => (iou(ref, d) > acc.v ? { v: iou(ref, d), d } : acc),
      { v: 0, d: nativeDets[0] }
    );
    worstIoU = Math.min(worstIoU, best.v);
    if (best.d) worstOffset = Math.max(worstOffset, Math.hypot(best.d.x - ref.x, best.d.y - ref.y));
  }
  check(
    'boxes reproduce OpenCV through the full pipeline',
    worstIoU > 0.99,
    `worst IoU ${worstIoU.toFixed(5)}, worst offset ${worstOffset.toFixed(3)} px`
  );
  native.close();

  // ---------------------------------------------------------------------
  // Pass B: the shipping configuration, 320 long side. This is the perf
  // baseline milestone 4 is a go/no-go on. Small faces legitimately drop out
  // here -- that is §5.8's lever 3 in action, not a defect -- so the assertion
  // is on speed, and face count is reported rather than required.
  // ---------------------------------------------------------------------
  const detector = new WorkerDetector(bitmap.width, bitmap.height, { target: 320, threads });
  const info = await detector.ready;
  log('');
  log(`shipping   ${info.inW}x${info.inH} input (fit ${info.fitW}x${info.fitH})`);

  const RUNS = 30;
  const timings: number[] = [];
  let dets: Awaited<ReturnType<typeof detector.detect>> = [];
  for (let i = 0; i < RUNS; i++) {
    const frame = await createImageBitmap(bitmap, {
      resizeWidth: info.fitW,
      resizeHeight: info.fitH,
      resizeQuality: 'low',
    });
    const t0 = performance.now();
    dets = await detector.detect(frame);
    timings.push(performance.now() - t0);
  }

  log(
    `detect     median ${median(timings).toFixed(1)} ms, ` +
      `min ${Math.min(...timings).toFixed(1)}, max ${Math.max(...timings).toFixed(1)} ` +
      `(${RUNS} runs)`
  );
  log(
    `           infer ${detector.lastInferMs.toFixed(1)} ms, prep ${detector.lastPrepMs.toFixed(1)} ms`
  );
  log(`           headroom at 30fps: ${(33.3 - median(timings)).toFixed(1)} ms`);
  log(
    `           ${dets.length}/${expected.faces.length} faces survive the downscale ` +
      `(smallest reference face is ${Math.min(...expected.faces.map((f) => f.w)).toFixed(0)}px wide ` +
      `-> ${(Math.min(...expected.faces.map((f) => f.w)) * (info.fitW / bitmap.width)).toFixed(0)}px at 320)`
  );
  log('');

  check('real-time at 30fps', median(timings) < 33.3, `${median(timings).toFixed(1)} ms/frame`);
  check(
    'finds the faces that survive the downscale',
    dets.length >= 3,
    `${dets.length} of ${expected.faces.length}`
  );

  // --- the pieces above the detector
  const tracker = new Tracker();
  const t1 = tracker.update(dets, 0);
  const t2 = tracker.update(dets, 1 / 30);
  check(
    'tracker assigns stable ids',
    t1.length === t2.length && t1.every((t, i) => t.id === t2[i].id),
    `${t1.map((t) => t.id).join(',')}`
  );

  const place = placementFor(dets[0]);
  check(
    'roll is level on an upright face',
    Math.abs(place.roll) < 0.35,
    `${((place.roll * 180) / Math.PI).toFixed(1)} deg`
  );
  check(
    'eye gap is plausible',
    place.eyeGap > 5 && place.eyeGap < dets[0].w,
    `${place.eyeGap.toFixed(1)} px vs box width ${dets[0].w.toFixed(1)}`
  );

  // §4's trap: flipping x without swapping the paired keypoints leaves every
  // face reading as upside down.
  const mirrored = mirrorDetection(dets[0], bitmap.width);
  const mPlace = placementFor(mirrored);
  check(
    'mirroring negates roll rather than flipping it',
    Math.abs(mPlace.roll + place.roll) < 1e-6,
    `${((mPlace.roll * 180) / Math.PI).toFixed(1)} vs ${((-place.roll * 180) / Math.PI).toFixed(1)} deg`
  );
  check('mirroring preserves eye gap', Math.abs(mPlace.eyeGap - place.eyeGap) < 1e-6);
  check('mirroring reflects x', Math.abs(bitmap.width - mPlace.x - place.x) < 1e-6);

  // ---------------------------------------------------------------------
  // The ways out of a running overlay. A desktop overlay is click-through and
  // always-on-top, so if none of these are wired the only exit is force-quit.
  // ---------------------------------------------------------------------
  const api = window.overlay;
  check('stage.setInteractive is exposed', typeof api?.stage.setInteractive === 'function');
  check('stage.stop is exposed', typeof api?.stage.stop === 'function');

  const panic = await api?.stage.panicKey();
  check(
    'a panic hotkey registered',
    typeof panic === 'string' && panic.length > 0,
    panic ?? 'none'
  );

  // Must be harmless from a non-stage window rather than throwing.
  await api?.stage.setInteractive(true);
  await api?.stage.setInteractive(false);
  check('setInteractive is inert off the stage', true);

  detector.close();

  log('');
  // The detail already reached stdout line by line through the main process's
  // console forwarding; this is just the verdict the exit code is built on.
  const verdict =
    failures === 0
      ? `SELFTEST PASS (${checks} checks)`
      : `SELFTEST FAIL (${failures} of ${checks} checks)`;
  log(verdict);
  window.overlay?.stage.reportError(verdict);
}

run().catch((err) => {
  log(`FATAL ${err instanceof Error ? err.stack : String(err)}`);
  window.overlay?.stage.reportError('SELFTEST FAIL (threw)');
});
