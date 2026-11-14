/**
 * Shared uniforms — the one object every material in the piece reads by reference.
 *
 * `syncShared(bridge, camera, viewport)` copies the Bridge into it once per frame. Nothing
 * here allocates after module load.
 *
 * Layout (GLSL declarations live in ./glsl/common.ts):
 *   uTime        seconds (bridge.time)
 *   uWavePos[8]  world position of each ACTIVE source, compacted to the front
 *   uWave[8]     x: wave number k (rad / world unit)   y: amplitude (band- and silence-weighted)
 *                z: modelled phase (rad)               w: pitch order 0..1 (0 = fundamental, 1 = 4 octaves up)
 *   uWaveBroad[8] amplitude · e^(−ENVELOPE_BROAD · order): each source's weight in the interference envelope
 *   uWaveCount   number of valid entries in the arrays above
 *   uWaveNorm    soft normaliser for the superposed field (1 for a single source)
 *   uEnvNorm     the same for the interference envelope (which weights the low partials, see glsl/common.ts)
 *   uComplexity  0 = one pitch … 1 = a chord (drives how far lamellae fan apart)
 *   uAttack[3]   xyz: world position of a recent strike, w: bridge.time when it happened
 *   uAttackGain  current strength of each of those wavefronts (decays over ~5 s)
 *   uBands       amplitude, low, mid, high
 *   uState       stability, presence, spectral, silence
 *   uPointer     xyz: world pointer, w: pointer energy
 *   uCamPos      camera world position
 *   uViewport    width (css px), height (css px), pixel ratio, aspect
 *   uEnvCol[7]   colours of the procedural studio lights, driven by bridge.spectral
 */
import { Vector3, Vector4, type Camera } from 'three';
import { MAX_WAVES, type Bridge } from '../core/contracts';
import { clamp, smoothstep } from '../core/math';

export const MAX_ATTACKS = 3;
export const ENV_LIGHTS = 7;

/** k = K_BASE · (f / fundamental)^K_POWER  → ratio 1 ≈ 4.2 world units per wave, ratio 16 ≈ 0.75. */
const K_BASE = 1.5;
const K_POWER = 0.62;
/** amplitude ∝ (f / fundamental)^−AMP_ROLLOFF. */
const AMP_ROLLOFF = 0.6;
/** The interference envelope weights each source by e^(−ENVELOPE_BROAD · order): it stays broad under a dense chord. */
const ENVELOPE_BROAD = 2.2;

/** Wave number (rad / world unit) for a pitch. Higher pitch → finer waves, compressed so 1…16 stays legible. */
export function waveNumber(freq: number, fundamental: number): number {
  const ratio = clamp(freq / Math.max(fundamental, 1e-3), 0.25, 32);
  return K_BASE * Math.pow(ratio, K_POWER);
}

const vec3Array = (n: number) => Array.from({ length: n }, () => new Vector3());
const vec4Array = (n: number) => Array.from({ length: n }, () => new Vector4());

export const shared = {
  uTime: { value: 0 },
  uWavePos: { value: vec3Array(MAX_WAVES) },
  uWave: { value: vec4Array(MAX_WAVES) },
  uWaveBroad: { value: new Float32Array(MAX_WAVES) },
  uWaveCount: { value: 0 },
  uWaveNorm: { value: 1 },
  uEnvNorm: { value: 1 },
  uComplexity: { value: 0 },
  uAttack: { value: vec4Array(MAX_ATTACKS) },
  uAttackGain: { value: new Float32Array(MAX_ATTACKS) },
  uBands: { value: new Vector4(0, 0, 0, 0) },
  uState: { value: new Vector4(0, 0, 0, 0) },
  uPointer: { value: new Vector4(0, 0, 0, 0) },
  uCamPos: { value: new Vector3(0, 0, 8) },
  uViewport: { value: new Vector4(1280, 720, 1, 1280 / 720) },
  uEnvCol: { value: vec3Array(ENV_LIGHTS) },
};

/** CPU-side companions of the uniforms (not uploaded). */
export const sharedState = {
  /** Set by the create* factories when the session runs on the lite tier. */
  lite: false,
  fundamental: 55,
  lastTime: 0,
  prevAttack: 0,
  attackSlot: 0,
  attackStrength: new Float32Array(MAX_ATTACKS),
};

