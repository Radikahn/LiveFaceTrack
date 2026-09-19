/** The app has exactly two modes, and mode is the one thing we must never get wrong. */
export type Mode = 'camera' | 'screen';

/** Where the PNG's anchor point lands on the face. */
export type AnchorMode = 'eyes' | 'nose';

/**
 * A library entry. The four calibration numbers are what separate this from a
 * toy: they map the PNG's own design space onto a face of any size (§5.5).
 */
export type Asset = {
  id: string;
  name: string;
  /** Filename inside <userData>/library/. Never a user-supplied path. */
  file: string;
  width: number;
  height: number;
  /** px between the eyes in the PNG's own design space */
  refEyeGap: number;
  /** the PNG pixel that lands on the anchor point */
  anchorX: number;
  anchorY: number;
  /** nudge, in eye-gap units */
  offsetX: number;
  offsetY: number;
  /** user multiplier, default 1 */
  scale: number;
  anchorMode: AnchorMode;
  enabled: boolean;
  createdAt: number;
};

export type AssetWithThumb = Asset & { thumb: string };

/** Sensible defaults on import; the calibration sheet refines them. */
export function defaultCalibration(width: number, height: number) {
  return {
    refEyeGap: width * 0.42,
    anchorX: width / 2,
    anchorY: height / 2,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    anchorMode: 'eyes' as AnchorMode,
  };
}

/** Keypoint indices. OpenCV's order, not InsightFace's (§5.1). */
export const KP = {
  RIGHT_EYE: 0,
  LEFT_EYE: 1,
  NOSE: 2,
  RIGHT_MOUTH: 3,
  LEFT_MOUTH: 4,
} as const;

/** One face, in source-frame pixel coordinates. */
export type Detection = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** 10 numbers: [rex, rey, lex, ley, nx, ny, rmx, rmy, lmx, lmy] */
  pts: number[];
};

/** A detection that has been matched to a face across frames (§5.7). */
export type Track = Detection & { id: number; age: number; missed: number };

/**
 * The escape hatch from §1. Everything above this line is runtime-agnostic:
 * swapping the WASM detector for a napi-rs one changes nothing else.
 */
export interface FaceDetector {
  detect(frame: ImageBitmap | VideoFrame): Promise<Detection[]>;
  close(): void;
}

export type ScreenSource = {
  id: string;
  name: string;
  thumbnail: string;
  displayId: string;
};

export type PermissionState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export type Permissions = {
  camera: PermissionState;
  screen: PermissionState;
};

export type StageConfig = {
  mode: Mode;
  /** desktopCapturer source id; only set for screen mode */
  sourceId?: string;
  /** false = show the capture in a normal window instead of overlaying the desktop */
  overlayDesktop: boolean;
};

export type PerfSample = {
  captureMs: number;
  inferMs: number;
  drawMs: number;
  fps: number;
  faces: number;
  threads: number;
  isolated: boolean;
};
