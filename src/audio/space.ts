/**
 * The room and the master: buses, long diffuse reverb, multi-tap delay, roughness,
 * the dissolve stage, limiter, hard ceiling and the analysis tap.
 *
 *   dry ─────────┐
 *   texture ─(AM roughness)─┤
 *   reverbIn → 19 ms → Convolver(procedural IR, 6.5 s; 3.6 s on the lite tier) → LP(bloom) → HP → return ─┤
 *   delayIn  → 3 taps (LP, pan) ⟲ feedback → return (+ a little into the reverb) ─┤
 *                                                                                 ▼
 *   sum → dissolve LP → dissolve gain → HP 22 Hz → limiter (Tone.Compressor 20:1)
 *       → make-up trim → soft ceiling (−1 dBFS, exact) → ● analysis taps (spectrum of the
 *         mono sum; peak and RMS per channel) → pause gain → mute gain (Tone.Gain) → destination
 */
import * as Tone from 'tone';
import { mulberry32 } from '../core/math';
import { Patch, Smooth, clamp01, sstep, type Ctx, type Rig } from './graph';

/**
 * The one loudness control of the whole instrument: gain of the summing bus, ahead of the
 * dissolve stage and the limiter. Every source is voiced far below full scale (a sustained
 * voice at level 0.5 peaks near −28 dBFS before this gain) so that the densest texture of
 * chapter V, with every pitched partial in phase, still sums below the limiter threshold;
 * the limiter and the ceiling are a guarantee, not part of the sound. The analysis mapping
 * in analysis.ts assumes this value — move them together (6 dB here = 6 dB there).
 */
const MASTER_GAIN = 1.55; // keeps the full chapter V stack under the limiter after the added upper partials
/** Absolute bound of the output signal (linear). −1 dBFS. */
const CEILING = 0.891;
/** Below this the ceiling stage is exactly linear. */
const KNEE = 0.6;
/** Input range covered by the ceiling curve (±). */
const SHAPER_RANGE = 4;
const LIMIT_DB = -8;
const LIMIT_RATIO = 20;
/**
 * A DynamicsCompressorNode applies a fixed make-up gain of (1 / fullRangeGain)^0.6.
 * With a hard knee that is 0.6·|T|·(1 − 1/ratio) dB; this trim removes it so quiet stays quiet.
 */
const LIMIT_TRIM = Math.pow(10, (0.6 * LIMIT_DB * (1 - 1 / LIMIT_RATIO)) / 20);
const REVERB_SECONDS = 6.5;
/** Reduced tier: a shorter tail is cheaper to synthesise and to convolve. */
const REVERB_SECONDS_LITE = 3.6;
/**
 * The impulse response is synthesised a slice per frame, not inside start(): the click that
 * unlocks audio must return at once. 32768 samples take well under a millisecond once the loop
 * is compiled; the whole response is ready about 20 frames later (11 on the lite tier), long
 * before the first chapter makes a sound, and the room then fades in over a quarter of a second.
 */
const IMPULSE_SLICE = 32768;

/** [seconds, gain, pan, low-pass Hz] — incommensurate times so the echoes never form a pulse. */
const TAPS: readonly (readonly [number, number, number, number])[] = [
  [0.293, 0.4, -0.62, 3600],
  [0.461, 0.32, 0.58, 2900],
  [0.719, 0.25, -0.18, 2200],
];

/** Everything that holds a tail. Rebuilt on flush so no reverberation survives a reset. */
class Wet {
  readonly patch: Patch;
  readonly reverbInput: GainNode;
  readonly delayInput: GainNode;
  readonly out: GainNode;
  readonly swell: GainNode;
  private tone: Smooth | null = null;
  private level: Smooth | null = null;

  constructor(
    private readonly rig: Rig,
    impulse: AudioBuffer | null,
    private wantLevel: number,
    private wantTone: number,
  ) {
    const p = (this.patch = new Patch(rig));
    this.out = p.gain(1);
    this.reverbInput = p.gain(1);
    this.swell = p.gain(1);
    this.swell.connect(this.out);
    if (impulse) this.furnish(impulse, false);

    // multi-tap delay
    this.delayInput = p.gain(1);
    const delayOut = p.gain(1);
    let lastTap: AudioNode = this.delayInput;
    for (const [seconds, gain, pan, cutoff] of TAPS) {
      const d = p.delay(1.5, seconds);
      const f = p.filter('lowpass', cutoff, 0.5);
      const g = p.gain(gain);
      const pn = p.pan(pan);
      this.delayInput.connect(d);
      d.connect(f);
      f.connect(g);
      g.connect(pn);
      pn.connect(delayOut);
      lastTap = f;
    }
    const fbHp = p.filter('highpass', 180, 0.5);
    const fb = p.gain(0.33);
    lastTap.connect(fbHp);
    fbHp.connect(fb);
    fb.connect(this.delayInput);
    delayOut.connect(this.out);
    const intoReverb = p.gain(0.35);
    delayOut.connect(intoReverb);
    intoReverb.connect(this.reverbInput);
  }

