/**
 * Headless smoke test of the journey: everything here is pure (no WebGL, no DOM, no Tone).
 *
 *   - the shape of the piece (five chapters, 300 s)
 *   - the harmonic world, the bridge model and the memory
 *   - each chapter's puzzle driven to its solution the way the chapter's own assist(3) does it
 *   - the Director's pacing, assistance, long stop, restart and jump, against stub chapters
 */
import { describe, expect, it } from 'vitest';
import { clearWaves, createBridge, stepBridge } from './bridge';
import { CHAPTER_SECONDS, MAX_WAVES, type AudioEngine, type Chapter, type ChapterContext, type Harmony, type Interaction, type Stage, type UI } from './contracts';
import { createDirector } from './Director';
import { createHarmony } from './harmony';
import { ease, lerp } from './math';
import { createMemory } from './memory';
import {
  TUNING,
  composeArrangement,
  createBalanceState,
  createPose,
  crowdedStart,
  evaluateBalance,
  isSolved,
  solveArrangement as solveBalance,
  stepHold,
  type FieldPose,
} from '../puzzles/balance';
import { createEvaluation, designConstellation, evaluate, magnetStep, relate, scatter, solveArrangement as solveConstellation } from '../puzzles/constellation';
import { RESONATOR_COUNT, ResonatorPuzzle, assignTones, generateSeats, isValidTriangle } from '../puzzles/resonators';
import { ALIGN_CENTS, HOLD_SECONDS, TuningPuzzle, createTuning } from '../puzzles/tuning';

const DT = 1 / 60;
const SEEDS = [1, 2, 3, 7, 42, 404, 2024, 31337, 0xdecaf, 4294967295];

describe('the shape of the piece', () => {
  it('is five chapters and exactly five minutes', () => {
    expect(CHAPTER_SECONDS.length).toBe(5);
    expect(CHAPTER_SECONDS.reduce((a, b) => a + b, 0)).toBe(300);
    expect(MAX_WAVES).toBe(8);
  });
});

describe('harmony', () => {
  it('is deterministic per seed, in range, and measures detune against itself', () => {
    for (const seed of SEEDS) {
      const a = createHarmony(seed);
      const b = createHarmony(seed);
      expect(a.root).toBe(b.root);
      expect(a.modeName).toBe(b.modeName);
      expect(a.rand()).toBe(b.rand());
      expect(a.root).toBeGreaterThanOrEqual(46);
      expect(a.root).toBeLessThanOrEqual(62);
      expect(a.ratios[0]).toBe(1);
      expect(a.ratios).toContain(3 / 2);
      for (let i = 1; i < a.ratios.length; i++) expect(a.ratios[i]).toBeGreaterThan(a.ratios[i - 1]);
      for (let degree = -7; degree < 22; degree++) {
        const hz = a.freq(degree, 1);
        expect(a.nearest(hz)).toBeCloseTo(hz, 6);
        expect(Math.abs(a.cents(hz))).toBeLessThan(1e-6);
        expect(a.cents(hz * Math.pow(2, 10 / 1200))).toBeCloseTo(10, 4);
      }
      expect(a.freq(a.ratios.length, 0)).toBeCloseTo(a.root * 2, 9);
    }
  });
});

describe('bridge model', () => {
  it('holds an in-tune pattern still and lets a detuned one crawl', () => {
    const harmony = createHarmony(7);
    const bridge = createBridge();
    bridge.waves[0].freq = harmony.freq(0, 2);
    bridge.waves[0].level = 1;
    bridge.waves[1].freq = harmony.freq(4, 2);
    bridge.waves[1].level = 0.8;
    bridge.waves[2].freq = harmony.freq(2, 3) * Math.pow(2, 40 / 1200); // 40 cents sharp
    bridge.waves[2].level = 0.8;
    let lastInTune = 0;
    let lastDetuned = 0;
    let crawl = 0;
    for (let i = 0; i < 600; i++) {
      stepBridge(bridge, harmony, DT);
      const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
      const inTune = wrap(bridge.waves[1].phase - bridge.waves[0].phase);
      const detuned = wrap(bridge.waves[2].phase - bridge.waves[0].phase);
      if (i > 0) {
        expect(Math.abs(wrap(inTune - lastInTune))).toBeLessThan(1e-9);
        crawl += Math.abs(wrap(detuned - lastDetuned));
      }
      lastInTune = inTune;
      lastDetuned = detuned;
    }
    expect(crawl).toBeGreaterThan(1); // radians of relative phase over ten seconds
    expect(bridge.activeWaves).toBe(3);
    expect(bridge.measured).toBe(false);
    for (const k of ['amplitude', 'centroid', 'low', 'mid', 'high'] as const) {
      expect(Number.isFinite(bridge[k])).toBe(true);
      expect(bridge[k]).toBeGreaterThanOrEqual(0);
      expect(bridge[k]).toBeLessThanOrEqual(1);
    }
    expect(bridge.amplitude).toBeGreaterThan(0.3);

    // Strikes decay; released slots fall silent; nothing goes non-finite at zero.
    bridge.attack = 1;
    clearWaves(bridge);
    for (let i = 0; i < 600; i++) stepBridge(bridge, harmony, DT);
    expect(bridge.attack).toBe(0);
    expect(bridge.activeWaves).toBe(0);
    expect(bridge.amplitude).toBeLessThan(0.01);
    for (const w of bridge.waves) {
      expect(w.amp).toBe(0);
      expect(Number.isFinite(w.phase)).toBe(true);
    }
  });
});

