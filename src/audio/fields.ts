/**
 * Chapter IV: three sounding ecosystems. Each occupies its own register and its own
 * kind of motion, so that placing them well is a real mixing act.
 *
 *   EARTH  beating pairs on the root (a reed: the whole harmonic series, so it is still there
 *          on a loudspeaker that cannot play 50 Hz), the fifth above and the octave, and brown,
 *          breathing resonances: noise through very narrow band-passes on harmonics 2·3·4·6·8
 *   AIR    a wide band of breath whose formant wanders, plus synthesised grains — short
 *          windowed bursts of noise through a sharp resonance tuned to a note of the mode
 *   LIGHT  six sine partials high in the mode, each shimmering on its own slow tremolo,
 *          and very rare single glass notes walking through the mode
 *
 * FieldMix → sound:
 *   level       output gain (∝ level^1.4)
 *   brightness  EARTH low-pass 4.5→14.5 × root · AIR formant centre (+2.2 oct) and grain register ·
 *               LIGHT how many of the upper partials are open
 *   diffusion   reverb send 0.08→0.85, pre-delay 12→125 ms, dry −35 %
 *   modulation  EARTH tremolo depth/rate · AIR formant sweep + breath depth + grain scatter ·
 *               LIGHT tremolo depth + vibrato
 *
 * A field only exists while it sounds: its oscillators, noise readers and filters are built
 * when its level first rises above zero and freed a few seconds after it has returned there.
 * Chapters I–III therefore carry none of this.
 */
import type { FieldMix, Harmony } from '../core/contracts';
import { Patch, Smooth, clamp01, fin, sstep, type Rig } from './graph';
import type { Space } from './space';
import type { Strikes } from './strikes';

const EARTH_GAIN = 0.13;
const AIR_GAIN = 0.27;
const LIGHT_GAIN = 0.058;
const GRAINS = 8;
const GRAINS_LITE = 4;
/** Seconds a field stays built after its level reached zero (its outlet needs ≈ 2 s to be inaudible). */
const LINGER = 3;

const EARTH_PAIRS: readonly (readonly [mult: number, wave: 'reed' | 'soft', gain: number, beat: number, spread: number])[] = [
  [1, 'reed', 0.3, 0.11, 0.9],
  [1.5, 'soft', 0.18, 0.17, 1.4],
  [2, 'soft', 0.14, 0.23, 2.1],
];
const EARTH_MODES: readonly (readonly [mult: number, gain: number, rate: number])[] = [
  [2, 2.0, 0.05],
  [3, 1.8, 0.08],
  [4, 3.2, 0.13],
  [6, 3.0, 0.21],
  [8, 2.0, 0.17],
];
/** [degree, octave, amplitude, tremolo Hz, pan] */
const LIGHT_PARTIALS: readonly (readonly [number, number, number, number, number])[] = [
  [0, 4, 0.3, 0.13, -0.35],
  [4, 4, 0.24, 0.19, 0.4],
  [0, 5, 0.18, 0.23, -0.6],
  [2, 5, 0.14, 0.31, 0.65],
  [4, 5, 0.1, 0.37, -0.8],
  [1, 6, 0.07, 0.43, 0.85],
];

interface Mix {
  level: number;
  brightness: number;
  diffusion: number;
  modulation: number;
}
interface Trio {
  earth: Mix;
  air: Mix;
  light: Mix;
}
const mix0 = (): Mix => ({ level: 0, brightness: 0.5, diffusion: 0.5, modulation: 0.3 });
const trio0 = (): Trio => ({ earth: mix0(), air: mix0(), light: mix0() });

function copyMix(src: FieldMix | undefined, dst: Mix, scale: number): void {
  if (!src) {
    dst.level = 0;
    return;
  }
  dst.level = clamp01(fin(src.level, 0)) * scale;
  dst.brightness = clamp01(fin(src.brightness, 0.5));
  dst.diffusion = clamp01(fin(src.diffusion, 0.5));
  dst.modulation = clamp01(fin(src.modulation, 0.3));
}

const earthCutoff = (root: number, m: Mix): number => root * (4.5 + 10 * m.brightness);

