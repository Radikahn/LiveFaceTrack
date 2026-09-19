import type { Detection, FaceDetector } from '@shared/types';
import type { WorkerIn, WorkerOut } from '../../worker/protocol';
import DetectorWorker from '../../worker/detector.worker?worker';

export type DetectorReady = {
  inW: number;
  inH: number;
  fitW: number;
  fitH: number;
  threads: number;
  isolated: boolean;
  simd: boolean;
  fixedInput: boolean;
  initMs: number;
};

export type DetectorOptions = {
  /** Both default to the build-time asset URLs resolved inside the worker. */
  modelUrl?: string;
  wasmPath?: string;
  /** long-side network input (§5.8 lever 3 turns this down) */
  target?: number;
  conf?: number;
  /** 0/undefined = auto. */
  threads?: number;
};

/**
 * Owns the worker and enforces the one rule from §5.8: if the worker is busy
 * when a frame arrives, discard the frame. Never queue -- a queue turns a slow
 * machine into a laggy one that gets progressively worse.
 */
export class WorkerDetector implements FaceDetector {
  private worker: Worker;
  private seq = 0;
  private inflight: { seq: number; resolve: (d: Detection[]) => void; reject: (e: Error) => void } | null = null;
  private readyResolve!: (r: DetectorReady) => void;
  private readyReject!: (e: Error) => void;

  /** Resolves once the session is live and warmed. */
  readonly ready: Promise<DetectorReady>;
  lastInferMs = 0;
  lastPrepMs = 0;

  constructor(srcW: number, srcH: number, opts: DetectorOptions = {}) {
    this.worker = new DetectorWorker();
    this.ready = new Promise<DetectorReady>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'detector worker failed');
      this.readyReject(err);
      this.inflight?.reject(err);
      this.inflight = null;
    };

    this.send({
      type: 'init',
      modelUrl: opts.modelUrl ?? '',
      wasmPath: opts.wasmPath ?? '',
      srcW,
      srcH,
      target: opts.target ?? 320,
      conf: opts.conf ?? 0.6,
      threads: opts.threads ?? 0,
    });
  }

  private send(msg: WorkerIn, transfer?: Transferable[]): void {
    this.worker.postMessage(msg, transfer ?? []);
  }

  private onMessage(msg: WorkerOut): void {
    switch (msg.type) {
      case 'ready':
        this.readyResolve(msg);
        break;
      case 'result':
        this.lastPrepMs = msg.prepMs;
        this.lastInferMs = msg.inferMs;
        if (this.inflight?.seq === msg.seq) {
          this.inflight.resolve(msg.dets);
          this.inflight = null;
        }
        break;
      case 'log':
        console.log(`[detector] ${msg.message}`);
        break;
      case 'error': {
        const err = new Error(msg.message);
        this.readyReject(err);
        this.inflight?.reject(err);
        this.inflight = null;
        break;
      }
    }
  }

  get busy(): boolean {
    return this.inflight !== null;
  }

  /**
   * Takes ownership of the bitmap: it is transferred to the worker, which
   * closes it. Rejects rather than queueing if a detection is already running.
   */
  detect(frame: ImageBitmap): Promise<Detection[]> {
    if (this.inflight) {
      frame.close();
      return Promise.reject(new Error('detector busy'));
    }
    const seq = ++this.seq;
    return new Promise<Detection[]>((resolve, reject) => {
      this.inflight = { seq, resolve, reject };
      this.send({ type: 'frame', seq, bitmap: frame }, [frame]);
    });
  }

  setConfidence(value: number): void {
    this.send({ type: 'conf', value });
  }

  close(): void {
    this.inflight?.reject(new Error('detector closed'));
    this.inflight = null;
    this.send({ type: 'close' });
    // Give the worker a tick to release the session before we cut it off.
    setTimeout(() => this.worker.terminate(), 100);
  }
}
