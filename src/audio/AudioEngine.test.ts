/**
 * Smoke test of the whole instrument against a fake Web Audio graph.
 *
 * It cannot listen, but it can prove the things that go wrong silently: that nothing is
 * built before start(), that no call throws or hands an AudioParam a NaN / out-of-range
 * value / non-positive time constant, that raw nodes are never wired straight into Tone
 * nodes, that envelopes really reach silence (reset, dissolve, mute) and that nothing leaks.
 *
 * The fake evaluates setValueAtTime / setTargetAtTime / linearRamp / cancelScheduledValues
 * timelines, so "is anything still audible at the destination" is computed from the real
 * automation the engine scheduled: the largest product of gains along any path from a
 * running source to the destination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Ev = { kind: 'set' | 'target' | 'ramp'; value: number; time: number; tc: number };

  class World {
    time = 0;
    sampleRate = 48000;
    state: 'suspended' | 'running' = 'suspended';
    created = 0;
    violations: string[] = [];
    sources = new Set<FakeSource>();
    /** Every value written to an oscillator frequency with setValueAtTime (i.e. every struck pitch). */
    struck: number[] = [];
    testAmp = 0.1;
    failContext = false;
    transport = 'stopped';
  }
  let world = new World();

  class FakeParam {
    events: Ev[] = [];
    /** Nodes connected to this parameter (control signals and modulators). */
    ins = new Set<FakeNode>();
    private base: number;
    constructor(
      readonly label: string,
      initial: number,
      readonly min = -Infinity,
      readonly max = Infinity,
    ) {
      this.base = initial;
    }
    private check(value: number, time: number, what: string): void {
      if (!Number.isFinite(value)) world.violations.push(`${this.label}.${what}: value ${value}`);
      if (!Number.isFinite(time) || time < 0) world.violations.push(`${this.label}.${what}: time ${time}`);
      if (value < this.min - 1e-9 || value > this.max + 1e-9) world.violations.push(`${this.label}.${what}: ${value} outside [${this.min}, ${this.max}]`);
    }
    private add(e: Ev): void {
      let i = this.events.length;
      while (i > 0 && this.events[i - 1].time > e.time) i--;
      this.events.splice(i, 0, e);
    }
    get value(): number {
      return this.at(world.time);
    }
    set value(v: number) {
      this.check(v, world.time, 'value');
      // As in a browser: the setter assigns the parameter's own value (which a later
      // cancelScheduledValues does not take back) and is also an event on the timeline.
      this.base = v;
      this.add({ kind: 'set', value: v, time: world.time, tc: 0 });
    }
    setValueAtTime(v: number, t: number): this {
      this.check(v, t, 'setValueAtTime');
      if (this.label === 'osc.frequency') world.struck.push(v);
      this.add({ kind: 'set', value: v, time: t, tc: 0 });
      return this;
    }
    setTargetAtTime(v: number, t: number, tc: number): this {
      this.check(v, t, 'setTargetAtTime');
      if (!(tc > 0) || !Number.isFinite(tc)) world.violations.push(`${this.label}.setTargetAtTime: time constant ${tc}`);
      this.add({ kind: 'target', value: v, time: t, tc });
      return this;
    }
    linearRampToValueAtTime(v: number, t: number): this {
      this.check(v, t, 'linearRampToValueAtTime');
      this.add({ kind: 'ramp', value: v, time: t, tc: 0 });
      return this;
    }
    cancelScheduledValues(t: number): this {
      if (!Number.isFinite(t) || t < 0) world.violations.push(`${this.label}.cancelScheduledValues: time ${t}`);
      this.events = this.events.filter((e) => e.time < t);
      return this;
    }
    at(T: number): number {
      let v = this.base;
      let last = 0;
      let target: Ev | null = null;
      const ev = this.events;
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i];
        if (e.kind === 'ramp') {
          if (e.time <= T) {
            v = e.value;
            last = e.time;
            target = null;
          } else {
            return v + ((e.value - v) * (T - last)) / Math.max(1e-9, e.time - last);
          }
          continue;
        }
        if (e.time > T) break;
        if (target) v = target.value + (v - target.value) * Math.exp(-(e.time - last) / target.tc);
        last = e.time;
        if (e.kind === 'set') {
          v = e.value;
          target = null;
        } else {
          target = e;
        }
      }
      if (target) v = target.value + (v - target.value) * Math.exp(-(T - last) / target.tc);
      return v;
    }
  }

  /** A signal on its way to the destination: per-channel amplitude, and whether it has been through a delay or the room. */
  type Sig = { l: number; r: number; stereo: boolean; wet: boolean };

  class FakeNode {
    outs = new Set<FakeNode>();
    ins = new Set<FakeNode>();
    paramOuts = new Set<FakeParam>();
    constructor(readonly kind: string) {
      world.created++;
    }
    connect(dst: unknown, _output?: number, _input?: number): void {
      if (dst instanceof FakeNode) {
        this.outs.add(dst);
        dst.ins.add(this);
      } else if (dst instanceof FakeParam) {
        this.paramOuts.add(dst);
        dst.ins.add(this);
      } else throw new Error(`${this.kind}: connect() to something that is not a node of this context`);
    }
    disconnect(dst?: unknown): void {
      if (dst instanceof FakeNode) {
        this.outs.delete(dst);
        dst.ins.delete(this);
      } else if (dst === undefined) {
        for (const o of this.outs) o.ins.delete(this);
        for (const p of this.paramOuts) p.ins.delete(this);
        this.outs.clear();
        this.paramOuts.clear();
      }
    }
    /** Linear gain this node applies to what passes through it. */
    factor(): number {
      return 1;
    }
    /** What this node does to a component at `f` Hz (level meter). Mutates and returns `s`, or null if nothing gets through. */
    pass(_f: number, s: Sig): Sig | null {
      const g = this.factor();
      if (g === 0) return null;
      s.l *= g;
      s.r *= g;
      return s;
    }
  }

  /** Value of a parameter including the DC arriving from constant sources connected to it. */
  function total(p: FakeParam): number {
    let v = p.value;
    for (const n of p.ins) v += dc(n, 0);
    return v;
  }
  function dc(n: FakeNode, depth: number): number {
    if (depth > 6) return 0;
    if (n instanceof FakeConstant) return n.started && !n.stopped ? total(n.offset) : 0;
    if (n instanceof FakeGain) {
      let sum = 0;
      for (const i of n.ins) sum += dc(i, depth + 1);
      return sum === 0 ? 0 : sum * total(n.gain);
    }
    return 0;
  }
  /** Audio-rate modulation arriving at a parameter: [modulator Hz, peak deviation]. */
  function modulation(p: FakeParam): [number, number] | null {
    let best: [number, number] | null = null;
    const walk = (n: FakeNode, gain: number, depth: number): void => {
      if (depth > 6) return;
      if (n instanceof FakeOsc) {
        const f = total(n.frequency);
        if (n.started && !n.stopped && f >= 20 && (!best || gain > best[1])) best = [f, gain];
      } else if (n instanceof FakeGain) {
        const g = Math.abs(total(n.gain));
        if (g > 0) for (const i of n.ins) walk(i, gain * g, depth + 1);
      }
    };
    for (const n of p.ins) walk(n, 1, 0);
    return best;
  }

  class FakeGain extends FakeNode {
    gain = new FakeParam('gain.gain', 1);
    constructor() {
      super('gain');
    }
    factor(): number {
      return Math.abs(this.gain.value);
    }
  }

  class FakeSource extends FakeNode {
    started = false;
    stopped = false;
    start(when?: number, offset?: number): void {
      if (this.started) throw new Error(`${this.kind}: started twice`);
      if (when !== undefined && (!Number.isFinite(when) || when < 0)) world.violations.push(`${this.kind}.start: when ${when}`);
      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) world.violations.push(`${this.kind}.start: offset ${offset}`);
      this.started = true;
      world.sources.add(this);
    }
    stop(): void {
      if (!this.started) throw new Error(`${this.kind}: stopped before it was started`);
      this.stopped = true;
      world.sources.delete(this);
    }
  }

  class FakeOsc extends FakeSource {
    type = 'sine';
    frequency = new FakeParam('osc.frequency', 440, -24000, 24000);
    detune = new FakeParam('osc.detune', 0);
    constructor() {
      super('oscillator');
    }
    wave: { real: Float32Array; imag: Float32Array } | null = null;
    setPeriodicWave(w: unknown): void {
      if (!w) throw new Error('setPeriodicWave(null)');
      this.wave = w as { real: Float32Array; imag: Float32Array };
    }
  }

  class FakeConstant extends FakeSource {
    offset = new FakeParam('constant.offset', 1);
    constructor() {
      super('constant');
    }
  }

  class FakeBufferSource extends FakeSource {
    buffer: unknown = null;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    constructor() {
      super('bufferSource');
    }
  }

  class FakeBiquad extends FakeNode {
    type = 'lowpass';
    frequency = new FakeParam('biquad.frequency', 350, 0, 24000);
    // For low-pass and high-pass Web Audio reads Q in decibels (negative = no resonance at all).
    Q = new FakeParam('biquad.Q', 1, -100, 1000);
    gain = new FakeParam('biquad.gain', 0, -40, 40);
    constructor() {
      super('biquad');
    }
    /** Magnitude response at `f` Hz, from the Web Audio specification's coefficients. */
    mag(f: number): number {
      const sr = world.sampleRate;
      const f0 = Math.min(sr * 0.4999, Math.max(1e-3, total(this.frequency)));
      const w0 = (2 * Math.PI * f0) / sr;
      const cos = Math.cos(w0);
      const sin = Math.sin(w0);
      const q = total(this.Q);
      let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
      if (this.type === 'lowpass' || this.type === 'highpass') {
        const alpha = sin / (2 * Math.pow(10, q / 20));
        const k = this.type === 'lowpass' ? 1 - cos : 1 + cos;
        b0 = k / 2;
        b1 = this.type === 'lowpass' ? k : -k;
        b2 = k / 2;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
      } else if (this.type === 'bandpass') {
        const alpha = sin / (2 * Math.max(1e-4, q));
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
      } else if (this.type === 'peaking') {
        const alpha = sin / (2 * Math.max(1e-4, q));
        const A = Math.pow(10, total(this.gain) / 40);
        b0 = 1 + alpha * A;
        b1 = -2 * cos;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cos;
        a2 = 1 - alpha / A;
      } else {
        throw new Error(`biquad type ${this.type} is not modelled`);
      }
      const w = (2 * Math.PI * f) / sr;
      const c1 = Math.cos(w);
      const s1 = Math.sin(w);
      const c2 = Math.cos(2 * w);
      const s2 = Math.sin(2 * w);
      const num = Math.hypot(b0 + b1 * c1 + b2 * c2, b1 * s1 + b2 * s2);
      const den = Math.hypot(a0 + a1 * c1 + a2 * c2, a1 * s1 + a2 * s2);
      return num / den;
    }
    pass(f: number, s: Sig): Sig | null {
      const g = this.mag(f);
      s.l *= g;
      s.r *= g;
      return s;
    }
  }

  class FakePanner extends FakeNode {
    pan = new FakeParam('panner.pan', 0, -1, 1);
    constructor() {
      super('panner');
    }
    /** Equal-power panning as specified for StereoPannerNode (mono and stereo inputs differ). */
    pass(_f: number, s: Sig): Sig | null {
      const p = Math.max(-1, Math.min(1, total(this.pan)));
      if (!s.stereo) {
        const x = ((p + 1) / 2) * (Math.PI / 2);
        const a = s.l;
        s.l = a * Math.cos(x);
        s.r = a * Math.sin(x);
        s.stereo = true;
        return s;
      }
      const x = (p <= 0 ? p + 1 : p) * (Math.PI / 2);
      const gl = Math.cos(x);
      const gr = Math.sin(x);
      const l = s.l;
      const r = s.r;
      if (p <= 0) {
        s.l = l + r * gl;
        s.r = r * gr;
      } else {
        s.l = l * gl;
        s.r = l * gr + r;
      }
      return s;
    }
  }

  class FakeDelay extends FakeNode {
    delayTime: FakeParam;
    constructor(max: number) {
      super('delay');
      if (!(max > 0 && max < 180)) throw new Error(`createDelay(${max})`);
      this.delayTime = new FakeParam('delay.delayTime', 0, 0, max);
    }
    /** A delayed copy no longer adds coherently to the direct sound. */
    pass(_f: number, s: Sig): Sig | null {
      s.wet = true;
      return s;
    }
  }

  class FakeShaper extends FakeNode {
    private c: Float32Array | null = null;
    oversample = 'none';
    constructor() {
      super('shaper');
    }
    get curve(): Float32Array | null {
      return this.c;
    }
    set curve(c: Float32Array | null) {
      if (c && c.length < 2) throw new Error('curve too short');
      if (c) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) throw new Error('curve holds a non-finite value');
      this.c = c;
    }
    /** Small-signal gain: the slope of the curve at its centre (input −1…1 spans the whole curve). */
    factor(): number {
      const c = this.c;
      if (!c) return 1;
      const mid = (c.length - 1) >> 1;
      return Math.abs(c[mid + 1] - c[mid - 1]) / (4 / (c.length - 1));
    }
  }

  class FakeAnalyser extends FakeNode {
    fftSize = 2048;
    smoothingTimeConstant = 0.8;
    constructor() {
      super('analyser');
    }
    get frequencyBinCount(): number {
      return this.fftSize / 2;
    }
    getFloatTimeDomainData(a: Float32Array): void {
      for (let i = 0; i < a.length; i++) a[i] = world.testAmp * Math.sin((2 * Math.PI * 220 * i) / world.sampleRate);
    }
    getFloatFrequencyData(a: Float32Array): void {
      const binHz = world.sampleRate / this.fftSize;
      a.fill(-140);
      if (world.testAmp > 0) {
        a[Math.round(220 / binHz)] = 20 * Math.log10(world.testAmp) - 13.6;
        a[Math.round(2000 / binHz)] = 20 * Math.log10(world.testAmp) - 30;
      }
    }
  }

  class FakeBuffer {
    private readonly data: Float32Array[] = [];
    constructor(
      readonly numberOfChannels: number,
      readonly length: number,
      readonly sampleRate: number,
    ) {
      for (let i = 0; i < numberOfChannels; i++) this.data.push(new Float32Array(length));
    }
    getChannelData(ch: number): Float32Array {
      return this.data[ch];
    }
  }

  class FakeContext {
    destination = new FakeNode('destination');
    get currentTime(): number {
      return world.time;
    }
    get sampleRate(): number {
      return world.sampleRate;
    }
    get state(): string {
      return world.state;
    }
    get rawContext(): { state: string; suspend(): Promise<void>; resume(): Promise<void> } {
      return {
        get state() {
          return world.state;
        },
        suspend: () => {
          world.state = 'suspended';
          return Promise.resolve();
        },
        resume: () => this.resume(),
      };
    }
    resume(): Promise<void> {
      world.state = 'running';
      return Promise.resolve();
    }
    createGain = () => new FakeGain();
    createOscillator = () => new FakeOsc();
    createConstantSource = () => new FakeConstant();
    createBufferSource = () => new FakeBufferSource();
    createBiquadFilter = () => new FakeBiquad();
    createStereoPanner = () => new FakePanner();
    createDelay = (max = 1) => new FakeDelay(max);
    createWaveShaper = () => new FakeShaper();
    createAnalyser = () => new FakeAnalyser();
    createChannelSplitter = () => new FakeNode('splitter');
    createBuffer = (channels: number, length: number, sampleRate: number) => new FakeBuffer(channels, length, sampleRate);
    createPeriodicWave = (real: Float32Array, imag: Float32Array) => {
      if (real.length !== imag.length || real.length < 2) throw new Error('createPeriodicWave: bad arrays');
      return { real, imag };
    };
  }

  let context = new FakeContext();

  /** Stand-ins for the three Tone.js nodes the instrument uses. */
  class ToneNode {
    input: FakeNode;
    output: FakeNode;
    constructor(node: FakeNode) {
      this.input = node;
      this.output = node;
    }
    connect(dst: unknown): this {
      this.output.connect(dst instanceof ToneNode ? dst.input : dst);
      return this;
    }
    toDestination(): this {
      this.output.connect(context.destination);
      return this;
    }
    dispose(): this {
      this.output.disconnect();
      return this;
    }
  }
  class ToneGain extends ToneNode {
    gain: { rampTo(value: number, seconds: number): void };
    constructor(opts: { gain?: number }) {
      const g = new FakeGain();
      super(g);
      g.gain.value = opts.gain ?? 1;
      this.gain = {
        rampTo: (value: number, seconds: number) => {
          // Tone schedules from "now + lookAhead".
          const t = world.time + 0.1;
          g.gain.setValueAtTime(g.gain.at(t), t);
          g.gain.linearRampToValueAtTime(value, t + seconds);
        },
      };
    }
  }
  /** Below threshold a DynamicsCompressorNode is its fixed make-up gain: (1 / full-range gain)^0.6. */
  class FakeCompressor extends FakeNode {
    constructor(private readonly makeUp: number) {
      super('compressor');
    }
    factor(): number {
      return this.makeUp;
    }
  }
  class ToneCompressor extends ToneNode {
    constructor(opts: { threshold: number; ratio: number; knee: number; attack: number; release: number }) {
      super(new FakeCompressor(Math.pow(10, (0.6 * -opts.threshold * (1 - 1 / opts.ratio)) / 20)));
      if (opts.threshold > 0 || opts.threshold < -100 || opts.ratio < 1 || opts.ratio > 20 || opts.knee < 0 || opts.knee > 40) throw new Error('compressor range');
      if (opts.attack < 0 || opts.attack > 1 || opts.release < 0 || opts.release > 1) throw new Error('compressor range');
    }
  }
  /**
   * The room. For the level meter its steady-state gain is measured from the impulse response the
   * engine really synthesised, normalised exactly as a ConvolverNode normalises it (Web Audio
   * specification: RMS over all channels scaled to 0.00125 · 44100 / sampleRate), and averaged per
   * third-octave band (a noise-like response has a ragged spectrum; the band mean is what is heard).
   */
  const roomCache = new Map<string, number>();
  class FakeConvolver extends FakeNode {
    constructor(readonly buffer: FakeBuffer) {
      super('convolver');
    }
    gainAt(f: number): number {
      const b = this.buffer;
      const band = Math.round(3 * Math.log2(Math.max(20, f) / 1000));
      const key = `${b.length}:${b.sampleRate}:${band}`;
      const known = roomCache.get(key);
      if (known !== undefined) return known;
      let sq = 0;
      for (let ch = 0; ch < b.numberOfChannels; ch++) {
        const d = b.getChannelData(ch);
        for (let i = 0; i < d.length; i++) sq += d[i] * d[i];
      }
      const rms = Math.max(0.000125, Math.sqrt(sq / (b.numberOfChannels * b.length)));
      const scale = (0.00125 * (44100 / b.sampleRate)) / rms;
      const centre = 1000 * Math.pow(2, band / 3);
      let power = 0;
      let n = 0;
      for (let k = -2; k <= 2; k++) {
        const w = (2 * Math.PI * centre * Math.pow(2, k / 18)) / b.sampleRate;
        const cw = Math.cos(w);
        const sw = Math.sin(w);
        for (let ch = 0; ch < b.numberOfChannels; ch++) {
          const d = b.getChannelData(ch);
          let re = 0;
          let im = 0;
          let cr = 1;
          let ci = 0;
          for (let i = 0; i < d.length; i++) {
            re += d[i] * cr;
            im -= d[i] * ci;
            const t = cr * cw - ci * sw;
            ci = cr * sw + ci * cw;
            cr = t;
          }
          power += (re * re + im * im) * scale * scale;
          n++;
        }
      }
      const g = Math.sqrt(power / n);
      roomCache.set(key, g);
      return g;
    }
    pass(f: number, s: Sig): Sig | null {
      const g = this.gainAt(f);
      if (!s.stereo) s.r = s.l;
      s.l *= g;
      s.r *= g;
      s.stereo = true;
      s.wet = true;
      return s;
    }
  }
  class ToneConvolver extends ToneNode {
    constructor(opts: { url: unknown }) {
      if (!(opts.url instanceof FakeBuffer)) throw new Error('convolver needs the synthesised impulse');
      super(new FakeConvolver(opts.url));
    }
  }

  const toneModule = {
    getContext: () => {
      if (world.failContext) throw new Error('no audio device');
      return context;
    },
    start: () => context.resume(),
    connect: (src: FakeNode, dst: unknown) => src.connect(dst instanceof ToneNode ? dst.input : dst),
    getTransport: () => ({
      get state() {
        return world.transport;
      },
      start: () => {
        world.transport = 'started';
      },
      pause: () => {
        world.transport = 'paused';
      },
      stop: () => {
        world.transport = 'stopped';
      },
    }),
    Gain: ToneGain,
    Compressor: ToneCompressor,
    Convolver: ToneConvolver,
  };

  /**
   * Largest product of gains along any path from a running source to the destination.
   * With `tonal`, only oscillators are considered and their path gains are summed instead:
   * the peak the pitched material would reach if every partial lined up, before the room
   * and before the limiter. (Noise paths carry large gains after very narrow filters, so
   * their path gain says nothing about level and they are left out of that sum.)
   */
  function audible(tonal = false): number {
    const memo = new Map<FakeNode, number>();
    const onPath = new Set<FakeNode>();
    const down = (n: FakeNode): number => {
      if (n === context.destination) return 1;
      const known = memo.get(n);
      if (known !== undefined) return known;
      if (onPath.has(n)) return 0;
      onPath.add(n);
      let best = 0;
      for (const o of n.outs) {
        const f = o.factor();
        if (f === 0) continue;
        const g = f * down(o);
        if (g > best) best = g;
      }
      onPath.delete(n);
      memo.set(n, best);
      return best;
    };
    let max = 0;
    let sum = 0;
    for (const s of world.sources) {
      if (tonal && !(s instanceof FakeOsc)) continue;
      const g = down(s);
      if (g > max) max = g;
      sum += g;
    }
    return tonal ? sum : max;
  }

  // ── level meter ─────────────────────────────────────────────────────────
  //
  // What actually reaches the destination, computed from the graph the engine built and the
  // automation it scheduled, at the present moment: every running oscillator is expanded into its
  // partials (PeriodicWave harmonics, normalised as Web Audio normalises them; FM sidebands from
  // the modulator really connected to its frequency), every noise source into narrow bands of its
  // pink spectrum, and each component is carried down every path to the destination through the
  // real biquad responses, panners, gains, the limiter's make-up, the ceiling and the measured room.
  // Direct paths add in amplitude; anything that went through a delay or the room adds in power.

  type Component = { f: number; l: number; r: number; wl: number; wr: number; tonal: boolean };

  const waveCache = new WeakMap<object, number[]>();
  function harmonicsOf(o: FakeOsc): number[] {
    const w = o.wave;
    if (!w) {
      if (o.type !== 'sine') throw new Error(`oscillator type ${o.type} is not modelled`);
      return [1];
    }
    const known = waveCache.get(w);
    if (known) return known;
    const n = w.real.length;
    let peak = 0;
    for (let i = 0; i < 4096; i++) {
      const x = (2 * Math.PI * i) / 4096;
      let v = 0;
      for (let k = 1; k < n; k++) v += w.real[k] * Math.cos(k * x) + w.imag[k] * Math.sin(k * x);
      peak = Math.max(peak, Math.abs(v));
    }
    const out: number[] = [];
    for (let k = 1; k < n; k++) out.push(Math.hypot(w.real[k], w.imag[k]) / peak);
    waveCache.set(w, out);
    return out;
  }

  /** Bessel function of the first kind, by its integral. */
  function besselJ(n: number, x: number): number {
    let s = 0;
    const steps = 240;
    for (let i = 0; i < steps; i++) {
      const t = ((i + 0.5) / steps) * Math.PI;
      s += Math.cos(n * t - x * Math.sin(t));
    }
    return s / steps;
  }

  /** Power of the synthesised pink noise per octave (buffer RMS 0.25; measured from the buffer the engine generates). */
  const PINK_PER_OCTAVE = 0.0046;
  const BANDS_PER_OCTAVE = 96;

  function pathsFrom(src: FakeNode): FakeNode[][] {
    const reach = new Map<FakeNode, boolean>();
    const reaches = (n: FakeNode, seen: Set<FakeNode>): boolean => {
      if (n === context.destination) return true;
      const known = reach.get(n);
      if (known !== undefined) return known;
      if (seen.has(n)) return false;
      seen.add(n);
      let ok = false;
      for (const o of n.outs) if (reaches(o, seen)) ok = true;
      seen.delete(n);
      reach.set(n, ok);
      return ok;
    };
    const out: FakeNode[][] = [];
    const path: FakeNode[] = [];
    const on = new Set<FakeNode>();
    const walk = (n: FakeNode): void => {
      for (const o of n.outs) {
        if (on.has(o) || !reaches(o, new Set())) continue;
        if (o === context.destination) {
          out.push(path.slice());
          continue;
        }
        // A gain that is shut cuts every path through it, whatever the frequency.
        if (o instanceof FakeGain && o.factor() === 0) continue;
        on.add(o);
        path.push(o);
        walk(o);
        path.pop();
        on.delete(o);
      }
    };
    on.add(src);
    walk(src);
    return out;
  }

  function carry(paths: FakeNode[][], f: number, amp: number, tonal: boolean, into: Component[]): void {
    let dl = 0;
    let dr = 0;
    let wl = 0;
    let wr = 0;
    const s: Sig = { l: 0, r: 0, stereo: false, wet: false };
    for (const path of paths) {
      s.l = amp;
      s.r = amp;
      s.stereo = false;
      s.wet = false;
      let alive = true;
      for (let i = 0; i < path.length; i++) {
        if (!path[i].pass(f, s) || (s.l === 0 && s.r === 0)) {
          alive = false;
          break;
        }
      }
      if (!alive) continue;
      if (!s.stereo) s.r = s.l;
      if (s.wet) {
        wl += s.l * s.l;
        wr += s.r * s.r;
      } else {
        dl += s.l;
        dr += s.r;
      }
    }
    if (dl !== 0 || dr !== 0 || wl !== 0 || wr !== 0) into.push({ f, l: dl, r: dr, wl, wr, tonal });
  }

  function components(): Component[] {
    const out: Component[] = [];
    const nyquist = world.sampleRate / 2;
    for (const src of world.sources) {
      if (src.outs.size === 0) continue;
      if (src instanceof FakeOsc) {
        const f0 = total(src.frequency);
        if (!(f0 >= 15)) continue;
        const paths = pathsFrom(src);
        if (paths.length === 0) continue;
        const harmonics = harmonicsOf(src);
        const fm = modulation(src.frequency);
        if (fm && harmonics.length === 1) {
          const beta = fm[1] / fm[0];
          const kMax = Math.ceil(beta + 5);
          for (let k = -kMax; k <= kMax; k++) {
            const a = Math.abs(besselJ(Math.abs(k), beta));
            const f = Math.abs(f0 + k * fm[0]);
            if (a > 1e-4 && f > 15 && f < nyquist) carry(paths, f, a, true, out);
          }
        } else {
          for (let h = 0; h < harmonics.length; h++) {
            const f = f0 * (h + 1);
            if (harmonics[h] > 0 && f < nyquist) carry(paths, f, harmonics[h], true, out);
          }
        }
      } else if (src instanceof FakeBufferSource) {
        const paths = pathsFrom(src);
        if (paths.length === 0) continue;
        const amp = Math.sqrt((2 * PINK_PER_OCTAVE) / BANDS_PER_OCTAVE);
        for (let b = 0; b < BANDS_PER_OCTAVE * 10; b++) {
          const f = 20 * Math.pow(2, (b + 0.5) / BANDS_PER_OCTAVE);
          if (f < nyquist) carry(paths, f, amp, false, out);
        }
      }
    }
    return out;
  }

  const db = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity);

  /**
   * Level at the destination in dBFS (louder channel):
   *   rms      everything, as power
   *   hi / lo  the part at or above / below 200 Hz (what a laptop speaker does / does not reproduce)
   *   stacked  every pitched partial in phase — an upper bound that is never reached
   *   peak     the level the signal realistically touches: 4 σ of the power sum, taken 3 dB hot
   *            because the slow beats of the paired oscillators coincide now and then; never more
   *            than `stacked` plus 4 σ of the noise and the room
   */
  function level(list: Component[] = components()): { rms: number; hi: number; lo: number; stacked: number; peak: number; list: Component[] } {
    const pow = [0, 0];
    const hi = [0, 0];
    const lo = [0, 0];
    const stack = [0, 0];
    const rest = [0, 0];
    for (const c of list) {
      const p = [(c.l * c.l + c.wl) / 2, (c.r * c.r + c.wr) / 2];
      for (let ch = 0; ch < 2; ch++) {
        pow[ch] += p[ch];
        (c.f >= 200 ? hi : lo)[ch] += p[ch];
        if (c.tonal) {
          stack[ch] += Math.abs(ch === 0 ? c.l : c.r);
          rest[ch] += (ch === 0 ? c.wl : c.wr) / 2;
        } else rest[ch] += p[ch];
      }
    }
    const peak = [0, 1].map((ch) => Math.min(stack[ch] + 4 * Math.sqrt(rest[ch]), 4 * Math.SQRT2 * Math.sqrt(pow[ch])));
    return {
      rms: db(Math.sqrt(Math.max(pow[0], pow[1]))),
      hi: db(Math.sqrt(Math.max(hi[0], hi[1]))),
      lo: db(Math.sqrt(Math.max(lo[0], lo[1]))),
      stacked: db(Math.max(stack[0], stack[1])),
      peak: db(Math.max(peak[0], peak[1])),
      list,
    };
  }

  return {
    toneModule,
    audible,
    components,
    level,
    oscillators: () => Array.from(world.sources).filter((s) => s instanceof FakeOsc).length,
    noises: () => Array.from(world.sources).filter((s) => s instanceof FakeBufferSource).length,
    get world() {
      return world;
    },
    fresh() {
      world = new World();
      context = new FakeContext();
      world.created = 0;
    },
    constants: () => Array.from(world.sources).filter((s): s is FakeConstant => s instanceof FakeConstant),
  };
});