  get furnished(): boolean {
    return this.level !== null;
  }

  /** Put the room in. `fadeIn`: it arrives under sound that is already playing, so it opens gently. */
  furnish(impulse: AudioBuffer, fadeIn: boolean): void {
    if (this.level || this.patch.dead) return;
    const p = this.patch;
    const rig = this.rig;
    const pre = p.delay(0.1, 0.019);
    const conv = p.own(new Tone.Convolver({ context: rig.ctx, url: impulse, normalize: true }));
    const lp = p.filter('lowpass', this.wantTone, 0.5);
    const hp = p.filter('highpass', 110, 0.5);
    const ret = p.gain(fadeIn ? 0 : this.wantLevel);
    this.reverbInput.connect(pre);
    Tone.connect(pre, conv);
    conv.connect(lp);
    lp.connect(hp);
    hp.connect(ret);
    ret.connect(this.swell);
    this.tone = new Smooth(rig, lp.frequency, this.wantTone);
    this.level = new Smooth(rig, ret.gain, fadeIn ? 0 : this.wantLevel);
    if (fadeIn) this.level.to(this.wantLevel, 0.25);
  }

  set(level: number, tone: number): void {
    this.wantLevel = level;
    this.wantTone = tone;
    if (this.level) this.level.to(level, 0.8);
    if (this.tone) this.tone.to(tone, 0.8);
  }
}

export class Space {
  /** Close, unprocessed sound. */
  readonly dry: GainNode;
  /** Sustained textures; amplitude-roughened when stability is low. */
  readonly texture: GainNode;
  readonly reverbIn: GainNode;
  readonly delayIn: GainNode;
  /** Mono sum of the output: the spectrum. */
  readonly analyser: AnalyserNode;
  /** Left and right separately: peak and RMS (a mono sum would under-read anything panned or decorrelated). */
  readonly analyserL: AnalyserNode;
  readonly analyserR: AnalyserNode;

  private readonly patch: Patch;
  private readonly sum: GainNode;
  private impulse: AudioBuffer | null = null;
  private job: ImpulseJob | null;
  private readonly rough: Smooth;
  private readonly bloomSend: Smooth;
  private readonly dissolveLp: BiquadFilterNode;
  private readonly dissolveGain: GainNode;
  private readonly pauseGain: GainNode;
  private readonly mute: Tone.Gain;
  private readonly open: number;
  private wet: Wet;
  private wetLevel = 0.74;
  private wetTone = 5000;

  constructor(private readonly rig: Rig) {
    const p = (this.patch = new Patch(rig));
    this.open = Math.min(20000, rig.sampleRate * 0.45);
    this.job = new ImpulseJob(rig.ctx, rig.lite ? REVERB_SECONDS_LITE : REVERB_SECONDS);

    this.sum = p.gain(MASTER_GAIN);
    this.dry = p.gain(1);
    this.texture = p.gain(1);
    this.reverbIn = p.gain(1);
    this.delayIn = p.gain(1);
    this.dry.connect(this.sum);
    this.texture.connect(this.sum);

    // Roughness: two slow-audio-rate tremolos (23 and 31.7 Hz, the region heard as "rough"),
    // added to the texture bus gain. Depth 0 → the bus is exactly unity.
    const r1 = p.osc('sine', 23);
    const r2 = p.osc('sine', 31.7);
    const r1g = p.gain(0.6);
    const r2g = p.gain(0.4);
    const depth = p.gain(0);
    r1.connect(r1g);
    r2.connect(r2g);
    r1g.connect(depth);
    r2g.connect(depth);
    depth.connect(this.texture.gain);
    this.rough = new Smooth(rig, depth.gain, 0);

    // Bloom: as the world coheres, the whole close field leaks into the room.
    const bloom = p.gain(0.06);
    this.dry.connect(bloom);
    this.texture.connect(bloom);
    bloom.connect(this.reverbIn);
    this.bloomSend = new Smooth(rig, bloom.gain, 0.06);

    // master
    this.dissolveLp = p.filter('lowpass', this.open, 0.5);
    this.dissolveGain = p.gain(1);
    const hp = p.filter('highpass', 22, 0.7071);
    const limiter = p.own(
      new Tone.Compressor({ context: rig.ctx, threshold: LIMIT_DB, ratio: LIMIT_RATIO, knee: 0, attack: 0.003, release: 0.12 }),
    );
    const trim = p.gain(LIMIT_TRIM / SHAPER_RANGE);
    const ceiling = p.shaper(makeCeilingCurve());
    // The spectrum and both level windows are read on the main thread every frame.
    const fft = rig.lite ? 2048 : 4096;
    this.analyser = p.analyser(fft, 0.5);
    this.analyserL = p.analyser(fft, 0);
    this.analyserR = p.analyser(fft, 0);
    const split = p.splitter(2);
    this.pauseGain = p.gain(1);
    this.mute = p.own(new Tone.Gain({ context: rig.ctx, gain: 1 }));

    this.sum.connect(this.dissolveLp);
    this.dissolveLp.connect(this.dissolveGain);
    this.dissolveGain.connect(hp);
    Tone.connect(hp, limiter);
    limiter.connect(trim);
    trim.connect(ceiling);
    ceiling.connect(this.analyser);
    ceiling.connect(split);
    split.connect(this.analyserL, 0);
    split.connect(this.analyserR, 1);
    ceiling.connect(this.pauseGain);
    Tone.connect(this.pauseGain, this.mute);
    this.mute.toDestination();

    this.wet = this.attachWet();
    this.setStability(0.7);
  }