describe('memory', () => {
  it('starts with a playable default, records, and resets', () => {
    const memory = createMemory();
    expect(memory.data.resonators.length).toBe(3);
    expect(memory.data.constellation.positions.length).toBe(3);
    for (let i = 0; i < 400; i++) memory.gesture(i * 0.5);
    expect(memory.data.gestures.length).toBeLessThanOrEqual(256);
    memory.data.tuning = { ratio: 2.5, seconds: 9 };
    memory.reset();
    expect(memory.data.gestures.length).toBe(0);
    expect(memory.data.tuning.ratio).toBe(1.5);
  });
});

describe('every puzzle can be brought to its solution', () => {
  it('I — three resonators woken', () => {
    for (const seed of SEEDS) {
      const harmony = createHarmony(seed);
      const seats = generateSeats(harmony.rand);
      expect(seats.length).toBe(RESONATOR_COUNT);
      expect(isValidTriangle(seats)).toBe(true);
      const puzzle = new ResonatorPuzzle(seats, assignTones(harmony));
      expect(puzzle.solved).toBe(false);
      while (!puzzle.solved) {
        const next = puzzle.nextAsleep();
        expect(next).toBeGreaterThanOrEqual(0);
        expect(puzzle.wake(next)).toBe(true);
        expect(puzzle.wake(next)).toBe(false);
      }
      expect(puzzle.progress).toBe(1);
      expect(puzzle.order.slice().sort()).toEqual([0, 2, 4]);
    }
  });

  it('II — the third voice glides into tune and is held', () => {
    for (const seed of SEEDS) {
      const harmony = createHarmony(seed);
      const spec = createTuning(harmony);
      const puzzle = new TuningPuzzle(spec);
      expect(Math.abs(spec.startCents)).toBeGreaterThanOrEqual(30);
      // Left alone it never solves.
      for (let i = 0; i < 300; i++) expect(puzzle.step(DT, spec.startT)).toBe(false);
      // assist(3): three seconds of glide, then the hold.
      let solvedAt = -1;
      for (let i = 0; i < 600 && solvedAt < 0; i++) {
        const t = lerp(spec.startT, spec.targetT, ease(Math.min(1, (i * DT) / 3)));
        if (puzzle.step(DT, t)) solvedAt = i * DT;
      }
      expect(solvedAt).toBeGreaterThan(0);
      expect(solvedAt).toBeLessThan(3 + HOLD_SECONDS + 0.1);
      expect(puzzle.solved).toBe(true);
      expect(Math.abs(puzzle.cents)).toBeLessThanOrEqual(ALIGN_CENTS);
      expect(puzzle.stability).toBeGreaterThan(0.9);
      // What chapter V and the finale are given: a tenth over the anchor, a third once folded.
      let folded = puzzle.ratio;
      while (folded >= 2) folded /= 2;
      expect(folded).toBeGreaterThan(1.15);
      expect(folded).toBeLessThan(1.3);
      // In tune means in the collection: the bridge will hold the pattern still.
      expect(Math.abs(harmony.cents(puzzle.hz))).toBeLessThanOrEqual(ALIGN_CENTS + 1e-6);
    }
  });

  it('III — the three that belong form the figure', () => {
    for (const seed of SEEDS) {
      const harmony = createHarmony(seed);
      const spec = designConstellation(harmony.ratios, harmony.rand);
      expect(spec.members.length).toBe(3);
      expect(spec.outsiders.length).toBe(2);
      const rel = relate(spec.pitches);
      const positions = scatter(rel, { x: 3, y: 1.6, z: 1 }, harmony.rand).map((p) => ({ ...p }));
      const evaluation = createEvaluation(rel.n);
      expect(evaluate(positions, rel, evaluation).solved).toBe(false);
      // assist(3): the members drift to the nearest solved figure.
      const targets = solveConstellation(positions, rel, spec.members).map((p) => ({ ...p }));
      const from = spec.members.map((m) => ({ ...positions[m] }));
      for (let i = 0; i <= 240; i++) {
        const u = ease(i / 240);
        spec.members.forEach((m, k) => {
          positions[m].x = lerp(from[k].x, targets[k].x, u);
          positions[m].y = lerp(from[k].y, targets[k].y, u);
          positions[m].z = lerp(from[k].z, targets[k].z, u);
        });
        evaluate(positions, rel, evaluation);
        expect(Number.isFinite(evaluation.progress)).toBe(true);
      }
      expect(evaluation.solved).toBe(true);
      expect(evaluation.progress).toBeGreaterThan(0.99);
      // The magnet is finite even when two fragments coincide.
      positions[spec.members[1]] = { ...positions[spec.members[0]] };
      const pulled = magnetStep(spec.members[0], { ...positions[spec.members[0]] }, positions, rel, 1);
      expect(Number.isFinite(pulled.x + pulled.y + pulled.z)).toBe(true);
    }
  });

  it('IV — earth, air and light each find their own space', () => {
    for (const seed of SEEDS) {
      const harmony = createHarmony(seed);
      const poses: FieldPose[] = [createPose(), createPose(), createPose()];
      const targets: FieldPose[] = [createPose(), createPose(), createPose()];
      crowdedStart(harmony.rand, poses);
      const state = createBalanceState();
      expect(evaluateBalance(poses, state).balance).toBeLessThan(0.2);
      // assist(3): five seconds of glide to the solving arrangement, then the hold.
      solveBalance(poses, targets);
      const from = poses.map((p) => ({ ...p }));
      let held = 0;
      let solvedAt = -1;
      for (let i = 0; i < 60 * 12 && solvedAt < 0; i++) {
        const u = ease(Math.min(1, (i * DT) / 5));
        for (let k = 0; k < 3; k++) {
          poses[k].x = lerp(from[k].x, targets[k].x, u);
          poses[k].y = lerp(from[k].y, targets[k].y, u);
          poses[k].z = lerp(from[k].z, targets[k].z, u);
        }
        evaluateBalance(poses, state);
        expect(Number.isFinite(state.balance)).toBe(true);
        held = stepHold(held, state.balance, DT);
        if (isSolved(held)) solvedAt = i * DT;
      }
      expect(solvedAt).toBeGreaterThan(0);
      expect(solvedAt).toBeLessThan(5 + TUNING.holdSeconds + 1);
      expect(state.balance).toBeGreaterThanOrEqual(TUNING.solved);
      // The signature's composed sculpture is finite and keeps the three apart.
      composeArrangement(poses, targets);
      for (const p of targets) expect(Number.isFinite(p.x + p.y + p.z + p.rotation)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────── director ──

interface Stub extends Chapter {
  log: string[];
  /** Seconds after enter at which the puzzle solves itself (Infinity = never). */
  solveAt: number;
  /** Seconds after assist(3) at which it completes. */
  autoSeconds: number;
  exitSeconds: number;
  throwIn: '' | 'enter' | 'update';
  entered: number;
  disposed: number;
}

function stub(index: number, log: string[]): Stub {
  let t = 0;
  let live = false;
  let completeAt = Infinity;
  let exitT = -1;
  const s: Stub = {
    index,
    numeral: ['I', 'II', 'III', 'IV', 'V'][index],
    name: `Chapter ${index + 1}`,
    line: `line ${index + 1}`,
    log,
    solveAt: Infinity,
    autoSeconds: 4,
    exitSeconds: 3,
    throwIn: '',
    entered: 0,
    disposed: 0,
    get progress() {
      return live ? Math.min(1, t / 10) : 0;
    },
    get complete() {
      return live && t >= Math.min(completeAt, s.solveAt);
    },
    get exited() {
      return exitT >= s.exitSeconds;
    },
    enter() {
      if (live) throw new Error(`${s.numeral} entered twice without dispose`);
      s.entered++;
      t = 0;
      exitT = -1;
      completeAt = Infinity;
      live = true;
      log.push(`${s.numeral}:enter`);
      if (s.throwIn === 'enter') throw new Error('stub enter failure');
    },
    update(dt) {
      if (!live) throw new Error(`${s.numeral} updated while not live`);
      if (s.throwIn === 'update') throw new Error('stub update failure');
      t += dt;
      if (exitT >= 0) exitT += dt;
    },
    assist(level) {
      log.push(`${s.numeral}:assist${level}@${t.toFixed(1)}`);
      if (level === 3) completeAt = t + s.autoSeconds;
    },
    exit() {
      log.push(`${s.numeral}:exit@${t.toFixed(1)}`);
      exitT = 0;
    },
    dispose() {
      if (live) s.disposed++;
      live = false;
      log.push(`${s.numeral}:dispose`);
    },
  };
  return s;
}

function world(seed = 1) {
  const log: string[] = [];
  const bridge = createBridge();
  const memory = createMemory();
  const calls = { reset: 0, setHarmony: 0, cleared: 0, ending: [] as boolean[], hints: [] as (string | null)[], captions: [] as string[], progress: 0 };
  const audio = new Proxy(
    {},
    {
      get(_t, key) {
        if (key === 'reset') return () => void calls.reset++;
        if (key === 'setHarmony') return () => void calls.setHarmony++;
        return () => undefined;
      },
    },
  ) as AudioEngine;
  const interaction = {
    onGesture: null as (() => void) | null,
    clear: () => void calls.cleared++,
  } as unknown as Interaction;
  const ui = {
    chapter: (n: string) => void log.push(`ui:${n || '-'}`),
    caption: (t: string) => void calls.captions.push(t),
    hint: (t: string | null) => void calls.hints.push(t),
    announce: () => undefined,
    progress: (t: number) => void (calls.progress = t),
    showTitle: () => undefined,
    showEnding: (v: boolean) => void calls.ending.push(v),
    setMuted: () => undefined,
    setPaused: () => undefined,
    update: () => undefined,
  } as UI;
  const stage = { grade: { exposure: 1, bloom: 0.5, dispersion: 0.3, grain: 0.5, fade: 0 } } as unknown as Stage;
  const ctx = { stage, rig: {}, audio, bridge, interaction, harmony: createHarmony(seed), memory, quality: { lite: false, reducedMotion: false }, ui } as unknown as ChapterContext;
  const chapters = [0, 1, 2, 3, 4].map((i) => stub(i, log));
  let ended = 0;
  const harmonies: Harmony[] = [];
  const director = createDirector(ctx, chapters.slice().reverse(), {
    onEnded: () => void ended++,
    setHarmony: (s) => {
      const h = createHarmony(s);
      harmonies.push(h);
      return h;
    },
  });
  const run = (seconds: number) => {
    for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
      stepBridge(bridge, ctx.harmony, DT);
      director.update(DT);
    }
  };
  const runUntil = (pred: () => boolean, max: number) => {
    for (let i = 0, n = Math.round(max / DT); i < n && !pred(); i++) {
      stepBridge(bridge, ctx.harmony, DT);
      director.update(DT);
    }
    return pred();
  };
  return { log, bridge, memory, calls, ctx, chapters, director, stage, interaction, harmonies, run, runUntil, ended: () => ended };
}

describe('director', () => {
  it('does nothing until begun, then holds in black before chapter I', () => {
    const w = world();
    w.run(5);
    expect(w.director.elapsed).toBe(0);
    expect(w.log).toEqual([]);
    w.director.begin(11);
    expect(w.ctx.harmony.seed).toBe(11);
    expect(w.bridge.fundamental).toBe(w.ctx.harmony.root);
    w.run(1.4);
    expect(w.chapters[0].entered).toBe(0);
    w.run(0.2);
    expect(w.chapters[0].entered).toBe(1);
    expect(w.bridge.chapter).toBe(0);
  });

  it('an unanswered journey is assisted 1 → 2 → 3 in every chapter and still reaches the end', () => {
    const w = world();
    w.director.begin(3);
    expect(w.runUntil(() => w.director.ended, 500)).toBe(true);
    for (const ch of w.chapters) {
      expect(ch.entered).toBe(1);
      expect(ch.disposed).toBe(1);
      const assists = w.log.filter((l) => l.startsWith(`${ch.numeral}:assist`)).map((l) => l.split(':')[1].slice(0, 7));
      expect(assists).toEqual(['assist1', 'assist2', 'assist3']);
    }
    // Order of the whole journey, and no chapter is entered before the previous one is disposed.
    const order = w.log.filter((l) => /:(enter|dispose)$/.test(l));
    expect(order).toEqual(['I:enter', 'I:dispose', 'II:enter', 'II:dispose', 'III:enter', 'III:dispose', 'IV:enter', 'IV:dispose', 'V:enter', 'V:dispose']);
    expect(w.ended()).toBe(1);
    expect(w.bridge.chapter).toBe(5);
    expect(w.stage.grade.fade).toBe(1);
    expect(w.calls.ending[w.calls.ending.length - 1]).toBe(true);
    expect(w.calls.progress).toBe(1);
    // Assistance arrives at 55 / 85 / 110 % of the first chapter's target length.
    const first = w.log.filter((l) => l.startsWith('I:assist')).map((l) => Number(l.split('@')[1]));
    expect(first[0]).toBeCloseTo(CHAPTER_SECONDS[0] * 0.55, 0);
    expect(first[1]).toBeCloseTo(CHAPTER_SECONDS[0] * 0.85, 0);
    expect(first[2]).toBeCloseTo(CHAPTER_SECONDS[0] * 1.1, 0);
    // A late visitor is helped sooner in the next chapter, never later.
    const second = Number(w.log.find((l) => l.startsWith('II:assist1'))!.split('@')[1]);
    expect(second).toBeLessThan(CHAPTER_SECONDS[1] * 0.55);
    expect(second).toBeGreaterThanOrEqual(CHAPTER_SECONDS[1] * 0.75 * 0.55 - 0.1);
  });

  it('a quick visitor is never held back, and gestures are remembered', () => {
    const w = world();
    for (const ch of w.chapters) ch.solveAt = 6;
    w.director.begin(5);
    w.run(4);
    w.interaction.onGesture?.();
    w.interaction.onGesture?.();
    expect(w.memory.data.gestures.length).toBe(2);
    expect(w.runUntil(() => w.director.ended, 120)).toBe(true);
    expect(w.director.elapsed).toBeLessThan(60);
    expect(w.log.some((l) => l.includes('assist'))).toBe(false);
  });

  it('retires a chapter that never completes, and survives one that throws', () => {
    const w = world();
    w.chapters[0].autoSeconds = Infinity; // ignores even assist(3)
    w.chapters[1].throwIn = 'enter';
    w.chapters[2].throwIn = 'update';
    w.chapters[3].solveAt = 2;
    w.chapters[4].solveAt = 2;
    const error = console.error;
    console.error = () => undefined;
    try {
      w.director.begin(9);
      expect(w.runUntil(() => w.chapters[0].disposed === 1, 120)).toBe(true);
      const forced = Number(w.log.find((l) => l.startsWith('I:exit'))!.split('@')[1]);
      expect(forced).toBeCloseTo(CHAPTER_SECONDS[0] * 1.1 + 25, 0);
      expect(w.runUntil(() => w.director.ended, 60)).toBe(true);
    } finally {
      console.error = error;
    }
    expect(w.chapters[3].entered).toBe(1);
    expect(w.ended()).toBe(1);
  });

  it('restart dips to black, tears the world down once, and begins again from I', () => {
    const w = world();
    w.director.begin(21);
    w.run(20);
    w.interaction.onGesture?.();
    const resets = w.calls.reset;
    w.director.begin(22);
    expect(w.stage.grade.fade).toBe(1);
    expect(w.calls.reset).toBe(resets + 1); // sound stops at once
    expect(w.memory.data.gestures.length).toBe(0);
    w.run(0.3);
    expect(w.chapters[0].disposed).toBe(0); // still sinking into black
    w.run(0.6);
    expect(w.chapters[0].disposed).toBe(1);
    expect(w.ctx.harmony.seed).toBe(22);
    expect(w.bridge.presence).toBe(0);
    w.run(1.6);
    expect(w.chapters[0].entered).toBe(2);
    expect(w.stage.grade.fade).toBe(0);
    expect(w.director.elapsed).toBeLessThan(3);
    w.director.dispose();
    expect(w.chapters[0].disposed).toBe(2);
    expect(w.interaction.onGesture).toBe(null);
  });

  it('begin + jump (the ?chapter=N path) enters that chapter at once, with nothing of the old one left', () => {
    for (let i = 0; i < 5; i++) {
      const w = world();
      w.director.begin(30 + i);
      w.director.jump(i);
      expect(w.director.chapterIndex).toBe(i);
      expect(w.chapters[i].entered).toBe(1);
      expect(w.bridge.chapter).toBe(i);
      expect(w.director.elapsed).toBe(CHAPTER_SECONDS.slice(0, i).reduce((a, b) => a + b, 0));
      w.run(5);
      expect(w.bridge.presence).toBeGreaterThan(0.5);
      // Jumping away from a live chapter silences it.
      const resets = w.calls.reset;
      w.director.jump((i + 1) % 5);
      expect(w.calls.reset).toBe(resets + 1);
      expect(w.chapters[i].disposed).toBe(1);
      expect(w.chapters[(i + 1) % 5].entered).toBe(1);
      for (const wave of w.bridge.waves) expect(wave.level).toBe(0);
    }
  });
});
