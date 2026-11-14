import { describe, it, expect } from 'vitest';
import { createHarmony } from '../core/harmony';
import { mulberry32 } from '../core/math';
import {
  CAPTURE,
  COMPAT_THRESHOLD,
  LENGTH_TOLERANCE,
  REPEL_RADIUS,
  TARGET_SCALE,
  bestTriads,
  chooseOutsiders,
  chooseTriad,
  compatibility,
  createEvaluation,
  designConstellation,
  evaluate,
  magnetStep,
  rationalize,
  relate,
  scatter,
  solveArrangement,
  tenneyHeight,
  type Relations,
  type Vec3,
} from './constellation';

const MODES: Record<string, number[]> = {
  dorian: [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 5 / 3, 9 / 5],
  lydian: [1, 9 / 8, 5 / 4, 45 / 32, 3 / 2, 5 / 3, 15 / 8],
  aeolian: [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 8 / 5, 9 / 5],
  mixolydian: [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 7 / 4],
  harmonic: [1, 9 / 8, 5 / 4, 11 / 8, 3 / 2, 13 / 8, 7 / 4],
};

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Rotate about an arbitrary axis (Rodrigues) then translate. */
function transform(p: Vec3, axis: Vec3, angle: number, offset: Vec3): Vec3 {
  const l = Math.hypot(axis.x, axis.y, axis.z);
  const k = v(axis.x / l, axis.y / l, axis.z / l);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = k.x * p.x + k.y * p.y + k.z * p.z;
  return v(
    p.x * c + (k.y * p.z - k.z * p.y) * s + k.x * d * (1 - c) + offset.x,
    p.y * c + (k.z * p.x - k.x * p.z) * s + k.y * d * (1 - c) + offset.y,
    p.z * c + (k.x * p.y - k.y * p.x) * s + k.z * d * (1 - c) + offset.z,
  );
}

/** The exact solved triangle for three bonded members, in the XY plane, scaled by `s`. */
function idealTriangle(rel: Relations, members: number[], s = 1): Vec3[] {
  const n = rel.n;
  const [a, b, c] = members;
  const ab = rel.ideal[a * n + b] * s;
  const ac = rel.ideal[a * n + c] * s;
  const bc = rel.ideal[b * n + c] * s;
  const x = (ab * ab + ac * ac - bc * bc) / (2 * ab);
  const y = Math.sqrt(Math.max(0, ac * ac - x * x));
  return [v(0, 0, 0), v(ab, 0, 0), v(x, y, 0)];
}

/** Five positions: members on `tri`, outsiders parked far away. */
function arrange(spec: { members: number[]; outsiders: number[] }, tri: Vec3[]): Vec3[] {
  const positions: Vec3[] = [];
  spec.members.forEach((m, k) => (positions[m] = tri[k]));
  spec.outsiders.forEach((o, k) => (positions[o] = v(40 + k * 10, -30, 12)));
  return positions;
}