  private attachWet(): Wet {
    const w = new Wet(this.rig, this.impulse, this.wetLevel, this.wetTone);
    this.reverbIn.connect(w.reverbInput);
    this.delayIn.connect(w.delayInput);
    w.out.connect(this.sum);
    return w;
  }

  /**
   * Once per frame until it returns true: synthesises the next slice of the impulse response
   * and, when it is complete, puts the room in. Never does more than one slice of work.
   */
  prepare(): boolean {
    const job = this.job;
    if (!job) return true;
    if (!job.step(IMPULSE_SLICE)) return false;
    this.job = null;
    this.impulse = job.buffer;
    this.wet.furnish(this.impulse, true);
    return false;
  }

  /** True once the room exists. */
  get ready(): boolean {
    return this.wet.furnished;
  }

  /** 0 = rough, 1 = pure with the room blooming open. */
  setStability(s: number): void {
    const r = (1 - s) * (1 - s);
    const b = sstep(0.55, 1, s);
    this.wetLevel = 0.6 + 0.42 * b;
    this.wetTone = 3200 + 6200 * b;
    this.rough.to(0.3 * r, 0.25);
    this.bloomSend.to(0.03 + 0.2 * b, 0.7);
    this.wet.set(this.wetLevel, this.wetTone);
  }

  /** A slow swell of the reverb return for composed gestures. `amount` is added to unity. */
  swell(amount: number, attack: number, hold: number, release: number): void {
    const now = this.rig.now;
    const g = this.wet.swell.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(1 + amount, now, Math.max(0.01, attack / 3));
    g.setTargetAtTime(1, now + attack + hold, Math.max(0.01, release / 3));
  }

  setMuted(muted: boolean): void {
    this.mute.gain.rampTo(muted ? 0 : 1, muted ? 0.09 : 0.25);
  }

  /** Close (before suspending the context) or reopen the pause gate. */
  setGate(open: boolean): void {
    const now = this.rig.now;
    const g = this.pauseGain.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(open ? 1 : 0, now, open ? 0.03 : 0.012);
  }

  /** Ending: the top of the spectrum closes first, then everything goes to exact zero at `seconds`. */
  dissolve(seconds: number): void {
    const now = this.rig.now;
    const f = this.dissolveLp.frequency;
    f.cancelScheduledValues(now);
    f.setTargetAtTime(140, now, seconds * 0.16);
    const g = this.dissolveGain.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0, now + seconds * 0.6, seconds * 0.07);
    // The last stretch closes a hundred times faster, so the exact zero that ends it is not a step.
    g.setTargetAtTime(0, now + seconds * 0.94, seconds * 0.006);
    g.setValueAtTime(0, now + seconds);
  }

  /**
   * After a dissolve, admit one last sound: the gate reopens (the top stays closed),
   * then shuts slowly and reaches exact zero 22 s later.
   */
  afterglow(): void {
    const now = this.rig.now;
    const g = this.dissolveGain.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(1, now, 0.03);
    g.setTargetAtTime(0, now + 8, 2);
    g.setTargetAtTime(0, now + 21, 0.1);
    g.setValueAtTime(0, now + 22);
    const f = this.dissolveLp.frequency;
    f.cancelScheduledValues(now);
    f.setTargetAtTime(2400, now, 0.05);
  }

  /**
   * Reset: duck the master to silence within ~0.25 s, throw away every tail
   * (a fresh convolver and fresh delay lines), then reopen for the next journey.
   */
  hush(): void {
    const now = this.rig.now;
    const g = this.dissolveGain.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0, now, 0.04);
    g.setTargetAtTime(1, now + 0.32, 0.04);
    const f = this.dissolveLp.frequency;
    f.cancelScheduledValues(now);
    f.setTargetAtTime(this.open, now + 0.3, 0.02);

    const old = this.wet;
    try {
      this.reverbIn.disconnect(old.reverbInput);
      this.delayIn.disconnect(old.delayInput);
    } catch {
      /* already detached */
    }
    old.out.gain.cancelScheduledValues(now);
    old.out.gain.setTargetAtTime(0, now, 0.04);
    old.patch.freeAt(now + 0.45);
    this.wet = this.attachWet();
  }

  dispose(): void {
    this.wet.patch.free();
    this.patch.free();
  }
}

