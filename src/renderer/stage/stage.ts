import type { Asset, PerfSample, StageConfig, Track } from '@shared/types';
import { WorkerDetector, type DetectorReady } from './detector-client';
import { Tracker } from './track';
import { assign, drawAsset, drawDebug, mirrorDetection, trackAlpha, type PreparedAsset } from './compose';
import { describeStreamError, openStream } from './capture-stream';

const api = window.overlay;

/**
 * capture -> detect -> compose. The draw loop runs every frame; detection runs
 * whenever the worker is free, which is the adaptive form of §5.8's lever 2.
 * Between detections the overlay holds its last smoothed position, which at
 * 30fps detect / 60fps draw is invisible.
 */
class Stage {
  private video = document.createElement('video');
  private canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
  private ctx = this.canvas.getContext('2d', { alpha: true })!;
  private hud = document.querySelector<HTMLElement>('#hud')!;
  private message = document.querySelector<HTMLElement>('#message')!;

  private cfg: StageConfig | null = null;
  private stream: MediaStream | null = null;
  private detector: WorkerDetector | null = null;
  private info: DetectorReady | null = null;
  private tracker = new Tracker();
  private tracks: Track[] = [];
  private assets: PreparedAsset[] = [];

  private running = false;
  private debug = new URLSearchParams(location.search).has('debug');
  private srcW = 0;
  private srcH = 0;

  // Rolling instrumentation. §5.8: when something is slow you want to know
  // *which* thing, so these are tracked separately from the start.
  private captureMs = 0;
  private drawMs = 0;
  private frames = 0;
  private fps = 0;
  private lastFpsAt = 0;
  private lastReport = 0;

  async start(): Promise<void> {
    this.cfg = await api.stage.config();
    if (!this.cfg) return this.fail('No stage configuration.');

    document.body.dataset.mode = this.cfg.mode;
    document.body.dataset.overlay = String(this.cfg.mode === 'screen' && this.cfg.overlayDesktop);

    try {
      this.stream = await openStream(this.cfg);
    } catch (err) {
      return this.fail(describeStreamError(err));
    }

    const track = this.stream.getVideoTracks()[0];
    // macOS drops screen capture on fast user switching; the stream just ends.
    track.addEventListener('ended', () => this.fail('The capture stream ended.'));

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    await this.firstFrame();

    this.srcW = this.video.videoWidth;
    this.srcH = this.video.videoHeight;
    if (!this.srcW || !this.srcH) return this.fail('The capture produced no frames.');

    this.detector = new WorkerDetector(this.srcW, this.srcH);
    try {
      this.info = await this.detector.ready;
    } catch (err) {
      return this.fail(`Detector failed to start: ${err instanceof Error ? err.message : err}`);
    }
    if (!this.info.isolated) {
      // Loud, because the symptom is "it works, just slowly" (§5.4).
      api.stage.reportError('not cross-origin isolated: running single-threaded');
    }

    await this.loadAssets();
    api.library.onChanged(() => void this.loadAssets());

    this.running = true;
    this.message.hidden = true;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.schedule();
  }

  private firstFrame(): Promise<void> {
    if (this.video.readyState >= 2) return Promise.resolve();
    return new Promise((r) => this.video.addEventListener('loadeddata', () => r(), { once: true }));
  }

  private async loadAssets(): Promise<void> {
    const all = await api.library.list();
    const enabled = all.filter((a) => a.enabled);
    const prepared: PreparedAsset[] = [];
    for (const asset of enabled) {
      const bytes = await api.library.bytes(asset.id);
      if (!bytes) continue;
      try {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        prepared.push({ asset: asset as Asset, bitmap });
      } catch {
        /* a file that will not decode is simply not drawn */
      }
    }
    for (const old of this.assets) old.bitmap.close();
    this.assets = prepared;
  }

