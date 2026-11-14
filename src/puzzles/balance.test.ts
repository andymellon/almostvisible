import { describe, expect, it } from 'vitest';
import type { FieldMix } from '../core/contracts';
import { mulberry32 } from '../core/math';
import {
  AIR,
  BOUNDS,
  EARTH,
  LIGHT,
  PAIRS,
  REACH,
  TUNING,
  audibility,
  balance,
  canonicalArrangement,
  clampToBounds,
  composeArrangement,
  createBalanceState,
  createPose,
  crowdedStart,
  evaluateBalance,
  isSolved,
  levelBand,
  masking,
  mixFromPose,
  openRegion,
  pairMasking,
  poseFromMix,
  solveArrangement,
  stepHold,
  type FieldPose,
} from './balance';

const P = (x: number, y: number, z: number, rotation = 0): FieldPose => createPose(x, y, z, rotation);
const three = (): FieldPose[] => [createPose(), createPose(), createPose()];
const score = (poses: FieldPose[]): number =>
  balance(
    poses.map((p) => mixFromPose(p)),
    poses,
  );
const dist = (a: FieldPose, b: FieldPose) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const inBounds = (p: FieldPose, xLimit: number = BOUNDS.xMax) =>
  Math.abs(p.x) <= xLimit + 1e-9 && p.y >= BOUNDS.yMin - 1e-9 && p.y <= BOUNDS.yMax + 1e-9 && p.z >= BOUNDS.zMin - 1e-9 && p.z <= BOUNDS.zMax + 1e-9;