/**
 * Output stage shared by the three fields: level → place, diffusion → reverb send.
 * Distance is also a pre-delay, 12 ms near and 125 ms far. The two are fixed delay lines that
 * are cross-faded: sweeping one delay time instead would bend the pitch of everything sent to
 * the room while a body is dragged in depth.
 */
class Outlet {
  readonly input: GainNode;
  private readonly dry: Smooth;
  private readonly send: Smooth;
  private readonly near: Smooth;
  private readonly far: Smooth;

  constructor(rig: Rig, p: Patch, space: Space, pan: number, diffusion: number) {
    this.input = p.gain(1);
    const dry = p.gain(0);
    const pn = p.pan(pan);
    const send = p.gain(0);
    const preNear = p.delay(0.05, 0.012);
    const preFar = p.delay(0.25, 0.125);
    const near = p.gain(1 - diffusion);
    const far = p.gain(diffusion);
    this.input.connect(dry);
    dry.connect(pn);
    pn.connect(space.texture);
    this.input.connect(send);
    send.connect(preNear);
    send.connect(preFar);
    preNear.connect(near);
    preFar.connect(far);
    near.connect(space.reverbIn);
    far.connect(space.reverbIn);
    this.dry = new Smooth(rig, dry.gain, 0);
    this.send = new Smooth(rig, send.gain, 0);
    this.near = new Smooth(rig, near.gain, 1 - diffusion);
    this.far = new Smooth(rig, far.gain, diffusion);
  }

  set(gain: number, diffusion: number, tc: number): void {
    this.dry.to(gain * (1 - 0.35 * diffusion), tc);
    this.send.to(gain * (0.08 + 0.77 * diffusion), tc);
    this.near.to(1 - diffusion, 0.3);
    this.far.to(diffusion, 0.3);
  }

  silence(): void {
    this.dry.force(0, 0.05);
    this.send.force(0, 0.05);
  }
}

// ───────────────────────────────────────────────────────────────── EARTH ──

interface Pair {
  mult: number;
  beat: number;
  spread: number;
  a: Smooth;
  b: Smooth;
}

class Earth {
  readonly patch: Patch;
  readonly out: Outlet;
  private readonly pairs: Pair[] = [];
  private readonly modes: Smooth[] = [];
  private readonly lp: Smooth;
  private readonly trem: Smooth;
  private readonly tremRate: Smooth;

  constructor(rig: Rig, space: Space, root: number, rough: number, m: Mix) {
    const p = (this.patch = new Patch(rig));
    this.out = new Outlet(rig, p, space, -0.18, m.diffusion);
    const eLp = p.filter('lowpass', earthCutoff(root, m), 0.6);
    const eTrem = p.gain(1);
    eLp.connect(eTrem);
    eTrem.connect(this.out.input);
    for (const [mult, wave, gain, beat, spread] of EARTH_PAIRS) {
      const w = wave === 'reed' ? rig.reedWave : rig.softWave;
      const f = root * mult;
      const fb = f + beat + spread * rough;
      const oa = p.osc(w, f);
      const ob = p.osc(w, fb);
      const ga = p.gain(gain * 0.5);
      const gb = p.gain(gain * 0.5);
      oa.connect(ga);
      ob.connect(gb);
      ga.connect(eLp);
      gb.connect(eLp);
      this.pairs.push({ mult, beat, spread, a: new Smooth(rig, oa.frequency, f), b: new Smooth(rig, ob.frequency, fb) });
    }
    const eNoise = p.noise(0.7);
    const eDark = p.filter('lowpass', 700, 0.5);
    eNoise.connect(eDark);
    for (const [mult, gain, rate] of EARTH_MODES) {
      const bp = p.filter('bandpass', root * mult, 28);
      const g = p.gain(gain);
      const lfo = p.osc('sine', rate);
      const depth = p.gain(gain * 0.55);
      eDark.connect(bp);
      bp.connect(g);
      g.connect(eLp);
      lfo.connect(depth);
      depth.connect(g.gain);
      this.modes.push(new Smooth(rig, bp.frequency, root * mult));
    }
    const eLfo = p.osc('sine', 0.07 + 0.25 * m.modulation);
    const eDepth = p.gain(0.5 * m.modulation);
    eLfo.connect(eDepth);
    eDepth.connect(eTrem.gain);
    this.lp = new Smooth(rig, eLp.frequency, eLp.frequency.value);
    this.trem = new Smooth(rig, eDepth.gain, 0.5 * m.modulation);
    this.tremRate = new Smooth(rig, eLfo.frequency, 0.07 + 0.25 * m.modulation);
  }