vi.mock('tone', () => fake.toneModule);

import { createBridge } from '../core/bridge';
import type { AudioEngine, Bridge, FieldMix, MemorySnapshot } from '../core/contracts';
import { createHarmony } from '../core/harmony';
import { createMemory } from '../core/memory';
import { createAudioEngine } from './AudioEngine';

const DT = 1 / 60;
const mix = (level: number, brightness: number, diffusion: number, modulation: number): FieldMix => ({ level, brightness, diffusion, modulation });
const SILENT = { earth: mix(0, 0.5, 0.5, 0), air: mix(0, 0.5, 0.5, 0), light: mix(0, 0.5, 0.5, 0) };

function run(engine: AudioEngine, seconds: number, each?: (t: number) => void): void {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) {
    fake.world.time += DT;
    if (each) each(i * DT);
    engine.update(DT);
  }
}

async function begin(seed = 7): Promise<{ engine: AudioEngine; bridge: Bridge }> {
  const bridge = createBridge();
  const engine = createAudioEngine(bridge);
  engine.setHarmony(createHarmony(seed));
  expect(await engine.start()).toBe(true);
  return { engine, bridge };
}

function memoryA(): MemorySnapshot {
  const m = createMemory().data;
  m.gestures = [1, 1.6, 3.1, 3.5, 6.2, 7.0, 7.3, 11.4, 12.0, 14.9];
  return m;
}

