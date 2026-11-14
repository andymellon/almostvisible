import { describe, expect, it } from 'vitest';
import { createHarmony } from '../core/harmony';
import {
  ALIGN_CENTS,
  CELL_MARGIN_CENTS,
  HOLD_SECONDS,
  MAGNET_CENTS,
  STABILITY_WIDTH,
  TuningPath,
  TuningPuzzle,
  beatHz,
  centsAt,
  createTuning,
  errorCents,
  hzAt,
  isAligned,
  magnetT,
  ratioAt,
  stabilityOf,
  tAtCents,
} from './tuning';

const SEEDS = Array.from({ length: 400 }, (_, i) => (i * 2246822519 + 3) >>> 0);
const DT = 1 / 60;

describe('tuning spec', () => {
  it('targets the just tenth of the mode over A, with B a just fifth', () => {
    const modes = new Set<string>();
    for (const seed of SEEDS) {
      const h = createHarmony(seed);
      const spec = createTuning(h);
      modes.add(h.modeName);
      expect(spec.anchorHz).toBeCloseTo(h.freq(0, 2), 9);
      expect(spec.fifthHz).toBeCloseTo(h.freq(4, 2), 9);
      expect(spec.fifthHz / spec.anchorHz).toBeCloseTo(1.5, 12);
      expect(spec.targetRatio).toBeCloseTo(2 * h.ratios[2], 12);
      expect(spec.targetHz).toBeCloseTo(h.freq(2, 3), 9);
      // The target belongs to the collection, so the bridge sees zero detune there.
      expect(Math.abs(h.cents(spec.targetHz))).toBeLessThan(1e-6);
      expect(hzAt(spec, spec.targetT)).toBeCloseTo(spec.targetHz, 9);
      expect(centsAt(spec, spec.targetT)).toBeCloseTo(0, 9);
      expect(ratioAt(spec, spec.targetT)).toBeCloseTo(spec.targetRatio, 9);
    }
    expect(modes.size).toBe(5);
  });

  it('maps t to pitch continuously and strictly monotonically over a generous, bounded range', () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const spec = createTuning(createHarmony(seed));
      expect(spec.lowCents).toBeLessThanOrEqual(-45);
      expect(spec.lowCents).toBeGreaterThanOrEqual(-120);
      expect(spec.highCents).toBeGreaterThanOrEqual(45);
      expect(spec.highCents).toBeLessThanOrEqual(120);
      expect(spec.highCents - spec.lowCents).toBeGreaterThan(120);
      expect(centsAt(spec, 0)).toBeCloseTo(spec.lowCents, 12);
      expect(centsAt(spec, 1)).toBeCloseTo(spec.highCents, 12);
      let prev = hzAt(spec, 0);
      for (let i = 1; i <= 400; i++) {
        const hz = hzAt(spec, i / 400);
        expect(hz).toBeGreaterThan(prev);
        // No jumps: one four-hundredth of the path never moves the pitch by more than a cent.
        expect(Math.abs(1200 * Math.log2(hz / prev))).toBeLessThan(1);
        prev = hz;
      }
      // Out-of-range t is clamped, not extrapolated.
      expect(hzAt(spec, -3)).toBe(hzAt(spec, 0));
      expect(hzAt(spec, 9)).toBe(hzAt(spec, 1));
    }
  });

  it('never puts the solution at the centre of the path, and varies it per seed', () => {
    const sides = new Set<number>();
    for (const seed of SEEDS) {
      const spec = createTuning(createHarmony(seed));
      expect(Math.abs(spec.targetT - 0.5)).toBeGreaterThan(0.03);
      expect(spec.targetT).toBeGreaterThan(0.3);
      expect(spec.targetT).toBeLessThan(0.7);
      sides.add(Math.sign(spec.targetT - 0.5));
    }
    expect(sides.size).toBe(2);
  });

  it('starts 35–70 cents away, on a seeded side, inside the path', () => {
    const signs = new Set<number>();
    for (const seed of SEEDS) {
      const spec = createTuning(createHarmony(seed));
      const mag = Math.abs(spec.startCents);
      expect(mag).toBeGreaterThanOrEqual(35);
      expect(mag).toBeLessThanOrEqual(70);
      expect(spec.startT).toBeGreaterThan(0);
      expect(spec.startT).toBeLessThan(1);
      expect(centsAt(spec, spec.startT)).toBeCloseTo(spec.startCents, 9);
      expect(isAligned(spec.startCents)).toBe(false);
      signs.add(Math.sign(spec.startCents));
    }
    expect(signs.size).toBe(2);
  });

  it('has exactly one resting place, and the bridge always measures detune against it', () => {
    for (const seed of SEEDS) {
      const h = createHarmony(seed);
      const spec = createTuning(h);
      let prev = Infinity;
      for (let i = 0; i <= 200; i++) {
        const hz = hzAt(spec, i / 200);
        // The target is the nearest pitch of the collection everywhere on the path, with margin,
        // so harmony.cents (what makes the interference crawl) equals the puzzle's own error …
        expect(h.nearest(hz)).toBeCloseTo(spec.targetHz, 6);
        expect(h.cents(hz)).toBeCloseTo(errorCents(spec, hz), 6);
        // … and therefore the crawl rate falls monotonically toward the target and rises after it.
        const detune = Math.abs(hz - h.nearest(hz));
        if (i / 200 <= spec.targetT) expect(detune).toBeLessThanOrEqual(prev + 1e-9);
        else if ((i - 1) / 200 >= spec.targetT) expect(detune).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = detune;
      }
      // Both ends stop short of the midpoint to the neighbouring degree.
      const r = h.ratios;
      expect(-spec.lowCents).toBeLessThanOrEqual((1200 * Math.log2(r[2] / r[1])) / 2 - CELL_MARGIN_CENTS + 1e-9);
      expect(spec.highCents).toBeLessThanOrEqual((1200 * Math.log2(r[3] / r[2])) / 2 - CELL_MARGIN_CENTS + 1e-9);
    }
  });

  it('is deterministic and draws a fixed number of random values', () => {
    const a = createHarmony(42);
    const b = createHarmony(42);
    expect(createTuning(a)).toEqual(createTuning(b));
    const c = createHarmony(42);
    for (let i = 0; i < 5; i++) c.rand();
    const next = c.rand();
    expect(a.rand()).toBe(next);
    expect(b.rand()).toBe(next);
  });

  it('inverts cents ↔ t', () => {
    const spec = createTuning(createHarmony(8));
    for (let t = 0; t <= 1; t += 0.05) expect(tAtCents(spec, centsAt(spec, t))).toBeCloseTo(t, 12);
    expect(tAtCents(spec, 0)).toBeCloseTo(spec.targetT, 12);
    expect(errorCents(spec, hzAt(spec, 0.3))).toBeCloseTo(centsAt(spec, 0.3), 9);
  });
});

