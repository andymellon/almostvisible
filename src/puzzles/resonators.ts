/**
 * Chapter I puzzle — three hidden resonators.
 *
 * Pure logic: no three.js scene, no audio. The chapter owns the objects; this module
 * decides where the resonators sit, which tone each one holds, and when the puzzle is solved.
 *
 * Seats are generated in a normalised safe frame (u, v ∈ [-1, 1]) and mapped to the world
 * with the *live* camera frame every frame, so the triangle stays inside the frustum in
 * landscape and portrait alike and follows a device rotation without a jump in topology.
 * Separation is guaranteed in the narrowest frame the piece supports; every wider or taller
 * frame only moves the seats further apart.
 */
import type { Harmony, Vec3Like } from '../core/contracts';

export const RESONATOR_COUNT = 3;

/** A resonator position in the normalised safe frame. `depth` is -1 (far) … 1 (near). */
export interface ResonatorSeat {
  u: number;
  v: number;
  depth: number;
}

/** The pitch a resonator holds: a scale degree of the visit's mode, an octave shift, and Hz. */
export interface ResonatorTone {
  degree: number;
  octave: number;
  hz: number;
}

/** Half extents (world units) of the area the seats may occupy at the focus plane. */
export interface SafeFrame {
  halfW: number;
  halfH: number;
}

export interface SeatOptions {
  /** Safe-frame width ÷ height in the narrowest layout that must still work. */
  worstAspect: number;
  /** Minimum pairwise distance, in units of the safe half-height, measured in the worst frame. */
  minSeparation: number;
  /** Seats keep at least this far (same units) from the frame centre, where the first point sits. */
  clearCentre: number;
  /** Each side of the triangle differs from the next by at least this fraction (scalene). */
  asymmetry: number;
}

export const DEFAULT_SEAT_OPTIONS: SeatOptions = {
  worstAspect: 0.69,
  minSeparation: 0.8,
  clearCentre: 0.5,
  asymmetry: 0.08,
};

/** Distance between two seats in a frame of the given width ÷ height, in units of its half-height. */
export function seatSeparation(a: ResonatorSeat, b: ResonatorSeat, aspect: number): number {
  return Math.hypot((a.u - b.u) * aspect, a.v - b.v);
}

/** Smallest pairwise separation of a layout in a frame of the given aspect. */
export function minSeatSeparation(seats: readonly ResonatorSeat[], aspect: number): number {
  let min = Infinity;
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) min = Math.min(min, seatSeparation(seats[i], seats[j], aspect));
  }
  return min;
}

/** True when three seats form a well-separated, clearly scalene, non-degenerate triangle. */
export function isValidTriangle(seats: readonly ResonatorSeat[], o: SeatOptions = DEFAULT_SEAT_OPTIONS): boolean {
  if (seats.length !== RESONATOR_COUNT) return false;
  const a = o.worstAspect;
  for (const s of seats) {
    if (Math.abs(s.u) > 1 || Math.abs(s.v) > 1) return false;
    if (Math.hypot(s.u * a, s.v) < o.clearCentre) return false;
  }
  const sides = [seatSeparation(seats[0], seats[1], a), seatSeparation(seats[1], seats[2], a), seatSeparation(seats[2], seats[0], a)].sort((p, q) => p - q);
  if (sides[0] < o.minSeparation) return false;
  if (sides[1] < sides[0] * (1 + o.asymmetry) || sides[2] < sides[1] * (1 + o.asymmetry)) return false;
  // Height over the longest side: rejects three points that are nearly in a line.
  const area = 0.5 * Math.abs((seats[1].u - seats[0].u) * a * (seats[2].v - seats[0].v) - (seats[2].u - seats[0].u) * a * (seats[1].v - seats[0].v));
  return (2 * area) / sides[2] >= o.minSeparation * 0.45;
}

/** A hand-placed scalene triangle, valid for the default options; used only if sampling fails. */
export const FALLBACK_SEATS: readonly ResonatorSeat[] = [
  { u: -0.74, v: -0.66, depth: 0.5 },
  { u: 0.86, v: 0.1, depth: -0.4 },
  { u: -0.22, v: 0.9, depth: -1 },
];

/**
 * Seeded seats for the three resonators: an asymmetric, well-separated triangle.
 * Rejection sampling; deterministic for a given `rand` stream.
 */
export function generateSeats(rand: () => number, options: Partial<SeatOptions> = {}): ResonatorSeat[] {
  const o: SeatOptions = { ...DEFAULT_SEAT_OPTIONS, ...options };
  const seats: ResonatorSeat[] = [];
  for (let attempt = 0; attempt < 400; attempt++) {
    seats.length = 0;
    for (let i = 0; i < RESONATOR_COUNT; i++) seats.push({ u: rand() * 2 - 1, v: rand() * 2 - 1, depth: 0 });
    if (isValidTriangle(seats, o)) {
      for (const s of seats) s.depth = rand() * 2 - 1;
      return seats;
    }
  }
  const mirror = rand() < 0.5 ? -1 : 1;
  return FALLBACK_SEATS.map((s) => ({ u: s.u * mirror, v: s.v, depth: s.depth }));
}

