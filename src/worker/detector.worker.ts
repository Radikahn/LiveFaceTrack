/// <reference lib="webworker" />
/**
 * ORT session lifecycle. Owns exactly one inference at a time -- backpressure
 * is the caller's job (§5.8: drop frames, never queue them).
 */
import * as ort from 'onnxruntime-web/wasm';
// Imported as URLs so Vite emits exactly one copy of each and resolves the
// path itself. This is also what §5.4 is really asking for: an explicit local
// path means ORT can never fall back to fetching its runtime from a CDN.
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import modelUrl from '../../resources/models/yunet.onnx?url';
import type { Detection } from '@shared/types';
import { decode, fitLetterbox, letterboxInto, preprocess, unletterbox, type Letterbox } from './yunet';
import type { WorkerIn, WorkerOut } from './protocol';

/** A one-instruction SIMD module: validates only where 128-bit SIMD exists. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1,
  8, 0, 65, 0, 253, 15, 253, 98, 11,
]);
const hasSimd = (() => {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
})();

const post = (m: WorkerOut, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? []);

let session: ort.InferenceSession | null = null;
let lb: Letterbox | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let input: Float32Array | null = null;
let conf = 0.6;

/** Static axes come back as numbers, symbolic ones as strings. */
function declaredInputSize(s: ort.InferenceSession): { w: number; h: number } | null {
  const meta = s.inputMetadata?.[0];
  if (!meta || !('shape' in meta) || meta.shape.length !== 4) return null;
  const h = meta.shape[2];
  const w = meta.shape[3];
  return typeof h === 'number' && typeof w === 'number' && h > 0 && w > 0 ? { w, h } : null;
}

const trace = (message: string) => post({ type: 'log', message });

async function init(msg: Extract<WorkerIn, { type: 'init' }>) {
  const t0 = performance.now();
  trace(`init wasm=${msg.wasmPath || wasmUrl} model=${msg.modelUrl || modelUrl}`);

  // Both, explicitly. ORT spawns its pthread workers from the .mjs glue, and
  // if it has to guess that URL under a custom protocol it guesses wrong and
  // the session create never settles.
  ort.env.wasm.wasmPaths = { wasm: msg.wasmPath || wasmUrl, mjs: mjsUrl };
  ort.env.wasm.simd = true;
  // Threads need SharedArrayBuffer, which needs cross-origin isolation (§5.4).
  // Without it, asking for threads throws rather than silently degrading.
  const isolated = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  const auto = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4));
  ort.env.wasm.numThreads = isolated ? (msg.threads || auto) : 1;
  ort.env.logLevel = 'error';

  trace(`threads=${ort.env.wasm.numThreads} isolated=${isolated}; creating session`);
  session = await ort.InferenceSession.create(msg.modelUrl || modelUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  trace('session created');
  // Prefer our aspect-preserving fit; obey the model if it pinned its own size.
  const fixed = declaredInputSize(session);
  lb = fixed
    ? letterboxInto(msg.srcW, msg.srcH, fixed.w, fixed.h)
    : fitLetterbox(msg.srcW, msg.srcH, msg.target);

  canvas = new OffscreenCanvas(lb.inW, lb.inH);
  ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  if (!ctx) throw new Error('no 2d context in worker');
  // The pad bars are written once; the fit area is overwritten every frame.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, lb.inW, lb.inH);

  input = new Float32Array(3 * lb.inW * lb.inH);
  conf = msg.conf;

  // Warm the graph so the first live frame isn't the one that pays for it.
  await session.run({ input: new ort.Tensor('float32', input, [1, 3, lb.inH, lb.inW]) });

  trace('warmup done');
  post({
    type: 'ready',
    inW: lb.inW,
    inH: lb.inH,
    fitW: lb.fitW,
    fitH: lb.fitH,
    threads: ort.env.wasm.numThreads ?? 1,
    isolated,
    simd: hasSimd,
    fixedInput: fixed !== null,
    initMs: performance.now() - t0,
  });
}

async function onFrame(seq: number, bitmap: ImageBitmap) {
  if (!session || !lb || !ctx || !input) {
    bitmap.close();
    return;
  }
  const t0 = performance.now();
  // The caller already scaled the bitmap on the GPU; this is a cheap blit into
  // the padded box.
  ctx.drawImage(bitmap, lb.padX, lb.padY, lb.fitW, lb.fitH);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, lb.inW, lb.inH);
  preprocess(data, lb.inW, lb.inH, input);
  const t1 = performance.now();

  const results = await session.run({
    input: new ort.Tensor('float32', input, [1, 3, lb.inH, lb.inW]),
  });
  const t2 = performance.now();

  const tensors: Record<string, Float32Array> = {};
  for (const [name, value] of Object.entries(results)) {
    tensors[name] = value.data as Float32Array;
  }

  const dets: Detection[] = unletterbox(decode(tensors, lb.inW, lb.inH, conf), lb);
  post({ type: 'result', seq, dets, prepMs: t1 - t0, inferMs: t2 - t1 });
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await init(msg);
        break;
      case 'frame':
        await onFrame(msg.seq, msg.bitmap);
        break;
      case 'conf':
        conf = msg.value;
        break;
      case 'close':
        await session?.release();
        session = null;
        self.close();
        break;
    }
  } catch (err) {
    if (msg.type === 'frame') msg.bitmap.close();
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