describe('tolerance, stability and beating', () => {
  it('counts ≤ 6 cents as aligned, on both sides, and nothing beyond', () => {
    expect(ALIGN_CENTS).toBe(6);
    for (const c of [0, 1, -1, 5.99, -5.99, 6, -6]) expect(isAligned(c)).toBe(true);
    for (const c of [6.01, -6.01, 7, -12, 35, -70]) expect(isAligned(c)).toBe(false);
  });

  it('stability is 1 in tune, symmetric, strictly decreasing with error, and within 0..1', () => {
    expect(stabilityOf(0)).toBe(1);
    expect(stabilityOf(STABILITY_WIDTH)).toBeCloseTo(0.5, 12);
    expect(stabilityOf(ALIGN_CENTS)).toBeGreaterThan(0.9);
    expect(stabilityOf(35)).toBeLessThan(0.35);
    expect(stabilityOf(70)).toBeLessThan(0.12);
    let prev = 1;
    for (let c = 0.5; c <= 130; c += 0.5) {
      const s = stabilityOf(c);
      expect(s).toBeLessThan(prev);
      expect(s).toBeGreaterThan(0);
      expect(stabilityOf(-c)).toBe(s);
      prev = s;
    }
  });

  it('beat rate is zero in tune and slows as the voice approaches', () => {
    const spec = createTuning(createHarmony(77));
    expect(beatHz(spec, 0)).toBe(0);
    let prev = 0;
    for (let c = 1; c <= 120; c++) {
      const b = beatHz(spec, c);
      expect(b).toBeGreaterThan(prev);
      prev = b;
    }
    // Inside the tolerance the beating is slow enough to hear as a swell, not a roughness.
    expect(beatHz(spec, ALIGN_CENTS)).toBeLessThan(3);
    expect(beatHz(spec, -ALIGN_CENTS)).toBeLessThan(3);
    // At the start it is clearly a rough flutter.
    expect(beatHz(spec, spec.startCents)).toBeGreaterThan(6);
    // And it is the actual difference of the two frequencies.
    expect(beatHz(spec, 20)).toBeCloseTo(hzAt(spec, tAtCents(spec, 20)) - spec.targetHz, 9);
  });
});