describe('pose → mix mapping', () => {
  it('proximity drives level', () => {
    const near = mixFromPose(P(0.5, 0, 0));
    const mid = mixFromPose(P(1.5, 0, 0));
    const far = mixFromPose(P(2.4, 1.6, -2.4));
    expect(near.level).toBeGreaterThan(mid.level);
    expect(mid.level).toBeGreaterThan(far.level);
    expect(mixFromPose(P(0, 0, 0)).level).toBe(1);
    expect(mixFromPose(P(REACH + 1, 0, 0)).level).toBe(0);
  });

  it('height drives brightness, depth drives diffusion, independently of x', () => {
    expect(mixFromPose(P(0, BOUNDS.yMin, 0)).brightness).toBe(0);
    expect(mixFromPose(P(0, BOUNDS.yMax, 0)).brightness).toBe(1);
    expect(mixFromPose(P(1, 0, 0)).brightness).toBeCloseTo(0.5, 6);
    expect(mixFromPose(P(0, 0, BOUNDS.zMax)).diffusion).toBe(0);
    expect(mixFromPose(P(0, 0, BOUNDS.zMin)).diffusion).toBe(1);
    expect(mixFromPose(P(-2, 0.4, -1)).brightness).toBeCloseTo(mixFromPose(P(2, 0.4, 1)).brightness, 9);
    expect(mixFromPose(P(-2, 0.4, -1)).diffusion).toBeGreaterThan(mixFromPose(P(-2, 0.4, 1)).diffusion);
  });

  it('rotation drives modulation: 0 at rest, 1 at half a turn, periodic and even', () => {
    expect(mixFromPose(P(1, 0, 0, 0)).modulation).toBeCloseTo(0, 9);
    expect(mixFromPose(P(1, 0, 0, Math.PI)).modulation).toBeCloseTo(1, 9);
    expect(mixFromPose(P(1, 0, 0, Math.PI / 2)).modulation).toBeCloseTo(0.5, 9);
    expect(mixFromPose(P(1, 0, 0, 0.7)).modulation).toBeCloseTo(mixFromPose(P(1, 0, 0, -0.7)).modulation, 9);
    expect(mixFromPose(P(1, 0, 0, 0.7 + Math.PI * 2)).modulation).toBeCloseTo(mixFromPose(P(1, 0, 0, 0.7)).modulation, 9);
  });

  it('always yields values in 0..1 and writes into the given object', () => {
    const out: FieldMix = { level: 9, brightness: 9, diffusion: 9, modulation: 9 };
    const same = mixFromPose(P(40, -30, 20, 123), out);
    expect(same).toBe(out);
    for (const v of Object.values(out)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('poseFromMix inverts mixFromPose (up to the side of x)', () => {
    for (const p of [P(-0.95, -1.15, 0.85, 0.4), P(0.25, 0.15, -1.95, 2.1), P(1.05, 1.2, 0.15, 0)]) {
      const mix = mixFromPose(p);
      const back = poseFromMix(mix, Math.sign(p.x) || 1);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
      expect(back.z).toBeCloseTo(p.z, 6);
      expect(mixFromPose(back).modulation).toBeCloseTo(mix.modulation, 6);
    }
    // An impossible mix (very loud yet very high) still lands inside the box.
    const odd = poseFromMix({ level: 1, brightness: 1, diffusion: 1, modulation: 0.3 }, -1);
    expect(inBounds(odd)).toBe(true);
    expect(Number.isFinite(odd.x + odd.y + odd.z + odd.rotation)).toBe(true);
  });

  it('clampToBounds keeps positions inside the volume, honouring a narrower portrait limit', () => {
    const p = clampToBounds({ x: 9, y: -9, z: 9 });
    expect(p).toEqual({ x: BOUNDS.xMax, y: BOUNDS.yMin, z: BOUNDS.zMax });
    expect(clampToBounds({ x: -9, y: 9, z: -9 }, 1.2, 1.0)).toEqual({ x: -1.2, y: 1.0, z: BOUNDS.zMin });
  });
});

describe('pair masking', () => {
  const m = (level: number, brightness: number): FieldMix => ({ level, brightness, diffusion: 0.5, modulation: 0 });
  const here = { x: 0, y: 0, z: 0 };

  it('is total when two fields share place, register and level', () => {
    expect(pairMasking(m(0.6, 0.5), here, m(0.6, 0.5), here)).toBe(1);
  });

  it('vanishes when the pair is separated in any ONE of space, register or level', () => {
    expect(pairMasking(m(0.6, 0.5), here, m(0.6, 0.5), { x: TUNING.spatialFar, y: 0, z: 0 })).toBe(0);
    expect(pairMasking(m(0.6, 0.5), here, m(0.6, 0.5 + TUNING.spectralFar), here)).toBe(0);
    expect(pairMasking(m(0.3, 0.5), here, m(0.3 + TUNING.levelFar, 0.5), here)).toBe(0);
  });

  it('partial separations multiply', () => {
    const half = { x: (TUNING.spatialNear + TUNING.spatialFar) / 2, y: 0, z: 0 };
    const spatialOnly = pairMasking(m(0.6, 0.5), here, m(0.6, 0.5), half);
    const both = pairMasking(m(0.6, 0.5), here, m(0.6, 0.5 + (TUNING.spectralNear + TUNING.spectralFar) / 2), half);
    expect(spatialOnly).toBeCloseTo(0.5, 6);
    expect(both).toBeCloseTo(0.25, 6);
  });

  it('is symmetric and uses depth as well as the picture plane', () => {
    const a = m(0.7, 0.4);
    const b = m(0.55, 0.55);
    const pa = { x: 0.2, y: 0.1, z: 0.3 };
    const pb = { x: 0.9, y: -0.4, z: -0.5 };
    expect(pairMasking(a, pa, b, pb)).toBeCloseTo(pairMasking(b, pb, a, pa), 12);
    expect(pairMasking(m(0.6, 0.5), here, m(0.6, 0.5), { x: 0, y: 0, z: -TUNING.spatialFar })).toBe(0);
  });
});

describe('audibility', () => {
  const m = (level: number): FieldMix => ({ level, brightness: 0.5, diffusion: 0.5, modulation: 0 });

  it('is 1 across the comfortable band', () => {
    expect(levelBand(0.3)).toBe(1);
    expect(levelBand(0.6)).toBe(1);
    expect(levelBand(0.9)).toBe(1);
    expect(audibility([m(0.5), m(0.6), m(0.7)])).toBe(1);
  });

  it('is 0 when a field is silenced or sits on top of the listener', () => {
    expect(audibility([m(0.6), m(0.1), m(0.6)])).toBe(0);
    expect(audibility([m(0.6), m(0.6), m(1)])).toBe(0);
  });

  it('falls when one field dominates the others', () => {
    // Each level is inside the band on its own; it is the spread between them that costs.
    expect(audibility([m(0.3), m(0.3), m(0.9)])).toBeLessThan(0.7);
    expect(audibility([m(0.32), m(0.34), m(0.9)])).toBeLessThan(audibility([m(0.4), m(0.4), m(0.9)]));
    expect(audibility([m(0.5), m(0.5), m(0.9)])).toBe(1);
  });
});

describe('the crowded opening fails', () => {
  it('for every seed tried: low balance, not solved, inside the bounds', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const poses = crowdedStart(mulberry32(seed * 7919), three());
      const s = evaluateBalance(poses);
      expect(s.balance).toBeLessThan(0.2);
      expect(s.masking).toBeGreaterThan(0.75);
      for (const p of poses) expect(inBounds(p)).toBe(true);
      // Each body is audible — the problem is masking, not silence.
      for (const mix of s.mixes) expect(mix.level).toBeGreaterThan(0.8);
    }
  });

  it('differs per visit', () => {
    const a = crowdedStart(mulberry32(11), three());
    const b = crowdedStart(mulberry32(12), three());
    expect(dist(a[0], b[0]) + dist(a[1], b[1]) + dist(a[2], b[2])).toBeGreaterThan(0.2);
  });

  it('all three exactly on the listener is the worst case, and finite', () => {
    const s = evaluateBalance([P(0, 0, 0), P(0, 0, 0), P(0, 0, 0)]);
    expect(s.balance).toBe(0);
    expect(s.masking).toBe(1);
    expect(Number.isFinite(s.audibility)).toBe(true);
  });
});

describe('many distinct arrangements solve it', () => {
  // [earth, air, light]
  const solutions: Record<string, FieldPose[]> = {
    'intended: earth low and near, air deep behind, light high': [P(-0.95, -1.15, 0.85), P(0.25, 0.15, -1.95), P(1.05, 1.2, 0.15)],
    'the same, mirrored': [P(0.95, -1.15, 0.85), P(-0.25, 0.15, -1.95), P(-1.05, 1.2, 0.15)],
    'register only: a vertical column': [P(0.1, -1.4, 0.4), P(-0.2, 0, -0.6), P(0.2, 1.4, 0.3)],
    'region only: spread wide at one height': [P(-2.1, 0, 0.4), P(0, 0.1, -2.0), P(2.1, 0, 0.4)],
    'roles reversed: light low, earth high': [P(1.0, 1.2, 0.2), P(-0.3, 0, -1.9), P(-1.0, -1.2, 0.8)],
    'a flat triangle in the picture plane': [P(-1.9, -1.0, 0), P(1.9, -1.0, 0), P(0, 1.35, 0)],
    'staggered in depth, slightly rotated': [P(-1.2, -0.6, 1.2, 0.8), P(1.3, 0.2, -2.2, -1.4), P(-0.2, 1.3, -0.4, 3)],
    'narrow (portrait) frame': [P(-0.8, -1.3, 0.8), P(0.2, 0.1, -2.0), P(0.9, 1.3, 0.2)],
  };

  for (const [name, poses] of Object.entries(solutions)) {
    it(name, () => {
      for (const p of poses) expect(inBounds(p)).toBe(true);
      const s = evaluateBalance(poses);
      expect(s.audibility).toBeGreaterThan(0.95);
      expect(s.balance).toBeGreaterThanOrEqual(TUNING.solved);
      expect(score(poses)).toBeCloseTo(s.balance, 12);
    });
  }

  it('the solutions really are different from one another', () => {
    const list = Object.values(solutions);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const travel = dist(list[a][0], list[b][0]) + dist(list[a][1], list[b][1]) + dist(list[a][2], list[b][2]);
        expect(travel).toBeGreaterThan(0.25);
      }
    }
  });

  it('rotation never decides the puzzle', () => {
    const poses = solutions['register only: a vertical column'].map((p) => ({ ...p }));
    const before = score(poses);
    poses[0].rotation = 2.2;
    poses[2].rotation = -5;
    expect(score(poses)).toBeCloseTo(before, 12);
  });
});

