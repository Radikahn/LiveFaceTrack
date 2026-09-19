import type { StageConfig } from '@shared/types';

/**
 * Desktop capture on macOS does not reject when the Screen Recording grant is
 * missing -- it hangs. Main pre-flights the permission, but a stage window must
 * never be able to sit on "Starting..." forever, so this is the backstop.
 */
const OPEN_TIMEOUT_MS = 10_000;

export async function openStream(cfg: StageConfig): Promise<MediaStream> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            cfg.mode === 'screen'
              ? 'Screen capture did not start within 10s. This usually means Screen Recording permission is missing.'
              : 'The camera did not start within 10s.'
          )
        ),
      OPEN_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([openStreamInner(cfg), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function openStreamInner(cfg: StageConfig): Promise<MediaStream> {
  if (cfg.mode === 'camera') {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  }

  if (!cfg.sourceId) throw new Error('no screen selected');
  // The legacy `mandatory` constraint form, still the only way to name a
  // desktopCapturer source. A 4K screen at 30fps is ~250 MB/s of pixel
  // traffic, so the cap is not optional.
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: cfg.sourceId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    },
  } as unknown as MediaStreamConstraints;
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function describeStreamError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'Permission denied. Grant camera access in system settings, then try again.';
    case 'NotFoundError':
      return 'No camera found.';
    case 'NotReadableError':
      return 'The camera is in use by another app.';
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