describe('harmonic relation', () => {
  it('reduces intervals to their simplest fraction', () => {
    expect(rationalize(3 / 2)).toEqual({ p: 3, q: 2 });
    expect(rationalize(16 / 15)).toEqual({ p: 16, q: 15 });
    expect(rationalize(6 / 4)).toEqual({ p: 3, q: 2 });
    expect(rationalize(2)).toEqual({ p: 2, q: 1 });
    expect(rationalize(0)).toBeNull();
    expect(rationalize(Number.NaN)).toBeNull();
  });

  it('does not mistake a tense interval for a nearby simple one', () => {
    // 45/32 is 7.7 cents from 7/5; 75/64 is 7.7 cents from 7/6: neither may collapse onto it.
    const tritone = rationalize(45 / 32)!;
    const augmentedSecond = rationalize(75 / 64)!;
    expect(tritone.p * tritone.q).toBeGreaterThan(500);
    expect(augmentedSecond.p * augmentedSecond.q).toBeGreaterThan(500);
    expect(Math.abs(Math.log2(tritone.p / tritone.q / (45 / 32))) * 1200).toBeLessThanOrEqual(3);
  });

  it('tolerates a few cents of mistuning', () => {
    expect(rationalize(1.5 * Math.pow(2, 2 / 1200))).toEqual({ p: 3, q: 2 });
    expect(rationalize(1.5 * Math.pow(2, 6 / 1200))).not.toEqual({ p: 3, q: 2 });
  });

  it('Tenney height is log2(p·q)', () => {
    expect(tenneyHeight(1, 2)).toBeCloseTo(1, 10);
    expect(tenneyHeight(2, 3)).toBeCloseTo(Math.log2(6), 10);
    expect(tenneyHeight(5 / 4, 3 / 2)).toBeCloseTo(Math.log2(30), 10);
    expect(tenneyHeight(3, 2)).toBeCloseTo(tenneyHeight(2, 3), 12);
  });

  it('orders intervals by simplicity and is symmetric', () => {
    const fifth = compatibility(1, 3 / 2);
    const fourth = compatibility(1, 4 / 3);
    const majorThird = compatibility(1, 5 / 4);
    const minorThird = compatibility(1, 6 / 5);
    const tone = compatibility(1, 9 / 8);
    const semitone = compatibility(1, 16 / 15);
    const tritone = compatibility(1, 45 / 32);
    expect(compatibility(1, 2)).toBe(1);
    expect(compatibility(220, 220)).toBe(1);
    expect(fifth).toBeGreaterThan(fourth);
    expect(fourth).toBeGreaterThan(majorThird);
    expect(majorThird).toBeGreaterThan(minorThird);
    expect(minorThird).toBeGreaterThanOrEqual(COMPAT_THRESHOLD);
    expect(tone).toBeLessThan(COMPAT_THRESHOLD);
    expect(semitone).toBeLessThan(tone);
    expect(tritone).toBe(0);
    expect(compatibility(3 / 2, 1)).toBe(fifth);
    expect(compatibility(1, Math.SQRT2)).toBe(0);
    for (const c of [fifth, fourth, majorThird, minorThird, tone, semitone]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('is invariant to absolute frequency', () => {
    expect(compatibility(220, 330)).toBeCloseTo(compatibility(1, 1.5), 12);
    expect(compatibility(51.3 * 4 * (5 / 4), 51.3 * 4 * (3 / 2))).toBeCloseTo(compatibility(5, 6), 12);
  });
});

describe('choosing the fragments', () => {
  it('finds a fully bonded triad in every mode', () => {
    for (const [name, scale] of Object.entries(MODES)) {
      const ties = bestTriads(scale);
      expect(ties.length, name).toBeGreaterThan(0);
      for (const [i, j, k] of ties) {
        expect(i).toBeLessThan(j);
        expect(j).toBeLessThan(k);
        expect(compatibility(scale[i], scale[j]), name).toBeGreaterThanOrEqual(COMPAT_THRESHOLD);
        expect(compatibility(scale[j], scale[k]), name).toBeGreaterThanOrEqual(COMPAT_THRESHOLD);
        expect(compatibility(scale[i], scale[k]), name).toBeGreaterThanOrEqual(COMPAT_THRESHOLD);
      }
    }
  });

  it('prefers the triad whose worst interval is simplest', () => {
    // Dorian: 3:4:5 (1, 4/3, 5/3) beats 10:12:15 (1, 6/5, 3/2) on its worst pair.
    expect(bestTriads(MODES.dorian)).toEqual([[0, 3, 5]]);
    // Aeolian: the minor triad on the root and the major triad on its third tie exactly.
    expect(bestTriads(MODES.aeolian)).toEqual([
      [0, 2, 4],
      [2, 4, 6],
    ]);
    // The harmonic mode: 4:5:6.
    expect(bestTriads(MODES.harmonic)).toEqual([[0, 2, 4]]);
  });

  it('chooseTriad is deterministic without rand and seeded with it', () => {
    expect(chooseTriad(MODES.mixolydian)).toEqual(bestTriads(MODES.mixolydian)[0]);
    const a = chooseTriad(MODES.mixolydian, mulberry32(7));
    const b = chooseTriad(MODES.mixolydian, mulberry32(7));
    expect(a).toEqual(b);
    expect(bestTriads(MODES.mixolydian)).toContainEqual(a);
  });

  it('outsiders are bonded to nothing', () => {
    for (const [name, scale] of Object.entries(MODES)) {
      for (let seed = 1; seed <= 40; seed++) {
        const triad = chooseTriad(scale).map((d) => scale[d]);
        const [o1, o2] = chooseOutsiders(triad, mulberry32(seed));
        for (const m of triad) {
          expect(compatibility(o1, m), `${name} ${seed}`).toBeLessThan(COMPAT_THRESHOLD);
          expect(compatibility(o2, m), `${name} ${seed}`).toBeLessThan(COMPAT_THRESHOLD);
        }
        expect(compatibility(o1, o2), `${name} ${seed}`).toBeLessThan(COMPAT_THRESHOLD);
        expect(Math.abs(Math.log2(o1 / o2)) * 1200).toBeGreaterThan(50);
      }
    }
  });

  it('designs five fragments: exactly three bonds, all among the members', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const harmony = createHarmony(seed * 7919);
      const spec = designConstellation(harmony.ratios, harmony.rand);
      expect(spec.pitches).toHaveLength(5);
      expect(spec.members).toHaveLength(3);
      expect(spec.outsiders).toHaveLength(2);
      expect([...spec.members, ...spec.outsiders].sort()).toEqual([0, 1, 2, 3, 4]);
      for (const m of spec.members) {
        expect(spec.degrees[m]).toBeGreaterThanOrEqual(0);
        expect(spec.pitches[m]).toBeCloseTo(harmony.ratios[spec.degrees[m]], 12);
      }
      for (const o of spec.outsiders) expect(spec.degrees[o]).toBe(-1);
      // members ascend in pitch
      expect(spec.pitches[spec.members[0]]).toBeLessThan(spec.pitches[spec.members[1]]);
      expect(spec.pitches[spec.members[1]]).toBeLessThan(spec.pitches[spec.members[2]]);

      const rel = relate(spec.pitches);
      expect(rel.bondCount, harmony.modeName).toBe(3);
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          if (i === j) continue;
          const both = spec.members.includes(i) && spec.members.includes(j);
          expect(rel.bonded[i * 5 + j], `${harmony.modeName} ${i}-${j}`).toBe(both);
        }
      }
    }
  });

  it('is reproducible for a seed and varies between seeds', () => {
    const one = designConstellation(MODES.lydian, mulberry32(11));
    const two = designConstellation(MODES.lydian, mulberry32(11));
    expect(one).toEqual(two);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) seen.add(JSON.stringify(designConstellation(MODES.lydian, mulberry32(seed)).pitches));
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe('geometric relation', () => {
  it('ideal sides follow harmonic distance, average TARGET_SCALE and close into a triangle', () => {
    for (const [name, scale] of Object.entries(MODES)) {
      const spec = designConstellation(scale, mulberry32(3));
      const rel = relate(spec.pitches);
      const [a, b, c] = spec.members;
      const ab = rel.ideal[a * 5 + b];
      const ac = rel.ideal[a * 5 + c];
      const bc = rel.ideal[b * 5 + c];
      expect((ab + ac + bc) / 3, name).toBeCloseTo(TARGET_SCALE, 10);
      // strict triangle inequality with room to spare
      const sides = [ab, ac, bc].sort((x, y) => x - y);
      expect(sides[0] + sides[1], name).toBeGreaterThan(sides[2] * 1.2);
      // proportional to Tenney height
      const hab = tenneyHeight(spec.pitches[a], spec.pitches[b]);
      const hac = tenneyHeight(spec.pitches[a], spec.pitches[c]);
      expect(ab / ac, name).toBeCloseTo(hab / hac, 10);
      // symmetric table, nothing for unbonded pairs
      expect(rel.ideal[b * 5 + a]).toBe(ab);
      for (const o of spec.outsiders) for (let j = 0; j < 5; j++) expect(rel.ideal[o * 5 + j]).toBe(0);
    }
  });

  it('4:5:6 → the fifth is the short side', () => {
    const rel = relate([1, 5 / 4, 3 / 2]);
    expect(rel.bondCount).toBe(3);
    expect(rel.ideal[0 * 3 + 2]).toBeLessThan(rel.ideal[0 * 3 + 1]);
    expect(rel.ideal[0 * 3 + 1]).toBeLessThan(rel.ideal[1 * 3 + 2]);
  });

  it('respects a custom target scale', () => {
    const a = relate([1, 5 / 4, 3 / 2], 1);
    const b = relate([1, 5 / 4, 3 / 2], 3);
    expect(b.ideal[1] / a.ideal[1]).toBeCloseTo(3, 10);
  });
});

describe('evaluate', () => {
  const spec = designConstellation(MODES.harmonic, mulberry32(5));
  const rel = relate(spec.pitches);

  it('reports every pair with compat and distance error', () => {
    const e = evaluate(arrange(spec, idealTriangle(rel, spec.members)), rel);
    expect(e.pairs).toHaveLength(10);
    let bonded = 0;
    for (const p of e.pairs) {
      expect(p.i).toBeLessThan(p.j);
      expect(p.compat).toBeCloseTo(compatibility(spec.pitches[p.i], spec.pitches[p.j]), 12);
      if (p.bonded) {
        bonded++;
        expect(Math.abs(p.distError)).toBeLessThan(1e-9);
        expect(p.closeness).toBeCloseTo(1, 9);
        expect(p.fit).toBe(1);
      } else {
        expect(p.closeness).toBe(0);
        expect(p.distError).toBeLessThanOrEqual(0);
      }
    }
    expect(bonded).toBe(3);
    expect(e.solved).toBe(true);
    expect(e.progress).toBe(1);
  });

  it('accepts raw pitches as well as precomputed relations', () => {
    const positions = arrange(spec, idealTriangle(rel, spec.members));
    expect(evaluate(positions, spec.pitches).solved).toBe(true);
  });

  it('is solved in any orientation, plane, position and handedness', () => {
    const rand = mulberry32(99);
    for (let n = 0; n < 60; n++) {
      const axis = v(rand() - 0.5, rand() - 0.5, rand() - 0.5 + 1e-3);
      const angle = rand() * Math.PI * 2;
      const offset = v((rand() - 0.5) * 8, (rand() - 0.5) * 8, (rand() - 0.5) * 8);
      const mirror = rand() < 0.5 ? -1 : 1;
      const tri = idealTriangle(rel, spec.members).map((p) => transform(v(p.x, p.y * mirror, p.z), axis, angle, offset));
      expect(evaluate(arrange(spec, tri), rel).solved).toBe(true);
    }
  });

  it('forgives 18 % on every side and no more', () => {
    expect(evaluate(arrange(spec, idealTriangle(rel, spec.members, 1 + LENGTH_TOLERANCE - 0.01)), rel).solved).toBe(true);
    expect(evaluate(arrange(spec, idealTriangle(rel, spec.members, 1 - LENGTH_TOLERANCE + 0.01)), rel).solved).toBe(true);
    const over = evaluate(arrange(spec, idealTriangle(rel, spec.members, 1 + LENGTH_TOLERANCE + 0.02)), rel);
    expect(over.solved).toBe(false);
    expect(over.progress).toBeLessThan(1);
    expect(over.progress).toBeGreaterThan(0.9);
    expect(evaluate(arrange(spec, idealTriangle(rel, spec.members, 1 - LENGTH_TOLERANCE - 0.02)), rel).solved).toBe(false);
  });

  it('one wrong side is enough to stay unsolved', () => {
    const tri = idealTriangle(rel, spec.members);
    tri[2] = v(tri[2].x + 1.1, tri[2].y + 0.9, 0.4);
    const e = evaluate(arrange(spec, tri), rel);
    expect(e.solved).toBe(false);
    expect(e.progress).toBeLessThan(1);
    expect(e.progress).toBeGreaterThan(0.3);
  });

  it('the outsiders never matter', () => {
    const positions = arrange(spec, idealTriangle(rel, spec.members));
    positions[spec.outsiders[0]] = v(0.3, 0.2, 0);
    positions[spec.outsiders[1]] = v(0.31, 0.2, 0.05);
    const e = evaluate(positions, rel);
    expect(e.solved).toBe(true);
    const intruding = e.pairs.filter((p) => !p.bonded && p.distError < 0);
    expect(intruding.length).toBeGreaterThan(0);
    // three outsiders-as-members never solve it
    const wrong: Vec3[] = [];
    const tri = idealTriangle(rel, spec.members);
    wrong[spec.outsiders[0]] = tri[0];
    wrong[spec.outsiders[1]] = tri[1];
    wrong[spec.members[0]] = tri[2];
    wrong[spec.members[1]] = v(30, 30, 0);
    wrong[spec.members[2]] = v(-30, 30, 0);
    expect(evaluate(wrong, rel).solved).toBe(false);
  });

  it('progress rises monotonically as the figure closes in', () => {
    const tri = idealTriangle(rel, spec.members);
    const cx = (tri[0].x + tri[1].x + tri[2].x) / 3;
    const cy = (tri[0].y + tri[1].y + tri[2].y) / 3;
    let last = -1;
    for (let s = 2.6; s >= 1; s -= 0.1) {
      const scaled = tri.map((p) => v(cx + (p.x - cx) * s, cy + (p.y - cy) * s, 0));
      const e = evaluate(arrange(spec, scaled), rel);
      expect(e.progress).toBeGreaterThanOrEqual(last);
      expect(e.progress).toBeGreaterThanOrEqual(0);
      expect(e.progress).toBeLessThanOrEqual(1);
      expect(e.progress === 1).toBe(e.solved);
      last = e.progress;
    }
    expect(last).toBe(1);
    // far apart → nothing
    const far = tri.map((p) => v(p.x * 9, p.y * 9, 0));
    expect(evaluate(arrange(spec, far), rel).progress).toBe(0);
    // collapsed onto one point → nothing
    expect(evaluate(arrange(spec, [v(0, 0, 0), v(0, 0, 0), v(0, 0, 0)]), rel).progress).toBe(0);
  });

  it('closeness is 1 at the ideal and 0 at the capture edge', () => {
    const [a, b] = spec.members;
    const ideal = rel.ideal[a * 5 + b];
    const at = (d: number) => {
      const positions = arrange(spec, [v(0, 0, 0), v(d, 0, 0), v(0, 60, 0)]);
      return evaluate(positions, rel).pairs.find((p) => p.i === Math.min(a, b) && p.j === Math.max(a, b))!;
    };
    expect(at(ideal).closeness).toBeCloseTo(1, 9);
    expect(at(ideal * (1 + CAPTURE)).closeness).toBeCloseTo(0, 9);
    expect(at(ideal * (1 + CAPTURE * 0.5)).closeness).toBeCloseTo(0.5, 9);
    expect(at(ideal * 3).closeness).toBe(0);
    expect(at(ideal * 1.3).distError).toBeCloseTo(0.3, 9);
    expect(at(ideal * 0.7).distError).toBeCloseTo(-0.3, 9);
  });

  it('reuses the output object without allocating new pairs', () => {
    const out = createEvaluation(5);
    const pairs = out.pairs;
    const first = pairs[0];
    const e = evaluate(arrange(spec, idealTriangle(rel, spec.members)), rel, out);
    expect(e).toBe(out);
    expect(e.pairs).toBe(pairs);
    expect(e.pairs[0]).toBe(first);
  });
});

describe('magnetStep', () => {
  const spec = designConstellation(MODES.dorian, mulberry32(21));
  const rel = relate(spec.pitches);
  const [a, b, c] = spec.members;
  const [o] = spec.outsiders;
  const far = (): Vec3[] => [v(50, 0, 0), v(0, 50, 0), v(0, 0, 50), v(-50, 0, 0), v(0, -50, 0)];

  it('draws a captured bonded fragment toward the ideal distance', () => {
    const ideal = rel.ideal[a * 5 + b];
    const positions = far();
    positions[b] = v(0, 0, 0);
    const desired = v(ideal * 1.25, 0, 0);
    const out = magnetStep(a, desired, positions, rel, 0.5, v(0, 0, 0));
    expect(out.x).toBeLessThan(desired.x);
    expect(out.x).toBeGreaterThan(ideal);
    expect(out.y).toBeCloseTo(0, 12);
    // desired is untouched when an out vector is given
    expect(desired.x).toBeCloseTo(ideal * 1.25, 12);
  });

  it('pushes apart a bonded pair that is too close', () => {
    const ideal = rel.ideal[a * 5 + b];
    const positions = far();
    positions[b] = v(1, 1, 1);
    const out = magnetStep(a, v(1 + ideal * 0.4, 1, 1), positions, rel, 1, v(0, 0, 0));
    expect(dist(out, positions[b])).toBeCloseTo(ideal, 9);
  });

  it('leaves a fragment alone outside the capture radius', () => {
    const ideal = rel.ideal[a * 5 + b];
    const positions = far();
    positions[b] = v(0, 0, 0);
    const desired = v(0, ideal * (1 + CAPTURE) + 0.01, 0);
    const out = magnetStep(a, desired, positions, rel, 1, v(9, 9, 9));
    expect(out).toEqual(desired);
  });

  it('has no jump at the capture edge', () => {
    const ideal = rel.ideal[a * 5 + b];
    const positions = far();
    positions[b] = v(0, 0, 0);
    const just = v(ideal * (1 + CAPTURE) - 1e-4, 0, 0);
    const out = magnetStep(a, just, positions, rel, 1, v(0, 0, 0));
    expect(Math.abs(out.x - just.x)).toBeLessThan(1e-6);
  });

  it('repels an unbonded fragment so a wrong connection never sticks', () => {
    const positions = far();
    positions[a] = v(0, 0, 0);
    const desired = v(REPEL_RADIUS * 0.4, 0, 0);
    const out = magnetStep(o, desired, positions, rel, 1, v(0, 0, 0));
    expect(out.x).toBeGreaterThan(desired.x);
    expect(out.x).toBeLessThanOrEqual(REPEL_RADIUS + 1e-9);
    // and is indifferent beyond the repel radius
    const clear = v(REPEL_RADIUS + 0.05, 0, 0);
    expect(magnetStep(o, clear, positions, rel, 1, v(0, 0, 0))).toEqual(clear);
    // members feel the same push from an outsider
    positions[o] = v(0, 0, 0);
    positions[a] = v(50, 0, 0);
    const pushed = magnetStep(a, v(0, 0.3, 0), positions, rel, 1, v(0, 0, 0));
    expect(pushed.y).toBeGreaterThan(0.3);
  });

  it('mutates desired in place by default and does nothing at strength 0', () => {
    const ideal = rel.ideal[a * 5 + b];
    const positions = far();
    positions[b] = v(0, 0, 0);
    const still = v(ideal * 1.2, 0, 0);
    magnetStep(a, still, positions, rel, 0);
    expect(still.x).toBeCloseTo(ideal * 1.2, 12);
    const moved = v(ideal * 1.2, 0, 0);
    const ret = magnetStep(a, moved, positions, rel, 1);
    expect(ret).toBe(moved);
    expect(moved.x).toBeLessThan(ideal * 1.2);
    expect(moved.x).toBeGreaterThanOrEqual(ideal);
  });

  it('separates coincident fragments in opposite directions', () => {
    const positions = far();
    positions[a] = v(2, 2, 2);
    positions[b] = v(2, 2, 2);
    const pa = magnetStep(a, v(2, 2, 2), positions, rel, 1, v(0, 0, 0));
    const pb = magnetStep(b, v(2, 2, 2), positions, rel, 1, v(0, 0, 0));
    expect(Number.isFinite(pa.x) && Number.isFinite(pb.x)).toBe(true);
    expect(dist(pa, pb)).toBeGreaterThan(0.5);
  });

  it('relaxes a roughly gathered triad into the solved figure', () => {
    const rand = mulberry32(4);
    for (let trial = 0; trial < 40; trial++) {
      const tri = idealTriangle(rel, spec.members).map((p) => v(p.x + (rand() - 0.5) * 0.5, p.y + (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5));
      const positions = arrange(spec, tri);
      const tmp = v(0, 0, 0);
      for (let step = 0; step < 240; step++) {
        for (const m of [a, b, c]) {
          magnetStep(m, positions[m], positions, rel, 1, tmp);
          const p = positions[m];
          positions[m] = v(p.x + (tmp.x - p.x) * 0.05, p.y + (tmp.y - p.y) * 0.05, p.z + (tmp.z - p.z) * 0.05);
        }
      }
      const e = evaluate(positions, rel);
      expect(e.solved, `trial ${trial}`).toBe(true);
      for (const p of e.pairs) if (p.bonded) expect(Math.abs(p.distError)).toBeLessThan(0.05);
    }
  });

  it('an outsider dropped into a solved figure is expelled without breaking it', () => {
    const tri = idealTriangle(rel, spec.members);
    const positions = arrange(spec, tri);
    positions[o] = v((tri[0].x + tri[1].x + tri[2].x) / 3, (tri[0].y + tri[1].y + tri[2].y) / 3 + 0.02, 0.05);
    const tmp = v(0, 0, 0);
    for (let step = 0; step < 400; step++) {
      for (let i = 0; i < 5; i++) {
        magnetStep(i, positions[i], positions, rel, 1, tmp);
        const p = positions[i];
        positions[i] = v(p.x + (tmp.x - p.x) * 0.05, p.y + (tmp.y - p.y) * 0.05, p.z + (tmp.z - p.z) * 0.05);
      }
    }
    expect(evaluate(positions, rel).solved).toBe(true);
    for (const m of spec.members) expect(dist(positions[o], positions[m])).toBeGreaterThan(REPEL_RADIUS * 0.6);
  });
});

describe('solveArrangement', () => {
  it('returns a solved figure that keeps the centroid, for every mode', () => {
    const rand = mulberry32(8);
    for (const scale of Object.values(MODES)) {
      const spec = designConstellation(scale, rand);
      const rel = relate(spec.pitches);
      for (let trial = 0; trial < 25; trial++) {
        const positions: Vec3[] = [];
        for (let i = 0; i < 5; i++) positions.push(v((rand() - 0.5) * 6, (rand() - 0.5) * 4, (rand() - 0.5) * 2));
        const targets = solveArrangement(positions, rel, spec.members);
        const solved = positions.slice();
        spec.members.forEach((m, k) => (solved[m] = targets[k]));
        const e = evaluate(solved, rel);
        expect(e.solved).toBe(true);
        for (const p of e.pairs) if (p.bonded) expect(Math.abs(p.distError)).toBeLessThan(1e-9);
        for (const axis of ['x', 'y', 'z'] as const) {
          const before = spec.members.reduce((s, m) => s + positions[m][axis], 0) / 3;
          const after = targets.reduce((s, t) => s + t[axis], 0) / 3;
          expect(after).toBeCloseTo(before, 9);
        }
      }
    }
  });

  it('does not move an arrangement that is already exact, in either handedness', () => {
    const spec = designConstellation(MODES.mixolydian, mulberry32(2));
    const rel = relate(spec.pitches);
    for (const mirror of [1, -1]) {
      const tri = idealTriangle(rel, spec.members).map((p) => transform(v(p.x, p.y * mirror, 0), v(0.3, 1, 0.2), 1.1, v(0.4, -0.2, 0.3)));
      const targets = solveArrangement(arrange(spec, tri), rel, spec.members);
      targets.forEach((t, k) => expect(dist(t, tri[k])).toBeLessThan(1e-9));
    }
  });

  it('moves less than a naive placement would', () => {
    const spec = designConstellation(MODES.lydian, mulberry32(2));
    const rel = relate(spec.pitches);
    const tri = idealTriangle(rel, spec.members).map((p) => transform(v(p.x * 1.6, p.y * 1.5, 0), v(0, 0, 1), 2.4, v(1, 1, 0)));
    const targets = solveArrangement(arrange(spec, tri), rel, spec.members);
    const moved = targets.reduce((s, t, k) => s + dist(t, tri[k]), 0);
    expect(moved).toBeLessThan(TARGET_SCALE * 1.6);
  });

  it('survives collinear and coincident input, and writes into the given array', () => {
    const spec = designConstellation(MODES.aeolian, mulberry32(2));
    const rel = relate(spec.pitches);
    const out = [v(0, 0, 0), v(0, 0, 0), v(0, 0, 0)];
    for (const tri of [
      [v(0, 0, 0), v(1, 0, 0), v(2, 0, 0)],
      [v(0, 0, 0), v(0, 1, 0), v(0, 3, 0)],
      [v(1, 1, 1), v(1, 1, 1), v(1, 1, 1)],
      [v(1, 1, 1), v(1, 1, 1), v(2, 1, 1)],
    ]) {
      const positions = arrange(spec, tri);
      const targets = solveArrangement(positions, rel, spec.members, out);
      expect(targets).toBe(out);
      for (const t of targets) expect(Number.isFinite(t.x + t.y + t.z)).toBe(true);
      const solved = positions.slice();
      spec.members.forEach((m, k) => (solved[m] = { ...targets[k] }));
      expect(evaluate(solved, rel).solved).toBe(true);
    }
  });
});

describe('scatter', () => {
  // Landscape, portrait, ultra-wide, phone, and the boxes Chapter III derives at 16:9, 1:1 and 9:19.5.
  const boxes: Vec3[] = [v(2.65, 1.85, 1.1), v(1.5, 2.6, 0.9), v(3.2, 1.7, 1.1), v(1.3, 2.2, 0.8), v(2.0, 1.54, 1.1), v(1.95, 1.75, 0.85), v(1.28, 2.2, 0.8)];

  it('starts inside the volume, unsolved, with every bond out of capture', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const harmony = createHarmony(seed * 104729);
      const spec = designConstellation(harmony.ratios, harmony.rand);
      const rel = relate(spec.pitches);
      for (const half of boxes) {
        const positions = scatter(rel, half, harmony.rand);
        expect(positions).toHaveLength(5);
        for (const p of positions) {
          expect(Math.abs(p.x)).toBeLessThanOrEqual(half.x + 1e-9);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(half.y + 1e-9);
          expect(Math.abs(p.z)).toBeLessThanOrEqual(half.z + 1e-9);
        }
        const e = evaluate(positions, rel);
        expect(e.solved).toBe(false);
        expect(e.progress).toBeLessThan(0.75);
        for (const pair of e.pairs) {
          if (pair.bonded) expect(pair.closeness, `${harmony.modeName} seed ${seed}`).toBe(0);
          expect(pair.distance).toBeGreaterThan(0.6);
        }
      }
    }
  });

  it('the fixed fallback layout is valid too', () => {
    // A generator stuck at the centre defeats rejection sampling and forces the fallback.
    for (const [name, scale] of Object.entries(MODES)) {
      for (let seed = 1; seed <= 12; seed++) {
        const spec = designConstellation(scale, mulberry32(seed));
        const rel = relate(spec.pitches);
        for (const half of boxes) {
          const positions = scatter(rel, half, () => 0.5);
          const e = evaluate(positions, rel);
          expect(e.solved).toBe(false);
          for (const pair of e.pairs) {
            if (pair.bonded) expect(pair.closeness, `${name} ${seed}`).toBe(0);
            expect(pair.distance, `${name} ${seed}`).toBeGreaterThan(0.9);
          }
          for (const p of positions) {
            expect(Math.abs(p.x)).toBeLessThanOrEqual(half.x);
            expect(Math.abs(p.y)).toBeLessThanOrEqual(half.y);
          }
        }
      }
    }
  });

  it('is reproducible for a seed', () => {
    const spec = designConstellation(MODES.dorian, mulberry32(1));
    const rel = relate(spec.pitches);
    expect(scatter(rel, boxes[0], mulberry32(77))).toEqual(scatter(rel, boxes[0], mulberry32(77)));
  });
});