describe('arrangements that do not solve it', () => {
  it('two fields left together while the third is moved away', () => {
    const s = evaluateBalance([P(-0.3, 0, 0.2), P(0.3, 0.1, 0.1), P(1.8, 1.3, -1)]);
    expect(s.pairs[0]).toBeGreaterThan(0.9);
    expect(s.balance).toBeLessThan(0.5);
    expect([EARTH, AIR]).toContain(s.mostMasked);
  });

  it('a field pushed out of earshot', () => {
    const poses = [P(-0.95, -1.15, 0.85), P(2.4, 1.6, -2.4), P(1.05, 1.2, 0.15)];
    const s = evaluateBalance(poses);
    expect(s.masking).toBeLessThan(0.1);
    expect(s.balance).toBeLessThan(0.1);
    expect(s.mostMasked).toBe(AIR);
  });

  it('a field parked on the listener', () => {
    const s = evaluateBalance([P(-0.95, -1.15, 0.85), P(0.25, 0.15, -1.95), P(0, 0, 0)]);
    expect(s.balance).toBe(0);
    expect(s.mostMasked).toBe(LIGHT);
  });
});

describe('feedback is continuous', () => {
  it('balance rises smoothly, without jumps, as the crowd opens into the intended arrangement', () => {
    const start = crowdedStart(mulberry32(5), three());
    const end = canonicalArrangement(1, three());
    const poses = three();
    let prev = -1;
    let rises = 0;
    for (let step = 0; step <= 200; step++) {
      const t = step / 200;
      for (let i = 0; i < 3; i++) {
        poses[i].x = start[i].x + (end[i].x - start[i].x) * t;
        poses[i].y = start[i].y + (end[i].y - start[i].y) * t;
        poses[i].z = start[i].z + (end[i].z - start[i].z) * t;
      }
      const b = score(poses);
      if (prev >= 0) {
        expect(Math.abs(b - prev)).toBeLessThan(0.06);
        if (b > prev + 1e-6) rises++;
      }
      prev = b;
    }
    expect(prev).toBeGreaterThan(0.95);
    expect(rises).toBeGreaterThan(40);
  });

  it('masking and balance agree with the per-frame evaluation', () => {
    const poses = [P(-0.6, -0.4, 0.5), P(0.5, 0.3, -0.9), P(0.9, 0.9, 0.2)];
    const mixes = poses.map((p) => mixFromPose(p));
    const s = evaluateBalance(poses, createBalanceState());
    expect(masking(mixes, poses)).toBeCloseTo(s.masking, 12);
    expect(balance(mixes, poses)).toBeCloseTo(s.balance, 12);
    PAIRS.forEach(([i, j], k) => expect(pairMasking(mixes[i], poses[i], mixes[j], poses[j])).toBeCloseTo(s.pairs[k], 12));
  });
});

