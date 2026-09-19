import { KP, type Asset, type Detection, type Track } from '@shared/types';
import { DRAW_GRACE } from './track';

/**
 * §5.5. Two eye keypoints give position, scale and roll -- everything a flat
 * sticker needs.
 */

export type PreparedAsset = { asset: Asset; bitmap: ImageBitmap };

/**
 * Mirroring: users expect a mirrored camera preview, but detection must run on
 * the *unmirrored* frame or the left/right eye keypoints silently swap and the
 * overlay rotation comes out backwards (§4). So we mirror coordinates here, at
 * draw time -- and swapping the paired keypoints is the part that is easy to
 * miss: flipping x alone leaves `dx` negative and every face reads as upside
 * down.
 */
export function mirrorDetection<T extends Detection>(det: T, frameWidth: number): T {
  const p = det.pts;
  const fx = (i: number) => frameWidth - p[i * 2];
  const fy = (i: number) => p[i * 2 + 1];
  const swapped = [
    fx(KP.LEFT_EYE),
    fy(KP.LEFT_EYE),
    fx(KP.RIGHT_EYE),
    fy(KP.RIGHT_EYE),
    fx(KP.NOSE),
    fy(KP.NOSE),
    fx(KP.LEFT_MOUTH),
    fy(KP.LEFT_MOUTH),
    fx(KP.RIGHT_MOUTH),
    fy(KP.RIGHT_MOUTH),
  ];
  return { ...det, x: frameWidth - (det.x + det.w), pts: swapped };
}

export type Placement = {
  x: number;
  y: number;
  roll: number;
  scale: number;
  eyeGap: number;
};

/** The face-space -> screen-space transform, independent of any asset. */
export function placementFor(det: Detection): Placement {
  const p = det.pts;
  const rex = p[KP.RIGHT_EYE * 2];
  const rey = p[KP.RIGHT_EYE * 2 + 1];
  const lex = p[KP.LEFT_EYE * 2];
  const ley = p[KP.LEFT_EYE * 2 + 1];

  const dx = lex - rex;
  const dy = ley - rey;

  return {
    x: (rex + lex) / 2,
    y: (rey + ley) / 2,
    roll: Math.atan2(dy, dx),
    // Eye gap is the scale reference: it is the one facial measurement that
    // barely changes with expression.
    eyeGap: Math.hypot(dx, dy),
    scale: 1,
  };
}

export function drawAsset(
  ctx: CanvasRenderingContext2D,
  prepared: PreparedAsset,
  det: Detection,
  alpha = 1
): void {
  const { asset, bitmap } = prepared;
  const place = placementFor(det);
  if (!(place.eyeGap > 0.5)) return;

  const s = (place.eyeGap / Math.max(asset.refEyeGap, 1)) * asset.scale;

  let ax = place.x;
  let ay = place.y;
  if (asset.anchorMode === 'nose') {
    ax = det.pts[KP.NOSE * 2];
    ay = det.pts[KP.NOSE * 2 + 1];
  }

  // Offsets are in eye-gap units, so a hat sits the same distance above the
  // eyes on a face at any distance from the camera.
  const ox = asset.offsetX * place.eyeGap;
  const oy = asset.offsetY * place.eyeGap;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(ax, ay);
  ctx.rotate(place.roll);
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  ctx.drawImage(bitmap, -asset.anchorX, -asset.anchorY);
  ctx.restore();
}

/** A track on its way out fades rather than popping. */
export const trackAlpha = (track: Track): number =>
  track.missed === 0 ? 1 : Math.max(0, 1 - track.missed / (DRAW_GRACE + 1));

/**
 * Assign assets to faces. With one asset every face wears it; with several,
 * faces take them in track order so identities stay put frame to frame.
 */
export function assign(tracks: Track[], assets: PreparedAsset[]): [Track, PreparedAsset][] {
  if (assets.length === 0) return [];
  return tracks.map((t, i) => [t, assets[assets.length === 1 ? 0 : i % assets.length]]);
}

/** Debug view for milestone 4: boxes and keypoints, no assets. */
export function drawDebug(ctx: CanvasRenderingContext2D, tracks: Track[], scale = 1): void {
  ctx.save();
  ctx.lineWidth = Math.max(1, 2 / scale);
  ctx.font = `${Math.round(12 / scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  for (const t of tracks) {
    ctx.strokeStyle = t.missed === 0 ? '#3BE08A' : '#E0B23B';
    ctx.strokeRect(t.x, t.y, t.w, t.h);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(`#${t.id} ${(t.score * 100) | 0}%`, t.x, t.y - 4 / scale);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i < 2 ? '#2B6BFF' : '#E0429B';
      ctx.beginPath();
      ctx.arc(t.pts[i * 2], t.pts[i * 2 + 1], Math.max(1.5, 3 / scale), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
