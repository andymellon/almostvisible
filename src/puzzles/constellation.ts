/**
 * Chapter III — the constellation puzzle. Pure logic: no three.js, no DOM, no audio.
 *
 * FIVE FRAGMENTS, each with a pitch (a ratio to the visit's root). Three belong
 * together; two do not.
 *
 * HARMONIC RELATION
 *   For two pitches a, b the interval is reduced to a fraction p/q in lowest terms
 *   (the simplest fraction within RATIO_TOLERANCE_CENTS, denominators ≤ 64).
 *   Its Tenney height is  H(a,b) = log2(p·q)  — Tenney's "harmonic distance".
 *     2/1 → 1      3/2 → 2.58   4/3 → 3.58   5/4 → 4.32   6/5 → 4.91
 *     9/8 → 6.17   16/15 → 7.91 45/32 → ≈ 10
 *   compatibility(a,b) = clamp(1 − (H − 1) / 8)            (octave = 1, tritone = 0)
 *   Two fragments are BONDED when compatibility ≥ 0.5, i.e. H ≤ 5, i.e. p·q ≤ 32.
 *   The three members are the triple of scale degrees whose three pairwise heights
 *   sum lowest (ties: lowest worst pair). The two outsiders are tense neighbours
 *   (minor second, tritone, chromatic semitone) chosen so that they are bonded to
 *   nothing — not to a member and not to each other.
 *
 * GEOMETRIC RELATION (the one rule of the puzzle)
 *   The solved figure is the triad drawn in harmonic space: every bonded pair wants
 *   the distance
 *
 *       ideal(i,j) = TARGET_SCALE · H(i,j) / mean(H over all bonded pairs)
 *
 *   so the purest interval is the shortest side and the mean side is TARGET_SCALE.
 *   Harmonic distance is a metric, so the three sides always close into a real
 *   (non-degenerate, generally scalene) triangle: 4:5:6 gives sides ≈ 0.66 : 1.10 : 1.25.
 *   The puzzle is SOLVED when every bonded pair satisfies
 *
 *       |distance − ideal| / ideal ≤ LENGTH_TOLERANCE   (18 %)
 *
 *   in any orientation, at any position, in any plane, mirrored or not. The
 *   outsiders play no part in the solution.
 *
 * GUIDANCE
 *   A bonded pair is "captured" while its distance is below ideal·(1 + CAPTURE).
 *   Inside that range magnetStep() pulls the pair toward the ideal distance (and
 *   pushes it apart when too close). Unbonded pairs repel softly inside REPEL_RADIUS,
 *   so a wrong connection never sticks.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Mean side length of the solved triangle, world units. */
export const TARGET_SCALE = 1.2;
/** Relative length tolerance on every side of the solved triangle. */
export const LENGTH_TOLERANCE = 0.18;
/** A bonded pair is captured while (distance − ideal) / ideal < CAPTURE. */
export const CAPTURE = 0.5;
/** compatibility at or above this ⇔ bonded (Tenney height ≤ 5, p·q ≤ 32). */
export const COMPAT_THRESHOLD = 0.5;
/** Unbonded fragments push each other out to this distance. */
export const REPEL_RADIUS = 0.95;
/** How far an interval may sit from a simple fraction and still be heard as it. */
export const RATIO_TOLERANCE_CENTS = 3;

const MAX_DENOMINATOR = 64;
/** Height given to an interval with no fraction within tolerance: beyond any bond. */
const UNRELATED_HEIGHT = 13;
/** Outsiders must stay clearly below the bond threshold against every other fragment. */
const OUTSIDER_MAX_COMPAT = 0.4;
/** Tense intervals an outsider may form with a member: minor second, tritone, chromatic semitone (both directions). */
const TENSE = [16 / 15, 15 / 16, 45 / 32, 32 / 45, 25 / 24, 24 / 25, 64 / 45, 45 / 64];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const cents = (a: number, b: number) => 1200 * Math.abs(Math.log2(a / b));

// ─────────────────────────────────────────────────────────── harmony ──

export interface Fraction {
  p: number;
  q: number;
}

