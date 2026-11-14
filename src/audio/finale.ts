/**
 * Chapter V: the composition the visitor has been writing all along.
 *
 *   memory.resonators      → the melodic cell (scale degrees, in the order they were woken)
 *   memory.tuning.ratio    → the governing interval: the low dyad of the pad, the halo
 *                            stacked above it, and the "answer" that follows a phrase.
 *                            A ratio the visitor left slightly impure stays impure and beats.
 *   memory.tuning.seconds  → patience: a visitor who tuned slowly gets a slower piece
 *   memory.constellation   → where things are: each pad tone sits at its fragment's position,
 *                            melodic events travel through the fragment positions in order;
 *                            its degrees are the pad's middle voices and the transpositions
 *                            the cell goes through
 *   memory.balance         → the layer mix: Earth / Air / Light return at the remembered
 *                            balance, and weight the pad's low, middle and high voices
 *   memory.gestures        → rhythm: the inter-onset intervals of the visitor's own gestures,
 *                            rescaled so their median is 2.4 s, become the durations
 *                            between melodic events (proportions preserved)
 *
 * `intensity` raises the pad, the remembered fields, the velocity and the density.
 */
import type { Bridge, Harmony, MemorySnapshot, Vec3Like } from '../core/contracts';
import { createMemory } from '../core/memory';
import type { Fields } from './fields';
import { Patch, Smooth, clamp01, depthCutoff, depthGain, fin, place, type Placement, type Rig } from './graph';
import type { Space } from './space';
import type { Strikes } from './strikes';

const PAD_GAIN = 0.07;
const FIELD_SHARE = 0.85;
const MEDIAN_IOI = 2.4;
const FALLBACK_RHYTHM = [2.4, 1.6, 3.6, 2.4, 1.2, 4.8];

interface Tone {
  hz: number;
  gain: number;
  pan: number;
  depth: number;
  pure: boolean;
}

interface Plan {
  cell: number[];
  transposes: number[];
  ratio: number;
  iois: number[];
  places: Placement[];
  world: Vec3Like[];
  chord: Tone[];
  tempo: number;
  lightWeight: number;
  balance: MemorySnapshot['balance'];
}

interface Twin {
  b: Smooth;
  hz: number;
  beat: number;
  spread: number;
}

interface Pad {
  patch: Patch;
  level: Smooth;
  twins: Twin[];
}

const weight = (level: number | undefined): number => 0.3 + 0.7 * clamp01(fin(level, 0.5));