  update(m: Mix, gain: number, root: number, rough: number): void {
    this.out.set(gain, m.diffusion, 0.35);
    for (let i = 0; i < this.pairs.length; i++) {
      const pr = this.pairs[i];
      const f = root * pr.mult;
      pr.a.to(f, 0.3);
      pr.b.to(f + pr.beat + pr.spread * rough, 0.5);
    }
    for (let i = 0; i < this.modes.length; i++) this.modes[i].to(root * EARTH_MODES[i][0], 0.3);
    this.lp.to(earthCutoff(root, m), 0.3);
    this.trem.to(0.5 * m.modulation, 0.3);
    this.tremRate.to(0.07 + 0.25 * m.modulation, 0.5);
  }
}

// ─────────────────────────────────────────────────────────────────── AIR ──

interface Grain {
  bp: BiquadFilterNode;
  amp: GainNode;
  pan: StereoPannerNode;
  /** Context time at which this grain has faded out and may be retuned. */
  until: number;
}

class Air {
  readonly patch: Patch;
  readonly out: Outlet;
  private readonly band: Smooth;
  private readonly formant: Smooth;
  private readonly sweep: Smooth;
  private readonly sweep2: Smooth;
  private readonly breath: Smooth;
  private readonly grains: Grain[] = [];
  private grainIn = 0.5;

  constructor(
    private readonly rig: Rig,
    space: Space,
    centre: number,
    private readonly top: number,
    m: Mix,
  ) {
    const p = (this.patch = new Patch(rig));
    this.out = new Outlet(rig, p, space, 0.12, m.diffusion);
    const aHp = p.filter('highpass', 240, 0.5);
    aHp.connect(this.out.input);
    const aNoise = p.noise(1.9);
    const band = p.filter('bandpass', centre, 0.8);
    const formant = p.filter('bandpass', Math.min(top, centre * 2.3), 2.2);
    const formantGain = p.gain(0.5);
    const breath = p.gain(1);
    aNoise.connect(band);
    aNoise.connect(formant);
    formant.connect(formantGain);
    band.connect(breath);
    formantGain.connect(breath);
    breath.connect(aHp);
    const sweepLfo = p.osc('sine', 0.061);
    const sweep = p.gain(0);
    const sweep2 = p.gain(0);
    sweepLfo.connect(sweep);
    sweepLfo.connect(sweep2);
    sweep.connect(band.frequency);
    sweep2.connect(formant.frequency);
    const breathLfo = p.osc('sine', 0.19);
    const breathDepth = p.gain(0);
    breathLfo.connect(breathDepth);
    breathDepth.connect(breath.gain);
    this.band = new Smooth(rig, band.frequency, centre);
    this.formant = new Smooth(rig, formant.frequency, formant.frequency.value);
    this.sweep = new Smooth(rig, sweep.gain, 0);
    this.sweep2 = new Smooth(rig, sweep2.gain, 0);
    this.breath = new Smooth(rig, breathDepth.gain, 0);
    // grains
    const gNoise = p.noise(3.3);
    const grainBus = p.gain(6);
    grainBus.connect(aHp);
    const count = rig.lite ? GRAINS_LITE : GRAINS;
    for (let i = 0; i < count; i++) {
      const bp = p.filter('bandpass', 1000, 32);
      const amp = p.gain(0);
      const pan = p.pan(0);
      gNoise.connect(bp);
      bp.connect(amp);
      amp.connect(pan);
      pan.connect(grainBus);
      this.grains.push({ bp, amp, pan, until: 0 });
    }
  }