/**
 * Simplest fraction p/q (lowest p·q, hence lowest terms) within RATIO_TOLERANCE_CENTS
 * of `ratio`, or null when no fraction with q ≤ 64 is that close.
 */
export function rationalize(ratio: number): Fraction | null {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null;
  for (let q = 1; q <= MAX_DENOMINATOR; q++) {
    const p = Math.round(ratio * q);
    if (p < 1) continue;
    if (cents(p / q, ratio) <= RATIO_TOLERANCE_CENTS) return { p, q };
  }
  return null;
}

/** Tenney height log2(p·q) of the interval between two pitches (order irrelevant). */
export function tenneyHeight(a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return UNRELATED_HEIGHT;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const f = rationalize(hi / lo);
  return f ? Math.min(UNRELATED_HEIGHT, Math.log2(f.p * f.q)) : UNRELATED_HEIGHT;
}

/** 0..1 — simplicity of the frequency ratio between two pitches. Symmetric. */
export function compatibility(a: number, b: number): number {
  return clamp01(1 - (tenneyHeight(a, b) - 1) / 8);
}

/**
 * The triple of scale degrees (i < j < k) whose three pairwise Tenney heights sum
 * lowest; ties go to the triple whose worst pair is simplest. Remaining exact ties
 * are returned together so a seeded choice can be made between them.
 */
export function bestTriads(scale: readonly number[]): [number, number, number][] {
  const n = scale.length;
  const EPS = 1e-9;
  let best: [number, number, number][] = [];
  let bestSum = Infinity;
  let bestMax = Infinity;
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        const hij = tenneyHeight(scale[i], scale[j]);
        const hjk = tenneyHeight(scale[j], scale[k]);
        const hik = tenneyHeight(scale[i], scale[k]);
        const sum = hij + hjk + hik;
        const max = Math.max(hij, hjk, hik);
        if (sum < bestSum - EPS || (Math.abs(sum - bestSum) <= EPS && max < bestMax - EPS)) {
          best = [[i, j, k]];
          bestSum = sum;
          bestMax = max;
        } else if (Math.abs(sum - bestSum) <= EPS && Math.abs(max - bestMax) <= EPS) {
          best.push([i, j, k]);
        }
      }
    }
  }
  return best;
}

/** One triad from bestTriads(); `rand` (0..1) chooses between exact ties. */
export function chooseTriad(scale: readonly number[], rand?: () => number): [number, number, number] {
  const ties = bestTriads(scale);
  if (ties.length === 0) return [0, Math.min(1, scale.length - 1), Math.min(2, scale.length - 1)];
  const pick = rand ? Math.min(ties.length - 1, Math.floor(rand() * ties.length)) : 0;
  return ties[pick];
}

export interface ConstellationSpec {
  /** Pitch of each of the five fragments as a ratio to the root. */
  pitches: number[];
  /** Scale degree of each fragment; -1 for the two that do not belong. */
  degrees: number[];
  /** Fragment indices of the three that belong, ascending in pitch. */
  members: number[];
  /** Fragment indices of the two that do not. */
  outsiders: number[];
}

function isOutsider(candidate: number, against: readonly number[]): boolean {
  for (const other of against) {
    if (cents(candidate, other) < 60) return false;
    if (compatibility(candidate, other) >= OUTSIDER_MAX_COMPAT) return false;
  }
  return true;
}

function shuffle<T>(list: T[], rand: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
  return list;
}

/** Two pitches near the triad that are bonded to no member and not to each other. */
export function chooseOutsiders(triad: readonly number[], rand: () => number): [number, number] {
  const lo = Math.min(...triad) * (15 / 16) - 1e-9;
  const hi = Math.max(...triad) * (16 / 15) + 1e-9;
  const candidates: number[] = [];
  for (const member of triad) {
    for (const t of TENSE) {
      const c = member * t;
      if (c < lo || c > hi) continue;
      if (candidates.some((x) => cents(x, c) < 1)) continue;
      if (isOutsider(c, triad)) candidates.push(c);
    }
  }
  shuffle(candidates, rand);
  for (let a = 0; a < candidates.length; a++) {
    for (let b = a + 1; b < candidates.length; b++) {
      if (isOutsider(candidates[b], [candidates[a]])) return [candidates[a], candidates[b]];
    }
  }
  // No tense just interval fits this triad: fall back to 31-tone steps, which are
  // never simple against a just triad. Always terminates with two distinct pitches.
  const found: number[] = candidates.length > 0 ? [candidates[0]] : [];
  const base = Math.min(...triad);
  for (let step = 1; step < 62 && found.length < 2; step++) {
    const c = base * Math.pow(2, (step * 2 - 1) / 62);
    if (c > hi) break;
    if (isOutsider(c, triad) && isOutsider(c, found)) found.push(c);
  }
  while (found.length < 2) found.push(base * Math.pow(2, (found.length * 7 + 3) / 62));
  return [found[0], found[1]];
}

