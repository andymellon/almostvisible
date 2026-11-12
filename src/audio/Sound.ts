import type { Input } from '../interaction/Input';
import type { Perception } from '../state/Perception';

// A just-intoned harmonic series over A1 (55 Hz): 4:5:6:7:9:12
const PARTIALS = [220, 275, 330, 385, 495, 660];

/**
 * Generative sound, entirely synthesised with the Web Audio API.
 * Nothing is created until the visitor asks for sound; nothing ever autoplays.
 *
 *   drones  – detuned sine pairs that beat slowly against each other
 *   partials – harmonic overtones that only sound as the form coheres
 *   air     – band-passed noise, opened and steered by movement
 *   grains  – brief sine grains scattered by interaction energy
 *   all of it into a long synthetic reverb, with periodic near-silence
 */
export class Sound {
  enabled = false;
  analyser: AnalyserNode | null = null;

  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private wet!: GainNode;
  private bus!: GainNode;
  private droneGain!: GainNode;
  private droneFilter!: BiquadFilterNode;
  private sub!: GainNode;
  private partials: { osc: OscillatorNode; gain: GainNode; rate: number; phase: number }[] = [];
  private air!: GainNode;
  private airFilter!: BiquadFilterNode;
  private airPan!: StereoPannerNode;
  private tick = 0;

  get supported() {
    return typeof window.AudioContext !== 'undefined' || 'webkitAudioContext' in window;
  }

  /** Must be called from a user gesture. Resolves to the new enabled state. */
  async toggle(): Promise<boolean> {
    if (!this.supported) return false;
    try {
      if (!this.ctx) this.build();
      const ctx = this.ctx!;
      this.enabled = !this.enabled;
      if (this.enabled) {
        await ctx.resume();
        this.master.gain.setTargetAtTime(0.85, ctx.currentTime, 1.2);
      } else {
        this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
        window.setTimeout(() => !this.enabled && ctx.suspend().catch(() => {}), 1500);
      }
    } catch {
      this.enabled = false; // permission refused or device unavailable: stay silent
    }
    return this.enabled;
  }

  private build() {
    const AC: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = (this.ctx = new AC());
    const now = ctx.currentTime;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(comp).connect(ctx.destination);
    this.master.connect(this.analyser);

    // long reverberant tail from a decaying noise impulse
    const len = Math.floor(ctx.sampleRate * 6);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 600 ? i / 600 : 1);
      }
    }
    const verb = ctx.createConvolver();
    verb.buffer = ir;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.7;
    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    this.bus.connect(verb).connect(this.wet).connect(this.master);

    // drones
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 220;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.3;
    this.droneFilter.connect(this.droneGain).connect(this.bus);
    for (const [f, g] of [[55, 0.5], [55.27, 0.5], [82.5, 0.28], [82.86, 0.28], [110.13, 0.14], [164.6, 0.06]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const gn = ctx.createGain();
      gn.gain.value = g;
      o.connect(gn).connect(this.droneFilter);
      o.start(now);
    }
    // a barely audible vibration under focused attention
    const so = ctx.createOscillator();
    so.frequency.value = 41.25;
    this.sub = ctx.createGain();
    this.sub.gain.value = 0;
    so.connect(this.sub).connect(this.master);
    so.start(now);

    // overtones
    PARTIALS.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = f * (1 + (Math.random() - 0.5) * 0.002);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.bus);
      osc.start(now);
      this.partials.push({ osc, gain, rate: 0.05 + Math.random() * 0.12, phase: i * 1.7 });
    });

    // distant air
    const nb = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    let last = 0;
    for (let i = 0; i < nd.length; i++) {
      last = last * 0.6 + (Math.random() * 2 - 1) * 0.4;
      nd[i] = last;
    }
    const ns = ctx.createBufferSource();
    ns.buffer = nb;
    ns.loop = true;
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.frequency.value = 500;
    this.airFilter.Q.value = 0.9;
    this.air = ctx.createGain();
    this.air.gain.value = 0.01;
    this.airPan = ctx.createStereoPanner();
    ns.connect(this.airFilter).connect(this.air).connect(this.airPan).connect(this.bus);
    ns.start(now);
  }

  private grain(p: Perception, x: number) {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const oct = Math.random() < 0.3 ? 4 : 2;
    const f = PARTIALS[Math.floor(Math.random() * PARTIALS.length)] * oct * (1 + (Math.random() - 0.5) * 0.01 * (1 + p.turbulence * 12));
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const g = ctx.createGain();
    const dur = 0.05 + Math.random() * 0.22 * (1 - p.turbulence * 0.6);
    const peak = (0.012 + 0.03 * p.energy) * (oct === 4 ? 0.5 : 1);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, x * 0.7 + (Math.random() - 0.5) * 0.6));
    o.connect(g).connect(pan).connect(this.bus);
    o.start(now);
    o.stop(now + dur + 0.02);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
      pan.disconnect();
    };
  }

  /** Map the perceptual model onto musical parameters. */
  update(dt: number, p: Perception, inp: Input, morph: { x: number; y: number; z: number }, closeness: number) {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // grains run every frame so their density tracks gesture energy
    const rate = (inp.touched ? 0.25 : 0.05) + p.energy * 9 + p.turbulence * 16 + p.coherence * 1.5;
    if (Math.random() < rate * dt) this.grain(p, inp.x);

    this.tick += dt;
    if (this.tick < 0.05) return;
    this.tick = 0;
    const k = 0.18;
    const quiet = 1 - 0.8 * p.still;
    this.droneGain.gain.setTargetAtTime((0.26 + 0.1 * p.memory) * quiet, now, 0.8);
    this.droneFilter.frequency.setTargetAtTime(170 + 500 * p.coherence + 260 * p.energy + 200 * closeness, now, 0.5);
    this.sub.gain.setTargetAtTime(0.16 * p.hold, now, 0.4);
    this.wet.gain.setTargetAtTime(0.55 + 0.35 * (1 - closeness), now, 1);

    const w = [morph.x, morph.y, morph.z];
    for (let i = 0; i < this.partials.length; i++) {
      const pt = this.partials[i];
      const lfo = 0.5 + 0.5 * Math.sin(p.time * pt.rate * 6.283 + pt.phase);
      const amt = p.coherence * p.coherence * 0.05 * (0.35 + 0.65 * w[i % 3]) * lfo + p.hold * 0.006;
      pt.gain.gain.setTargetAtTime((amt / (1 + i * 0.35)) * quiet, now, 0.35);
    }

    this.air.gain.setTargetAtTime((0.008 + 0.11 * p.energy + 0.1 * p.turbulence) * quiet, now, k);
    this.airFilter.frequency.setTargetAtTime(380 + 1900 * p.energy + (inp.y + 1) * 500 + 1800 * p.turbulence, now, k);
    this.airPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, inp.x * 0.7)), now, k);
  }
}