  update(m: Mix, gain: number, level: number, centre: number, dt: number, h: Harmony, rand: () => number): void {
    this.out.set(gain, m.diffusion, 0.3);
    this.band.to(centre, 0.3);
    this.formant.to(Math.min(this.top, centre * 2.3), 0.3);
    this.sweep.to(centre * 0.45 * m.modulation, 0.3);
    this.sweep2.to(centre * 0.9 * m.modulation, 0.3);
    this.breath.to(0.55 * m.modulation, 0.3);

    if (level > 0.02) {
      const rate = level * (3 + 10 * m.brightness) * (0.6 + 0.8 * m.modulation);
      this.grainIn -= dt;
      let spawned = 0;
      while (this.grainIn <= 0 && spawned < 4) {
        this.grain(m, h, rand, spawned * 0.011);
        this.grainIn += -Math.log(1 - rand() * 0.999) / rate;
        spawned++;
      }
      if (this.grainIn < 0) this.grainIn = 0;
    }
  }

  /**
   * One synthesised grain: a windowed burst of noise through a sharp resonance on a note of the mode.
   * Only a grain that has faded out is retuned and re-placed — stepping the resonance or the pan of
   * one that is still sounding would tick — so when all are busy the cloud is simply as dense as it gets.
   */
  private grain(m: Mix, h: Harmony, rand: () => number, offset: number): void {
    // The draws are made whether or not a grain is free, so the piece stays the same piece.
    const degree = Math.floor(rand() * h.ratios.length);
    const octave = 3 + Math.floor(rand() * (1.6 + 1.4 * m.brightness));
    const dur = 0.07 + 0.2 * rand();
    const peak = 0.45 + 0.55 * rand();
    const where = (rand() * 2 - 1) * (0.35 + 0.6 * m.modulation);
    const now = this.rig.now;
    const t = now + 0.004 + offset;
    let g: Grain | null = null;
    for (let i = 0; i < this.grains.length; i++) {
      if (this.grains[i].until <= t) {
        g = this.grains[i];
        break;
      }
    }
    if (!g) return;
    const hz = Math.min(this.top, h.freq(degree, octave));
    g.bp.frequency.cancelScheduledValues(now);
    g.pan.pan.cancelScheduledValues(now);
    g.amp.gain.cancelScheduledValues(now);
    g.bp.frequency.setValueAtTime(hz, t);
    g.pan.pan.setValueAtTime(where, t);
    g.amp.gain.setTargetAtTime(peak, t, dur * 0.22);
    g.amp.gain.setTargetAtTime(0, t + dur * 0.55, dur * 0.25);
    // Seven release time constants: −61 dB under the grain's own peak.
    g.until = t + dur * (0.55 + 7 * 0.25);
  }

  silence(): void {
    const now = this.rig.now;
    for (const g of this.grains) {
      g.amp.gain.cancelScheduledValues(now);
      g.amp.gain.setTargetAtTime(0, now, 0.03);
      g.until = Math.min(g.until, now + 0.25);
    }
    this.grainIn = 0.5;
  }
}

// ───────────────────────────────────────────────────────────────── LIGHT ──

interface Partial {
  degree: number;
  octave: number;
  amplitude: number;
  sign: number;
  rate: number;
  hz: number;
  freq: Smooth;
  amp: Smooth;
  trem: Smooth;
  tremRate: Smooth;
  vib: Smooth;
}

class Light {
  readonly patch: Patch;
  readonly out: Outlet;
  private readonly echo: Smooth;
  private readonly partials: Partial[] = [];

