/**
 * GLSL shared by every material: the shared-uniform block, hashes, the superposed wave
 * field with its analytic gradient, and a cheap domain-warped noise with analytic gradient.
 *
 * Shaders that include WAVES must define WAVE_TERMS (8, or 4 on the lite tier).
 */
import { MAX_WAVES } from '../../core/contracts';
import { ENV_LIGHTS, MAX_ATTACKS } from '../shared';

export const SHARED = /* glsl */ `
uniform float uTime;
uniform vec3 uWavePos[${MAX_WAVES}];
uniform vec4 uWave[${MAX_WAVES}];      // k, amplitude, phase, pitch order 0..1
uniform float uWaveBroad[${MAX_WAVES}]; // amplitude · e^(−broad · order): each source's weight in the envelope
uniform int uWaveCount;
uniform float uWaveNorm;
uniform float uEnvNorm;
uniform float uComplexity;
uniform vec4 uAttack[${MAX_ATTACKS}];  // xyz position, w start time
uniform float uAttackGain[${MAX_ATTACKS}];
uniform vec4 uBands;                   // amplitude, low, mid, high
uniform vec4 uState;                   // stability, presence, spectral, silence
uniform vec4 uPointer;                 // xyz, energy
uniform vec3 uCamPos;
uniform vec4 uViewport;                // width, height, pixel ratio, aspect
uniform vec3 uEnvCol[${ENV_LIGHTS}];

const float TAU = 6.28318530718;
const float PI = 3.14159265359;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

export const WAVES = /* glsl */ `
const float WAVE_FALL = 0.018;   // amplitude falls as 1 / (1 + WAVE_FALL r²)
const float WAVE_SOFT = 0.3;    // softened distance: no cusp at a source

// Superposed field of the modelled sources at world position x.
//   f   = Σ aᵢ · sin(kᵢ rᵢ − φᵢ) · fall(rᵢ)                    the surface
//   g   = ∇f, analytic
//   cs  = Σ bᵢ fall(rᵢ) · (cos, sin)(kᵢ rᵢ − φᵢ),  bᵢ = uWaveBroad[i] = aᵢ · e^(−broad · pitch order)
//         → |cs| is the interference ENVELOPE, weighted toward the low partials so that it stays
//           broad however many high voices sound: it stands still while the sources are in tune
//           and crawls at the beat rate when they are not
//   gcx, gcy = ∇cs.x, ∇cs.y, analytic → ∇|cs| = (cs.x gcx + cs.y gcy) / |cs|
//   sum = Σ bᵢ fall(rᵢ)                                         (the envelope if every source agreed)
// lag shifts the phase (more for higher partials) so stacked lamellae shear like silk.
void waveField(in vec3 x, in float lag, in float kScale, out float f, out vec3 g, out vec2 cs, out vec3 gcx, out vec3 gcy, out float sum) {
  f = 0.0;
  g = vec3(0.0);
  cs = vec2(0.0);
  gcx = vec3(0.0);
  gcy = vec3(0.0);
  sum = 0.0;
  for (int i = 0; i < WAVE_TERMS; i++) {
    if (i >= uWaveCount) break;
    vec4 w = uWave[i];
    vec3 d = x - uWavePos[i];
    float r = sqrt(dot(d, d) + WAVE_SOFT);
    float fall = 1.0 / (1.0 + WAVE_FALL * r * r);
    float k = w.x * kScale;
    float ph = k * r - w.z - lag * (0.5 + w.w);
    float sn = sin(ph);
    float cn = cos(ph);
    float a = w.y * fall;
    float droop = 2.0 * WAVE_FALL * r * fall;          // −fall′ / fall
    vec3 dir = d / r;
    vec3 ds = dir * (k * cn - droop * sn);             // ∇(fall · sin) / fall
    vec3 dc = dir * (-k * sn - droop * cn);            // ∇(fall · cos) / fall
    f += a * sn;
    g += a * ds;
    float b = uWaveBroad[i] * fall;
    cs += b * vec2(cn, sn);
    gcx += b * dc;
    gcy += b * ds;
    sum += b;
  }
}
`;

export const SILK = /* glsl */ `
// Domain-warped gyroid: smooth, organic, three sines and three cosines, analytic gradient.
float silk(in vec3 x, in float t, out vec3 grad) {
  vec3 a = x.yzx * 1.7 + vec3(0.0, 1.3, 2.1) + t * vec3(0.31, -0.23, 0.17);
  vec3 q = x + 0.42 * sin(a);
  vec3 ca = 0.714 * cos(a);
  vec3 s = sin(q);
  vec3 c = cos(q);
  vec3 dq = vec3(c.x * c.y - s.z * s.x, c.y * c.z - s.x * s.y, c.z * c.x - s.y * s.z);
  grad = vec3(dq.x + dq.z * ca.z, dq.y + dq.x * ca.x, dq.z + dq.y * ca.y);
  return s.x * c.y + s.y * c.z + s.z * c.x;
}
`;