describe('magnet', () => {
  it('does nothing outside 12 cents', () => {
    const spec = createTuning(createHarmony(21));
    for (const c of [MAGNET_CENTS, -MAGNET_CENTS, 20, -40, spec.highCents, spec.lowCents]) {
      const t = tAtCents(spec, c);
      expect(magnetT(spec, t, true)).toBeCloseTo(t, 12);
      expect(magnetT(spec, t, false)).toBeCloseTo(t, 12);
    }
  });

  it('pulls gently while dragging: closer to the solution, never past it, continuous and monotone', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const spec = createTuning(createHarmony(seed));
      let prev = -Infinity;
      for (let c = -MAGNET_CENTS - 2; c <= MAGNET_CENTS + 2; c += 0.05) {
        const out = centsAt(spec, magnetT(spec, tAtCents(spec, c), true));
        expect(out).toBeGreaterThan(prev);
        if (prev !== -Infinity) expect(out - prev).toBeLessThan(0.12);
        expect(Math.abs(out)).toBeLessThanOrEqual(Math.abs(c) + 1e-9);
        expect(Math.sign(out) === Math.sign(c) || Math.abs(out) < 1e-9).toBe(true);
        prev = out;
      }
      // Gentle: a hand 9 cents away is not yanked into the tolerance.
      expect(Math.abs(centsAt(spec, magnetT(spec, tAtCents(spec, 9), true)))).toBeGreaterThan(ALIGN_CENTS);
    }
  });

  it('settles exactly on the solution when released within reach', () => {
    const spec = createTuning(createHarmony(21));
    for (const c of [-11.9, -6, -0.1, 0, 3, 11.9]) expect(magnetT(spec, tAtCents(spec, c), false)).toBe(spec.targetT);
  });
});