  constructor(
    rig: Rig,
    space: Space,
    h: Harmony,
    private readonly top: number,
    m: Mix,
  ) {
    const p = (this.patch = new Patch(rig));
    this.out = new Outlet(rig, p, space, 0, m.diffusion);
    const lHp = p.filter('highpass', 420, 0.5);
    lHp.connect(this.out.input);
    const lEcho = p.gain(0);
    lHp.connect(lEcho);
    lEcho.connect(space.delayIn);
    this.echo = new Smooth(rig, lEcho.gain, 0);
    const vibLfo = p.osc('sine', 4.7);
    let sign = 1;
    for (const [degree, octave, amplitude, rate, pan] of LIGHT_PARTIALS) {
      const hz = Math.min(top, h.freq(degree, octave));
      const o = p.osc('sine', hz);
      const a = p.gain(0);
      const pn = p.pan(pan);
      const lfo = p.osc('sine', rate);
      const depth = p.gain(0);
      const vib = p.gain(0);
      o.connect(a);
      a.connect(pn);
      pn.connect(lHp);
      lfo.connect(depth);
      depth.connect(a.gain);
      vibLfo.connect(vib);
      vib.connect(o.frequency);
      this.partials.push({
        degree,
        octave,
        amplitude,
        sign,
        rate,
        hz,
        freq: new Smooth(rig, o.frequency, hz),
        amp: new Smooth(rig, a.gain, 0),
        trem: new Smooth(rig, depth.gain, 0),
        tremRate: new Smooth(rig, lfo.frequency, rate),
        vib: new Smooth(rig, vib.gain, 0),
      });
      sign = -sign;
    }
  }

  retune(h: Harmony): void {
    for (const part of this.partials) part.hz = Math.min(this.top, h.freq(part.degree, part.octave));
  }

  update(m: Mix, gain: number, rough: number): void {
    this.out.set(gain, m.diffusion, 0.3);
    this.echo.to(gain * 0.3, 0.3);
    const n = this.partials.length;
    for (let i = 0; i < n; i++) {
      const part = this.partials[i];
      const open = sstep(i / n - 0.35, i / n + 0.15, m.brightness);
      const a = part.amplitude * open;
      // Unstable light is slightly out of tune with itself (up to ±14 cents); stable light is exact.
      part.freq.to(part.hz * (1 + part.sign * 0.008 * rough), 0.4);
      part.amp.to(a, 0.4);
      part.trem.to(a * (0.3 + 0.6 * m.modulation), 0.4);
      part.tremRate.to(part.rate * (1 + m.modulation), 0.6);
      part.vib.to(part.hz * 0.003 * m.modulation, 0.4);
    }
  }
}

// ──────────────────────────────────────────────────────────────── fields ──

export class Fields {
  private readonly direct = trio0();
  private readonly memory = trio0();
  private readonly fadeMul = { earth: 1, air: 1, light: 1 };
  private harmony: Harmony;
  private rough = 0.09;
  private readonly top: number;

  private earth: Earth | null = null;
  private air: Air | null = null;
  private light: Light | null = null;
  /** Context times after which a silent field is torn down (−1: it is sounding). */
  private earthQuiet = -1;
  private airQuiet = -1;
  private lightQuiet = -1;
  private lightIn = 4;
  private lightDegree = 4;

  constructor(
    private readonly rig: Rig,
    private readonly space: Space,
    private readonly strikes: Strikes,
    harmony: Harmony,
  ) {
    this.harmony = harmony;
    this.top = Math.min(9000, rig.sampleRate * 0.4);
  }

  /** Which of the three exist right now (earth, air, light). */
  get built(): number {
    return (this.earth ? 1 : 0) + (this.air ? 1 : 0) + (this.light ? 1 : 0);
  }

  /** Direct control from chapter IV. */
  set(f: { earth: FieldMix; air: FieldMix; light: FieldMix }): void {
    copyMix(f.earth, this.direct.earth, 1);
    copyMix(f.air, this.direct.air, 1);
    copyMix(f.light, this.direct.light, 1);
  }

  /** The remembered balance, re-summoned by the finale at `scale` (0 releases it). */
  remember(b: { earth: FieldMix; air: FieldMix; light: FieldMix } | null, scale: number): void {
    copyMix(b?.earth, this.memory.earth, scale);
    copyMix(b?.air, this.memory.air, scale);
    copyMix(b?.light, this.memory.light, scale);
  }

  /** Dissolve multipliers. */
  setFade(light: number, air: number, earth: number): void {
    this.fadeMul.light = light;
    this.fadeMul.air = air;
    this.fadeMul.earth = earth;
  }

  setStability(s: number): void {
    this.rough = (1 - s) * (1 - s);
  }

  retune(h: Harmony): void {
    this.harmony = h;
    this.lightDegree = 4;
    if (this.light) this.light.retune(h);
  }

