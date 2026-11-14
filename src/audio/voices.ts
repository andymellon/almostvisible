/**
 * Eight sustained, continuously tunable voices. Voice ids are bridge.waves slots.
 *
 * Every voice has one pitch signal (a ConstantSource) that all of its oscillators and
 * pitch-tracking filters follow, so a frequency change is a single glide (time constant
 * 18 ms ≈ 55 ms to settle) with no partial left behind.
 *
 * Beating is real, not simulated: the timbres carry low harmonics, so two voices a
 * mistuned fifth apart beat at 3·f₁ − 2·f₂ exactly as two strings would, and the shared
 * voice bus has a very mild asymmetric non-linearity that adds combination tones
 * (f₂ − f₁, 2f₁ − f₂) which beat against each other below the pair.
 */
import type { Vec3Like, VoiceTimbre } from '../core/contracts';
import { MAX_WAVES } from '../core/contracts';
import { Patch, Smooth, clamp01, depthCutoff, depthGain, depthSend, fin, place, type Placement, type Rig } from './graph';
import type { Space } from './space';

const GLIDE = 0.018;
/** Peak of one voice at level 1, close. */
const VOICE_GAIN = 0.09;
const ATTACK = 0.12;
const BUS_DRIVE = 2.5;

/**
 * Per-timbre trim. `pure` is nearly a sine and is voiced up, `glass` is dense with harmonics and
 * is voiced down: at equal `level` the two are then about equally loud, and a quiet pure voice
 * placed a few cents from a glass one (chapter II's sympathetic tone, level 0.14 against 0.68)
 * has half the amplitude of the glass voice's fundamental — a beat of about 9 dB, not 5.
 */
const TRIM: Record<VoiceTimbre, number> = { pure: 1.4, glass: 0.65, fm: 0.75, breath: 1 };
/** Low-pass cutoff = pitch × (base + span × brightness). */
const TONE: Record<VoiceTimbre, readonly [number, number]> = {
  pure: [3, 9],
  glass: [5, 14],
  fm: [6, 12],
  breath: [4, 10],
};

interface Voice {
  timbre: VoiceTimbre;
  patch: Patch;
  freq: Smooth;
  amp: Smooth;
  tone: Smooth;
  pan: Smooth;
  dist: Smooth;
  send: Smooth;
  /** FM index (fm) */
  index: Smooth | null;
  /** Noise amount (breath) */
  air: Smooth | null;
  hz: number;
  level: number;
  bright: number;
  depth: number;
}

const clampHz = (hz: number): number => (hz < 16 ? 16 : hz > 8000 ? 8000 : hz);

export class Voices {
  private readonly patch: Patch;
  private readonly bus: GainNode;
  private readonly sendBus: GainNode;
  private readonly busLevel: Smooth;
  private readonly sendLevel: Smooth;
  private readonly slots: (Voice | null)[] = [];
  private readonly at: Placement = { pan: 0, depth: 0.3 };
  private readonly top: number;

  constructor(
    private readonly rig: Rig,
    space: Space,
  ) {
    const p = (this.patch = new Patch(rig));
    this.top = Math.min(16000, rig.sampleRate * 0.45);
    for (let i = 0; i < MAX_WAVES; i++) this.slots.push(null);

    this.bus = p.gain(1);
    const pre = p.gain(BUS_DRIVE / 2);
    const ear = p.shaper(makeCombinationCurve());
    const post = p.gain(1 / BUS_DRIVE);
    this.bus.connect(pre);
    pre.connect(ear);
    ear.connect(post);
    post.connect(space.dry);
    this.sendBus = p.gain(1);
    this.sendBus.connect(space.reverbIn);
    this.busLevel = new Smooth(rig, this.bus.gain, 1);
    this.sendLevel = new Smooth(rig, this.sendBus.gain, 1);
  }

  private build(timbre: VoiceTimbre, hz: number, level: number, bright: number, pos: Vec3Like | undefined): Voice {
    const rig = this.rig;
    const p = new Patch(rig);
    const at = place(pos, this.at);
    const fc = p.constant(hz);
    const [base, span] = TONE[timbre];
    const tone = p.filter('lowpass', Math.min(this.top, hz * (base + span * bright)), 0.6);
    const amp = p.gain(0);
    const dist = p.filter('lowpass', depthCutoff(at.depth), 0.5);
    const pan = p.pan(at.pan);
    const send = p.gain(depthSend(at.depth));
    tone.connect(amp);
    amp.connect(dist);
    dist.connect(pan);
    pan.connect(this.bus);
    pan.connect(send);
    send.connect(this.sendBus);

    let index: Smooth | null = null;
    let air: Smooth | null = null;

    if (timbre === 'fm') {
      // Carrier : modulator = 1 : 2 — a hollow, clarinet-like spectrum whose edge is the index.
      const car = p.osc('sine', 0);
      const mod = p.osc('sine', 0);
      const ratio = p.gain(2);
      const dev = p.gain(0);
      const idx = p.gain(fmIndex(bright));
      fc.connect(car.frequency);
      fc.connect(ratio);
      ratio.connect(mod.frequency);
      mod.connect(dev);
      dev.connect(car.frequency);
      fc.connect(idx);
      idx.connect(dev.gain);
      car.connect(tone);
      index = new Smooth(rig, idx.gain, fmIndex(bright));
    } else if (timbre === 'breath') {
      // A quiet tone inside pitched air: noise through resonances at the pitch and its octave.
      const o = p.osc(rig.softWave, 0);
      const og = p.gain(0.45);
      fc.connect(o.frequency);
      o.connect(og);
      og.connect(tone);
      const n = p.noise(hz * 0.013);
      const bp1 = p.filter('bandpass', 0, 14);
      const bp2 = p.filter('bandpass', 0, 9);
      const oct = p.gain(2);
      const upper = p.gain(0.5);
      const ng = p.gain(breathAir(bright));
      fc.connect(bp1.frequency);
      fc.connect(oct);
      oct.connect(bp2.frequency);
      n.connect(bp1);
      n.connect(bp2);
      bp1.connect(ng);
      bp2.connect(upper);
      upper.connect(ng);
      ng.connect(tone);
      air = new Smooth(rig, ng.gain, breathAir(bright));
    } else {
      const o = p.osc(timbre === 'glass' ? rig.glassWave : rig.softWave, 0);
      fc.connect(o.frequency);
      o.connect(tone);
    }

    return {
      timbre,
      patch: p,
      freq: new Smooth(rig, fc.offset, hz),
      amp: new Smooth(rig, amp.gain, 0),
      tone: new Smooth(rig, tone.frequency, tone.frequency.value),
      pan: new Smooth(rig, pan.pan, at.pan),
      dist: new Smooth(rig, dist.frequency, dist.frequency.value),
      send: new Smooth(rig, send.gain, send.gain.value),
      index,
      air,
      hz,
      level,
      bright,
      depth: at.depth,
    };
  }

