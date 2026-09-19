import type { Detection } from '@shared/types';

export type DetectorInit = {
  type: 'init';
  modelUrl: string;
  wasmPath: string;
  srcW: number;
  srcH: number;
  /** long-side network input; 320 is the default, 256 is the low lever (§5.8) */
  target: number;
  conf: number;
  /** 0 = auto (min(4, hardwareConcurrency)). Overridable for §5.8 tuning. */
  threads?: number;
};

export type WorkerIn =
  | DetectorInit
  | { type: 'frame'; seq: number; bitmap: ImageBitmap }
  | { type: 'conf'; value: number }
  | { type: 'close' };

export type WorkerOut =
  | {
      type: 'ready';
      inW: number;
      inH: number;
      /** the source rect inside the padded input; what the caller should resize to */
      fitW: number;
      fitH: number;
      threads: number;
      isolated: boolean;
      simd: boolean;
      /** true when the model pinned its own input size and we had to obey it */
      fixedInput: boolean;
      initMs: number;
    }
  | { type: 'result'; seq: number; dets: Detection[]; prepMs: number; inferMs: number }
  | { type: 'error'; message: string }
  /** Init progress. A hang in a packaged build is otherwise silent. */
  | { type: 'log'; message: string };
