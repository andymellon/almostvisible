/**
 * Chapter IV — "Give every sound its own space."  Pure puzzle logic (no three, no DOM, no audio).
 *
 * Three sound fields (EARTH, AIR, LIGHT) are placed in a box around the listener, who sits at the
 * origin. A field's pose maps to its mix:
 *
 *   proximity to the listener → level        (1 at the origin, 0 at REACH)
 *   height (y)                → brightness   (bottom of the box = 0, top = 1)
 *   depth (z)                 → diffusion    (front of the box = dry 0, back = diffuse 1)
 *   rotation                  → modulation   (0 at rest, 1 at half a turn, periodic)
 *
 * Two fields MASK each other when they are spatially close AND spectrally close (brightness) AND
 * similar in level — the product of three soft "closeness" terms, so opening up any one of the three
 * dimensions far enough frees the pair, and partial separation in several adds up.
 *
 *   masking  = 0.6 · worst pair + 0.4 · mean of the pairs            (0..1, "normalised masking")
 *   audible  = every level inside the comfortable band (not silenced, not on top of the listener)
 *              × no field towering over another
 *   balance  = (1 − masking) · audible                               (0..1)
 *
 * Solved when balance ≥ TUNING.solved, held for TUNING.holdSeconds. The intended discovery is
 * "Earth low and near, Light high, Air deep behind", but any arrangement that satisfies the
 * separation criteria solves it (see balance.test.ts for several).
 *
 * Functions that take an `out` argument write into it and allocate nothing, so the chapter can call
 * them every frame.
 */
import type { FieldMix, Vec3Like } from '../core/contracts';

export const FIELD_IDS = ['earth', 'air', 'light'] as const;
export type FieldId = (typeof FIELD_IDS)[number];
export const EARTH = 0;
export const AIR = 1;
export const LIGHT = 2;

/** Position (world units, listener at the origin) and rotation (radians) of one field. */
export interface FieldPose {
  x: number;
  y: number;
  z: number;
  rotation: number;
}

/** The volume the sculptures live in. +z is toward the viewer, −z is "behind". */
export const BOUNDS = { xMin: -2.4, xMax: 2.4, yMin: -1.6, yMax: 1.6, zMin: -2.4, zMax: 1.4 } as const;

/** Distance from the listener at which a field's level reaches 0. */
export const REACH = 4.4;

/** Every threshold of the puzzle, in one place. Soft edges are (lo, hi) pairs of a smoothstep. */
export const TUNING = {
  /** Pair distance (world units): fully "in the same place" below near, fully apart above far. */
  spatialNear: 0.9,
  spatialFar: 2.4,
  /** Brightness difference: same register below near, separate registers above far. */
  spectralNear: 0.12,
  spectralFar: 0.42,
  /** Level difference: equally loud below near, clearly layered above far. */
  levelNear: 0.2,
  levelFar: 0.55,
  /** A field fades out of the picture between these levels (too far from the listener). */
  silentLo: 0.14,
  silentHi: 0.3,
  /** A field sits on top of the listener between these levels (drowns everything). */
  loudLo: 0.9,
  loudHi: 1.0,
  /** Loudest minus quietest level: one field starts to dominate between these. */
  dominanceLo: 0.5,
  dominanceHi: 0.75,
  /** Weight of the worst pair in the normalised masking (the rest is the mean of all pairs). */
  worstWeight: 0.6,
  /** Balance needed, and for how long it must be held. */
  solved: 0.8,
  holdSeconds: 2,
  /** While balance stays within this margin below `solved` the hold pauses instead of draining. */
  holdGrace: 0.06,
} as const;

/** Index pairs in the order used by BalanceState.pairs: earth–air, earth–light, air–light. */
export const PAIRS: readonly (readonly [number, number])[] = [
  [EARTH, AIR],
  [EARTH, LIGHT],
  [AIR, LIGHT],
];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mixf = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const createMix = (): FieldMix => ({ level: 0, brightness: 0, diffusion: 0, modulation: 0 });
export const createPose = (x = 0, y = 0, z = 0, rotation = 0): FieldPose => ({ x, y, z, rotation });