  /** Once per frame: resolves the effective mixes, eases every parameter, schedules grains and rare notes. */
  update(dt: number, rand: () => number): void {
    const h = this.harmony;
    const root = h.root;
    const rough = this.rough;
    const now = this.rig.now;

    // EARTH
    {
      const m = this.memory.earth.level > this.direct.earth.level ? this.memory.earth : this.direct.earth;
      const g = EARTH_GAIN * Math.pow(m.level, 1.4) * this.fadeMul.earth;
      if (g > 0) {
        if (!this.earth) this.earth = new Earth(this.rig, this.space, root, rough, m);
        this.earthQuiet = -1;
      } else if (this.earth) {
        if (this.earthQuiet < 0) this.earthQuiet = now + LINGER;
        else if (now >= this.earthQuiet) {
          this.earth.patch.free();
          this.earth = null;
          this.earthQuiet = -1;
        }
      }
      if (this.earth) this.earth.update(m, g, root, rough);
    }

    // AIR
    {
      const m = this.memory.air.level > this.direct.air.level ? this.memory.air : this.direct.air;
      const level = m.level * this.fadeMul.air;
      const g = AIR_GAIN * Math.pow(m.level, 1.4) * this.fadeMul.air;
      const centre = Math.min(this.top * 0.4, root * Math.pow(2, 3.5 + 2.2 * m.brightness));
      if (g > 0) {
        if (!this.air) this.air = new Air(this.rig, this.space, centre, this.top, m);
        this.airQuiet = -1;
      } else if (this.air) {
        if (this.airQuiet < 0) this.airQuiet = now + LINGER;
        else if (now >= this.airQuiet) {
          this.air.patch.free();
          this.air = null;
          this.airQuiet = -1;
        }
      }
      if (this.air) this.air.update(m, g, level, centre, dt, h, rand);
    }

    // LIGHT
    {
      const m = this.memory.light.level > this.direct.light.level ? this.memory.light : this.direct.light;
      const level = m.level * this.fadeMul.light;
      const g = LIGHT_GAIN * Math.pow(m.level, 1.4) * this.fadeMul.light;
      if (g > 0) {
        if (!this.light) this.light = new Light(this.rig, this.space, h, this.top, m);
        this.lightQuiet = -1;
      } else if (this.light) {
        if (this.lightQuiet < 0) this.lightQuiet = now + LINGER;
        else if (now >= this.lightQuiet) {
          this.light.patch.free();
          this.light = null;
          this.lightQuiet = -1;
        }
      }
      if (this.light) this.light.update(m, g, rough);

      if (level > 0.04) {
        this.lightIn -= dt;
        if (this.lightIn <= 0) {
          const span = h.ratios.length * 2;
          let d = this.lightDegree + Math.round((rand() - 0.5) * 4);
          if (d < 0) d = -d;
          if (d > span) d = span - (d - span);
          this.lightDegree = d;
          const hz = Math.min(this.top, h.freq(d, 4));
          this.strikes.ping(hz, (0.2 + 0.25 * rand()) * level, 'glass', (rand() * 2 - 1) * 0.8, 0.3 + 0.5 * m.diffusion);
          this.lightIn = (4 + 9 * rand()) / (0.5 + level);
        }
      }
    }
  }

  /** Reset: everything to zero, quickly, and forget both mixes. */
  silence(): void {
    this.direct.earth.level = this.direct.air.level = this.direct.light.level = 0;
    this.memory.earth.level = this.memory.air.level = this.memory.light.level = 0;
    this.fadeMul.earth = this.fadeMul.air = this.fadeMul.light = 1;
    const soon = this.rig.now + 0.6;
    if (this.earth) {
      this.earth.out.silence();
      this.earthQuiet = soon;
    }
    if (this.air) {
      this.air.out.silence();
      this.air.silence();
      this.airQuiet = soon;
    }
    if (this.light) {
      this.light.out.silence();
      this.lightQuiet = soon;
    }
    this.lightIn = 4;
  }

  dispose(): void {
    if (this.earth) this.earth.patch.free();
    if (this.air) this.air.patch.free();
    if (this.light) this.light.patch.free();
    this.earth = this.air = this.light = null;
  }
}