describe('hold', () => {
  it('solves after the balance has been held for two seconds', () => {
    let held = 0;
    for (let i = 0; i < 119; i++) held = stepHold(held, 0.9, 1 / 60);
    expect(isSolved(held)).toBe(false);
    for (let i = 0; i < 2; i++) held = stepHold(held, 0.9, 1 / 60);
    expect(isSolved(held)).toBe(true);
  });

  it('pauses through a small wobble and drains after a real loss of balance', () => {
    let held = 1.2;
    held = stepHold(held, TUNING.solved - 0.03, 0.5);
    expect(held).toBeCloseTo(1.2, 9);
    held = stepHold(held, 0.4, 0.25);
    expect(held).toBeCloseTo(0.7, 9);
    held = stepHold(held, 0.1, 5);
    expect(held).toBe(0);
  });

  it('never solves the crowded opening however long it is left', () => {
    const s = evaluateBalance(crowdedStart(mulberry32(3), three()));
    let held = 0;
    for (let i = 0; i < 6000; i++) held = stepHold(held, s.balance, 1 / 60);
    expect(isSolved(held)).toBe(false);
  });
});

describe('assistance', () => {
  it('openRegion finds a place that improves the most masked field', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const poses = crowdedStart(mulberry32(seed * 131), three());
      const before = evaluateBalance(poses);
      const i = before.mostMasked;
      const spot = openRegion(i, poses, { x: 0, y: 0, z: 0 });
      const moved = poses.map((p) => ({ ...p }));
      moved[i] = { ...moved[i], ...spot };
      const after = evaluateBalance(moved);
      expect(inBounds(moved[i])).toBe(true);
      expect(after.perField[i]).toBeLessThan(before.perField[i] - 0.5);
      expect(after.balance).toBeGreaterThanOrEqual(before.balance);
    }
  });

  it('openRegion leans on character: with the others out of the way Earth goes low, Light high, Air deep', () => {
    const away = (): FieldPose[] => [P(-2.2, 0.1, 1.2), P(2.2, 0.1, 1.2), P(0, 0.1, 1.3)];
    const e = away();
    e[EARTH] = P(0, 0.2, -0.4);
    e[AIR] = P(2.2, 1.5, -2.2);
    e[LIGHT] = P(-2.2, 1.5, -2.2);
    expect(openRegion(EARTH, e, { x: 0, y: 0, z: 0 }).y).toBeLessThan(0);
    const l = away();
    l[LIGHT] = P(0, -0.2, -0.4);
    l[EARTH] = P(-2.2, -1.5, 1.2);
    l[AIR] = P(2.2, -1.5, -2.2);
    expect(openRegion(LIGHT, l, { x: 0, y: 0, z: 0 }).y).toBeGreaterThan(0);
    const a = away();
    a[AIR] = P(0, 0, 0.6);
    a[EARTH] = P(-2.0, -1.4, 1.2);
    a[LIGHT] = P(2.0, 1.4, 1.2);
    expect(openRegion(AIR, a, { x: 0, y: 0, z: 0 }).z).toBeLessThan(-0.5);
  });

  it('openRegion does not disturb its input and respects a narrow frame', () => {
    const poses = crowdedStart(mulberry32(77), three());
    const copy = poses.map((p) => ({ ...p }));
    const spot = openRegion(1, poses, { x: 0, y: 0, z: 0 }, 1.1);
    expect(poses).toEqual(copy);
    expect(Math.abs(spot.x)).toBeLessThanOrEqual(1.1);
  });

  it('solveArrangement balances any crowded opening, in wide and narrow frames, keeping rotations', () => {
    for (const xLimit of [BOUNDS.xMax, 1.6, 1.1]) {
      for (let seed = 1; seed <= 60; seed++) {
        const poses = crowdedStart(mulberry32(seed * 977), three());
        const solved = solveArrangement(poses, three(), xLimit);
        const s = evaluateBalance(solved);
        expect(s.balance).toBeGreaterThanOrEqual(0.9);
        for (let i = 0; i < 3; i++) {
          expect(inBounds(solved[i], xLimit)).toBe(true);
          expect(solved[i].rotation).toBe(poses[i].rotation);
        }
      }
    }
  });

  it('solveArrangement rescues awkward states too (one lost, two stacked) and leaves a solved state alone', () => {
    const awkward = solveArrangement([P(2.4, 1.6, -2.4), P(0, 0, 0), P(0.1, 0, 0)], three());
    expect(evaluateBalance(awkward).balance).toBeGreaterThanOrEqual(0.9);
    const good = canonicalArrangement(-1, three());
    const kept = solveArrangement(good, three());
    expect(kept).toEqual(good);
  });

  it('the canonical arrangement is balanced in both handednesses and in a narrow frame', () => {
    expect(evaluateBalance(canonicalArrangement(1, three())).balance).toBeGreaterThan(0.95);
    expect(evaluateBalance(canonicalArrangement(-1, three())).balance).toBeGreaterThan(0.95);
    const narrow = canonicalArrangement(1, three(), 0.9);
    expect(evaluateBalance(narrow).balance).toBeGreaterThan(TUNING.solved);
    for (const p of narrow) expect(Math.abs(p.x)).toBeLessThanOrEqual(0.9);
  });
});

