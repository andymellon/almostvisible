/**
 * One-shot FM resonators. A voice is three oscillators (carrier, modulator, one extra
 * partial); voices are built when a strike needs one, reused while they exist and freed a
 * moment after they have rung out, so nothing runs while nothing sounds. At most ten are
 * alive at once (six on the lite tier). Each voice is silent whenever its gain timeline says
 * so, and that timeline is written in full at the strike: there is no note-off to lose, hence
 * no stuck note.
 *
 *   bell   carrier : modulator = 1 : 1.4 (inharmonic), index falling 2.2 → 0.2, plus a
 *          2.76× partial; decay time constant 1.7 s (≈ 12 s to −60 dB)
 *   glass  1 : 3, short bright index burst, 5.4× partial; decay 0.3 s
 *   sub    1 : 3 with a little index and a partial on the twelfth: the fundamental is pressure
 *          (it is folded below 130 Hz), the harmonics 2 · 3 · 4 above it are what a small
 *          loudspeaker reproduces of it
 *
 * Stealing: an idle voice if there is one, otherwise a new one, otherwise the quietest. A
 * stolen voice is closed over ~20 ms before it is retuned, so stealing never clicks.
 */
import type { StrikeTimbre, Vec3Like } from '../core/contracts';
import { Patch, clamp01, depthCutoff, depthGain, depthSend, place, type Placement, type Rig } from './graph';
import type { Space } from './space';

const POOL = 10;
const POOL_LITE = 6;
/** A voice is kept this long after it has rung out before its oscillators are stopped. */
const LINGER = 1.5;
/** Decay time constants until a voice counts as rung out (−69 dB). */
const RING = 8;

interface Recipe {
  /** Modulator / carrier frequency ratio. */
  ratio: number;
  /** FM index at the attack and where it settles, with the time constant between. */
  idx0: number;
  idx1: number;
  idxTc: number;
  /** Attack and decay time constants (s). */
  atk: number;
  dec: number;
  /** Extra sine partial: ratio, relative gain, decay. */
  pRatio: number;
  pGain: number;
  pDec: number;
  /** Peak at velocity 1, close. */
  peak: number;
  /** Extra reverb send and delay send. */
  send: number;
  echo: number;
}

const RECIPES: Record<StrikeTimbre, Recipe> = {
  bell: { ratio: 1.4, idx0: 2.2, idx1: 0.2, idxTc: 0.35, atk: 0.005, dec: 1.7, pRatio: 2.76, pGain: 0.22, pDec: 0.45, peak: 0.1, send: 0.3, echo: 0.2 },
  glass: { ratio: 3, idx0: 1.3, idx1: 0.08, idxTc: 0.09, atk: 0.003, dec: 0.3, pRatio: 5.4, pGain: 0.16, pDec: 0.07, peak: 0.09, send: 0.35, echo: 0.4 },
  sub: { ratio: 3, idx0: 1.3, idx1: 0.55, idxTc: 0.3, atk: 0.02, dec: 0.85, pRatio: 3, pGain: 0.32, pDec: 0.6, peak: 0.15, send: 0, echo: 0 },
};

interface StrikeVoice {
  patch: Patch;
  car: OscillatorNode;
  mod: OscillatorNode;
  par: OscillatorNode;
  dev: GainNode;
  cAmp: GainNode;
  pAmp: GainNode;
  dist: BiquadFilterNode;
  pan: StereoPannerNode;
  send: GainNode;
  echo: GainNode;
  /** Envelope bookkeeping for stealing. */
  t0: number;
  peak: number;
  dec: number;
  until: number;
}

export class Strikes {
  private readonly pool: StrikeVoice[] = [];
  private readonly at: Placement = { pan: 0, depth: 0.3 };
  private readonly nyquist: number;
  private readonly size: number;

  constructor(
    private readonly rig: Rig,
    private readonly space: Space,
  ) {
    this.nyquist = rig.sampleRate * 0.45;
    this.size = rig.lite ? POOL_LITE : POOL;
  }

  /** Oscillators start silent (both amplitudes are 0) and already on pitch. */
  private build(f: number, fm: number, fp: number): StrikeVoice {
    const p = new Patch(this.rig);
    const car = p.osc('sine', f);
    const mod = p.osc('sine', fm);
    const par = p.osc('sine', fp);
    const dev = p.gain(0);
    const cAmp = p.gain(0);
    const pAmp = p.gain(0);
    const dist = p.filter('lowpass', 8000, 0.5);
    const pan = p.pan(0);
    const send = p.gain(0.3);
    const echo = p.gain(0);
    mod.connect(dev);
    dev.connect(car.frequency);
    car.connect(cAmp);
    par.connect(pAmp);
    cAmp.connect(dist);
    pAmp.connect(dist);
    dist.connect(pan);
    pan.connect(this.space.dry);
    pan.connect(send);
    send.connect(this.space.reverbIn);
    pan.connect(echo);
    echo.connect(this.space.delayIn);
    return { patch: p, car, mod, par, dev, cAmp, pAmp, dist, pan, send, echo, t0: 0, peak: 0, dec: 1, until: 0 };
  }

  /** Voices alive right now (sounding or lingering). */
  get alive(): number {
    return this.pool.length;
  }