export function copyMix(from: FieldMix, out: FieldMix): FieldMix {
  out.level = from.level;
  out.brightness = from.brightness;
  out.diffusion = from.diffusion;
  out.modulation = from.modulation;
  return out;
}

export function copyPose(from: FieldPose, out: FieldPose): FieldPose {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  out.rotation = from.rotation;
  return out;
}

// ───────────────────────────────────────────────────────────── mapping ──

/** Pose → mix. Proximity → level, height → brightness, depth → diffusion, rotation → modulation. */
export function mixFromPose(pose: FieldPose, out: FieldMix = createMix()): FieldMix {
  const d = Math.sqrt(pose.x * pose.x + pose.y * pose.y + pose.z * pose.z);
  out.level = clamp01(1 - d / REACH);
  out.brightness = clamp01((pose.y - BOUNDS.yMin) / (BOUNDS.yMax - BOUNDS.yMin));
  out.diffusion = clamp01((BOUNDS.zMax - pose.z) / (BOUNDS.zMax - BOUNDS.zMin));
  out.modulation = 0.5 - 0.5 * Math.cos(pose.rotation);
  return out;
}

/**
 * Mix → pose (inverse of mixFromPose, used by chapter V to rebuild the layers from memory).
 * Height and depth are exact; the lateral offset is whatever remains of the level's distance,
 * on the side given by `side` (±1). Mixes that no pose can produce are projected into the box.
 */
export function poseFromMix(mix: FieldMix, side: number, out: FieldPose = createPose()): FieldPose {
  const y = mixf(BOUNDS.yMin, BOUNDS.yMax, clamp01(mix.brightness));
  const z = mixf(BOUNDS.zMax, BOUNDS.zMin, clamp01(mix.diffusion));
  const d = (1 - clamp01(mix.level)) * REACH;
  const x2 = d * d - y * y - z * z;
  const x = x2 > 0 ? Math.min(Math.sqrt(x2), BOUNDS.xMax) : 0;
  out.x = side < 0 ? -x : x;
  out.y = y;
  out.z = z;
  out.rotation = Math.acos(1 - 2 * clamp01(mix.modulation));
  return out;
}

/** Clamp a position into the bounding volume (optionally a narrower |x| for portrait frames). */
export function clampToBounds<T extends Vec3Like>(p: T, xLimit: number = BOUNDS.xMax, yLimit: number = BOUNDS.yMax): T {
  const xl = Math.min(xLimit, BOUNDS.xMax);
  const yl = Math.min(yLimit, BOUNDS.yMax);
  p.x = Math.min(xl, Math.max(-xl, p.x));
  p.y = Math.min(yl, Math.max(-yl, p.y));
  p.z = Math.min(BOUNDS.zMax, Math.max(BOUNDS.zMin, p.z));
  return p;
}

// ───────────────────────────────────────────────────────────── masking ──

/** 1 inside the comfortable level band, falling to 0 when silenced or when drowning the listener. */
export function levelBand(level: number): number {
  return sstep(TUNING.silentLo, TUNING.silentHi, level) * (1 - sstep(TUNING.loudLo, TUNING.loudHi, level));
}

/** How much two fields mask each other, 0..1. */
export function pairMasking(a: FieldMix, pa: Vec3Like, b: FieldMix, pb: Vec3Like): number {
  const dx = pa.x - pb.x;
  const dy = pa.y - pb.y;
  const dz = pa.z - pb.z;
  const spatial = 1 - sstep(TUNING.spatialNear, TUNING.spatialFar, Math.sqrt(dx * dx + dy * dy + dz * dz));
  const spectral = 1 - sstep(TUNING.spectralNear, TUNING.spectralFar, Math.abs(a.brightness - b.brightness));
  const level = 1 - sstep(TUNING.levelNear, TUNING.levelFar, Math.abs(a.level - b.level));
  return spatial * spectral * level;
}