describe('TuningPuzzle', () => {
  it('starts unsolved and stays unsolved if left alone', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const spec = createTuning(createHarmony(seed));
      const puzzle = new TuningPuzzle(spec);
      expect(puzzle.cents).toBeCloseTo(spec.startCents, 9);
      for (let i = 0; i < 600; i++) expect(puzzle.step(DT, puzzle.t)).toBe(false);
      expect(puzzle.solved).toBe(false);
      expect(puzzle.seconds).toBeCloseTo(10, 6);
    }
  });

  it('is solvable for every seed by dragging toward the solution and holding', () => {
    for (const seed of SEEDS) {
      const spec = createTuning(createHarmony(seed));
      const puzzle = new TuningPuzzle(spec);
      let t = spec.startT;
      let solvedAt = -1;
      for (let i = 0; i < 60 * 30 && solvedAt < 0; i++) {
        // A hand moving at a steady 6 % of the path per second, with the magnet applied.
        const step = Math.sign(spec.targetT - t) * Math.min(Math.abs(spec.targetT - t), 0.06 * DT);
        t = magnetT(spec, t + step, true);
        if (puzzle.step(DT, t)) solvedAt = i;
      }
      expect(solvedAt).toBeGreaterThan(0);
      expect(puzzle.solved).toBe(true);
      expect(Math.abs(puzzle.cents)).toBeLessThanOrEqual(ALIGN_CENTS);
      expect(Math.abs(1200 * Math.log2(puzzle.ratio / spec.targetRatio))).toBeLessThanOrEqual(ALIGN_CENTS);
      expect(puzzle.seconds).toBeGreaterThanOrEqual(HOLD_SECONDS);
      expect(puzzle.seconds).toBeLessThan(30);
    }
  });

  it('accepts any resting point within the tolerance, not only the exact pitch', () => {
    const spec = createTuning(createHarmony(314));
    for (const c of [-6, -4, 0, 2.5, 6]) {
      const puzzle = new TuningPuzzle(spec);
      const t = tAtCents(spec, c);
      let solved = false;
      for (let i = 0; i < 200 && !solved; i++) solved = puzzle.step(DT, t);
      expect(solved).toBe(true);
      expect(1200 * Math.log2(puzzle.ratio / spec.targetRatio)).toBeCloseTo(c, 6);
    }
  });

  it('requires the alignment to be held for about 1.2 s', () => {
    const spec = createTuning(createHarmony(2718));
    const puzzle = new TuningPuzzle(spec);
    const frames = Math.ceil(HOLD_SECONDS / DT);
    for (let i = 0; i < frames - 2; i++) expect(puzzle.step(DT, spec.targetT)).toBe(false);
    expect(puzzle.solved).toBe(false);
    expect(puzzle.held).toBeGreaterThan(1.1);
    let solved = false;
    for (let i = 0; i < 4 && !solved; i++) solved = puzzle.step(DT, spec.targetT);
    expect(solved).toBe(true);
  });

  it('resets the hold when the voice leaves the tolerance, and passing through does not solve', () => {
    const spec = createTuning(createHarmony(1618));
    const puzzle = new TuningPuzzle(spec);
    for (let i = 0; i < 50; i++) puzzle.step(DT, spec.targetT);
    expect(puzzle.held).toBeGreaterThan(0.8);
    puzzle.step(DT, tAtCents(spec, 9));
    expect(puzzle.held).toBe(0);
    expect(puzzle.solved).toBe(false);

    // A fast sweep straight through the solution.
    const sweep = new TuningPuzzle(spec);
    for (let i = 0; i <= 120; i++) expect(sweep.step(DT, i / 120)).toBe(false);
    expect(sweep.solved).toBe(false);
  });

  it('reports solving once, then freezes the record while still tracking the voice', () => {
    const spec = createTuning(createHarmony(4));
    const puzzle = new TuningPuzzle(spec);
    let count = 0;
    for (let i = 0; i < 300; i++) if (puzzle.step(DT, tAtCents(spec, 3))) count++;
    expect(count).toBe(1);
    const { seconds, ratio } = puzzle;
    puzzle.step(DT, 0);
    expect(puzzle.solved).toBe(true);
    expect(puzzle.seconds).toBe(seconds);
    expect(puzzle.ratio).toBe(ratio);
    expect(puzzle.cents).toBeCloseTo(spec.lowCents, 9);
    expect(puzzle.stability).toBeCloseTo(stabilityOf(spec.lowCents), 12);
  });

  it('stability feedback rises all the way in as the voice approaches from the start', () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const spec = createTuning(createHarmony(seed));
      const puzzle = new TuningPuzzle(spec);
      let prev = puzzle.stability;
      expect(prev).toBeLessThan(0.3);
      for (let i = 1; i <= 100; i++) {
        puzzle.step(0, spec.startT + ((spec.targetT - spec.startT) * i) / 100);
        expect(puzzle.stability).toBeGreaterThan(prev);
        prev = puzzle.stability;
      }
      expect(prev).toBeCloseTo(1, 9);
    }
  });
});