  /** A strike at a world position. */
  strike(freq: number, velocity: number, timbre: StrikeTimbre, pos: Vec3Like | undefined): void {
    const at = place(pos, this.at);
    this.ping(freq, velocity, timbre, at.pan, at.depth);
  }

  /** A strike at an explicit stage position (used by the instrument's own melodic events). */
  ping(freq: number, velocity: number, timbre: StrikeTimbre, pan: number, depth: number): void {
    if (!(freq > 0) || !Number.isFinite(freq)) return;
    const r = RECIPES[timbre];
    let f = freq < 20 ? 20 : freq > 9000 ? 9000 : freq;
    if (timbre === 'sub') while (f > 130) f *= 0.5;
    const vel = clamp01(velocity);
    if (vel <= 0) return;
    const now = this.rig.now;
    const fm = f * r.ratio;
    const fpRaw = f * r.pRatio;
    const fp = fpRaw < this.nyquist ? fpRaw : f;

    // Voice allocation: idle, else new, else the quietest.
    const pool = this.pool;
    let v: StrikeVoice | null = null;
    let stolen = false;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].until <= now) {
        v = pool[i];
        break;
      }
    }
    if (!v) {
      if (pool.length < this.size) {
        v = this.build(f, fm, fp);
        pool.push(v);
      } else {
        let bestScore = Infinity;
        for (let i = 0; i < pool.length; i++) {
          const c = pool[i];
          const score = c.peak * Math.exp(-(now - c.t0) / c.dec);
          if (score < bestScore) {
            bestScore = score;
            v = c;
          }
        }
        stolen = true;
      }
    }
    if (!v) return;
    const t = now + (stolen ? 0.022 : 0.003);

    const cg = v.cAmp.gain;
    const pg = v.pAmp.gain;
    const dg = v.dev.gain;
    cg.cancelScheduledValues(now);
    pg.cancelScheduledValues(now);
    dg.cancelScheduledValues(now);
    if (stolen) {
      cg.setTargetAtTime(0, now, 0.004);
      pg.setTargetAtTime(0, now, 0.004);
    }

    // Keep the sidebands below Nyquist: the higher the note, the purer it is struck.
    const tame = Math.pow(Math.min(1, 900 / f), 0.7) * (0.4 + 0.6 * vel);
    // Everything that steps (pitch, index, place, sends) steps at `t`, when this voice is
    // silent: rung out, newly built, or just closed.
    v.car.frequency.cancelScheduledValues(now);
    v.mod.frequency.cancelScheduledValues(now);
    v.par.frequency.cancelScheduledValues(now);
    v.car.frequency.setValueAtTime(f, t);
    v.mod.frequency.setValueAtTime(fm, t);
    v.par.frequency.setValueAtTime(fp, t);
    dg.setValueAtTime(r.idx0 * tame * fm, t);
    dg.setTargetAtTime(r.idx1 * tame * fm, t, r.idxTc);

    // Velocity → level on a gentle curve: a whisper (0.1) is 16 dB under a full strike, not 24.
    const d = clamp01(depth);
    const peak = r.peak * Math.pow(vel, 0.8) * depthGain(d);
    cg.setTargetAtTime(peak, t, r.atk);
    cg.setTargetAtTime(0, t + r.atk * 4, r.dec);
    const pPeak = fpRaw < this.nyquist ? peak * r.pGain : 0;
    pg.setTargetAtTime(pPeak, t, r.atk);
    pg.setTargetAtTime(0, t + r.atk * 4, r.pDec);

    v.dist.frequency.cancelScheduledValues(now);
    v.pan.pan.cancelScheduledValues(now);
    v.send.gain.cancelScheduledValues(now);
    v.echo.gain.cancelScheduledValues(now);
    v.dist.frequency.setValueAtTime(depthCutoff(d), t);
    v.pan.pan.setValueAtTime(pan < -1 ? -1 : pan > 1 ? 1 : pan, t);
    v.send.gain.setValueAtTime(timbre === 'sub' ? 0.1 : depthSend(d) + r.send, t);
    v.echo.gain.setValueAtTime(r.echo, t);

    v.t0 = t;
    v.peak = peak;
    v.dec = r.dec;
    v.until = t + r.atk * 4 + r.dec * RING;
  }

  /** Once per frame: stop and free the voices that rang out a while ago. Allocates nothing. */
  prune(): void {
    const pool = this.pool;
    if (pool.length === 0) return;
    const now = this.rig.now;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].until + LINGER <= now) {
        pool[i].patch.free();
        pool[i] = pool[pool.length - 1];
        pool.pop();
      }
    }
  }

  /** Close every resonator (≈ 0.2 s). */
  silence(): void {
    const now = this.rig.now;
    for (const v of this.pool) {
      v.cAmp.gain.cancelScheduledValues(now);
      v.pAmp.gain.cancelScheduledValues(now);
      v.cAmp.gain.setTargetAtTime(0, now, 0.04);
      v.pAmp.gain.setTargetAtTime(0, now, 0.04);
      v.until = Math.min(v.until, now + 0.3);
    }
  }

  dispose(): void {
    for (const v of this.pool) v.patch.free();
    this.pool.length = 0;
  }
}