// ── studio light colours ─────────────────────────────────────────────────────
// Four stops per light at spectral = 0, 0.35, 0.65, 0.9 (held above 0.9):
//   0     ivory / silver / graphite only
//   0.35  ice blue enters the cool lights
//   0.65  champagne enters the warm lights, the cool ones deepen
//   0.9+  the deep ultramarine → teal and amber → champagne of the reference
// The blues always keep some green and a trace of red: deep ultramarine, never a pure (0, 0, 1).
const STOPS = [0, 0.35, 0.65, 0.9];
const PALETTE: readonly (readonly number[])[] = [
  // 0 back, cool outer pool: graphite silver → slate blue → deep blue → ultramarine
  [0.3, 0.315, 0.34, 0.2, 0.3, 0.46, 0.09, 0.2, 0.54, 0.05, 0.155, 0.6],
  // 1 back, cool inner pool: silver → pale ice → pale teal → teal / cyan
  [0.52, 0.54, 0.57, 0.42, 0.53, 0.62, 0.22, 0.56, 0.63, 0.095, 0.58, 0.64],
  // 2 back, warm outer pool: warm graphite → warm grey → soft amber → amber
  [0.27, 0.265, 0.25, 0.4, 0.36, 0.3, 0.68, 0.48, 0.24, 0.82, 0.53, 0.17],
  // 3 back, warm inner pool: ivory → ivory → pale champagne → champagne / pale gold
  [0.8, 0.78, 0.72, 0.82, 0.79, 0.71, 0.88, 0.8, 0.63, 0.92, 0.82, 0.59],
  // 4 front key: ivory throughout
  [0.95, 0.93, 0.87, 0.95, 0.94, 0.9, 1.0, 0.95, 0.86, 1.0, 0.94, 0.84],
  // 5 front accent strip: silver → ice
  [0.62, 0.65, 0.69, 0.6, 0.7, 0.82, 0.62, 0.74, 0.9, 0.66, 0.8, 1.0],
  // 6 back, high wide band: graphite → slate → deep blue → deep ultramarine
  [0.1, 0.105, 0.12, 0.09, 0.13, 0.22, 0.05, 0.1, 0.3, 0.03, 0.08, 0.4],
];

function writeEnvironment(spectral: number): void {
  const s = clamp(spectral, 0, STOPS[STOPS.length - 1]);
  let seg = 0;
  while (seg < STOPS.length - 2 && s > STOPS[seg + 1]) seg++;
  const span = STOPS[seg + 1] - STOPS[seg];
  let t = (s - STOPS[seg]) / span;
  t = t * t * (3 - 2 * t);
  const a = seg * 3;
  const b = a + 3;
  const cols = shared.uEnvCol.value;
  for (let i = 0; i < ENV_LIGHTS; i++) {
    const p = PALETTE[i];
    cols[i].set(p[a] + (p[b] - p[a]) * t, p[a + 1] + (p[b + 1] - p[a + 1]) * t, p[a + 2] + (p[b + 2] - p[a + 2]) * t);
  }
}
writeEnvironment(0);

const scratchAmp = new Float32Array(MAX_WAVES);
const scratchSort = new Float32Array(MAX_WAVES);

/** Wave terms the lite tier evaluates per vertex. */
const LITE_TERMS = 4;

