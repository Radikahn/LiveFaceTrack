import type { Detection, Track } from '@shared/types';
import { OneEuroVec, DEFAULT_ONE_EURO, type OneEuroParams } from './smooth';

/**
 * §5.7. Without identity, two people in frame swap PNGs whenever detection
 * order flips. Greedy IoU matching against the previous frame; fifty lines,
 * and it is the difference between a demo and a tool.
 *
 * Each track owns its own filters, so a face that appears mid-session starts
 * smooth instead of easing in from wherever the previous occupant of that slot
 * happened to be.
 */
export const IOU_MATCH = 0.3;
/** Keep a lost track alive this long so a single dropped frame doesn't blink. */
export const MAX_MISSED = 8;
/** ...but stop drawing it after this many, fading out on the way. */
export const DRAW_GRACE = 3;

/** 14 smoothed channels: x, y, w, h, then 5 keypoints. */
const CHANNELS = 14;

type Slot = {
  id: number;
  filters: OneEuroVec;
  smoothed: number[];
  score: number;
  missed: number;
  age: number;
};

function iou(a: { x: number; y: number; w: number; h: number }, b: number[]): number {
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(a.x, bx);
  const y1 = Math.max(a.y, by);
  const x2 = Math.min(a.x + a.w, bx + bw);
  const y2 = Math.min(a.y + a.h, by + bh);
  const iw = x2 - x1;
  const ih = y2 - y1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / (a.w * a.h + bw * bh - inter);
}

const flatten = (d: Detection): number[] => [d.x, d.y, d.w, d.h, ...d.pts];

export class Tracker {
  private slots: Slot[] = [];
  private nextId = 1;

  constructor(private params: OneEuroParams = DEFAULT_ONE_EURO) {}

  /** @param t seconds, monotonic */
  update(dets: Detection[], t: number): Track[] {
    // Greedy: take the highest-IoU pair available, repeat. Cheap and stable at
    // the handful-of-faces scale this app works at.
    const pairs: { s: number; d: number; v: number }[] = [];
    this.slots.forEach((slot, s) => {
      dets.forEach((det, d) => {
        const v = iou(det, slot.smoothed);
        if (v >= IOU_MATCH) pairs.push({ s, d, v });
      });
    });
    pairs.sort((a, b) => b.v - a.v);

    const slotTaken = new Set<number>();
    const detTaken = new Set<number>();
    for (const { s, d } of pairs) {
      if (slotTaken.has(s) || detTaken.has(d)) continue;
      slotTaken.add(s);
      detTaken.add(d);
      const slot = this.slots[s];
      const det = dets[d];
      slot.filters.filter(flatten(det), t, slot.smoothed);
      slot.score = det.score;
      slot.missed = 0;
      slot.age++;
    }

    this.slots.forEach((slot, s) => {
      if (!slotTaken.has(s)) slot.missed++;
    });
    this.slots = this.slots.filter((s) => s.missed <= MAX_MISSED);

    dets.forEach((det, d) => {
      if (detTaken.has(d)) return;
      const values = flatten(det);
      const filters = new OneEuroVec(CHANNELS, this.params);
      filters.reset(values);
      this.slots.push({
        id: this.nextId++,
        filters,
        smoothed: values.slice(),
        score: det.score,
        missed: 0,
        age: 1,
      });
    });

    return this.slots
      .filter((s) => s.missed <= DRAW_GRACE)
      .map((s) => ({
        id: s.id,
        x: s.smoothed[0],
        y: s.smoothed[1],
        w: s.smoothed[2],
        h: s.smoothed[3],
        pts: s.smoothed.slice(4),
        score: s.score,
        age: s.age,
        missed: s.missed,
      }));
  }

  reset(): void {
    this.slots = [];
  }
}