/**
 * The five fragments of one visit: the simplest triad of the mode plus two
 * unrelated pitches, in a seeded order.
 */
export function designConstellation(scale: readonly number[], rand: () => number): ConstellationSpec {
  const triad = chooseTriad(scale, rand);
  const triadPitches = triad.map((d) => scale[d]);
  const [o1, o2] = chooseOutsiders(triadPitches, rand);
  const entries = shuffle(
    [
      { pitch: triadPitches[0], degree: triad[0] },
      { pitch: triadPitches[1], degree: triad[1] },
      { pitch: triadPitches[2], degree: triad[2] },
      { pitch: o1, degree: -1 },
      { pitch: o2, degree: -1 },
    ],
    rand,
  );
  const members: number[] = [];
  const outsiders: number[] = [];
  entries.forEach((e, i) => (e.degree >= 0 ? members : outsiders).push(i));
  members.sort((a, b) => entries[a].pitch - entries[b].pitch);
  return {
    pitches: entries.map((e) => e.pitch),
    degrees: entries.map((e) => e.degree),
    members,
    outsiders,
  };
}

// ───────────────────────────────────────────────────────── relations ──

/** Pairwise tables for a fixed set of pitches. Index with i * n + j. */
export interface Relations {
  readonly n: number;
  readonly pitches: readonly number[];
  readonly compat: readonly number[];
  readonly bonded: readonly boolean[];
  /** Ideal distance of a bonded pair; 0 for unbonded pairs. */
  readonly ideal: readonly number[];
  readonly bondCount: number;
}

/** Precompute compatibility, bonds and ideal distances (see file header). */
export function relate(pitches: readonly number[], scale = TARGET_SCALE): Relations {
  const n = pitches.length;
  const compat = new Array<number>(n * n).fill(1);
  const bonded = new Array<boolean>(n * n).fill(false);
  const ideal = new Array<number>(n * n).fill(0);
  const height = new Array<number>(n * n).fill(0);
  let sum = 0;
  let bondCount = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const h = tenneyHeight(pitches[i], pitches[j]);
      const c = clamp01(1 - (h - 1) / 8);
      const b = c >= COMPAT_THRESHOLD;
      compat[i * n + j] = compat[j * n + i] = c;
      bonded[i * n + j] = bonded[j * n + i] = b;
      // A unison or octave still needs room to exist as two bodies.
      height[i * n + j] = height[j * n + i] = Math.max(h, 1);
      if (b) {
        sum += Math.max(h, 1);
        bondCount++;
      }
    }
  }
  const mean = bondCount > 0 ? sum / bondCount : 1;
  for (let i = 0; i < n * n; i++) if (bonded[i]) ideal[i] = (scale * height[i]) / mean;
  return { n, pitches: pitches.slice(), compat, bonded, ideal, bondCount };
}

// ──────────────────────────────────────────────────────── evaluation ──

export interface PairState {
  i: number;
  j: number;
  compat: number;
  bonded: boolean;
  distance: number;
  /** Ideal distance (bonded pairs), else 0. */
  ideal: number;
  /**
   * Bonded: signed relative length error (distance − ideal) / ideal.
   * Unbonded: how far the pair intrudes into the repel radius, ≤ 0 (0 = clear).
   */
  distError: number;
  /** Bonded: 1 at the ideal distance, 0 at the edge of capture and beyond. Unbonded: 0. */
  closeness: number;
  /** Bonded: 1 inside the tolerance, falling to 0 at twice the ideal distance (or at contact). */
  fit: number;
}

