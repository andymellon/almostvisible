/**
 * Chapter II puzzle — bring the third voice to rest.
 *
 * Pure logic: no three.js scene, no audio.
 *
 * THE TARGET (one defined frequency ratio):
 *   A = root × 4            (the fundamental, two octaves up)
 *   B = A × 3/2             (a just fifth; the stable pair, never moves)
 *   C → A × 2·ratios[2]     (the mode's third one octave up: a just tenth over A —
 *                            5/2 in lydian / mixolydian / harmonic, 12/5 in dorian / aeolian)
 * The target is taken from the visit's modal collection on purpose: the bridge measures every
 * wave source against that collection, so only a pitch that belongs to it makes the
 * interference pattern stand perfectly still. In the major modes it is also exactly the
 * summation tone of the stable pair (A + B = 5/2·A): the third voice comes to rest in the
 * space the other two already imply.
 *
 * The draggable body's path parameter t ∈ [0, 1] maps linearly to cents (so continuously and
 * strictly monotonically to pitch). The reachable range is asymmetric, so the solution never
 * sits at the middle of the path.
 *
 * RANGE. The brief asks for about ±120 cents. The path is deliberately shorter where the mode
 * requires it (≈ 48–99 cents per side): it never leaves the region in which the target is the
 * *nearest* pitch of the collection. The bridge derives the visual crawl from each source's
 * distance to its nearest collection pitch, so past the midpoint to a neighbouring degree the
 * pattern would slow down while the voice moves the wrong way. Inside this range image, sound
 * and feedback all agree: the further from rest, the faster everything beats, and there is
 * exactly one place where it stops.
 */
import type { Harmony, Vec3Like } from '../core/contracts';

/** |error| at or below this counts as aligned. Forgiving: about a sixteenth of a semitone. */
export const ALIGN_CENTS = 6;
/** Alignment must be held this long before the puzzle is solved. */
export const HOLD_SECONDS = 1.2;
/** Within this distance the solution pulls gently. */
export const MAGNET_CENTS = 12;
/** Half-width (cents) of the stability curve: stability is 0.5 at this error. */
export const STABILITY_WIDTH = 22;
/** The path stops this far short of the midpoint to the neighbouring scale degree. */
export const CELL_MARGIN_CENTS = 3;

const centsOf = (ratio: number) => 1200 * Math.log2(ratio);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface TuningSpec {
  /** A, Hz. */
  readonly anchorHz: number;
  /** B, Hz (A × 3/2). */
  readonly fifthHz: number;
  /** C ÷ A when at rest. */
  readonly targetRatio: number;
  /** C when at rest, Hz. */
  readonly targetHz: number;
  /** Pitch offset at t = 0 (negative cents). */
  readonly lowCents: number;
  /** Pitch offset at t = 1 (positive cents). */
  readonly highCents: number;
  /** Path parameter of the solution. Never 0.5. */
  readonly targetT: number;
  /** Where the body starts. */
  readonly startT: number;
  /** Signed starting error, 35–70 cents in magnitude. */
  readonly startCents: number;
}

export type TuningHarmony = Pick<Harmony, 'root' | 'ratios' | 'rand'>;

/** Build the seeded puzzle for a visit. Always draws exactly five values from harmony.rand(). */
export function createTuning(harmony: TuningHarmony): TuningSpec {
  const r = harmony.ratios;
  const third = r.length > 2 ? r[2] : 5 / 4;
  const below = r.length > 2 ? r[1] : 1;
  const above = r.length > 3 ? r[3] : 3 / 2;

  const anchorHz = harmony.root * 4;
  const fifthHz = anchorHz * 1.5;
  const targetRatio = 2 * third;
  const targetHz = anchorHz * targetRatio;

  const pick = harmony.rand();
  const smallDraw = harmony.rand();
  const largeDraw = harmony.rand();
  const signDraw = harmony.rand();
  const amountDraw = harmony.rand();

  // Room on either side before a neighbouring degree of the collection becomes the nearer one.
  const roomLow = centsOf(third / below) / 2 - CELL_MARGIN_CENTS;
  const roomHigh = centsOf(above / third) / 2 - CELL_MARGIN_CENTS;
  // The shorter side is the one the mode leaves less room for; if they are alike, it is seeded.
  const smallOnLow = roomLow < 0.85 * roomHigh ? true : roomHigh < 0.85 * roomLow ? false : pick < 0.5;
  const roomLarge = smallOnLow ? roomHigh : roomLow;
  const roomSmall = smallOnLow ? roomLow : roomHigh;
  const large = Math.max(45, Math.min(105 + 15 * largeDraw, roomLarge * (0.88 + 0.12 * largeDraw)));
  // At most 85 % of the long side, so the solution is always clearly off-centre.
  const small = Math.max(40, Math.min(72 + 18 * smallDraw, roomSmall * (0.9 + 0.1 * smallDraw), 0.85 * large));
  const low = smallOnLow ? small : large;
  const high = smallOnLow ? large : small;

  const sign = signDraw < 0.5 ? -1 : 1;
  const side = sign < 0 ? low : high;
  const amount = Math.min(35 + 35 * amountDraw, side - 4);
  const startCents = sign * amount;

  return {
    anchorHz,
    fifthHz,
    targetRatio,
    targetHz,
    lowCents: -low,
    highCents: high,
    targetT: low / (low + high),
    startT: (startCents + low) / (low + high),
    startCents,
  };
}

