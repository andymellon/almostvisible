/**
 * The drone: detuned oscillator pairs on the root and its harmonics.
 * Each pair beats slowly (0.05–0.3 Hz when stable, up to a few Hz when the world is
 * rough) and the two halves sit left and right, so the beating travels across the room.
 *
 * Three registers, because the root (46–62 Hz) is below what a laptop or a phone can play:
 *   sub    the root itself, a sine pair on the dry bus — felt on a full-range system
 *   low    harmonics 2 and 3 (92–186 Hz) — warmth
 *   upper  harmonics 4 · 6 · 8 · 12 … (184 Hz and up) from a reed pair on the double octave
 *          and a sine pair on the fifth above it — the part every loudspeaker reproduces,
 *          voiced so the drone is still there when the sub is not
 * Low and upper pass a low-pass and a resonant peak that wander over the overtones on three
 * incommensurate LFOs (periods 24–59 s): the spectrum never repeats.
 *
 * Nothing runs while the drone is silent: the oscillators are built when a level is first
 * asked for and stopped a few seconds after it has faded to nothing.
 */
import { Patch, Smooth, clamp01, type Rig } from './graph';
import type { Space } from './space';

interface LayerSpec {
  /** Harmonic of the root. */
  mult: number;
  wave: 'sine' | 'soft' | 'reed';
  gain: number;
  /** Beat rate in Hz when perfectly stable. */
  beat: number;
  /** Extra beat rate in Hz at stability 0. */
  spread: number;
  /** Stereo half-width of the pair. */
  width: number;
  sub: boolean;
}

const LAYERS: readonly LayerSpec[] = [
  { mult: 1, wave: 'sine', gain: 0.36, beat: 0.07, spread: 0.8, width: 0.12, sub: true },
  { mult: 2, wave: 'soft', gain: 0.14, beat: 0.13, spread: 1.5, width: 0.4, sub: false },
  { mult: 3, wave: 'sine', gain: 0.06, beat: 0.19, spread: 2.3, width: 0.6, sub: false },
  { mult: 1, wave: 'reed', gain: 0.08, beat: 0.05, spread: 1.1, width: 0.5, sub: false },
  { mult: 4, wave: 'reed', gain: 0.3, beat: 0.29, spread: 3.1, width: 0.75, sub: false },
  { mult: 6, wave: 'sine', gain: 0.24, beat: 0.23, spread: 2.6, width: 0.6, sub: false },
];

/** Output gains at level 1. Level is linear: 0.22 (chapter I, "barely there") is 13 dB under full. */
const SUB_GAIN = 0.15;
const BODY_GAIN = 0.24;
/** Low-pass cutoff = root × (LP_BASE + LP_SPAN × brightness). */
const LP_BASE = 6.5;
const LP_SPAN = 10;

interface Layer {
  spec: LayerSpec;
  a: Smooth;
  b: Smooth;
}

interface Built {
  patch: Patch;
  layers: Layer[];
  lp: Smooth;
  peak: Smooth;
  peakGain: Smooth;
  sweep1: Smooth;
  sweep2: Smooth;
  sweep3: Smooth;
  subOut: Smooth;
  bodyOut: Smooth;
}

export class Drone {
  private built: Built | null = null;
  /** Context time after which a silent drone is torn down (−1: it is sounding). */
  private quietAt = -1;
  private root: number;
  private rough = 0.09;
  private bright = 0.3;

  constructor(
    private readonly rig: Rig,
    private readonly space: Space,
    root: number,
  ) {
    this.root = root;
  }

  /** True while the oscillators exist. */
  get running(): boolean {
    return this.built !== null;
  }