describe('TuningPath', () => {
  const frames: [number, number, number][] = [
    [3, 2.08, 0],
    [2.2, 2.08, 0.4],
    [1.36, 2.6, 1],
  ];

  it('is parameterised by arc length: equal steps of t are equal distances', () => {
    for (const [w, h, tall] of frames) {
      const path = new TuningPath(w, h, tall);
      const a = { x: 0, y: 0, z: 0 };
      const b = { x: 0, y: 0, z: 0 };
      const n = path.count - 1;
      const mean = path.length / n;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        path.point(i / n, a);
        path.point((i + 1) / n, b);
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        expect(d / mean).toBeGreaterThan(0.97);
        expect(d / mean).toBeLessThan(1.03);
        sum += d;
      }
      expect(sum).toBeLessThanOrEqual(path.length + 1e-9);
      expect(sum).toBeGreaterThan(path.length * 0.995);
      expect(path.length).toBeGreaterThan(2);
    }
  });

  it('projects any point of the path back to its own parameter', () => {
    for (const [w, h, tall] of frames) {
      const path = new TuningPath(w, h, tall);
      const p = { x: 0, y: 0, z: 0 };
      for (let i = 0; i <= 500; i++) {
        const t = i / 500;
        path.point(t, p);
        expect(path.nearestT(p.x, p.y, p.z)).toBeCloseTo(t, 6);
      }
    }
  });

  it('constrains off-path positions to the path, clamps beyond its ends, and is stable under re-projection', () => {
    const path = new TuningPath(3, 2.08, 0);
    const p = { x: 0, y: 0, z: 0 };
    const q = { x: 0, y: 0, z: 0 };
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      path.point(t, p);
      const near = path.nearestT(p.x + 0.03, p.y - 0.05, p.z + 0.04);
      expect(Math.abs(near - t)).toBeLessThan(0.03);
      path.point(near, q);
      expect(path.nearestT(q.x, q.y, q.z)).toBeCloseTo(near, 6);
    }
    expect(path.nearestT(-50, 0, 0)).toBe(0);
    expect(path.nearestT(50, 3, 0)).toBe(1);
  });

  it('moves steadily left to right so the arrow keys map onto it, and is a true S in depth', () => {
    for (const [w, h, tall] of frames) {
      const path = new TuningPath(w, h, tall);
      const p = { x: 0, y: 0, z: 0 };
      let prevX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i <= 200; i++) {
        path.point(i / 200, p);
        expect(p.x).toBeGreaterThan(prevX);
        prevX = p.x;
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(w * 0.8 + 1e-9);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThanOrEqual(h * 0.82);
      }
      expect(maxZ - minZ).toBeGreaterThan(0.4);
    }
  });

  it('has unit tangents that follow the direction of travel', () => {
    const path = new TuningPath(3, 2.08, 0);
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    const tan = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 50; i++) {
      const t = i / 50;
      path.tangent(t, tan);
      expect(Math.hypot(tan.x, tan.y, tan.z)).toBeCloseTo(1, 9);
      path.point(t, a);
      path.point(t + 0.01, b);
      expect((b.x - a.x) * tan.x + (b.y - a.y) * tan.y + (b.z - a.z) * tan.z).toBeGreaterThan(0);
    }
  });

  it('rebuilds in place for a new frame and keeps the same sample count', () => {
    const path = new TuningPath(3, 2.08, 0);
    const xs = path.xs;
    const before = path.length;
    path.rebuild(1.36, 2.6, 1);
    expect(path.xs).toBe(xs);
    expect(path.count).toBe(129);
    expect(path.length).not.toBeCloseTo(before, 3);
    const p = { x: 0, y: 0, z: 0 };
    path.point(0.37, p);
    expect(path.nearestT(p.x, p.y, p.z)).toBeCloseTo(0.37, 6);
  });

  it('gives the tolerance a reachable width along the path', () => {
    // ±6 cents (±12 with the magnet) must be a hand-sized stretch of the path, even in portrait.
    for (const seed of SEEDS.slice(0, 40)) {
      const spec = createTuning(createHarmony(seed));
      for (const [w, h, tall] of frames) {
        const path = new TuningPath(w, h, tall);
        const centsPerUnit = (spec.highCents - spec.lowCents) / path.length;
        expect((2 * MAGNET_CENTS) / centsPerUnit).toBeGreaterThan(0.22);
      }
    }
  });
});