/** Pitch error in cents at path parameter t (t is clamped to 0..1). */
export function centsAt(spec: TuningSpec, t: number): number {
  return spec.lowCents + (spec.highCents - spec.lowCents) * clamp01(t);
}

/** Path parameter that produces a given error in cents (clamped to the path). */
export function tAtCents(spec: TuningSpec, cents: number): number {
  return clamp01((cents - spec.lowCents) / (spec.highCents - spec.lowCents));
}

/** t → Hz. Continuous and strictly increasing. */
export function hzAt(spec: TuningSpec, t: number): number {
  return spec.targetHz * Math.pow(2, centsAt(spec, t) / 1200);
}

/** Signed error of a frequency against the target, in cents. */
export function errorCents(spec: TuningSpec, hz: number): number {
  return hz > 0 ? centsOf(hz / spec.targetHz) : 0;
}

/** C ÷ A at path parameter t. */
export function ratioAt(spec: TuningSpec, t: number): number {
  return hzAt(spec, t) / spec.anchorHz;
}

export function isAligned(cents: number): boolean {
  return Math.abs(cents) <= ALIGN_CENTS;
}

/**
 * Feedback curve 0..1: exactly 1 in tune, ≈ 0.93 at the edge of the tolerance, 0.5 at
 * STABILITY_WIDTH, and a long low tail so there is always a gradient to follow.
 */
export function stabilityOf(cents: number): number {
  const x = cents / STABILITY_WIDTH;
  return 1 / (1 + x * x);
}

/**
 * Audible beat rate in Hz: the difference between the voice and the pitch at which it would
 * rest (first-order beating against the sympathetic tone the chapter sounds there; the beat
 * between C's second partial and A's fifth is exactly twice this in the major modes).
 */
export function beatHz(spec: TuningSpec, cents: number): number {
  return spec.targetHz * Math.abs(Math.pow(2, cents / 1200) - 1);
}

/**
 * The magnet. Outside MAGNET_CENTS it does nothing. Inside, while dragging, it compresses the
 * error smoothly toward zero (the mapping stays continuous and strictly monotone, so the hand
 * never feels a jump); once released it pulls all the way to the exact solution.
 */
export function magnetT(spec: TuningSpec, t: number, dragging: boolean): number {
  const c = centsAt(spec, t);
  const a = Math.abs(c);
  if (a >= MAGNET_CENTS) return clamp01(t);
  if (!dragging) return spec.targetT;
  const w = 1 - a / MAGNET_CENTS;
  return tAtCents(spec, c * (1 - 0.6 * w));
}

/** Puzzle state: where the voice is, how stable the chord is, and whether it has come to rest. */
export class TuningPuzzle {
  t: number;
  cents: number;
  hz: number;
  stability: number;
  /** Seconds of uninterrupted alignment so far. */
  held = 0;
  solved = false;
  /** Seconds spent before solving (frozen once solved). */
  seconds = 0;
  /** C ÷ A at the moment of solving (the target ratio until then). */
  ratio: number;

  constructor(readonly spec: TuningSpec) {
    this.t = spec.startT;
    this.cents = centsAt(spec, this.t);
    this.hz = hzAt(spec, this.t);
    this.stability = stabilityOf(this.cents);
    this.ratio = spec.targetRatio;
  }

  /** Advance with the body at path parameter `t`. Returns true on the step the puzzle is solved. */
  step(dt: number, t: number): boolean {
    this.t = clamp01(t);
    this.cents = centsAt(this.spec, this.t);
    this.hz = hzAt(this.spec, this.t);
    this.stability = stabilityOf(this.cents);
    if (this.solved) return false;
    this.seconds += dt;
    if (isAligned(this.cents)) {
      this.held += dt;
      if (this.held >= HOLD_SECONDS) {
        this.solved = true;
        this.ratio = this.hz / this.spec.anchorHz;
        return true;
      }
    } else {
      this.held = 0;
    }
    return false;
  }
}