function memoryB(): MemorySnapshot {
  const m = createMemory().data;
  m.resonators = [2, 0, 5];
  m.tuning = { ratio: 1.482, seconds: 46 };
  m.constellation = {
    positions: [
      { x: 2.2, y: 0.4, z: -2 },
      { x: -2.0, y: 1.0, z: 1.5 },
      { x: 0.3, y: -1.2, z: 0 },
    ],
    degrees: [3, 5, 1],
  };
  m.balance = { earth: mix(0.9, 0.2, 0.2, 0.1), air: mix(0.2, 0.8, 0.9, 0.7), light: mix(0.8, 0.4, 0.6, 0.2) };
  m.gestures = [2, 2.3, 2.5, 6.5, 6.8, 13, 13.2, 13.5, 20, 20.4, 26];
  return m;
}

beforeEach(() => {
  fake.fresh();
  vi.useFakeTimers();
  vi.stubGlobal('window', { AudioContext: function AudioContext() {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('before start', () => {
  it('builds nothing, never throws, and still marks strikes in the bridge', () => {
    const bridge = createBridge();
    const engine = createAudioEngine(bridge);
    engine.setHarmony(createHarmony(3));
    engine.setMuted(true);
    engine.setMuted(false);
    engine.setPaused(false);
    engine.setDrone(0.5, 0.5);
    engine.setStability(0.3);
    engine.voiceOn(0, 220, { level: 0.5, timbre: 'glass', pos: { x: 1, y: 0, z: 0 } });
    engine.voiceSet(0, { freq: 230 });
    engine.voiceOff(0, 1);
    engine.setFields({ earth: mix(0.5, 0.5, 0.5, 0.5), air: mix(0.5, 0.5, 0.5, 0.5), light: mix(0.5, 0.5, 0.5, 0.5) });
    engine.resolve('consonance');
    engine.setMemory(memoryA());
    engine.setFinale(0.7);
    engine.dissolve(5);
    engine.strike(330, { velocity: 0.8, pos: { x: 1, y: 2, z: 3 }, timbre: 'bell' });
    engine.update(DT);
    engine.reset();
    expect(engine.started).toBe(false);
    expect(engine.peakDb).toBe(-Infinity);
    expect(fake.world.created).toBe(0);
    expect(bridge.attack).toBe(1);
    expect(bridge.attackAt.toArray()).toEqual([1, 2, 3]);
    expect(bridge.measured).toBe(false);
  });

  it('resolves false, without throwing, when audio is unavailable — and stays inert', async () => {
    const bridge = createBridge();
    vi.unstubAllGlobals();
    const noApi = createAudioEngine(bridge);
    expect(await noApi.start()).toBe(false);

    vi.stubGlobal('window', { AudioContext: function AudioContext() {} });
    fake.world.failContext = true;
    const engine = createAudioEngine(bridge);
    expect(await engine.start()).toBe(false);
    expect(engine.started).toBe(false);
    engine.voiceOn(1, 110);
    engine.strike(110);
    engine.resolve('final');
    engine.update(DT);
    engine.reset();
    engine.dispose();
    expect(fake.world.created).toBe(0);
    expect(bridge.measured).toBe(false);
  });

  it('honours state that was asked for while the context was still locked', async () => {
    const bridge = createBridge();
    const engine = createAudioEngine(bridge);
    engine.setHarmony(createHarmony(11));
    engine.setDrone(0.6, 0.4);
    engine.voiceOn(2, 180, { level: 0.6, timbre: 'pure' });
    engine.voiceSet(2, { freq: 190 });
    engine.voiceOn(3, 300, { level: 0.6, timbre: 'fm' });
    engine.voiceOff(3);
    expect(await engine.start()).toBe(true);
    const voices = fake.constants();
    expect(voices.length).toBe(1);
    run(engine, 0.5);
    expect(voices[0].offset.value).toBeCloseTo(190, 3);
    expect(fake.audible()).toBeGreaterThan(0.005);
    expect(fake.world.violations).toEqual([]);
  });
});

describe('the instrument', () => {
  it('measures the real output into the bridge and tracks the peak per channel', async () => {
    const { engine, bridge } = await begin();
    fake.world.testAmp = 0.1;
    run(engine, 1);
    expect(bridge.measured).toBe(true);
    expect(engine.peakDb).toBeCloseTo(-20, 1);
    expect(bridge.amplitude).toBeGreaterThan(0.5);
    expect(bridge.amplitude).toBeLessThanOrEqual(1);
    // the test signal is 220 Hz with a trace at 2 kHz: all mid, a little high, nothing low
    expect(bridge.mid).toBeGreaterThan(0.5);
    expect(bridge.high).toBeGreaterThan(0);
    expect(bridge.mid).toBeGreaterThan(bridge.high);
    expect(bridge.low).toBeLessThan(0.05);
    expect(bridge.centroid).toBeGreaterThan(0.2);
    expect(bridge.centroid).toBeLessThan(0.6);

    // a very quiet passage still registers
    fake.world.testAmp = 0.003;
    run(engine, 2);
    expect(bridge.amplitude).toBeGreaterThan(0.05);
    expect(bridge.amplitude).toBeLessThan(0.5);

    // muted, or paused: the bridge model takes over
    engine.setMuted(true);
    run(engine, 0.1);
    expect(bridge.measured).toBe(false);
    engine.setMuted(false);
    run(engine, 0.1);
    expect(bridge.measured).toBe(true);
    engine.reset();
    fake.world.testAmp = 0;
    run(engine, 0.1);
    expect(engine.peakDb).toBe(-Infinity);
  });

  it('glides a dragged voice continuously and settles within 80 ms', async () => {
    const { engine } = await begin();
    engine.voiceOn(0, 200, { level: 0.8, timbre: 'glass', pos: { x: -1, y: 0, z: 0 } });
    engine.voiceOn(1, 300, { level: 0.8, timbre: 'glass', pos: { x: 1, y: 0, z: 0 } });
    run(engine, 0.6);
    const [a, b] = fake.constants();
    expect(a.offset.value).toBeCloseTo(200, 2);
    expect(b.offset.value).toBeCloseTo(300, 2);

    // a step is never a jump …
    engine.voiceSet(1, { freq: 330 });
    run(engine, DT);
    const justAfter = b.offset.value;
    expect(justAfter).toBeGreaterThan(300);
    expect(justAfter).toBeLessThan(330);
    // … and has arrived (within two cents) 80 ms later
    run(engine, 0.08 - DT);
    expect(Math.abs(1200 * Math.log2(b.offset.value / 330))).toBeLessThan(2);

    // a slow drag is followed closely enough for real beating: never more than a few cents behind
    let worst = 0;
    run(engine, 2, (t) => {
      const hz = 330 - 15 * t;
      engine.voiceSet(1, { freq: hz, pos: { x: 1 - t, y: 0, z: -t } });
      worst = Math.max(worst, Math.abs(1200 * Math.log2(b.offset.value / hz)));
    });
    expect(worst).toBeLessThan(5);

    // soft release, then the nodes are freed
    const before = fake.world.sources.size;
    engine.voiceOff(0, 1);
    engine.voiceOff(1, 1);
    run(engine, 0.3);
    expect(fake.world.sources.size).toBe(before);
    run(engine, 2);
    expect(fake.world.sources.size).toBeLessThan(before);
    expect(fake.constants().length).toBe(0);
    expect(fake.world.violations).toEqual([]);
  });

  it('plays a whole journey without an invalid parameter, reaches silence, and leaks nothing', async () => {
    const { engine, bridge } = await begin(21);
    const h = createHarmony(21);
    engine.setHarmony(h);
    run(engine, 0.2);
    const baseline = fake.world.sources.size;
    expect(fake.audible()).toBe(0);

    // I
    engine.setDrone(0.3, 0.1);
    engine.setStability(0.2);
    engine.strike(h.freq(0, 1), { velocity: 0.32, pos: { x: 0, y: 0, z: 0 }, timbre: 'sub' });
    for (let i = 0; i < 3; i++) {
      engine.strike(h.freq(i * 2, 2), { velocity: 0.7, pos: { x: i - 1, y: 0.5, z: -i }, timbre: 'bell' });
      engine.voiceOn(i, h.freq(i * 2, 2), { level: 0.5, timbre: 'pure', pos: { x: i - 1, y: 0.5, z: -i } });
      run(engine, 1.5);
    }
    expect(bridge.attack).toBe(1);
    engine.resolve('signal');
    run(engine, 6);
    for (let i = 0; i < 3; i++) engine.voiceOff(i, 2);

    // II
    engine.setDrone(0.5, 0.2);
    for (let i = 0; i < 3; i++) engine.voiceOn(i, h.freq(0, 2) * (1 + i * 0.26), { level: 0, timbre: 'glass', pos: { x: i, y: 0, z: 0 } });
    engine.voiceOn(3, h.freq(4, 2), { level: 0, timbre: 'pure' });
    run(engine, 6, (t) => {
      engine.voiceSet(2, { freq: h.freq(0, 2) * (1.4 + 0.02 * t), level: 0.6, pos: { x: 2 - t * 0.2, y: 0, z: 0 } });
      engine.voiceSet(0, { level: 0.6 });
      engine.setStability(Math.min(1, t / 5));
    });
    engine.resolve('consonance');
    run(engine, 9);
    for (let i = 0; i < 4; i++) engine.voiceOff(i, 1.5);

    // III — more strikes than the pool holds: stealing must stay valid
    for (let i = 0; i < 3; i++) engine.voiceOn(i, h.freq(i + 1, 3), { level: 0.5, timbre: 'fm', pos: { x: i, y: 1, z: -1 } });
    engine.voiceOn(5, h.freq(2, 2), { level: 0.4, timbre: 'breath', pos: { x: 0, y: 0, z: 2 } });
    for (let i = 0; i < 40; i++) {
      engine.strike(h.freq(i % 9, 2 + (i % 3)), { velocity: 0.2 + 0.02 * i, pos: { x: (i % 5) - 2, y: 0, z: -(i % 4) }, timbre: i % 2 ? 'glass' : 'bell' });
      run(engine, 0.03);
    }
    for (let i = 0; i < 3; i++) engine.voiceSet(i, { brightness: i / 2, level: 0.3 });
    engine.resolve('lattice');
    run(engine, 7);
    for (let i = 0; i < 8; i++) engine.voiceOff(i, 0.3);

    // IV
    engine.setStability(0);
    const fields = { earth: mix(0, 0.3, 0.5, 0.3), air: mix(0, 0.5, 0.6, 0.4), light: mix(0, 0.75, 0.4, 0.3) };
    run(engine, 20, (t) => {
      const k = Math.min(1, t / 10);
      fields.earth.level = k;
      fields.air.level = 0.8 * k;
      fields.light.level = 0.9 * k;
      fields.earth.brightness = 0.5 + 0.5 * Math.sin(t);
      fields.air.diffusion = 0.5 + 0.5 * Math.cos(t * 0.7);
      fields.light.modulation = 0.5 + 0.5 * Math.sin(t * 0.3);
      engine.setFields(fields);
      engine.setStability(k);
    });
    engine.resolve('balance');
    run(engine, 10);

    // V
    engine.setMemory(memoryA());
    engine.setDrone(0.36, 0.45);
    let marked = 0;
    run(engine, 40, (t) => {
      engine.setFinale(Math.min(0.78, 0.15 + t / 40));
      engine.setStability(0.88);
      if (bridge.attack > 0 && bridge.attack < 1) marked++;
      bridge.attack = Math.max(0, bridge.attack - DT / 0.6);
    });
    expect(marked).toBeGreaterThan(0);
    expect(fake.audible()).toBeGreaterThan(0.01);
    // Headroom: with every pitched partial of the full chapter V texture in phase, the dry
    // sum stays under the limiter threshold (−8 dBFS = 0.40); the ceiling is never needed for it.
    const stacked = fake.audible(true);
    console.info(`chapter V, all partials in phase: ${(20 * Math.log10(stacked)).toFixed(1)} dBFS`);
    expect(stacked).toBeGreaterThan(0.03);
    expect(stacked).toBeLessThan(0.4);

    // dissolve → true silence
    engine.dissolve(10);
    run(engine, 5);
    expect(fake.audible()).toBeGreaterThan(0);
    run(engine, 5.2);
    expect(fake.audible()).toBe(0);
    engine.setFields(SILENT);

    // the last resonance is let through, and then that is gone too
    engine.resolve('final');
    run(engine, 1);
    expect(fake.audible()).toBeGreaterThan(0.001);
    run(engine, 22);
    expect(fake.audible()).toBe(0);

    // restart: quiet within half a second, back to the idle graph soon after
    engine.setFinale(0.8);
    engine.setDrone(0.6, 0.5);
    engine.voiceOn(0, 220, { level: 1 });
    engine.strike(440, { velocity: 1 });
    engine.resolve('consonance');
    run(engine, 0.3);
    engine.reset();
    run(engine, 0.5);
    expect(fake.audible()).toBeLessThan(1e-3);
    run(engine, 3);
    expect(fake.audible()).toBeLessThan(1e-6);
    expect(fake.world.sources.size).toBe(baseline);

    // and the next journey can be heard again
    engine.setDrone(0.5, 0.3);
    engine.strike(220, { velocity: 0.8 });
    run(engine, 1);
    expect(fake.audible()).toBeGreaterThan(0.005);

    expect(fake.world.violations).toEqual([]);

    engine.dispose();
    expect(fake.world.sources.size).toBe(0);
    expect(engine.started).toBe(false);
    engine.voiceOn(0, 220);
    engine.strike(220);
    engine.update(DT);
    expect(bridge.measured).toBe(false);
  });

  it('composes a different piece from a different memory', async () => {
    const melody = async (m: MemorySnapshot): Promise<number[]> => {
      fake.fresh();
      const { engine } = await begin(99);
      const before = fake.world.struck.length;
      engine.setMemory(m);
      run(engine, 45, () => engine.setFinale(0.7));
      expect(fake.world.violations).toEqual([]);
      const notes = fake.world.struck.slice(before);
      engine.dispose();
      return notes;
    };
    const a = await melody(memoryA());
    const a2 = await melody(memoryA());
    const b = await melody(memoryB());
    expect(a.length).toBeGreaterThan(12);
    expect(b.length).toBeGreaterThan(12);
    // the same visit is the same piece; another visit is another piece
    expect(a2).toEqual(a);
    expect(b).not.toEqual(a);
  });

  it('mutes without a click and pauses the context and the transport', async () => {
    const { engine, bridge } = await begin();
    engine.setDrone(0.8, 0.5);
    run(engine, 8);
    const open = fake.audible();
    expect(open).toBeGreaterThan(0);

    engine.setMuted(true);
    run(engine, 0.12);
    const closing = fake.audible();
    expect(closing).toBeGreaterThan(0);
    expect(closing).toBeLessThan(open);
    run(engine, 0.4);
    expect(fake.audible()).toBe(0);
    engine.setMuted(false);
    run(engine, 0.6);
    expect(fake.audible()).toBeCloseTo(open, 3);

    expect(fake.world.transport).toBe('started');
    engine.setPaused(true);
    expect(fake.world.transport).toBe('paused');
    expect(fake.world.state).toBe('running');
    fake.world.time += 0.1;
    vi.advanceTimersByTime(100);
    expect(fake.world.state).toBe('suspended');
    engine.update(DT);
    expect(bridge.measured).toBe(false);

    engine.setPaused(false);
    expect(fake.world.state).toBe('running');
    expect(fake.world.transport).toBe('started');
    run(engine, 0.3);
    expect(bridge.measured).toBe(true);
    expect(fake.audible()).toBeCloseTo(open, 3);

    // a pause that is taken back at once never suspends
    engine.setPaused(true);
    engine.setPaused(false);
    vi.advanceTimersByTime(200);
    expect(fake.world.state).toBe('running');
    expect(fake.world.violations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────── gain staging ──

const dB = (x: number): string => (Number.isFinite(x) ? x.toFixed(1).padStart(6) : '  -inf');

/** Seeds whose roots sit at the bottom, the middle and the top of the 46–62 Hz range, and one minor mode. */
function seedFor(pick: (root: number, third: number) => boolean): number {
  for (let s = 1; s < 5000; s++) {
    const h = createHarmony(s);
    if (pick(h.root, h.ratios[2])) return s;
  }
  throw new Error('no such seed');
}
const SEED_LOW = seedFor((r) => r < 46.6);
const SEED_MID = seedFor((r, t) => r > 53 && r < 55 && t === 5 / 4);
const SEED_HIGH = seedFor((r) => r > 61.4);

/** The loudest moment of an event: sampled every `every` seconds for `seconds`. */
function loudest(engine: AudioEngine, seconds: number, every = DT): ReturnType<typeof fake.level> {
  let best = fake.level();
  const steps = Math.max(1, Math.round(seconds / every));
  for (let i = 0; i < steps; i++) {
    run(engine, every);
    const m = fake.level();
    if (m.rms > best.rms) best = m;
  }
  return best;
}

describe('levels (scratch)', () => {
  it('prints the table', async () => {
    const lines: string[] = [];
    const put = (name: string, m: ReturnType<typeof fake.level>) =>
      lines.push(`${name.padEnd(46)} rms ${dB(m.rms)}  >=200Hz ${dB(m.hi)}  <200Hz ${dB(m.lo)}  stacked ${dB(m.stacked)}  peak ${dB(m.peak)}`);
    for (const seed of [SEED_LOW, SEED_MID, SEED_HIGH]) {
      const h = createHarmony(seed);
      lines.push(`── seed ${seed}: root ${h.root.toFixed(1)} Hz, ${h.modeName}`);
      const only = new RegExp((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.ROWS ?? '.');
      const solo = async (name: string, act: (e: AudioEngine) => void, seconds: number, every = DT) => {
        if (!only.test(name)) return;
        fake.fresh();
        const { engine } = await begin(seed);
        run(engine, 0.5);
        act(engine);
        put(name, loudest(engine, seconds, every));
        engine.dispose();
      };
      const held = async (name: string, act: (e: AudioEngine) => void, settle = 6) => {
        if (!only.test(name)) return;
        fake.fresh();
        const { engine } = await begin(seed);
        run(engine, 0.5);
        act(engine);
        run(engine, settle);
        put(name, fake.level());
        engine.dispose();
      };
      const P = { x: 0.3, y: 0.5, z: -0.15 };
      // I
      await held('I   drone 0.22 / 0.1 (enter)', (e) => (e.setStability(0.2), e.setDrone(0.22, 0.1)));
      await held('I   drone 0.43 / 0.25 (three woken)', (e) => (e.setStability(0.5), e.setDrone(0.43, 0.25)));
      await held('I   drone 0.6 / 0.3 (signature)', (e) => (e.setStability(1), e.setDrone(0.6, 0.3)));
      await solo('I   pulse: sub strike v 0.32', (e) => e.strike(h.freq(0, 1), { velocity: 0.32, pos: { x: 0, y: 0.12, z: -0.08 }, timbre: 'sub' }), 0.3);
      await solo('I   wake: bell v 0.85 (root x4)', (e) => e.strike(h.freq(0, 2), { velocity: 0.85, pos: P, timbre: 'bell' }), 0.2);
      await solo('I   re-strike: bell v 0.45', (e) => e.strike(h.freq(4, 2), { velocity: 0.45, pos: P, timbre: 'bell' }), 0.2);
      await solo('I   guide: glass v 0.16', (e) => e.strike(h.freq(2, 3), { velocity: 0.16, pos: P, timbre: 'glass' }), 0.2);
      await held('I   voice pure 0.3 (root x4)', (e) => e.voiceOn(0, h.freq(0, 2), { level: 0.3, timbre: 'pure', pos: { x: -1.5, y: 0.5, z: -0.15 } }), 2);
      await held('I   voice pure 0.42 (third, x8)', (e) => (e.voiceOn(2, h.freq(2, 3), { level: 0.42, timbre: 'pure', pos: P }), e.voiceSet(2, { brightness: 0.5 })), 2);
      await solo('I   resolve signal', (e) => (e.setStability(1), e.resolve('signal')), 6, 0.25);
      // II
      const A = h.root * 4;
      const target = A * 2 * h.ratios[2];
      const two = (e: AudioEngine, cents: number) => {
        e.setStability(1 / (1 + (cents / 22) ** 2));
        e.voiceOn(0, A, { level: 0.75, timbre: 'glass', pos: { x: -1.26, y: -0.7, z: 0.12 } });
        e.voiceOn(1, A * 1.5, { level: 0.62, timbre: 'glass', pos: { x: 0.9, y: -0.9, z: -0.22 } });
        e.voiceOn(2, target * Math.pow(2, cents / 1200), { level: 0.68, timbre: 'glass', pos: { x: 1.2, y: 0.8, z: -0.1 } });
        e.voiceOn(3, target, { level: 0.14, timbre: 'pure', pos: { x: -0.18, y: -0.8, z: -0.05 } });
      };
      await held('II  drone 0.5 / 0.2', (e) => (e.setStability(0.2), e.setDrone(0.5, 0.2)));
      await held('II  three glass voices + sympathetic', (e) => two(e, 40), 2);
      await solo('II  ring: glass v 0.4', (e) => e.strike(target, { velocity: 0.4, pos: P, timbre: 'glass' }), 0.2);
      await solo('II  resolve consonance', (e) => (e.setStability(1), e.resolve('consonance')), 8, 0.25);
      await held('II  solved: voices + drone 0.65 / 0.35', (e) => (two(e, 0), e.setDrone(0.65, 0.35), [0, 1, 2].forEach((i) => e.voiceSet(i, { brightness: 0.7 }))));
      // III
      await held('III drone 0.34 / 0.3', (e) => (e.setStability(0.5), e.setDrone(0.34, 0.3)));
      await solo('III hover: glass v 0.22', (e) => e.strike(A * 1.25, { velocity: 0.22, pos: P, timbre: 'glass' }), 0.2);
      await solo('III guide: glass v 0.16', (e) => e.strike(A * 1.5, { velocity: 0.16, pos: P, timbre: 'glass' }), 0.2);
      await solo('III press: bell v 0.8', (e) => e.strike(A * 1.5, { velocity: 0.8, pos: P, timbre: 'bell' }), 0.2);
      await held('III held voice fm 0.5', (e) => e.voiceOn(0, A * 1.25, { level: 0.5, timbre: 'fm', pos: P }), 2);
      await held('III chord: three fm 0.3', (e) => [1, 1.25, 1.5].forEach((r, i) => e.voiceOn(i, A * r, { level: 0.3, timbre: 'fm', pos: { x: i - 1, y: 0.3, z: -0.4 * i } })), 2);
      await solo('III resolve lattice', (e) => (e.setStability(1), e.resolve('lattice')), 5, 0.05);
      // IV — the composed arrangement (balance.ts COMPOSED → mixFromPose)
      const earth = mix(0.67, 0.275, 0.22, 0.3);
      const air = mix(0.7, 0.59, 0.7, 0.3);
      const light = mix(0.68, 0.79, 0.28, 0.3);
      const off = mix(0, 0.5, 0.5, 0);
      await held('IV  drone 0.3 / 0.3', (e) => (e.setStability(0.3), e.setDrone(0.3, 0.3)));
      await held('IV  EARTH alone 0.67', (e) => (e.setStability(1), e.setFields({ earth, air: off, light: off })), 4);
      await held('IV  AIR alone 0.70 (breath; grains on top)', (e) => (e.setStability(1), e.setFields({ earth: off, air, light: off })), 4);
      await held('IV  LIGHT alone 0.68', (e) => (e.setStability(1), e.setFields({ earth: off, air: off, light })), 4);
      await held('IV  EARTH far 0.3', (e) => (e.setStability(1), e.setFields({ earth: mix(0.3, 0.5, 0.6, 0.3), air: off, light: off })), 4);
      await held('IV  LIGHT far 0.3', (e) => (e.setStability(1), e.setFields({ earth: off, air: off, light: mix(0.3, 0.5, 0.6, 0.3) })), 4);
      await held('IV  all three + drone 0.42 / 0.5', (e) => (e.setStability(1), e.setDrone(0.42, 0.5), e.setFields({ earth, air, light })), 6);
      await solo('IV  press earth: sub v 0.28', (e) => e.strike(h.freq(0, 1), { velocity: 0.28, pos: P, timbre: 'sub' }), 0.3);
      await solo('IV  press air: glass v 0.28', (e) => e.strike(h.freq(4, 2), { velocity: 0.28, pos: P, timbre: 'glass' }), 0.2);
      await solo('IV  press light: bell v 0.28', (e) => e.strike(h.freq(2, 3), { velocity: 0.28, pos: P, timbre: 'bell' }), 0.2);
      await solo('IV  resolve balance', (e) => (e.setStability(1), e.resolve('balance')), 8, 0.25);
      // V
      const mem = memoryA();
      mem.balance = { earth, air, light };
      const five = (e: AudioEngine, finale: number, stab: number) => {
        e.setMemory(mem);
        e.setFinale(finale);
        e.setDrone(0.36, 0.45);
        e.setStability(stab);
        e.setFields({ earth, air, light });
      };
      await held('V   opening: finale 0.15', (e) => five(e, 0.15, 0.88), 8);
      await held('V   finale 0.5', (e) => five(e, 0.5, 0.88), 8);
      await held('V   pad alone, finale 0.78', (e) => (e.setMemory({ ...mem, balance: { earth: off, air: off, light: off } }), e.setFinale(0.78), e.setStability(1)), 8);
      await held('V   full texture: finale 0.78', (e) => five(e, 0.78, 1), 8);
      await solo('V   visitor strike: bell v 0.12 (still)', (e) => e.strike(h.freq(2, 2), { velocity: 0.12, pos: P, timbre: 'bell' }), 0.2);
      await solo('V   visitor strike: glass v 0.066 (unfold)', (e) => e.strike(h.freq(2, 3), { velocity: 0.066, pos: P, timbre: 'glass' }), 0.2);
      await solo('V   visitor strike: bell v 0.57 (moving)', (e) => e.strike(h.freq(2, 2), { velocity: 0.57, pos: P, timbre: 'bell' }), 0.2);
      await solo('V   resolve final (after the dissolve)', (e) => (e.dissolve(1), run(e, 1.2), e.resolve('final')), 1.5, 0.05);
    }
    console.info('\n' + lines.join('\n'));
  });
});