  private apply(v: Voice, ampTc: number): void {
    const shape = TONE[v.timbre];
    v.freq.to(v.hz, GLIDE);
    v.tone.to(Math.min(this.top, v.hz * (shape[0] + shape[1] * v.bright)), 0.08);
    v.amp.to(VOICE_GAIN * TRIM[v.timbre] * v.level * depthGain(v.depth), ampTc);
    if (v.index) v.index.to(fmIndex(v.bright), 0.08);
    if (v.air) v.air.to(breathAir(v.bright), 0.08);
  }

  private move(v: Voice, pos: Vec3Like): void {
    const at = place(pos, this.at);
    v.depth = at.depth;
    v.pan.to(at.pan, 0.05);
    v.dist.to(depthCutoff(at.depth), 0.08);
    v.send.to(depthSend(at.depth), 0.1);
  }

  on(id: number, freq: number, level: number, timbre: VoiceTimbre, pos: Vec3Like | undefined): void {
    if (!(id >= 0 && id < MAX_WAVES) || !(freq > 0) || !Number.isFinite(freq)) return;
    id = Math.floor(id);
    const hz = clampHz(freq);
    const lv = clamp01(level);
    const cur = this.slots[id];
    if (cur && cur.timbre === timbre) {
      // Already sounding: voiceOn is idempotent, it only updates.
      cur.hz = hz;
      cur.level = lv;
      if (pos) this.move(cur, pos);
      this.apply(cur, 0.06);
      return;
    }
    if (cur) this.off(id, 0.25);
    const v = this.build(timbre, hz, lv, 0.5, pos);
    this.slots[id] = v;
    this.apply(v, ATTACK);
  }

  set(id: number, p: { freq?: number; level?: number; brightness?: number; pos?: Vec3Like }): void {
    if (!(id >= 0 && id < MAX_WAVES)) return;
    const v = this.slots[Math.floor(id)];
    if (!v) return;
    const f = fin(p.freq, 0);
    if (f > 0) v.hz = clampHz(f);
    if (p.level !== undefined) v.level = clamp01(fin(p.level, v.level));
    if (p.brightness !== undefined) v.bright = clamp01(fin(p.brightness, v.bright));
    if (p.pos) this.move(v, p.pos);
    this.apply(v, 0.06);
  }

  /** Soft release: −40 dB after `release` seconds, nodes freed once inaudible. */
  off(id: number, release: number): void {
    if (!(id >= 0 && id < MAX_WAVES)) return;
    id = Math.floor(id);
    const v = this.slots[id];
    if (!v) return;
    this.slots[id] = null;
    const r = Math.max(0.03, fin(release, 1.2));
    v.amp.force(0, r / 4.6);
    v.patch.freeAt(this.rig.now + r * 1.6 + 0.05);
  }

  allOff(release: number): void {
    for (let i = 0; i < MAX_WAVES; i++) this.off(i, release);
  }

  /** Dissolve multiplier for the whole voice group (dry and send). */
  setFade(m: number, tc: number): void {
    this.busLevel.to(m, tc);
    this.sendLevel.to(m, tc);
  }

  dispose(): void {
    for (let i = 0; i < MAX_WAVES; i++) {
      const v = this.slots[i];
      if (v) v.patch.free();
      this.slots[i] = null;
    }
    this.patch.free();
  }
}

/** Index × modulator ratio (deviation = this × pitch, in Hz). */
const fmIndex = (bright: number): number => (0.25 + 1.6 * bright) * 2;
const breathAir = (bright: number): number => 2.2 + 5 * bright;

/**
 * y = x + 0.12·x² − 0.12·x³ on |x| ≤ 1 (x = bus signal × BUS_DRIVE), continued linearly
 * outside so it stays monotonic. At ordinary levels the added harmonics are below −30 dB;
 * what it contributes are difference tones between voices.
 */
function makeCombinationCurve(): Float32Array<ArrayBuffer> {
  const n = 4097;
  const a = 0.12;
  const b = 0.12;
  const g = (x: number) => x + a * x * x - b * x * x * x;
  const slope = (x: number) => 1 + 2 * a * x - 3 * b * x * x;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    curve[i] = x > 1 ? g(1) + slope(1) * (x - 1) : x < -1 ? g(-1) + slope(-1) * (x + 1) : g(x);
  }
  return curve;
}
