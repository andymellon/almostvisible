import { Vector3 } from 'three';
import { MAX_WAVES, type Bridge, type Harmony, type WaveSource } from './contracts';
import { clamp, damp, TAU } from './math';

/** Common phase velocity (Hz) of all wavefronts: how fast rings travel outward. */
const CARRIER_HZ = 0.11;
/** Visual beat rate per Hz of real detune. Real beats are too fast to read; this keeps them legible. */
const BEAT_SCALE = 0.16;

export function createBridge(): Bridge {
  const waves: WaveSource[] = Array.from({ length: MAX_WAVES }, () => ({
    position: new Vector3(),
    freq: 0,
    level: 0,
    amp: 0,
    phase: 0,
  }));
  return {
    time: 0,
    dt: 0,
    fundamental: 55,
    waves,
    activeWaves: 0,
    amplitude: 0,
    centroid: 0,
    low: 0,
    mid: 0,
    high: 0,
    measured: false,
    attack: 0,
    attackAt: new Vector3(),
    stability: 0,
    presence: 0,
    spectral: 0,
    silence: 0,
    chapter: 0,
    progress: 0,
    pointer: new Vector3(),
    pointerEnergy: 0,
  };
}

/**
 * Advance the modelled part of the bridge. Call once per frame *before*
 * AudioEngine.update (which overwrites the measured values when audio runs).
 */
export function stepBridge(b: Bridge, harmony: Harmony, dt: number): void {
  b.time += dt;
  b.dt = dt;
  b.fundamental = harmony.root;
  let active = 0;
  let sum = 0;
  let weighted = 0;
  for (let i = 0; i < MAX_WAVES; i++) {
    const w = b.waves[i];
    const target = w.freq > 0 ? clamp(w.level) : 0;
    w.amp = damp(w.amp, target, target > w.amp ? 5 : 1.6, dt);
    if (w.amp < 1e-4 && target === 0) {
      w.amp = 0;
      continue;
    }
    // In tune → every source shares the carrier, so nodal lines stand still.
    // Detuned → this source runs ahead/behind and the interference crawls.
    const detuneHz = w.freq > 0 ? w.freq - harmony.nearest(w.freq) : 0;
    w.phase = (w.phase + TAU * (CARRIER_HZ + detuneHz * BEAT_SCALE) * dt) % TAU;
    if (w.amp > 0.02) active++;
    sum += w.amp;
    weighted += w.amp * Math.log2(Math.max(w.freq, 1) / b.fundamental);
  }
  b.activeWaves = active;
  b.attack = Math.max(0, b.attack - dt / 0.6);

  if (!b.measured) {
    // No analyser: derive a plausible spectrum from the model so the image never depends on audio.
    const amp = clamp(sum / 3) * (1 - b.silence);
    const cen = sum > 1e-3 ? clamp(weighted / sum / 6) : 0;
    b.amplitude = damp(b.amplitude, amp, 4, dt);
    b.centroid = damp(b.centroid, cen, 4, dt);
    b.low = damp(b.low, amp * (1 - cen), 4, dt);
    b.mid = damp(b.mid, amp * (1 - Math.abs(cen - 0.5) * 2), 4, dt);
    b.high = damp(b.high, amp * cen, 4, dt);
  }
}

/** Release every wave slot (chapter change / restart). */
export function clearWaves(b: Bridge): void {
  for (const w of b.waves) {
    w.freq = 0;
    w.level = 0;
  }
}