export interface Evaluation {
  /** Every unordered pair, i < j, in row order. */
  pairs: PairState[];
  /** Mean fit of the bonded pairs; 1 exactly when solved. */
  progress: number;
  solved: boolean;
}

export function createEvaluation(n: number): Evaluation {
  const pairs: PairState[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs.push({ i, j, compat: 0, bonded: false, distance: 0, ideal: 0, distError: 0, closeness: 0, fit: 0 });
    }
  }
  return { pairs, progress: 0, solved: false };
}

/**
 * Measure an arrangement. `pitches` is either the per-fragment pitch ratios or the
 * precomputed Relations for them. Pass `out` (from createEvaluation) to avoid allocation.
 */
export function evaluate(positions: readonly Vec3[], pitches: readonly number[] | Relations, out?: Evaluation): Evaluation {
  const rel: Relations = Array.isArray(pitches) ? relate(pitches as readonly number[]) : (pitches as Relations);
  const n = rel.n;
  const result = out && out.pairs.length === (n * (n - 1)) / 2 ? out : createEvaluation(n);
  let sum = 0;
  let allFit = true;
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pair = result.pairs[k++];
      const a = positions[i];
      const b = positions[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const idx = i * n + j;
      pair.i = i;
      pair.j = j;
      pair.compat = rel.compat[idx];
      pair.bonded = rel.bonded[idx];
      pair.distance = d;
      if (pair.bonded) {
        const ideal = rel.ideal[idx];
        const err = (d - ideal) / ideal;
        const abs = Math.abs(err);
        pair.ideal = ideal;
        pair.distError = err;
        pair.closeness = clamp01(1 - abs / CAPTURE);
        pair.fit = abs <= LENGTH_TOLERANCE ? 1 : clamp01(1 - (abs - LENGTH_TOLERANCE) / (1 - LENGTH_TOLERANCE));
        sum += pair.fit;
        if (abs > LENGTH_TOLERANCE) allFit = false;
      } else {
        pair.ideal = 0;
        pair.distError = Math.min(0, (d - REPEL_RADIUS) / REPEL_RADIUS);
        pair.closeness = 0;
        pair.fit = 0;
      }
    }
  }
  result.solved = rel.bondCount > 0 && allFit;
  result.progress = rel.bondCount > 0 ? (result.solved ? 1 : Math.min(sum / rel.bondCount, 0.999)) : 0;
  return result;
}

// ─────────────────────────────────────────────────────────── guidance ──

/**
 * Where fragment `index`, wanting to be at `desired`, is gently drawn to.
 *
 * Bonded neighbours inside capture pull it toward the ideal distance (full pull when
 * too close, fading to nothing at the capture edge, so there is no jump on entry).
 * Unbonded neighbours inside REPEL_RADIUS push it away. `strength` 0..1 is the
 * fraction of the error removed in one call: ~0.3 while dragging (a perceptible
 * lean), ~1 for a free fragment relaxing over several frames.
 *
 * `positions[index]` is ignored. Writes to `out` (default: `desired`, in place).
 */
export function magnetStep(index: number, desired: Vec3, positions: readonly Vec3[], rel: Relations, strength: number, out: Vec3 = desired): Vec3 {
  const n = rel.n;
  let px = 0;
  let py = 0;
  let pz = 0;
  let pullWeight = 0;
  let rx = 0;
  let ry = 0;
  let rz = 0;
  for (let j = 0; j < n; j++) {
    if (j === index) continue;
    const o = positions[j];
    let dx = desired.x - o.x;
    let dy = desired.y - o.y;
    let dz = desired.z - o.z;
    let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6) {
      // Coincident: separate along a fixed, pair-dependent direction.
      dx = index < j ? -1 : 1;
      dy = 0;
      dz = 0;
      d = 0;
    } else {
      dx /= d;
      dy /= d;
      dz /= d;
    }
    const idx = index * n + j;
    if (rel.bonded[idx]) {
      const ideal = rel.ideal[idx];
      const err = (d - ideal) / ideal;
      if (err >= CAPTURE) continue;
      let w = 1;
      if (err > 0) {
        const t = 1 - err / CAPTURE;
        w = t * t * (3 - 2 * t);
      }
      const move = (ideal - d) * w;
      px += dx * move;
      py += dy * move;
      pz += dz * move;
      pullWeight += w;
    } else if (d < REPEL_RADIUS) {
      const t = 1 - d / REPEL_RADIUS;
      const move = (REPEL_RADIUS - d) * (0.4 + 0.6 * t) * (1 - rel.compat[idx]);
      rx += dx * move;
      ry += dy * move;
      rz += dz * move;
    }
  }
  // Several bonds pulling at once share the step, so the sum never overshoots.
  const share = pullWeight > 1 ? 1 / pullWeight : 1;
  const s = clamp01(strength);
  const x = desired.x + (px * share + rx) * s;
  const y = desired.y + (py * share + ry) * s;
  const z = desired.z + (pz * share + rz) * s;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * The solved triangle nearest to where three bonded fragments are now: same centroid,
 * same plane, rotated (and mirrored if that is closer) for least total movement.
 * `members` are three fragment indices; `out[k]` receives the target of members[k].
 */
