/**
 * Real analysis of the master output (4096-point AnalyserNodes after the ceiling):
 *
 *   time domain → per channel (L, R): sample peak of everything that left the instrument
 *     (L and R)   (peakDb) and RMS of the most recent 43 ms, averaged in power → bridge.amplitude
 *   spectrum    → of the mono sum: band energies (low < 180 Hz ≤ mid < 1.8 kHz ≤ high) → bridge.low/mid/high
 *               → magnitude-weighted mean of log-frequency → bridge.centroid
 *
 * All five are mapped on decibel scales reaching far down, so a very quiet passage
 * still moves the image. Nothing here estimates phase: wave phase is modelled in the
 * bridge, never read off FFT magnitudes.
 */
import type { Bridge } from '../core/contracts';
import { damp } from '../core/math';
import { clamp01 } from './graph';

const LOW_HZ = 180;
const MID_HZ = 1800;
const TOP_HZ = 12000;
const BOTTOM_HZ = 28;
/** Summed bin power of a full-scale sine through the analyser's Blackman window is −11.2 dB. */
const WINDOW_DB = 11.2;
const LN10_20 = Math.LN10 / 20;
const CENTROID_LO = Math.log2(50);
const CENTROID_SPAN = Math.log2(5000) - CENTROID_LO;

export class Analysis {
  private readonly timeL: Float32Array<ArrayBuffer>;
  private readonly timeR: Float32Array<ArrayBuffer>;
  private readonly spec: Float32Array<ArrayBuffer>;
  private readonly logHz: Float32Array;
  private readonly tilt: Float32Array;
  private readonly k0: number;
  private readonly k1: number;
  private readonly k2: number;
  private readonly k3: number;
  private peak = 0;
  private wasLive = false;
  private amp = 0;
  private cen = 0;
  private lo = 0;
  private mi = 0;
  private hi = 0;

  constructor(
    private readonly node: AnalyserNode,
    private readonly left: AnalyserNode,
    private readonly right: AnalyserNode,
    sampleRate: number,
  ) {
    this.timeL = new Float32Array(left.fftSize);
    this.timeR = new Float32Array(right.fftSize);
    this.spec = new Float32Array(node.frequencyBinCount);
    const binHz = sampleRate / node.fftSize;
    const bins = node.frequencyBinCount;
    const bin = (hz: number) => Math.max(1, Math.min(bins, Math.round(hz / binHz)));
    this.k0 = bin(BOTTOM_HZ);
    this.k1 = bin(LOW_HZ);
    this.k2 = bin(MID_HZ);
    this.k3 = bin(TOP_HZ);
    this.logHz = new Float32Array(bins);
    this.tilt = new Float32Array(bins);
    for (let k = 1; k < bins; k++) {
      const hz = k * binHz;
      this.logHz[k] = Math.log2(hz);
      // +3 dB / octave: equal weight per octave for a pink spectrum, so the sub does not pin the centroid.
      this.tilt[k] = Math.sqrt(hz / 100);
    }
  }

  /** Peak of the output in dBFS since resetPeak(). */
  get peakDb(): number {
    return this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity;
  }

  resetPeak(): void {
    this.peak = 0;
  }

  /**
   * `live` = audio is running and audible. The peak is tracked regardless; the bridge is
   * only written (and flagged as measured) while live, otherwise the bridge model takes over.
   */
  update(dt: number, bridge: Bridge, live: boolean): void {
    const tl = this.timeL;
    const tr = this.timeR;
    this.left.getFloatTimeDomainData(tl);
    this.right.getFloatTimeDomainData(tr);
    const n = tl.length;
    const half = n >> 1;
    let peak = this.peak;
    let sq = 0;
    // The whole window is scanned for the peak (85 ms: frames overlap, nothing is missed down to
    // 12 fps); only its newer half feeds the RMS.
    for (let i = 0; i < n; i++) {
      const l = tl[i];
      const r = tr[i];
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      if (i >= half) sq += l * l + r * r;
    }
    this.peak = peak;

    bridge.measured = live;
    if (!live) {
      this.wasLive = false;
      return;
    }
    if (!this.wasLive) {
      // Take over from the bridge model without a jump.
      this.wasLive = true;
      this.amp = bridge.amplitude;
      this.cen = bridge.centroid;
      this.lo = bridge.low;
      this.mi = bridge.mid;
      this.hi = bridge.high;
    }

    const spec = this.spec;
    this.node.getFloatFrequencyData(spec);
    const tilt = this.tilt;
    const logHz = this.logHz;
    let pLow = 0;
    let pMid = 0;
    let pHigh = 0;
    let wSum = 0;
    let wLog = 0;
    for (let k = this.k0; k < this.k1; k++) {
      const db = spec[k];
      if (!(db > -120)) continue;
      const m = Math.exp(db * LN10_20);
      pLow += m * m;
      const w = m * tilt[k];
      wSum += w;
      wLog += w * logHz[k];
    }
    for (let k = this.k1; k < this.k2; k++) {
      const db = spec[k];
      if (!(db > -120)) continue;
      const m = Math.exp(db * LN10_20);
      pMid += m * m;
      const w = m * tilt[k];
      wSum += w;
      wLog += w * logHz[k];
    }
    for (let k = this.k2; k < this.k3; k++) {
      const db = spec[k];
      if (!(db > -120)) continue;
      const m = Math.exp(db * LN10_20);
      pHigh += m * m;
      const w = m * tilt[k];
      wSum += w;
      wLog += w * logHz[k];
    }

    const rmsDb = 10 * Math.log10(sq / (2 * (n - half)) + 1e-12);
    const ampT = clamp01((rmsDb + 58) / 46);
    const lowT = clamp01((10 * Math.log10(pLow + 1e-14) + WINDOW_DB + 54) / 42);
    const midT = clamp01((10 * Math.log10(pMid + 1e-14) + WINDOW_DB + 60) / 44);
    const highT = clamp01((10 * Math.log10(pHigh + 1e-14) + WINDOW_DB + 72) / 46);
    // In true silence there is no centroid; let it rest where it was and sink slowly.
    const audible = rmsDb > -72 && wSum > 0;
    const cenT = audible ? clamp01((wLog / wSum - CENTROID_LO) / CENTROID_SPAN) : this.cen * 0.98;

    this.amp = damp(this.amp, ampT, ampT > this.amp ? 16 : 5, dt);
    this.lo = damp(this.lo, lowT, lowT > this.lo ? 14 : 4, dt);
    this.mi = damp(this.mi, midT, midT > this.mi ? 16 : 5, dt);
    this.hi = damp(this.hi, highT, highT > this.hi ? 20 : 6, dt);
    this.cen = damp(this.cen, cenT, 6, dt);

    bridge.amplitude = this.amp;
    bridge.centroid = this.cen;
    bridge.low = this.lo;
    bridge.mid = this.mi;
    bridge.high = this.hi;
  }
}