/** Normalised masking of the whole arrangement, 0 (every field has its own space) .. 1. */
export function masking(mixes: readonly FieldMix[], positions: readonly Vec3Like[]): number {
  let worst = 0;
  let sum = 0;
  for (let k = 0; k < PAIRS.length; k++) {
    const i = PAIRS[k][0];
    const j = PAIRS[k][1];
    const m = pairMasking(mixes[i], positions[i], mixes[j], positions[j]);
    if (m > worst) worst = m;
    sum += m;
  }
  return TUNING.worstWeight * worst + (1 - TUNING.worstWeight) * (sum / PAIRS.length);
}

/** 1 when every field is comfortably audible and none dominates; 0 when one is lost or drowning. */
export function audibility(mixes: readonly FieldMix[]): number {
  let band = 1;
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < mixes.length; i++) {
    const l = mixes[i].level;
    band = Math.min(band, levelBand(l));
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  return band * (1 - sstep(TUNING.dominanceLo, TUNING.dominanceHi, hi - lo));
}

/** Balance score 0..1 = (1 − normalised masking) × audibility. */
export function balance(mixes: readonly FieldMix[], positions: readonly Vec3Like[]): number {
  return (1 - masking(mixes, positions)) * audibility(mixes);
}

// ──────────────────────────────────────────────────── per-frame evaluation ──

export interface BalanceState {
  /** Mix of each field (earth, air, light). The objects are stable; only their numbers change. */
  readonly mixes: [FieldMix, FieldMix, FieldMix];
  /** Masking of each pair, in PAIRS order. */
  readonly pairs: [number, number, number];
  /** How troubled each field is: its two pair maskings plus a penalty for leaving the level band. */
  readonly perField: [number, number, number];
  masking: number;
  audibility: number;
  balance: number;
  /** Index of the field most in need of its own space. */
  mostMasked: number;
}

export function createBalanceState(): BalanceState {
  return {
    mixes: [createMix(), createMix(), createMix()],
    pairs: [0, 0, 0],
    perField: [0, 0, 0],
    masking: 0,
    audibility: 0,
    balance: 0,
    mostMasked: 0,
  };
}

/** Everything the chapter needs each frame, written into `out` (no allocation). */
export function evaluateBalance(poses: readonly FieldPose[], out: BalanceState = createBalanceState()): BalanceState {
  for (let i = 0; i < 3; i++) mixFromPose(poses[i], out.mixes[i]);
  let worst = 0;
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const i = PAIRS[k][0];
    const j = PAIRS[k][1];
    const m = pairMasking(out.mixes[i], poses[i], out.mixes[j], poses[j]);
    out.pairs[k] = m;
    if (m > worst) worst = m;
    sum += m;
  }
  out.masking = TUNING.worstWeight * worst + (1 - TUNING.worstWeight) * (sum / 3);
  out.audibility = audibility(out.mixes);
  out.balance = (1 - out.masking) * out.audibility;
  out.perField[EARTH] = out.pairs[0] + out.pairs[1] + (1 - levelBand(out.mixes[EARTH].level));
  out.perField[AIR] = out.pairs[0] + out.pairs[2] + (1 - levelBand(out.mixes[AIR].level));
  out.perField[LIGHT] = out.pairs[1] + out.pairs[2] + (1 - levelBand(out.mixes[LIGHT].level));
  let most = 0;
  for (let i = 1; i < 3; i++) if (out.perField[i] > out.perField[most] + 1e-9) most = i;
  out.mostMasked = most;
  return out;
}

// ──────────────────────────────────────────────────────────────── hold ──

/**
 * Advance the "held in balance" clock. It fills while balance ≥ solved, pauses inside a small grace
 * margin (a wobbling hand does not lose its progress) and drains twice as fast below that.
 */
export function stepHold(held: number, balanceNow: number, dt: number): number {
  if (balanceNow >= TUNING.solved) return held + dt;
  if (balanceNow >= TUNING.solved - TUNING.holdGrace) return held;
  return Math.max(0, held - 2 * dt);
}

