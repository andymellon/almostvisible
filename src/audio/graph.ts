/**
 * Low-level plumbing shared by every part of the instrument.
 *
 * Tone.js owns the AudioContext, the Transport and the master dynamics / convolver;
 * the voices themselves are raw Web Audio nodes created *through* Tone's context so
 * that envelopes and additive modulation are sample-accurate and free of look-ahead
 * latency (dragging an object must sweep its pitch immediately).
 *
 * Envelope rule used everywhere: only setTargetAtTime (exponential approach) is ever
 * scheduled on a gain. Cancelling such a timeline never makes the value jump, so
 * retriggering, stealing and reset() are click-free by construction.
 */
import * as Tone from 'tone';
import type { Vec3Like } from '../core/contracts';
import { mulberry32 } from '../core/math';

export type Ctx = Tone.BaseContext;

export const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);
/** Finite number or the fallback. Public inputs pass through this: a NaN must never reach an AudioParam. */
export const fin = (x: number | undefined, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
export const sstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** A group of nodes that are built, sound and are freed together. */
export class Patch {
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly toneNodes: Tone.ToneAudioNode[] = [];
  dead = false;

  constructor(readonly rig: Rig) {
    rig.adopt(this);
  }

  gain(value = 1): GainNode {
    const g = this.rig.ctx.createGain();
    g.gain.value = value;
    this.nodes.push(g);
    return g;
  }

  /** A running oscillator. `at` defers the start (absolute context time). */
  osc(wave: OscillatorType | PeriodicWave, freq: number, at?: number): OscillatorNode {
    const o = this.rig.ctx.createOscillator();
    if (typeof wave === 'string') o.type = wave as OscillatorType;
    else o.setPeriodicWave(wave);
    o.frequency.value = freq;
    if (at === undefined) o.start();
    else o.start(at);
    this.nodes.push(o);
    this.sources.push(o);
    return o;
  }

  /** A running DC source; used as a shared, glidable pitch signal. */
  constant(value: number): ConstantSourceNode {
    const c = this.rig.ctx.createConstantSource();
    c.offset.value = value;
    c.start();
    this.nodes.push(c);
    this.sources.push(c);
    return c;
  }

  /**
   * `q` is always a plain quality factor (0.7071 = maximally flat). Web Audio reads the Q of
   * low-pass and high-pass filters in decibels of resonance instead, so it is converted here:
   * without this a "soft" Q of 0.5 would be +0.5 dB of peak at the cutoff rather than −6 dB.
   */
  filter(type: BiquadFilterType, freq: number, q = 0.7071): BiquadFilterNode {
    const f = this.rig.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q;
    this.nodes.push(f);
    return f;
  }

  /** Equal-power stereo placement. */
  pan(value = 0): StereoPannerNode {
    const p = this.rig.ctx.createStereoPanner();
    p.pan.value = value;
    this.nodes.push(p);
    return p;
  }

  delay(maxSeconds: number, seconds: number): DelayNode {
    const d = this.rig.ctx.createDelay(maxSeconds);
    d.delayTime.value = seconds;
    this.nodes.push(d);
    return d;
  }

  shaper(curve: Float32Array<ArrayBuffer>): WaveShaperNode {
    const s = this.rig.ctx.createWaveShaper();
    s.curve = curve;
    s.oversample = 'none';
    this.nodes.push(s);
    return s;
  }

  /** Looping synthesised noise. `offset` decorrelates several readers of the same buffer. */
  noise(offset = 0): AudioBufferSourceNode {
    const s = this.rig.ctx.createBufferSource();
    s.buffer = this.rig.noiseBuffer;
    s.loop = true;
    s.loopStart = 0;
    s.loopEnd = this.rig.noiseLoop;
    s.start(0, offset % this.rig.noiseLoop);
    this.nodes.push(s);
    this.sources.push(s);
    return s;
  }

  analyser(fftSize: number, smoothing: number): AnalyserNode {
    const a = this.rig.ctx.createAnalyser();
    a.fftSize = fftSize;
    a.smoothingTimeConstant = smoothing;
    this.nodes.push(a);
    return a;
  }

  splitter(outputs: number): ChannelSplitterNode {
    const s = this.rig.ctx.createChannelSplitter(outputs);
    this.nodes.push(s);
    return s;
  }

  /** Adopt a Tone.js node so it is disposed with this patch. */
  own<T extends Tone.ToneAudioNode>(node: T): T {
    this.toneNodes.push(node);
    return node;
  }

  /** Stop every source at `time` (they must already be inaudible) and free the nodes shortly after. */
  freeAt(time: number): void {
    if (this.dead) return;
    this.rig.bury(this, time);
  }

  free(): void {
    if (this.dead) return;
    this.dead = true;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* never started or already stopped */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    for (const t of this.toneNodes) {
      try {
        t.dispose();
      } catch {
        /* already disposed */
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    this.toneNodes.length = 0;
    this.rig.forget(this);
  }
}

/**
 * A smoothed AudioParam. Remembers its last target so per-frame calls that do not
 * change anything schedule nothing (no automation build-up, no zipper noise).
 */
export class Smooth {
  private last: number;

  constructor(
    private readonly rig: Rig,
    private readonly param: AudioParam,
    initial: number,
  ) {
    param.value = initial;
    this.last = initial;
  }

  get target(): number {
    return this.last;
  }

  /** Approach `value` exponentially with time constant `tc` seconds (≈ 95 % after 3·tc). */
  to(value: number, tc: number): void {
    if (!Number.isFinite(value)) return;
    const d = value - this.last;
    if ((d < 0 ? -d : d) <= 1e-5 * (1 + (this.last < 0 ? -this.last : this.last))) return;
    this.last = value;
    this.param.setTargetAtTime(value, this.rig.ctx.currentTime, tc > 0.001 ? tc : 0.001);
  }

  /** Same, but always re-issued and clearing anything scheduled later (reset paths). */
  force(value: number, tc: number): void {
    if (!Number.isFinite(value)) return;
    const now = this.rig.ctx.currentTime;
    this.last = value;
    this.param.cancelScheduledValues(now);
    this.param.setTargetAtTime(value, now, tc > 0.001 ? tc : 0.001);
  }
}

interface Burial {
  patch: Patch;
  at: number;
}

/** The shared context, synthesised source material and the life-cycle of every patch. */
export class Rig {
  readonly sampleRate: number;
  /** Near-sine with a few soft harmonics, so mistuned intervals between two voices beat audibly. */
  readonly softWave: PeriodicWave;
  /** Odd-weighted, glassy. */
  readonly glassWave: PeriodicWave;
  /** Gently rolled-off full series for the drone body. */
  readonly reedWave: PeriodicWave;

  private readonly patches = new Set<Patch>();
  private readonly grave: Burial[] = [];
  private noise: { buffer: AudioBuffer; loop: number } | null = null;

  /**
   * @param lite reduced tier (phones, tablets): a shorter room, fewer resonators and grains.
   */
  constructor(
    readonly ctx: Ctx,
    readonly lite = false,
  ) {
    this.sampleRate = ctx.sampleRate;
    this.softWave = makeWave(ctx, [1, 0.3, 0.2, 0.08, 0.04, 0.015]);
    this.glassWave = makeWave(ctx, [1, 0.2, 0.42, 0.06, 0.26, 0.03, 0.14, 0.02, 0.09, 0, 0.05]);
    const reed: number[] = [];
    for (let n = 1; n <= 24; n++) reed.push(1 / Math.pow(n, 1.35));
    this.reedWave = makeWave(ctx, reed);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /**
   * Five seconds of pink noise (synthesised, seeded), RMS ≈ 0.25. Nothing needs it before
   * chapter IV, so it is not generated inside start(): the engine warms it during an idle
   * frame (see warm()), and whoever asks first gets it made on the spot otherwise.
   */
  get noiseBuffer(): AudioBuffer {
    return this.warm().buffer;
  }

  /** Loop length in seconds (the tail beyond it is crossfaded into the head). */
  get noiseLoop(): number {
    return this.warm().loop;
  }

  get noiseReady(): boolean {
    return this.noise !== null;
  }

  warm(): { buffer: AudioBuffer; loop: number } {
    if (!this.noise) this.noise = makePinkNoise(this.ctx, 5);
    return this.noise;
  }

  adopt(p: Patch): void {
    this.patches.add(p);
  }

  forget(p: Patch): void {
    this.patches.delete(p);
  }

  bury(patch: Patch, at: number): void {
    this.grave.push({ patch, at });
  }

  /** Free patches whose release has finished. Called once per frame; allocates nothing. */
  sweep(): void {
    const g = this.grave;
    if (g.length === 0) return;
    const now = this.ctx.currentTime;
    for (let i = g.length - 1; i >= 0; i--) {
      if (g[i].at <= now) {
        g[i].patch.free();
        g[i] = g[g.length - 1];
        g.pop();
      }
    }
  }

  dispose(): void {
    this.grave.length = 0;
    for (const p of Array.from(this.patches)) p.free();
    this.patches.clear();
  }
}

function makeWave(ctx: Ctx, harmonics: number[]): PeriodicWave {
  const n = harmonics.length + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < harmonics.length; i++) imag[i + 1] = harmonics[i];
  return ctx.createPeriodicWave(real, imag);
}

function makePinkNoise(ctx: Ctx, seconds: number): { buffer: AudioBuffer; loop: number } {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  // The noise itself carries no identity; a fixed seed keeps the instrument deterministic.
  const rand = mulberry32(0x51a7e5);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const w = rand() * 2 - 1;
    // Paul Kellet's pink filter
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    d[i] = v;
    sum += v * v;
  }
  const norm = 0.25 / Math.sqrt(sum / len + 1e-12);
  for (let i = 0; i < len; i++) d[i] *= norm;
  // Seamless loop: the head is crossfaded with what follows the loop end, so the
  // sample after (len - fade - 1) is exactly the sample at 0.
  const fade = Math.min(2048, len >> 2);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i] * Math.sqrt(t) + d[len - fade + i] * Math.sqrt(1 - t);
  }
  return { buffer: buf, loop: (len - fade) / sr };
}

/** Stereo / depth placement derived from a world position. */
export interface Placement {
  /** -1 … 1, equal-power. */
  pan: number;
  /** 0 = close … 1 = far. */
  depth: number;
}

/**
 * World → sound stage. x → pan (soft-limited so nothing sits hard in one ear),
 * z → depth (three.js convention: +z toward the viewer). Writes into `out`; no allocation.
 */
export function place(pos: Vec3Like | undefined, out: Placement): Placement {
  if (!pos) {
    out.pan = 0;
    out.depth = 0.3;
    return out;
  }
  const x = fin(pos.x, 0);
  const z = fin(pos.z, 0);
  out.pan = Math.tanh(x / 2.4) * 0.94;
  out.depth = clamp01(0.3 - z / 7);
  return out;
}

/** Air absorption: the far field is darker. */
export const depthCutoff = (depth: number): number => 1500 * Math.pow(2, 3.4 * (1 - depth));
/** Distance attenuation (gentle: depth is mostly carried by the low-pass and the reverb). */
export const depthGain = (depth: number): number => 1 - 0.42 * depth;
/** The far field is wetter. */
export const depthSend = (depth: number): number => 0.15 + 0.5 * depth;