const RAW = 385;
const SAMPLES = 129;

/**
 * The constrained path of the tunable body: a smooth S in three dimensions, resampled by arc
 * length so that equal distances along it are equal steps of t (and therefore of cents).
 * Rebuilt in place when the frame changes; nothing is allocated after construction.
 */
export class TuningPath {
  readonly count = SAMPLES;
  readonly xs = new Float64Array(SAMPLES);
  readonly ys = new Float64Array(SAMPLES);
  readonly zs = new Float64Array(SAMPLES);
  length = 0;
  private readonly raw = new Float64Array(RAW * 3);
  private readonly cum = new Float64Array(RAW);

  /**
   * @param halfW usable half-width of the composition, world units
   * @param halfH usable half-height
   * @param tall  0 = landscape (the S runs across the upper frame) … 1 = portrait (it climbs)
   */
  constructor(halfW = 3, halfH = 2, tall = 0) {
    this.rebuild(halfW, halfH, tall);
  }

  rebuild(halfW: number, halfH: number, tall: number): void {
    const k = clamp01(tall);
    const x0 = -0.66 * halfW;
    const x1 = 0.7 * halfW;
    const y0 = (0.3 + (0.08 - 0.3) * k) * halfH;
    const y1 = (0.42 + (0.7 - 0.42) * k) * halfH;
    const bendY = (1 - k) * 0.11 * halfH;
    const bendX = k * 0.1 * halfW;
    const raw = this.raw;
    const cum = this.cum;
    for (let i = 0; i < RAW; i++) {
      const s = i / (RAW - 1);
      const wave = Math.sin(s * Math.PI * 2);
      raw[i * 3] = x0 + (x1 - x0) * s + bendX * wave;
      raw[i * 3 + 1] = y0 + (y1 - y0) * s + bendY * wave;
      raw[i * 3 + 2] = 0.26 * Math.cos(s * Math.PI) - 0.05;
      cum[i] = i === 0 ? 0 : cum[i - 1] + Math.hypot(raw[i * 3] - raw[i * 3 - 3], raw[i * 3 + 1] - raw[i * 3 - 2], raw[i * 3 + 2] - raw[i * 3 - 1]);
    }
    const total = cum[RAW - 1];
    this.length = total;
    let j = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const d = (total * i) / (SAMPLES - 1);
      while (j < RAW - 2 && cum[j + 1] < d) j++;
      const span = cum[j + 1] - cum[j];
      const f = span > 1e-12 ? clamp01((d - cum[j]) / span) : 0;
      this.xs[i] = raw[j * 3] + (raw[j * 3 + 3] - raw[j * 3]) * f;
      this.ys[i] = raw[j * 3 + 1] + (raw[j * 3 + 4] - raw[j * 3 + 1]) * f;
      this.zs[i] = raw[j * 3 + 2] + (raw[j * 3 + 5] - raw[j * 3 + 2]) * f;
    }
  }

  /** Position at t ∈ [0, 1] (clamped). Writes into `out`. */
  point<T extends Vec3Like>(t: number, out: T): T {
    const p = clamp01(t) * (SAMPLES - 1);
    const i = Math.min(SAMPLES - 2, Math.floor(p));
    const f = p - i;
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * f;
    out.y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * f;
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * f;
    return out;
  }

  /** Unit tangent at t. Writes into `out`. */
  tangent<T extends Vec3Like>(t: number, out: T): T {
    const p = clamp01(t) * (SAMPLES - 1);
    const i = Math.min(SAMPLES - 2, Math.floor(p));
    const dx = this.xs[i + 1] - this.xs[i];
    const dy = this.ys[i + 1] - this.ys[i];
    const dz = this.zs[i + 1] - this.zs[i];
    const l = Math.hypot(dx, dy, dz) || 1;
    out.x = dx / l;
    out.y = dy / l;
    out.z = dz / l;
    return out;
  }

  /** Path parameter of the point on the path nearest to (x, y, z). */
  nearestT(x: number, y: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    const xs = this.xs;
    const ys = this.ys;
    const zs = this.zs;
    for (let i = 0; i < SAMPLES - 1; i++) {
      const ax = xs[i];
      const ay = ys[i];
      const az = zs[i];
      const dx = xs[i + 1] - ax;
      const dy = ys[i + 1] - ay;
      const dz = zs[i + 1] - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      const f = len2 > 1e-14 ? clamp01(((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2) : 0;
      const ex = ax + dx * f - x;
      const ey = ay + dy * f - y;
      const ez = az + dz * f - z;
      const d = ex * ex + ey * ey + ez * ez;
      if (d < bestD) {
        bestD = d;
        best = (i + f) / (SAMPLES - 1);
      }
    }
    return best;
  }
}