export const isSolved = (held: number): boolean => held >= TUNING.holdSeconds;

// ─────────────────────────────────────────────────────────── arrangements ──

/**
 * The opening state: all three crowded around the listener, in the same register, equally loud.
 * `rand` is the visit's seeded PRNG, so the crowd differs per visit but always fails.
 */
export function crowdedStart(rand: () => number, out: FieldPose[]): FieldPose[] {
  const base = rand() * Math.PI * 2;
  for (let i = 0; i < 3; i++) {
    const a = base + (i * Math.PI * 2) / 3 + (rand() - 0.5) * 0.5;
    const r = 0.5 + rand() * 0.14;
    const p = out[i];
    p.x = Math.cos(a) * r;
    p.y = Math.sin(a) * r * 0.45;
    p.z = (rand() - 0.5) * 0.5;
    p.rotation = (rand() - 0.5) * 0.6;
  }
  return out;
}

/** The intended discovery: Earth low and near, Air deep behind, Light high. `mirror` = ±1 flips x. */
export function canonicalArrangement(mirror: number, out: FieldPose[], xLimit: number = BOUNDS.xMax): FieldPose[] {
  const m = (mirror < 0 ? -1 : 1) * Math.min(1, xLimit / 1.1);
  out[EARTH].x = -0.95 * m;
  out[EARTH].y = -1.15;
  out[EARTH].z = 0.85;
  out[AIR].x = 0.25 * m;
  out[AIR].y = 0.15;
  out[AIR].z = -1.95;
  out[LIGHT].x = 1.05 * m;
  out[LIGHT].y = 1.2;
  out[LIGHT].z = 0.15;
  return out;
}

const GRID_X = [-1, -0.5, 0, 0.5, 1];
const GRID_Y = [-1.3, -0.5, 0.5, 1.3];
const GRID_Z = [-2.0, -1.0, 0.2, 1.0];
const scratchPoses: FieldPose[] = [createPose(), createPose(), createPose()];
const scratchState = createBalanceState();
const scratchPoint = { x: 0, y: 0, z: 0 };

/** How much a place suits a field's character, 0..1: Earth low and near, Air deep, Light high. */
function affinity(index: number, y: number, z: number): number {
  const height = clamp01((y - BOUNDS.yMin) / (BOUNDS.yMax - BOUNDS.yMin));
  const depth = clamp01((BOUNDS.zMax - z) / (BOUNDS.zMax - BOUNDS.zMin));
  if (index === EARTH) return 0.5 * (1 - height) + 0.5 * (1 - depth);
  if (index === AIR) return depth;
  return height;
}

/**
 * An open region for field `index` given where the other two are: the best of a coarse grid of
 * places, preferring high balance, then the field's own character, then a short journey.
 * Used for the ghost marker (assist 2) and by solveArrangement (assist 3).
 */
export function openRegion<T extends Vec3Like>(index: number, poses: readonly FieldPose[], out: T, xLimit: number = BOUNDS.xMax): T {
  for (let i = 0; i < 3; i++) copyPose(poses[i], scratchPoses[i]);
  const cur = poses[index];
  const xl = Math.min(xLimit, BOUNDS.xMax) * 0.85;
  let best = -Infinity;
  out.x = cur.x;
  out.y = cur.y;
  out.z = cur.z;
  const moved = scratchPoses[index];
  for (let a = 0; a < GRID_X.length; a++) {
    for (let b = 0; b < GRID_Y.length; b++) {
      for (let c = 0; c < GRID_Z.length; c++) {
        moved.x = GRID_X[a] * xl;
        moved.y = GRID_Y[b];
        moved.z = GRID_Z[c];
        const score0 = evaluateBalance(scratchPoses, scratchState).balance;
        const dx = moved.x - cur.x;
        const dy = moved.y - cur.y;
        const dz = moved.z - cur.z;
        const score = score0 + 0.1 * affinity(index, moved.y, moved.z) - 0.03 * Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (score > best) {
          best = score;
          out.x = moved.x;
          out.y = moved.y;
          out.z = moved.z;
        }
      }
    }
  }
  return out;
}

