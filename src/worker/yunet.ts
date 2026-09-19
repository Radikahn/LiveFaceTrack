/**
 * YuNet (face_detection_yunet_2023mar) I/O, implemented from scratch.
 *
 * The model is normally driven through OpenCV's `FaceDetectorYN`, which hides
 * the decode. We call raw ONNX, so we implement it -- and every constant here
 * matters. Getting the colour order or the anchor convention wrong yields a
 * model that runs fine and detects nothing, or plausible boxes that are subtly
 * off. See scripts/verify-decode.py, which diffs this against OpenCV.
 *
 * This file has no dependencies -- not on ORT, not on the DOM. That is
 * deliberate: it is the one piece that survives a port to another runtime
 * (§1's escape hatch, §10's Android note).
 */

export const STRIDES = [8, 16, 32] as const;
/** Every input dimension must divide by the largest stride. */
export const STRIDE_MULTIPLE = 32;

export type Raw = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** 10 numbers: [rex, rey, lex, ley, nx, ny, rmx, rmy, lmx, lmy] */
  pts: number[];
};

export type Letterbox = {
  /** network input size; both multiples of STRIDE_MULTIPLE */
  inW: number;
  inH: number;
  /** source -> network scale factor */
  scale: number;
  padX: number;
  padY: number;
  /** the source rect, scaled; inW/inH minus this is padding */
  fitW: number;
  fitH: number;
};

/** Fit a source frame into a given network input box, preserving aspect ratio. */
export function letterboxInto(srcW: number, srcH: number, inW: number, inH: number): Letterbox {
  const scale = Math.min(inW / srcW, inH / srcH);
  const fitW = Math.round(srcW * scale);
  const fitH = Math.round(srcH * scale);
  return {
    inW,
    inH,
    scale,
    padX: Math.floor((inW - fitW) / 2),
    padY: Math.floor((inH - fitH) / 2),
    fitW,
    fitH,
  };
}

/**
 * Choose a network input that preserves aspect ratio (§5.3 -- stretching skews
 * the eye-gap measurement, so the PNG scale breathes as faces cross the frame)
 * while staying on the stride grid. A 1280x720 source at target 320 gives
 * 320x192 with 6px bars, rather than the 320x320 square a naive letterbox
 * would use: 40% fewer pixels through the network for an identical result.
 */
export function fitLetterbox(srcW: number, srcH: number, target = 320): Letterbox {
  const m = STRIDE_MULTIPLE;
  const s = target / Math.max(srcW, srcH);
  const inW = Math.max(m, Math.ceil((srcW * s) / m) * m);
  const inH = Math.max(m, Math.ceil((srcH * s) / m) * m);
  return letterboxInto(srcW, srcH, inW, inH);
}

/**
 * RGBA bytes -> NCHW **BGR** float32 in [0, 255], no normalisation.
 * Not RGB. Not 0-1. (§5.1)
 */
export function preprocess(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  out: Float32Array
): Float32Array {
  const px = w * h;
  for (let i = 0, p = 0; i < px; i++, p += 4) {
    out[i] = rgba[p + 2]; // B
    out[px + i] = rgba[p + 1]; // G
    out[2 * px + i] = rgba[p]; // R
  }
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Decode the 12 output tensors into boxes in *network input* coordinates.
 * Scores are already in [0,1] -- do not apply a sigmoid.
 */
export function decode(
  out: Record<string, Float32Array>,
  inW: number,
  inH: number,
  conf = 0.6,
  iou = 0.3
): Raw[] {
  const dets: Raw[] = [];

  for (const s of STRIDES) {
    const cls = out[`cls_${s}`];
    const obj = out[`obj_${s}`];
    const bbox = out[`bbox_${s}`];
    const kps = out[`kps_${s}`];
    if (!cls || !obj || !bbox || !kps) continue;

    const cols = Math.floor(inW / s);
    const rows = Math.floor(inH / s);
    const n = Math.min(rows * cols, cls.length, obj.length, bbox.length >> 2, kps.length / 10);

    for (let i = 0; i < n; i++) {
      // OpenCV's convention: the geometric mean of the two clamped scores.
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
      if (score < conf) continue;

      const c = i % cols;
      const r = (i / cols) | 0;
      const b = i * 4;

      // The anchor sits at the grid CORNER, not the cell centre.
      const cx = (c + bbox[b]) * s;
      const cy = (r + bbox[b + 1]) * s;
      const w = Math.exp(bbox[b + 2]) * s;
      const h = Math.exp(bbox[b + 3]) * s;

      const k = i * 10;
      const pts: number[] = new Array(10);
      for (let j = 0; j < 5; j++) {
        pts[j * 2] = (c + kps[k + j * 2]) * s;
        pts[j * 2 + 1] = (r + kps[k + j * 2 + 1]) * s;
      }

      dets.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, pts });
    }
  }

  return nms(dets, iou);
}

/** Greedy NMS by IoU, highest score first. */
export function nms(dets: Raw[], iouThresh = 0.3, limit = 64): Raw[] {
  if (dets.length < 2) return dets;
  const order = dets.slice().sort((a, b) => b.score - a.score);
  const keep: Raw[] = [];

  outer: for (const d of order) {
    for (const k of keep) {
      if (iouOf(d, k) > iouThresh) continue outer;
    }
    keep.push(d);
    if (keep.length >= limit) break;
  }
  return keep;
}

function iouOf(a: Raw, b: Raw): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = x2 - x1;
  const ih = y2 - y1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Network-input coordinates -> source-frame pixels. */
export function unletterbox(dets: Raw[], lb: Letterbox): Raw[] {
  const { padX, padY, scale } = lb;
  return dets.map((d) => {
    const pts = new Array<number>(10);
    for (let i = 0; i < 10; i += 2) {
      pts[i] = (d.pts[i] - padX) / scale;
      pts[i + 1] = (d.pts[i + 1] - padY) / scale;
    }
    return {
      x: (d.x - padX) / scale,
      y: (d.y - padY) / scale,
      w: d.w / scale,
      h: d.h / scale,
      score: d.score,
      pts,
    };
  });
}