/** Fractions of the visible frame the seats may use, and caps that hold the composition on very wide screens. */
export const FRAME_MARGIN_X = 0.8;
export const FRAME_MARGIN_Y = 0.72;
export const FRAME_MAX_HALF_W = 2.9;
export const FRAME_MAX_HALF_H = 2.3;

/**
 * The safe frame at the focus plane of a perspective camera.
 * `fovDeg` is the vertical field of view actually in use (the rig may widen it in portrait).
 * Pass `out` to reuse an object (no allocation).
 */
export function safeFrame(fovDeg: number, aspect: number, distance: number, out: SafeFrame = { halfW: 0, halfH: 0 }): SafeFrame {
  const halfH = Math.tan((fovDeg * Math.PI) / 360) * distance;
  const halfW = halfH * aspect;
  out.halfW = Math.min(halfW * FRAME_MARGIN_X, FRAME_MAX_HALF_W);
  out.halfH = Math.min(halfH * FRAME_MARGIN_Y, FRAME_MAX_HALF_H);
  return out;
}

/** Map a seat into the world. Writes into `out` (no allocation). */
export function seatToWorld<T extends Vec3Like>(seat: ResonatorSeat, frame: SafeFrame, centre: Vec3Like, depthRange: number, out: T): T {
  out.x = centre.x + seat.u * frame.halfW;
  out.y = centre.y + seat.v * frame.halfH;
  out.z = centre.z + seat.depth * depthRange;
  return out;
}

/**
 * The three tones, drawn from the visit's mode: the root two octaves above the fundamental,
 * the just fifth above it, and the mode's third one octave higher still (a tenth over the root).
 * Which seat holds which tone is seeded.
 */
export function assignTones(harmony: Pick<Harmony, 'freq' | 'rand'>): ResonatorTone[] {
  const tones: ResonatorTone[] = [
    { degree: 0, octave: 2, hz: harmony.freq(0, 2) },
    { degree: 4, octave: 2, hz: harmony.freq(4, 2) },
    { degree: 2, octave: 3, hz: harmony.freq(2, 3) },
  ];
  for (let i = tones.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(harmony.rand() * (i + 1)));
    const t = tones[i];
    tones[i] = tones[j];
    tones[j] = t;
  }
  return tones;
}

/** 1 at (or inside) `near`, falling smoothly to 0 at `far`. Monotone in distance. */
export function proximity(distance: number, near = 0.2, far = 1.6): number {
  const t = Math.min(1, Math.max(0, (distance - near) / (far - near)));
  return 1 - t * t * (3 - 2 * t);
}

/** Distance from point `p` to the ray that starts at `origin` and passes through `through`. */
export function distanceToRay(p: Vec3Like, origin: Vec3Like, through: Vec3Like): number {
  const dx = through.x - origin.x;
  const dy = through.y - origin.y;
  const dz = through.z - origin.z;
  const px = p.x - origin.x;
  const py = p.y - origin.y;
  const pz = p.z - origin.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-12) return Math.hypot(px, py, pz);
  const s = Math.max(0, (px * dx + py * dy + pz * dz) / len2);
  return Math.hypot(px - dx * s, py - dy * s, pz - dz * s);
}

/** Puzzle state: which resonators are awake, and in which order their degrees were found. */
export class ResonatorPuzzle {
  readonly awake: boolean[];
  /** Scale degrees in the order they were woken (what chapter V remembers). */
  readonly order: number[] = [];
  private count = 0;

  constructor(
    readonly seats: readonly ResonatorSeat[],
    readonly tones: readonly ResonatorTone[],
  ) {
    if (seats.length !== tones.length) throw new Error('ResonatorPuzzle: seats and tones differ in length');
    this.awake = seats.map(() => false);
  }

  get size(): number {
    return this.seats.length;
  }
  get woken(): number {
    return this.count;
  }
  get progress(): number {
    return this.count / this.seats.length;
  }
  get solved(): boolean {
    return this.count === this.seats.length;
  }

  /** Wake resonator `index`. Returns false (and changes nothing) if it is invalid or already awake. */
  wake(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.awake.length || this.awake[index]) return false;
    this.awake[index] = true;
    this.count++;
    this.order.push(this.tones[index].degree);
    return true;
  }

  /** First resonator still asleep, or -1. */
  nextAsleep(): number {
    return this.awake.indexOf(false);
  }

  /** The sleeping resonator whose world position is nearest to (x, y), or -1 if all are awake. */
  nearestAsleep(x: number, y: number, positions: readonly Vec3Like[]): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.awake.length; i++) {
      if (this.awake[i]) continue;
      const d = Math.hypot(positions[i].x - x, positions[i].y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
}
