/**
 * PARTICLES — dust in a void. Rare motes of light, not a galaxy.
 *
 * THREE.Points; `position` is each mote's home, `aSeed` its random. Everything else is
 * stateless and analytic in the vertex shader:
 *   - drift: two incommensurate sines per axis around home, amplitude ∝ params.drift
 *   - the wave field nudges a mote along the local wavefront normal and lights it up
 *     where the sources agree (sound reveals even the dust)
 *   - impulse(at, strength): a radial push that eases out and slowly lets go again
 *
 * Output: PREMULTIPLIED with alpha = 0 → pure additive light through the same blend
 * function as everything else (dst = src.rgb + dst). Peak values are low; a mote is 1–3 px.
 *
 * Defines: WAVE_TERMS.
 */
import { SHARED, WAVES } from './common';

export const MAX_IMPULSES = 4;

export const PARTICLES_VERT = /* glsl */ `
attribute float aSeed;
${SHARED}
${WAVES}
uniform float uReveal;
uniform float uDrift;
uniform vec4 uImpulse[${MAX_IMPULSES}];       // xyz position, w start time
uniform float uImpulseGain[${MAX_IMPULSES}];
varying vec3 vMote;   // x brightness, y seed, z point size (device px)

void main() {
  float s = aSeed;
  vec3 ph = vec3(s * TAU, s * 17.0, s * 29.0);
  vec3 wander = vec3(
    sin(uTime * 0.11 + ph.x) + 0.5 * sin(uTime * 0.047 + ph.y),
    sin(uTime * 0.083 + ph.y) + 0.5 * sin(uTime * 0.061 + ph.z),
    sin(uTime * 0.097 + ph.z) + 0.5 * sin(uTime * 0.039 + ph.x));
  vec3 pw = (modelMatrix * vec4(position + wander * (0.6 * uDrift), 1.0)).xyz;

  float f;
  vec3 g;
  vec2 cs;
  vec3 gcx;
  vec3 gcy;
  float sum;
  waveField(pw, 0.0, 1.0, f, g, cs, gcx, gcy, sum);
  pw += g * (f * uWaveNorm * 0.1 / (length(g) + 1e-3));
  float env = min(length(cs) * uEnvNorm, 1.0);

  for (int i = 0; i < ${MAX_IMPULSES}; i++) {
    float age = uTime - uImpulse[i].w;
    if (uImpulseGain[i] > 0.0 && age > 0.0) {
      vec3 d = pw - uImpulse[i].xyz;
      float r2 = dot(d, d);
      float push = uImpulseGain[i] * (1.0 - exp(-4.0 * age)) * exp(-0.4 * age) / (1.0 + 0.3 * r2);
      pw += d * (push / sqrt(r2 + 0.01));
    }
  }

  vec4 mv = viewMatrix * vec4(pw, 1.0);
  float dist = max(-mv.z, 0.05);
  float radius = mix(0.007, 0.018, fract(s * 13.7));
  float px = 2.0 * radius * projectionMatrix[1][1] * uViewport.y * uViewport.z * 0.5 / dist;
  float size = clamp(px, 1.6 * uViewport.z, 22.0 * uViewport.z);

  float twinkle = 0.6 + 0.4 * sin(uTime * (0.25 + 0.6 * fract(s * 7.1)) + s * 40.0);
  float born = smoothstep(s * 0.8, s * 0.8 + 0.2, uReveal);
  float near = smoothstep(0.6, 2.2, dist);
  float energy = px / size;                               // keep total light when the size is clamped
  float b = born * near * twinkle * (0.22 + 0.78 * smoothstep(0.05, 0.6, env)) * min(energy * energy, 1.0)
    * uState.y * (1.0 - smoothstep(0.4, 1.0, uState.w));

  vMote = vec3(b, s, size);
  gl_PointSize = size;
  gl_Position = b > 0.002 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const PARTICLES_FRAG = /* glsl */ `
${SHARED}
varying vec3 vMote;

void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(pc, pc);
  float px = vMote.z;
  // a hot centre about a pixel wide inside a faint halo
  float core = exp(-d2 * px * px * 0.22);
  float halo = max(1.0 - d2, 0.0);
  halo = halo * halo * halo * 0.12;
  vec3 tint = mix(uEnvCol[0], uEnvCol[2], fract(vMote.y * 5.3));
  vec3 col = mix(vec3(0.95, 0.94, 0.9), tint * 1.2 + 0.15, 0.6 * uState.z);
  gl_FragColor = vec4(col * ((core + halo) * vMote.x * 0.85), 0.0);
}
`;