function compile(m: MemorySnapshot, h: Harmony): Plan {
  const root = h.root;

  // melodic cell
  const cell: number[] = [];
  for (const d of m.resonators ?? []) if (Number.isFinite(d) && cell.length < 8) cell.push(Math.round(d));
  if (cell.length === 0) cell.push(0, 4, 2);

  // governing interval, folded into one octave
  let ratio = fin(m.tuning?.ratio, 1.5);
  if (!(ratio > 0)) ratio = 1.5;
  while (ratio >= 2) ratio /= 2;
  while (ratio < 1) ratio *= 2;
  if (ratio < 1.03) ratio = 2;
  const near = h.nearest(root * ratio);
  if (Math.abs(1200 * Math.log2((root * ratio) / near)) < 6) ratio = near / root;
  const tempo = Math.min(1.6, Math.max(0.75, 0.75 + fin(m.tuning?.seconds, 20) / 60));

  // rhythm
  const times: number[] = [];
  for (const t of m.gestures ?? []) if (Number.isFinite(t)) times.push(t);
  times.sort((a, b) => a - b);
  let iois: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d >= 0.12 && d <= 20) iois.push(d);
  }
  if (iois.length >= 3) {
    iois = iois.slice(-32);
    const sorted = iois.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const scale = MEDIAN_IOI / median;
    iois = iois.map((d) => Math.min(7.5, Math.max(0.55, d * scale)));
  } else {
    const shift = (((cell[0] + cell.length) % FALLBACK_RHYTHM.length) + FALLBACK_RHYTHM.length) % FALLBACK_RHYTHM.length;
    iois = FALLBACK_RHYTHM.map((_, i) => FALLBACK_RHYTHM[(i + shift) % FALLBACK_RHYTHM.length]);
  }

  // placement
  const world: Vec3Like[] = [];
  for (const p of m.constellation?.positions ?? []) {
    if (p && world.length < 8) world.push({ x: fin(p.x, 0), y: fin(p.y, 0), z: fin(p.z, 0) });
  }
  if (world.length === 0) world.push({ x: -1.2, y: -0.5, z: 0 }, { x: 1.2, y: -0.5, z: 0.2 }, { x: 0, y: 1.1, z: -0.3 });
  const places = world.map((p) => place(p, { pan: 0, depth: 0.3 }));

  const degrees: number[] = [];
  for (const d of m.constellation?.degrees ?? []) if (Number.isFinite(d) && degrees.length < 8) degrees.push(Math.round(d));
  if (degrees.length === 0) degrees.push(0, 4, 2);
  const transposes = [0, ...degrees];

  // pad
  const wEarth = weight(m.balance?.earth?.level);
  const wAir = weight(m.balance?.air?.level);
  const wLight = weight(m.balance?.light?.level);
  const chord: Tone[] = [];
  const add = (hz: number, gain: number, pan: number, depth: number, pure: boolean) => {
    for (const t of chord) if (Math.abs(1200 * Math.log2(hz / t.hz)) < 4) return;
    chord.push({ hz, gain, pan, depth, pure });
  };
  add(root * 2, 0.3 * wEarth, -0.1, 0.15, false);
  add(root * 2 * ratio, 0.22 * wEarth, 0.1, 0.2, false);
  for (let i = 0; i < Math.min(4, degrees.length); i++) {
    let hz = h.freq(degrees[i], 2);
    while (hz > root * 10) hz /= 2;
    while (hz < root * 3.5) hz *= 2;
    const at = places[i % places.length];
    add(hz, 0.2 * wAir, at.pan, at.depth, false);
  }
  let halo = root * 8;
  for (let i = 0; i < 2; i++) {
    halo *= ratio;
    while (halo >= root * 32) halo /= 2;
    add(halo, (0.07 - 0.02 * i) * wLight, i === 0 ? -0.6 : 0.6, 0.55, true);
  }

  return { cell, transposes, ratio, iois, places, world, chord, tempo, lightWeight: wLight, balance: m.balance };
}

export class Finale {
  private memory: MemorySnapshot | null = null;
  private plan: Plan | null = null;
  private pad: Pad | null = null;
  private harmony: Harmony;
  private intensity = 0;
  private rough = 0.09;
  private clock = 0;
  private nextAt = 1.5;
  private step = 0;
  private answerAt = -1;
  private answerHz = 0;
  private answerPan = 0;
  private answerDepth = 0.4;
  private answerVel = 0;

  constructor(
    private readonly rig: Rig,
    private readonly space: Space,
    private readonly strikes: Strikes,
    private readonly fields: Fields,
    harmony: Harmony,
  ) {
    this.harmony = harmony;
  }

  setMemory(m: MemorySnapshot): void {
    this.memory = m;
    this.rebuild();
  }

  retune(h: Harmony): void {
    this.harmony = h;
    if (this.plan) this.rebuild();
  }

  private rebuild(): void {
    this.plan = compile(this.memory ?? createMemory().data, this.harmony);
    this.step = 0;
    this.nextAt = this.clock + 1.5;
    this.answerAt = -1;
    this.releasePad(1.2);
    if (this.intensity > 0.01) this.pad = this.buildPad(this.plan);
    this.fields.remember(this.plan.balance, this.intensity * FIELD_SHARE);
  }

  setIntensity(intensity: number): void {
    this.intensity = clamp01(fin(intensity, 0));
    if (this.intensity > 0.01) {
      if (!this.plan) this.rebuild();
      if (this.plan && !this.pad) this.pad = this.buildPad(this.plan);
    }
    if (this.plan) this.fields.remember(this.plan.balance, this.intensity * FIELD_SHARE);
  }

  setStability(s: number): void {
    this.rough = (1 - s) * (1 - s);
    const pad = this.pad;
    if (!pad) return;
    for (let i = 0; i < pad.twins.length; i++) {
      const t = pad.twins[i];
      t.b.to(t.hz + t.beat + t.spread * this.rough, 0.5);
    }
  }