export function solveArrangement(positions: readonly Vec3[], rel: Relations, members: readonly number[], out?: Vec3[]): Vec3[] {
  const result = out ?? [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
  ];
  const n = rel.n;
  const [a, b, c] = members;
  const p0 = positions[a];
  const p1 = positions[b];
  const p2 = positions[c];
  const s01 = rel.ideal[a * n + b] || TARGET_SCALE;
  const s02 = rel.ideal[a * n + c] || TARGET_SCALE;
  const s12 = rel.ideal[b * n + c] || TARGET_SCALE;

  // Ideal triangle in 2D, centred on its centroid.
  const x2 = (s01 * s01 + s02 * s02 - s12 * s12) / (2 * s01);
  const y2 = Math.sqrt(Math.max(0, s02 * s02 - x2 * x2));
  const qcx = (s01 + x2) / 3;
  const qcy = y2 / 3;
  const q0x = -qcx;
  const q0y = -qcy;
  const q1x = s01 - qcx;
  const q1y = -qcy;
  const q2x = x2 - qcx;
  const q2y = y2 - qcy;

  // Current centroid and plane basis (u, v).
  const gx = (p0.x + p1.x + p2.x) / 3;
  const gy = (p0.y + p1.y + p2.y) / 3;
  const gz = (p0.z + p1.z + p2.z) / 3;
  let ux = p1.x - p0.x;
  let uy = p1.y - p0.y;
  let uz = p1.z - p0.z;
  let ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (ul < 1e-6) {
    ux = p2.x - p0.x;
    uy = p2.y - p0.y;
    uz = p2.z - p0.z;
    ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  }
  if (ul < 1e-6) {
    ux = 1;
    uy = 0;
    uz = 0;
    ul = 1;
  }
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // v: the part of (p2 − p0) orthogonal to u; if the three are collinear, the part of world-up (else world-right).
  let wx = p2.x - p0.x;
  let wy = p2.y - p0.y;
  let wz = p2.z - p0.z;
  let dot = wx * ux + wy * uy + wz * uz;
  let vx = wx - dot * ux;
  let vy = wy - dot * uy;
  let vz = wz - dot * uz;
  let vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (vl < 1e-4) {
    wx = 0;
    wy = 1;
    wz = 0;
    dot = uy;
    vx = wx - dot * ux;
    vy = wy - dot * uy;
    vz = wz - dot * uz;
    vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
  }
  if (vl < 1e-4) {
    dot = ux;
    vx = 1 - dot * ux;
    vy = -dot * uy;
    vz = -dot * uz;
    vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
  }
  vx /= vl;
  vy /= vl;
  vz /= vl;

  // Current positions in that plane, relative to the centroid.
  const a0x = (p0.x - gx) * ux + (p0.y - gy) * uy + (p0.z - gz) * uz;
  const a0y = (p0.x - gx) * vx + (p0.y - gy) * vy + (p0.z - gz) * vz;
  const a1x = (p1.x - gx) * ux + (p1.y - gy) * uy + (p1.z - gz) * uz;
  const a1y = (p1.x - gx) * vx + (p1.y - gy) * vy + (p1.z - gz) * vz;
  const a2x = (p2.x - gx) * ux + (p2.y - gy) * uy + (p2.z - gz) * uz;
  const a2y = (p2.x - gx) * vx + (p2.y - gy) * vy + (p2.z - gz) * vz;

  // Best in-plane rotation for the triangle and for its mirror image (2D Procrustes).
  const dotP = q0x * a0x + q0y * a0y + q1x * a1x + q1y * a1y + q2x * a2x + q2y * a2y;
  const crossP = q0x * a0y - q0y * a0x + q1x * a1y - q1y * a1x + q2x * a2y - q2y * a2x;
  const dotM = q0x * a0x - q0y * a0y + q1x * a1x - q1y * a1y + q2x * a2x - q2y * a2y;
  const crossM = q0x * a0y + q0y * a0x + q1x * a1y + q1y * a1x + q2x * a2y + q2y * a2x;
  const mirror = Math.hypot(dotM, crossM) > Math.hypot(dotP, crossP) + 1e-12 ? -1 : 1;
  const theta = mirror === 1 ? Math.atan2(crossP, dotP) : Math.atan2(crossM, dotM);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const place = (target: Vec3, qx: number, qy: number) => {
    const my = qy * mirror;
    const rxp = cos * qx - sin * my;
    const ryp = sin * qx + cos * my;
    target.x = gx + ux * rxp + vx * ryp;
    target.y = gy + uy * rxp + vy * ryp;
    target.z = gz + uz * rxp + vz * ryp;
  };
  place(result[0], q0x, q0y);
  place(result[1], q1x, q1y);
  place(result[2], q2x, q2y);
  return result;
}