/** Copies Bridge → shared uniforms (wave sources, scalars, camera, viewport). Once per frame. No allocation. */
export function syncShared(bridge: Bridge, camera: Camera, viewport: { width: number; height: number; pixelRatio: number }): void {
  const st = sharedState;
  const time = bridge.time;

  // A restart rewinds bridge.time: forget every wavefront that now lies in the future.
  if (time < st.lastTime - 1e-4) {
    st.prevAttack = 0;
    for (let i = 0; i < MAX_ATTACKS; i++) {
      st.attackStrength[i] = 0;
      shared.uAttackGain.value[i] = 0;
    }
  }
  st.lastTime = time;
  st.fundamental = bridge.fundamental > 0 ? bridge.fundamental : 55;
  shared.uTime.value = time;

  const stability = clamp(bridge.stability);
  const presence = clamp(bridge.presence);
  const spectral = clamp(bridge.spectral);
  const silence = clamp(bridge.silence);
  shared.uState.value.set(stability, presence, spectral, silence);
  shared.uBands.value.set(clamp(bridge.amplitude), clamp(bridge.low), clamp(bridge.mid), clamp(bridge.high));
  shared.uPointer.value.set(bridge.pointer.x, bridge.pointer.y, bridge.pointer.z, clamp(bridge.pointerEnergy));

  // ── wave sources ───────────────────────────────────────────────────────────
  const low = clamp(bridge.low);
  const mid = clamp(bridge.mid);
  const high = clamp(bridge.high);
  const waves = bridge.waves;
  const n = Math.min(waves.length, MAX_WAVES);
  let rawSum = 0;
  for (let i = 0; i < MAX_WAVES; i++) {
    let amp = 0;
    if (i < n) {
      const w = waves[i];
      if (w.amp > 1e-4 && w.freq > 0) {
        const ratio = clamp(w.freq / st.fundamental, 0.25, 32);
        const order = clamp(Math.log2(ratio) / 4);
        // Each source breathes with the band it sounds in.
        const wl = 1 - smoothstep(1.5, 3.5, ratio);
        const wh = smoothstep(4, 9, ratio);
        const band = wl * low + wh * high + (1 - wl - wh) * mid;
        // Silence takes the highs first.
        const start = 0.62 - 0.57 * order;
        const gate = 1 - smoothstep(start, start + 0.3, silence);
        // Higher partials move the surface less (≈ equal steepness for every pitch): fine ripples
        // ride the broad swell instead of shredding it.
        const rolloff = Math.pow(Math.max(ratio, 1), -AMP_ROLLOFF);
        amp = clamp(w.amp) * (0.72 + 0.9 * band) * gate * rolloff;
        rawSum += clamp(w.amp);
      }
    }
    scratchAmp[i] = amp;
  }

  // Lite tier evaluates four terms: soft-threshold against the fifth strongest so that a
  // source entering or leaving the top four does so at zero amplitude (no pop).
  if (st.lite) {
    scratchSort.set(scratchAmp);
    for (let i = 1; i < MAX_WAVES; i++) {
      const v = scratchSort[i];
      let j = i - 1;
      while (j >= 0 && scratchSort[j] < v) {
        scratchSort[j + 1] = scratchSort[j];
        j--;
      }
      scratchSort[j + 1] = v;
    }
    const floor = scratchSort[LITE_TERMS];
    if (floor > 0) for (let i = 0; i < MAX_WAVES; i++) scratchAmp[i] = Math.max(0, scratchAmp[i] - floor);
  }

  const limit = st.lite ? LITE_TERMS : MAX_WAVES;
  const wavePos = shared.uWavePos.value;
  const wave = shared.uWave.value;
  let count = 0;
  let sum = 0;
  let broad = 0;
  for (let i = 0; i < n && count < limit; i++) {
    const amp = scratchAmp[i];
    if (amp <= 1e-4) continue;
    const w = waves[i];
    const ratio = clamp(w.freq / st.fundamental, 0.25, 32);
    wavePos[count].copy(w.position);
    const order = clamp(Math.log2(ratio) / 4);
    wave[count].set(K_BASE * Math.pow(ratio, K_POWER), amp, w.phase, order);
    const weight = amp * Math.exp(-ENVELOPE_BROAD * order);
    shared.uWaveBroad.value[count] = weight;
    sum += amp;
    broad += weight;
    count++;
  }
  for (let i = count; i < MAX_WAVES; i++) {
    wave[i].set(1, 0, 0, 0);
    shared.uWaveBroad.value[i] = 0;
  }
  shared.uWaveCount.value = count;
  shared.uWaveNorm.value = 1 / (1 + 0.35 * Math.max(0, sum - 1));
  // The envelope of a lone voice reads the same whatever its pitch; a chord saturates softly.
  shared.uEnvNorm.value = broad > 1e-5 ? Math.min(sum / broad, 12) / (1 + 0.35 * Math.max(0, sum - 1)) : 1;
  shared.uComplexity.value = smoothstep(0.6, 3.2, rawSum);

  // ── strikes → travelling wavefronts ────────────────────────────────────────
  const attack = clamp(bridge.attack);
  if (attack > st.prevAttack + 0.04) {
    const slot = (st.attackSlot + 1) % MAX_ATTACKS;
    st.attackSlot = slot;
    st.attackStrength[slot] = attack;
    shared.uAttack.value[slot].set(bridge.attackAt.x, bridge.attackAt.y, bridge.attackAt.z, time);
  }
  st.prevAttack = attack;
  for (let i = 0; i < MAX_ATTACKS; i++) {
    const strength = st.attackStrength[i];
    if (strength <= 0) {
      shared.uAttackGain.value[i] = 0;
      continue;
    }
    const age = time - shared.uAttack.value[i].w;
    if (age > 6) {
      st.attackStrength[i] = 0;
      shared.uAttackGain.value[i] = 0;
    } else {
      shared.uAttackGain.value[i] = strength * Math.exp(-0.55 * Math.max(age, 0)) * (1 - smoothstep(4, 6, age));
    }
  }

  // ── camera, viewport, studio lights ────────────────────────────────────────
  camera.getWorldPosition(shared.uCamPos.value);
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  shared.uViewport.value.set(width, height, Math.max(0.25, viewport.pixelRatio), width / height);
  writeEnvironment(spectral);
}