describe('the composed sculpture', () => {
  const sources: FieldPose[][] = [
    [P(-0.95, -1.15, 0.85, 0.3), P(0.25, 0.15, -1.95, 1), P(1.05, 1.2, 0.15, -2)],
    [P(0.1, -1.4, 0.4), P(-0.2, 0, -0.6), P(0.2, 1.4, 0.3)],
    [P(-2.1, 0, 0.4), P(0, 0.1, -2.0), P(2.1, 0, 0.4)],
    [P(1.0, 1.2, 0.2), P(-0.3, 0, -1.9), P(-1.0, -1.2, 0.8)],
    [P(0, 0, 0), P(0, 0, 0), P(0, 0, 0)],
    [P(0.5, 0.5, 0), P(1.5, 1.5, 0), P(1.0, 1.0, 0)],
  ];

  it('keeps three distinct bodies, inside the bounds, drawn in around the centre', () => {
    for (const src of sources) {
      const out = composeArrangement(src, three());
      for (const [i, j] of PAIRS) expect(dist(out[i], out[j])).toBeGreaterThan(1.2);
      for (let i = 0; i < 3; i++) {
        expect(inBounds(out[i])).toBe(true);
        expect(Math.hypot(out[i].x, out[i].y, out[i].z)).toBeLessThan(2.6);
        expect(out[i].rotation).toBe(src[i].rotation);
      }
    }
  });

  it('is asymmetric and keeps the handedness of the visitor’s own solution', () => {
    const right = composeArrangement(sources[0], three());
    const left = composeArrangement(
      sources[0].map((p) => ({ ...p, x: -p.x })),
      three(),
    );
    expect(right[LIGHT].x).toBeGreaterThan(right[EARTH].x);
    expect(left[LIGHT].x).toBeLessThan(left[EARTH].x);
    const d = [dist(right[0], right[1]), dist(right[0], right[2]), dist(right[1], right[2])];
    expect(Math.max(...d) - Math.min(...d)).toBeGreaterThan(0.1);
  });

  it('differs with the solution it grew from, and can be computed in place', () => {
    const a = composeArrangement(sources[0], three());
    const b = composeArrangement(sources[1], three());
    expect(dist(a[0], b[0]) + dist(a[1], b[1]) + dist(a[2], b[2])).toBeGreaterThan(0.3);
    const inPlace = sources[2].map((p) => ({ ...p }));
    composeArrangement(inPlace, inPlace);
    expect(inPlace).toEqual(composeArrangement(sources[2], three()));
  });
});