// ──────────────────────────────────────────────────────────── opening ──

/** Guaranteed-valid layout in units of the half extents (members first, then outsiders). */
const ANCHORS_MEMBER = [
  { x: -0.9, y: -0.85 },
  { x: 0.9, y: -0.35 },
  { x: -0.1, y: 0.92 },
];
const ANCHORS_OUTSIDER = [
  { x: -0.75, y: 0.35 },
  { x: 0.55, y: 0.3 },
];

/**
 * Seeded starting positions inside the box [−half, +half]: nothing overlapping, and
 * every bonded pair well outside capture, so the opening is never accidentally solved
 * and no filament is visible before the visitor acts.
 */
export function scatter(rel: Relations, half: Vec3, rand: () => number): Vec3[] {
  const n = rel.n;
  const minSeparation = Math.min(1.0, Math.min(half.x, half.y) * 0.7);
  const positions: Vec3[] = [];
  for (let i = 0; i < n; i++) positions.push({ x: 0, y: 0, z: 0 });

  const valid = () => {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = positions[i].x - positions[j].x;
        const dy = positions[i].y - positions[j].y;
        const dz = positions[i].z - positions[j].z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < minSeparation) return false;
        const idx = i * n + j;
        if (rel.bonded[idx] && d < rel.ideal[idx] * (1 + CAPTURE) + 0.15) return false;
      }
    }
    return true;
  };

  for (let attempt = 0; attempt < 240; attempt++) {
    for (let i = 0; i < n; i++) {
      positions[i].x = (rand() * 2 - 1) * half.x;
      positions[i].y = (rand() * 2 - 1) * half.y;
      positions[i].z = (rand() * 2 - 1) * half.z;
    }
    if (valid()) return positions;
  }

  // Fallback: fixed anchors (bonded fragments on the far-apart ones), seeded depth.
  const isMember = (i: number) => {
    for (let j = 0; j < n; j++) if (j !== i && rel.bonded[i * n + j]) return true;
    return false;
  };
  let m = 0;
  let o = 0;
  for (let i = 0; i < n; i++) {
    const anchor = isMember(i) ? ANCHORS_MEMBER[m++ % ANCHORS_MEMBER.length] : ANCHORS_OUTSIDER[o++ % ANCHORS_OUTSIDER.length];
    positions[i].x = anchor.x * half.x;
    positions[i].y = anchor.y * half.y;
    positions[i].z = (rand() * 2 - 1) * half.z * 0.6;
  }
  return positions;
}
