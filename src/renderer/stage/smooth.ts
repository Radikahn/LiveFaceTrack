/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012).
 *
 * §5.6, and it is not optional: raw YuNet output jitters 2-4px per frame on a
 * stationary face, and an unsmoothed overlay visibly vibrates. One Euro beats
 * an EMA here because it adapts -- heavy smoothing when still, light smoothing
 * when moving -- so you don't trade jitter for lag.
 */

const alphaFor = (cutoff: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

class LowPass {
  private y: number | null = null;

  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }

  get value(): number | null {
    return this.y;
  }

  reset(x: number): void {
    this.y = x;
  }
}

export type OneEuroParams = {
  /** Hz. Lower = smoother when still. */
  minCutoff: number;
  /** How aggressively cutoff rises with speed. Higher = less lag when moving. */
  beta: number;
  /** Cutoff for the derivative estimate. */
  dCutoff: number;
};

/** Tuned for 30fps face tracking. */
export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 };

class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private tPrev: number | null = null;

  constructor(private p: OneEuroParams) {}

  filter(value: number, t: number): number {
    if (this.tPrev === null) {
      this.tPrev = t;
      this.x.reset(value);
      this.dx.reset(0);
      return value;
    }
    // Clamp dt: a stalled tab or a dropped frame must not spike the derivative.
    const dt = Math.min(Math.max(t - this.tPrev, 1 / 240), 1 / 5);
    this.tPrev = t;

    const prev = this.x.value ?? value;
    const rate = (value - prev) / dt;
    const smoothedRate = this.dx.filter(rate, alphaFor(this.p.dCutoff, dt));
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(smoothedRate);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }

  reset(value: number): void {
    this.x.reset(value);
    this.dx.reset(0);
    this.tPrev = null;
  }
}

/** One independent filter per channel -- keypoints must not drag each other. */
export class OneEuroVec {
  private filters: OneEuro[];

  constructor(size: number, params: OneEuroParams = DEFAULT_ONE_EURO) {
    this.filters = Array.from({ length: size }, () => new OneEuro(params));
  }

  filter(values: number[], t: number, out: number[] = new Array(values.length)): number[] {
    for (let i = 0; i < values.length; i++) out[i] = this.filters[i].filter(values[i], t);
    return out;
  }

  reset(values: number[]): void {
    values.forEach((v, i) => this.filters[i].reset(v));
  }
}
