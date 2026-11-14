import { describe, expect, it } from 'vitest';
import { createHarmony } from '../core/harmony';
import { mulberry32 } from '../core/math';
import {
  DEFAULT_SEAT_OPTIONS,
  FALLBACK_SEATS,
  RESONATOR_COUNT,
  ResonatorPuzzle,
  assignTones,
  distanceToRay,
  generateSeats,
  isValidTriangle,
  minSeatSeparation,
  proximity,
  safeFrame,
  seatToWorld,
} from './resonators';

const SEEDS = Array.from({ length: 300 }, (_, i) => (i * 2654435761 + 17) >>> 0);

// Chapter I camera: 35° vertical fov, 6.2 from the focus plane. Below aspect 0.8 the rig
// widens the vertical fov so the horizontal extent is kept.
const FOV = 35;
const DISTANCE = 6.2;
const DEPTH_RANGE = 0.2;
const effectiveFov = (aspect: number) => (aspect >= 0.8 ? FOV : (2 * Math.atan(Math.tan((FOV * Math.PI) / 360) * (0.8 / aspect)) * 180) / Math.PI);

describe('resonator seats', () => {
  it('always yields three seats inside the normalised frame', () => {
    for (const seed of SEEDS) {
      const seats = generateSeats(mulberry32(seed));
      expect(seats).toHaveLength(RESONATOR_COUNT);
      for (const s of seats) {
        expect(Math.abs(s.u)).toBeLessThanOrEqual(1);
        expect(Math.abs(s.v)).toBeLessThanOrEqual(1);
        expect(Math.abs(s.depth)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('forms a well-separated, scalene, non-degenerate triangle for every seed', () => {
    for (const seed of SEEDS) {
      const seats = generateSeats(mulberry32(seed));
      expect(isValidTriangle(seats)).toBe(true);
      expect(minSeatSeparation(seats, DEFAULT_SEAT_OPTIONS.worstAspect)).toBeGreaterThanOrEqual(DEFAULT_SEAT_OPTIONS.minSeparation);
    }
  });

  it('only gets further apart in wider frames', () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const seats = generateSeats(mulberry32(seed));
      const narrow = minSeatSeparation(seats, DEFAULT_SEAT_OPTIONS.worstAspect);
      for (const aspect of [0.8, 1, 1.78, 2.4]) expect(minSeatSeparation(seats, aspect)).toBeGreaterThanOrEqual(narrow);
    }
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = generateSeats(mulberry32(1234));
    const b = generateSeats(mulberry32(1234));
    const c = generateSeats(mulberry32(1235));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('has a valid hand-placed fallback, mirrored or not', () => {
    expect(isValidTriangle(FALLBACK_SEATS)).toBe(true);
    expect(isValidTriangle(FALLBACK_SEATS.map((s) => ({ ...s, u: -s.u })))).toBe(true);
    // An impossible constraint forces the fallback path.
    const seats = generateSeats(mulberry32(7), { minSeparation: 9 });
    expect(seats).toHaveLength(RESONATOR_COUNT);
    expect(isValidTriangle(seats)).toBe(true);
  });

  it('rejects collinear, crowded and symmetric layouts', () => {
    expect(
      isValidTriangle([
        { u: -0.9, v: -0.9, depth: 0 },
        { u: 0, v: 0.45, depth: 0 },
        { u: 0.6, v: 0.92, depth: 0 },
      ]),
    ).toBe(false);
    expect(
      isValidTriangle([
        { u: -0.9, v: -0.8, depth: 0 },
        { u: -0.6, v: -0.7, depth: 0 },
        { u: 0.8, v: 0.8, depth: 0 },
      ]),
    ).toBe(false);
    expect(
      isValidTriangle([
        { u: -0.9, v: -0.6, depth: 0 },
        { u: 0.9, v: -0.6, depth: 0 },
        { u: 0, v: 0.9, depth: 0 },
      ]),
    ).toBe(false);
  });
});

describe('seats in the world', () => {
  const centre = { x: 0, y: 0.12, z: 0 };

  it('stay inside the camera frustum in landscape and portrait', () => {
    for (const aspect of [9 / 19.5, 9 / 16, 3 / 4, 1, 4 / 3, 16 / 9, 21 / 9]) {
      const fov = effectiveFov(aspect);
      const frame = safeFrame(fov, aspect, DISTANCE);
      const tan = Math.tan((fov * Math.PI) / 360);
      for (const seed of SEEDS.slice(0, 80)) {
        const seats = generateSeats(mulberry32(seed));
        for (const seat of seats) {
          const p = seatToWorld(seat, frame, centre, DEPTH_RANGE, { x: 0, y: 0, z: 0 });
          // Frustum half extents at this point's own depth, camera looking down -z at the centre.
          const halfH = tan * (DISTANCE - (p.z - centre.z));
          const halfW = halfH * aspect;
          expect(Math.abs(p.x - centre.x)).toBeLessThan(halfW * 0.9);
          expect(Math.abs(p.y - centre.y)).toBeLessThan(halfH * 0.9);
        }
      }
    }
  });

  it('keeps hit spheres of radius 0.55 from overlapping at every supported aspect', () => {
    const p = [0, 1, 2].map(() => ({ x: 0, y: 0, z: 0 }));
    for (const aspect of [9 / 19.5, 9 / 16, 3 / 4, 1, 16 / 9, 21 / 9]) {
      const frame = safeFrame(effectiveFov(aspect), aspect, DISTANCE);
      for (const seed of SEEDS.slice(0, 80)) {
        const seats = generateSeats(mulberry32(seed));
        seats.forEach((s, i) => seatToWorld(s, frame, centre, 0, p[i]));
        for (let i = 0; i < 3; i++) {
          for (let j = i + 1; j < 3; j++) expect(Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y)).toBeGreaterThan(1.1);
        }
      }
    }
  });

  it('caps the frame on very wide screens so the composition stays held', () => {
    const frame = safeFrame(FOV, 3.5, DISTANCE);
    expect(frame.halfW).toBeLessThanOrEqual(2.9);
    expect(frame.halfH).toBeLessThanOrEqual(2.3);
  });
});

describe('resonator tones', () => {
  it('are the root, the just fifth and the tenth of the mode, in a seeded order', () => {
    const orders = new Set<string>();
    for (const seed of SEEDS.slice(0, 80)) {
      const h = createHarmony(seed);
      const tones = assignTones(h);
      expect(tones.map((t) => t.degree).sort()).toEqual([0, 2, 4]);
      for (const t of tones) {
        expect(t.hz).toBeCloseTo(h.freq(t.degree, t.octave), 9);
        expect(Math.abs(h.cents(t.hz))).toBeLessThan(1e-6);
      }
      const root = tones.find((t) => t.degree === 0)!;
      const fifth = tones.find((t) => t.degree === 4)!;
      const third = tones.find((t) => t.degree === 2)!;
      expect(root.hz).toBeCloseTo(h.root * 4, 9);
      expect(fifth.hz / root.hz).toBeCloseTo(1.5, 9);
      expect(third.hz / root.hz).toBeCloseTo(2 * h.ratios[2], 9);
      orders.add(tones.map((t) => t.degree).join(''));
    }
    expect(orders.size).toBe(6);
  });
});

describe('proximity and ray distance', () => {
  it('proximity is 1 near, 0 far and monotone between', () => {
    expect(proximity(0)).toBe(1);
    expect(proximity(0.2)).toBe(1);
    expect(proximity(1.6)).toBe(0);
    expect(proximity(5)).toBe(0);
    let prev = 1;
    for (let d = 0; d <= 2; d += 0.01) {
      const p = proximity(d);
      expect(p).toBeLessThanOrEqual(prev + 1e-12);
      prev = p;
    }
  });

  it('measures distance to the pointer ray, not to the pointer point', () => {
    const origin = { x: 0, y: 0, z: 6 };
    const through = { x: 1, y: 0, z: 0 };
    // A point on the ray beyond `through` is at distance 0.
    expect(distanceToRay({ x: 2, y: 0, z: -6 }, origin, through)).toBeCloseTo(0, 9);
    expect(distanceToRay({ x: 1, y: 0.5, z: 0 }, origin, through)).toBeCloseTo(0.5, 9);
    // Behind the origin the distance is to the origin itself.
    expect(distanceToRay({ x: 0, y: 0, z: 9 }, origin, through)).toBeCloseTo(3, 9);
    // Degenerate ray.
    expect(distanceToRay({ x: 3, y: 4, z: 6 }, origin, origin)).toBeCloseTo(5, 9);
  });
});

describe('ResonatorPuzzle', () => {
  const make = (seed: number) => {
    const h = createHarmony(seed);
    return new ResonatorPuzzle(generateSeats(h.rand), assignTones(h));
  };

  it('is solved by waking all three, in any order, and records the degrees in that order', () => {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      const puzzle = make(99);
      expect(puzzle.progress).toBe(0);
      expect(puzzle.solved).toBe(false);
      order.forEach((index, n) => {
        expect(puzzle.wake(index)).toBe(true);
        expect(puzzle.woken).toBe(n + 1);
        expect(puzzle.progress).toBeCloseTo((n + 1) / 3, 12);
      });
      expect(puzzle.solved).toBe(true);
      expect(puzzle.progress).toBe(1);
      expect(puzzle.order).toEqual(order.map((i) => puzzle.tones[i].degree));
      expect(puzzle.nextAsleep()).toBe(-1);
    }
  });

  it('ignores repeated and invalid wakes', () => {
    const puzzle = make(5);
    expect(puzzle.wake(1)).toBe(true);
    expect(puzzle.wake(1)).toBe(false);
    expect(puzzle.wake(-1)).toBe(false);
    expect(puzzle.wake(3)).toBe(false);
    expect(puzzle.wake(0.5)).toBe(false);
    expect(puzzle.woken).toBe(1);
    expect(puzzle.order).toHaveLength(1);
    expect(puzzle.solved).toBe(false);
  });

  it('can always be completed by repeatedly waking the next sleeper (self-completion)', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const puzzle = make(seed);
      let guard = 0;
      while (!puzzle.solved && guard++ < 10) expect(puzzle.wake(puzzle.nextAsleep())).toBe(true);
      expect(puzzle.solved).toBe(true);
      expect(guard).toBe(3);
    }
  });

  it('finds the nearest sleeping resonator', () => {
    const puzzle = make(11);
    const positions = [
      { x: -2, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 2, y: 0, z: 0 },
    ];
    expect(puzzle.nearestAsleep(1.8, 0.1, positions)).toBe(2);
    puzzle.wake(2);
    expect(puzzle.nearestAsleep(1.8, 0.1, positions)).toBe(1);
    puzzle.wake(1);
    expect(puzzle.nearestAsleep(1.8, 0.1, positions)).toBe(0);
    puzzle.wake(0);
    expect(puzzle.nearestAsleep(1.8, 0.1, positions)).toBe(-1);
  });

  it('refuses mismatched seats and tones', () => {
    const h = createHarmony(3);
    expect(() => new ResonatorPuzzle(generateSeats(h.rand).slice(0, 2), assignTones(h))).toThrow();
  });
});