/**
 * The hard guarantee: |out| ≤ CEILING for any input. Exactly linear below KNEE,
 * then a C¹ tanh shoulder. Not oversampled, so the bound holds sample for sample.
 */
function makeCeilingCurve(): Float32Array<ArrayBuffer> {
  const n = 8193;
  const curve = new Float32Array(n);
  const span = CEILING - KNEE;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * SHAPER_RANGE;
    const a = Math.abs(x);
    const y = a <= KNEE ? a : KNEE + span * Math.tanh((a - KNEE) / span);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

/**
 * Procedural impulse response: decorrelated stereo noise with a diffuse 35 ms onset
 * (no slap), an exponential tail (RT60 = 0.86 × its length: ≈ 5.6 s, 3.1 s on the lite tier)
 * and a spectrum that darkens as it decays, as air and soft walls would. No early reflections:
 * the room is a wash, not a place.
 *
 * Resumable: step() synthesises a bounded number of samples and keeps the filter state, so the
 * work can be spread over frames instead of blocking the gesture that starts the audio.
 */
class ImpulseJob {
  readonly buffer: AudioBuffer;
  private readonly sr: number;
  private readonly len: number;
  private readonly rt60: number;
  private readonly fadeFrom: number;
  private readonly hpA: number;
  private ch = 0;
  private i = 0;
  private rand: () => number;
  private lp1 = 0;
  private lp2 = 0;
  private low = 0;
  private a = 1;
  private comp = 1;
  private env = 0;

  constructor(ctx: Ctx, seconds: number) {
    this.sr = ctx.sampleRate;
    this.len = Math.floor(this.sr * seconds);
    this.buffer = ctx.createBuffer(2, this.len, this.sr);
    this.rt60 = seconds * 0.86;
    this.fadeFrom = this.len - Math.floor(this.sr * 0.25);
    this.hpA = 1 - Math.exp((-2 * Math.PI * 90) / this.sr);
    this.rand = mulberry32(0xa11ce);
  }

  /** Synthesise up to `samples` more samples. True once the response is complete. */
  step(samples: number): boolean {
    const { sr, len, rt60, fadeFrom, hpA } = this;
    let budget = samples;
    while (budget > 0 && this.ch < 2) {
      const d = this.buffer.getChannelData(this.ch);
      const rand = this.rand;
      let { lp1, lp2, low, a, comp, env } = this;
      let i = this.i;
      const end = Math.min(len, i + budget);
      budget -= end - i;
      for (; i < end; i++) {
        if ((i & 63) === 0) {
          const t = i / sr;
          const cutoff = 900 + 10100 * Math.exp(-t / 1.1);
          a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
          comp = Math.pow(11000 / cutoff, 0.25);
          env = (1 - Math.exp(-t / 0.035)) * Math.exp((-6.91 * t) / rt60);
          if (i > fadeFrom) env *= clamp01((len - i) / (len - fadeFrom));
        }
        const w = rand() * 2 - 1;
        lp1 += a * (w - lp1);
        lp2 += a * (lp1 - lp2);
        low += hpA * (lp2 - low);
        d[i] = (lp2 - low) * env * comp;
      }
      if (i >= len) {
        this.ch++;
        this.i = 0;
        this.lp1 = this.lp2 = this.low = 0;
        this.rand = mulberry32(0xa11ce + this.ch * 7919);
      } else {
        this.i = i;
        this.lp1 = lp1;
        this.lp2 = lp2;
        this.low = low;
        this.a = a;
        this.comp = comp;
        this.env = env;
      }
    }
    return this.ch >= 2;
  }
}