  private buildPad(plan: Plan): Pad {
    const rig = this.rig;
    const p = new Patch(rig);
    const bus = p.gain(0);
    const send = p.gain(0.35);
    bus.connect(this.space.texture);
    bus.connect(send);
    send.connect(this.space.reverbIn);
    const twins: Twin[] = [];
    for (let i = 0; i < plan.chord.length; i++) {
      const t = plan.chord[i];
      const wave = t.pure ? 'sine' : rig.softWave;
      const beat = 0.11 + 0.05 * i;
      const spread = 0.6 + 0.35 * i;
      const oa = p.osc(wave, t.hz);
      const ob = p.osc(wave, t.hz + beat + spread * this.rough);
      const g = p.gain(t.gain * depthGain(t.depth));
      const half = p.gain(0.5);
      const lp = p.filter('lowpass', depthCutoff(t.depth), 0.5);
      const pn = p.pan(t.pan);
      // Each tone breathes on its own period (9–17 s) so the chord is never the same twice.
      const lfo = p.osc('sine', 0.06 + 0.0137 * i);
      const depth = p.gain(t.gain * depthGain(t.depth) * 0.45);
      oa.connect(half);
      ob.connect(half);
      half.connect(g);
      lfo.connect(depth);
      depth.connect(g.gain);
      g.connect(lp);
      lp.connect(pn);
      pn.connect(bus);
      twins.push({ b: new Smooth(rig, ob.frequency, t.hz + beat + spread * this.rough), hz: t.hz, beat, spread });
    }
    return { patch: p, level: new Smooth(rig, bus.gain, 0), twins };
  }

  private releasePad(seconds: number): void {
    const pad = this.pad;
    if (!pad) return;
    this.pad = null;
    pad.level.force(0, seconds / 4.6);
    pad.patch.freeAt(this.rig.now + seconds * 1.6 + 0.05);
  }

  /**
   * Once per frame. `melody` false stops new melodic events (dissolve), `fade` scales the pad.
   * Melodic events also leave a soft attack in the bridge at their constellation position.
   */
  update(dt: number, rand: () => number, bridge: Bridge, melody: boolean, fade: number): void {
    const plan = this.plan;
    const i = this.intensity;
    if (this.pad) this.pad.level.to(PAD_GAIN * Math.pow(i, 1.2) * fade, 0.8);
    if (!plan || i < 0.02) return;
    this.clock += dt;

    if (this.answerAt >= 0 && this.clock >= this.answerAt) {
      this.answerAt = -1;
      if (melody) this.strikes.ping(this.answerHz, this.answerVel, 'bell', this.answerPan, this.answerDepth);
    }
    if (!melody || this.clock < this.nextAt) return;

    const k = this.step++;
    const len = plan.cell.length;
    const cycle = Math.floor(k / len);
    const pos = k % len;
    const ioi = plan.iois[k % plan.iois.length];
    this.nextAt = this.clock + (ioi * plan.tempo) / (0.7 + 0.6 * i);

    // Rests keep the line sparse while the finale is still gathering.
    if (pos !== 0 && rand() < 0.22 * (1 - i)) return;

    const degree = plan.cell[pos] + plan.transposes[cycle % plan.transposes.length];
    const long = ioi > 2.6;
    const short = ioi < 1.1;
    let hz = this.harmony.freq(degree, long ? 2 : short ? 4 : 3);
    while (hz > 2400) hz *= 0.5;
    const slot = k % plan.places.length;
    const at = plan.places[slot];
    const vel = (0.22 + 0.4 * i) * plan.lightWeight * (long ? 1 : 0.8);
    this.strikes.ping(hz, vel, short ? 'glass' : 'bell', at.pan, at.depth);

    const w = plan.world[slot];
    const mark = 0.35 + 0.4 * i;
    if (bridge.attack < mark) bridge.attack = mark;
    bridge.attackAt.set(w.x, w.y, w.z);

    // The governing interval answers: after a long note, and at the end of every other statement.
    if (long || (pos === len - 1 && cycle % 2 === 1)) {
      let answer = hz * plan.ratio;
      while (answer > 3000) answer *= 0.5;
      this.answerHz = answer;
      this.answerAt = this.clock + 0.24 * plan.tempo;
      this.answerPan = -at.pan;
      this.answerDepth = Math.min(1, at.depth + 0.25);
      this.answerVel = vel * 0.6;
    }
  }

  /** Reset: release the pad and forget the composition. */
  stop(): void {
    this.releasePad(0.25);
    this.plan = null;
    this.memory = null;
    this.intensity = 0;
    this.clock = 0;
    this.nextAt = 1.5;
    this.step = 0;
    this.answerAt = -1;
    this.fields.remember(null, 0);
  }

  dispose(): void {
    if (this.pad) this.pad.patch.free();
    this.pad = null;
  }
}