/**
 * A balanced arrangement reachable from `poses` with little travel: repeatedly move the most masked
 * field into its open region; fall back to the canonical arrangement if that somehow fails.
 * Rotations are kept. `out` may be the same array as `poses`.
 */
export function solveArrangement(poses: readonly FieldPose[], out: FieldPose[], xLimit: number = BOUNDS.xMax): FieldPose[] {
  if (out !== poses) for (let i = 0; i < 3; i++) copyPose(poses[i], out[i]);
  const state = createBalanceState();
  for (let iter = 0; iter < 6; iter++) {
    evaluateBalance(out, state);
    if (state.balance >= 0.93) return out;
    const i = state.mostMasked;
    openRegion(i, out, scratchPoint, xLimit);
    out[i].x = scratchPoint.x;
    out[i].y = scratchPoint.y;
    out[i].z = scratchPoint.z;
  }
  if (evaluateBalance(out, state).balance < 0.9) canonicalArrangement(out[LIGHT].x - out[EARTH].x, out, xLimit);
  return out;
}

/** Composed positions of the merged sculpture, before the visitor's own arrangement is blended in. */
const COMPOSED = [
  { x: -1.15, y: -0.72, z: 0.55 },
  { x: 0.35, y: 0.28, z: -1.25 },
  { x: 0.98, y: 0.92, z: 0.35 },
] as const;
const COMPOSE_MIN_GAP = 1.35;

/**
 * The signature arrangement: the three sculptures drawn in around the central membrane into one
 * asymmetric composition. It keeps the handedness and some of the character of the visitor's own
 * solution (40 %), so no two visits end on the same sculpture. Rotations are kept.
 * `out` may be the same array as `poses`.
 */
export function composeArrangement(poses: readonly FieldPose[], out: FieldPose[]): FieldPose[] {
  const mirror = poses[LIGHT].x - poses[EARTH].x < 0 ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    const p = poses[i];
    const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    const k = d > 1.6 ? 1.6 / d : 1;
    const x = COMPOSED[i].x * mirror * 0.6 + p.x * k * 0.4;
    const y = COMPOSED[i].y * 0.6 + p.y * k * 0.4;
    const z = COMPOSED[i].z * 0.6 + p.z * k * 0.4;
    const rotation = p.rotation;
    out[i].x = x;
    out[i].y = y;
    out[i].z = z;
    out[i].rotation = rotation;
  }
  // Relax: no two bodies closer than the minimum gap (they must read as three, not as a lump).
  for (let iter = 0; iter < 8; iter++) {
    for (let k = 0; k < 3; k++) {
      const a = out[PAIRS[k][0]];
      const b = out[PAIRS[k][1]];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dz = b.z - a.z;
      let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= COMPOSE_MIN_GAP) continue;
      if (d < 1e-4) {
        // Coincident: separate along the canonical direction of the pair.
        dx = (COMPOSED[PAIRS[k][1]].x - COMPOSED[PAIRS[k][0]].x) * mirror;
        dy = COMPOSED[PAIRS[k][1]].y - COMPOSED[PAIRS[k][0]].y;
        dz = COMPOSED[PAIRS[k][1]].z - COMPOSED[PAIRS[k][0]].z;
        d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const push = COMPOSE_MIN_GAP * 0.5;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        a.z -= (dz / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
        b.z += (dz / d) * push;
        continue;
      }
      const push = ((COMPOSE_MIN_GAP - d) * 0.5 + 0.01) / d;
      a.x -= dx * push;
      a.y -= dy * push;
      a.z -= dz * push;
      b.x += dx * push;
      b.y += dy * push;
      b.z += dz * push;
    }
  }
  for (let i = 0; i < 3; i++) clampToBounds(out[i]);
  return out;
}