  /** The canvas is sized in source pixels and scaled by CSS, so all overlay
   *  maths stays in one coordinate system. */
  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const overlayMode = this.cfg?.mode === 'screen' && this.cfg.overlayDesktop;
    if (overlayMode) {
      // Cover the window exactly; source pixels map to CSS px by scale below.
      this.canvas.width = Math.round(window.innerWidth * dpr);
      this.canvas.height = Math.round(window.innerHeight * dpr);
    } else {
      this.canvas.width = this.srcW;
      this.canvas.height = this.srcH;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    const anyVideo = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (anyVideo.requestVideoFrameCallback) {
      anyVideo.requestVideoFrameCallback(() => void this.tick());
    } else {
      requestAnimationFrame(() => void this.tick());
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.detector || !this.info) return;
    const now = performance.now();

    // --- detect (only when the worker is free; otherwise this frame is dropped)
    if (!this.detector.busy) {
      const t0 = performance.now();
      try {
        // GPU-accelerated downscale; far cheaper than a canvas drawImage.
        const bitmap = await createImageBitmap(this.video, {
          resizeWidth: this.info.fitW,
          resizeHeight: this.info.fitH,
          resizeQuality: 'low',
        });
        this.captureMs = performance.now() - t0;
        void this.detector
          .detect(bitmap)
          .then((dets) => {
            this.tracks = this.tracker.update(dets, performance.now() / 1000);
          })
          .catch(() => {
            /* busy or closed; the next frame will try again */
          });
      } catch {
        /* the video was not ready for this frame */
      }
    }

    // --- draw (every frame, from the most recent tracks)
    const t1 = performance.now();
    this.draw();
    this.drawMs = performance.now() - t1;

    this.frames++;
    if (now - this.lastFpsAt >= 500) {
      this.fps = (this.frames * 1000) / (now - this.lastFpsAt);
      this.frames = 0;
      this.lastFpsAt = now;
      this.updateHud();
    }
    if (now - this.lastReport >= 1000) {
      this.lastReport = now;
      api.stage.reportPerf(this.sample());
    }

    this.schedule();
  }

  private draw(): void {
    const ctx = this.ctx;
    const overlayMode = this.cfg?.mode === 'screen' && this.cfg?.overlayDesktop;
    const mirror = this.cfg?.mode === 'camera';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (overlayMode) {
      // Draw nothing but the overlays; the desktop shows through.
      const scale = Math.min(this.canvas.width / this.srcW, this.canvas.height / this.srcH);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    } else {
      // Mirror the preview -- users expect it -- but only the preview. The
      // overlay coordinates are mirrored separately, below.
      if (mirror) {
        ctx.setTransform(-1, 0, 0, 1, this.canvas.width, 0);
      }
      ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    const tracks = mirror ? this.tracks.map((t) => mirrorDetection(t, this.srcW)) : this.tracks;

    if (this.debug) {
      drawDebug(ctx, tracks, 1);
      return;
    }
    for (const [track, prepared] of assign(tracks, this.assets)) {
      drawAsset(ctx, prepared, track, trackAlpha(track));
    }
  }

  private sample(): PerfSample {
    return {
      captureMs: this.captureMs,
      inferMs: this.detector?.lastInferMs ?? 0,
      drawMs: this.drawMs,
      fps: this.fps,
      faces: this.tracks.length,
      threads: this.info?.threads ?? 0,
      isolated: this.info?.isolated ?? false,
    };
  }

  private updateHud(): void {
    if (!this.debug) {
      this.hud.hidden = true;
      return;
    }
    const s = this.sample();
    this.hud.hidden = false;
    this.hud.textContent =
      `${s.fps.toFixed(0)} fps · cap ${s.captureMs.toFixed(1)} · infer ${s.inferMs.toFixed(1)} · ` +
      `draw ${s.drawMs.toFixed(1)} · ${s.faces} face${s.faces === 1 ? '' : 's'} · ` +
      `${s.threads} thread${s.threads === 1 ? '' : 's'}${s.isolated ? '' : ' · NOT ISOLATED'}`;
  }

  private fail(message: string): void {
    this.running = false;
    this.message.hidden = false;
    this.message.textContent = message;
    api.stage.reportError(message);
    // A click-through overlay cannot show an error usefully -- and cannot be
    // dismissed by clicking it. Hand the user back to Home, which displays it.
    if (this.cfg?.mode === 'screen' && this.cfg.overlayDesktop) {
      void api.stage.stop();
    }
  }

  stop(): void {
    this.running = false;
    this.detector?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    for (const a of this.assets) a.bitmap.close();
    this.assets = [];
  }
}

const stage = new Stage();
void stage.start();
window.addEventListener('beforeunload', () => stage.stop());