  private build(): Built {
    const rig = this.rig;
    const root = this.root;
    const p = new Patch(rig);

    const sub = p.gain(0);
    const body = p.gain(0);
    const lp = p.filter('lowpass', root * (LP_BASE + LP_SPAN * this.bright), 0.6);
    const peak = p.filter('peaking', root * 5.5, 3.5);
    peak.gain.value = 5 + 6 * this.bright;
    lp.connect(peak);
    peak.connect(body);
    sub.connect(this.space.dry);
    body.connect(this.space.texture);
    const send = p.gain(0.2);
    body.connect(send);
    send.connect(this.space.reverbIn);

    const layers: Layer[] = [];
    for (const spec of LAYERS) {
      const wave = spec.wave === 'sine' ? 'sine' : spec.wave === 'soft' ? rig.softWave : rig.reedWave;
      const f = root * spec.mult;
      const fb = f + spec.beat + spec.spread * this.rough;
      const oa = p.osc(wave, f);
      const ob = p.osc(wave, fb);
      const ga = p.gain(spec.gain * 0.5);
      const gb = p.gain(spec.gain * 0.5);
      const pa = p.pan(-spec.width);
      const pb = p.pan(spec.width);
      oa.connect(ga);
      ob.connect(gb);
      ga.connect(pa);
      gb.connect(pb);
      const dest = spec.sub ? sub : lp;
      pa.connect(dest);
      pb.connect(dest);
      layers.push({ spec, a: new Smooth(rig, oa.frequency, f), b: new Smooth(rig, ob.frequency, fb) });
    }

    // Slow spectral evolution.
    const l1 = p.osc('sine', 0.017);
    const l2 = p.osc('sine', 0.041);
    const l3 = p.osc('sine', 0.029);
    const d1 = p.gain(root * 1.9);
    const d2 = p.gain(root * 0.9);
    const d3 = p.gain(root * 1.1);
    l1.connect(d1);
    l2.connect(d2);
    l3.connect(d3);
    d1.connect(peak.frequency);
    d2.connect(peak.frequency);
    d3.connect(lp.frequency);

    return {
      patch: p,
      layers,
      lp: new Smooth(rig, lp.frequency, lp.frequency.value),
      peak: new Smooth(rig, peak.frequency, root * 5.5),
      peakGain: new Smooth(rig, peak.gain, peak.gain.value),
      sweep1: new Smooth(rig, d1.gain, root * 1.9),
      sweep2: new Smooth(rig, d2.gain, root * 0.9),
      sweep3: new Smooth(rig, d3.gain, root * 1.1),
      subOut: new Smooth(rig, sub.gain, 0),
      bodyOut: new Smooth(rig, body.gain, 0),
    };
  }

  private tune(tc: number): void {
    const d = this.built;
    if (!d) return;
    const root = this.root;
    for (let i = 0; i < d.layers.length; i++) {
      const l = d.layers[i];
      const f = root * l.spec.mult;
      l.a.to(f, tc);
      l.b.to(f + l.spec.beat + l.spec.spread * this.rough, tc);
    }
    d.lp.to(root * (LP_BASE + LP_SPAN * this.bright), 0.6);
    d.peak.to(root * 5.5, tc);
    d.peakGain.to(5 + 6 * this.bright, 0.6);
    d.sweep1.to(root * 1.9, tc);
    d.sweep2.to(root * 0.9, tc);
    d.sweep3.to(root * 1.1, tc);
  }

  /** New harmonic world: glide to the new root. */
  retune(root: number): void {
    this.root = root;
    this.tune(0.3);
  }

  /** Called every frame by the engine (and at once by setDrone). */
  set(level: number, brightness: number, tc: number): void {
    this.bright = clamp01(brightness);
    const l = clamp01(level);
    let d = this.built;
    if (l > 0) {
      if (!d) d = this.built = this.build();
      this.quietAt = -1;
    } else if (d) {
      const now = this.rig.now;
      // Eight time constants (−69 dB) after the fade was asked for, the oscillators stop.
      if (this.quietAt < 0) this.quietAt = now + 8 * Math.max(0.02, tc) + 0.1;
      else if (now >= this.quietAt) {
        d.patch.free();
        this.built = null;
        this.quietAt = -1;
        return;
      }
    }
    if (!d) return;
    d.subOut.to(SUB_GAIN * l, tc);
    d.bodyOut.to(BODY_GAIN * l, tc);
    d.lp.to(this.root * (LP_BASE + LP_SPAN * this.bright), 0.6);
    d.peakGain.to(5 + 6 * this.bright, 0.6);
  }

  setStability(s: number): void {
    this.rough = (1 - s) * (1 - s);
    this.tune(0.5);
  }

  silence(): void {
    const d = this.built;
    if (!d) return;
    d.subOut.force(0, 0.06);
    d.bodyOut.force(0, 0.06);
    this.quietAt = this.rig.now + 0.6;
  }

  dispose(): void {
    if (this.built) this.built.patch.free();
    this.built = null;
  }
}
