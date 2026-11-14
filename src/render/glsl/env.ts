/**
 * The procedural studio — a handful of soft lights on pure black. Never a texture.
 *
 * Directions are expressed in the RAY FRAME of the fragment being shaded:
 *   +x = camera right, +y = camera up, +z = toward the viewer.
 * So (0,0,-1) is "straight through the glass" and (0,0,1) is "straight back at the eye"; both
 * are black. Light is only found off-axis, which is why flat, undisturbed matter stays dark and
 * colour pools on the slopes the waves raise.
 *
 *   back lights (seen through the glass, by refraction): broad, soft-edged POOLS — flat-topped
 *   and without a hard edge anywhere, so that refracted colour arrives as large calm shapes with
 *   smooth gradients. They come in pairs: a pale one close to the axis (reached by gentle
 *   slopes) and a deep one further out (reached by steep ones), overlapping, so a slope grades
 *   from one into the other.
 *     0  cool, outer   graphite → slate blue → ultramarine
 *     1  cool, inner   silver   → pale ice   → teal / cyan
 *     2  warm, outer   graphite → warm grey  → amber
 *     3  warm, inner   ivory    → ivory      → champagne / pale gold
 *     6  high wide band, dim   graphite → deep ultramarine (reached only by the steepest slopes)
 *   front lights (seen in reflection, closed bodies only): small and soft-ended
 *     4  key, above                ivory
 *     5  thin accent, below        silver → ice
 *
 * Between the cool and the warm pair, above and below the axis, there is nothing: slopes that
 * face up or down fall to black.
 *
 * Colours come from the shared uEnvCol[] (driven by bridge.spectral, see ../shared.ts);
 * `warmth` (-1..1) leans the balance between the cool and the warm lights per object;
 * `soft` scales the size of every pool (crystal sees them tighter, earth broader).
 */

interface StudioLight {
  /** uEnvCol index. */
  index: number;
  back: boolean;
  /** Azimuth / elevation of the centre in degrees, measured from the −z (back) or +z (front) axis. */
  az: number;
  el: number;
  /** Roll of the light about its own centre direction, degrees. */
  roll: number;
  /** Half extents in tangent units. */
  halfW: number;
  halfH: number;
  /** Brightness ramp across the light (per half extent): one side pools, the other falls away. */
  rampX: number;
  rampY: number;
  /** −1 cool … +1 warm: how the light answers to MatterParams.warmth. */
  temp: number;
}

const LIGHTS: readonly StudioLight[] = [
  { index: 0, back: true, az: -17, el: 3.5, roll: 14, halfW: 0.105, halfH: 0.2, rampX: 0.3, rampY: 0.15, temp: -0.6 },
  { index: 1, back: true, az: -7.4, el: -1, roll: 14, halfW: 0.085, halfH: 0.16, rampX: 0.25, rampY: -0.2, temp: -0.4 },
  { index: 2, back: true, az: 15.5, el: -7, roll: -22, halfW: 0.105, halfH: 0.19, rampX: -0.3, rampY: 0.15, temp: 0.8 },
  { index: 3, back: true, az: 6.8, el: -1.5, roll: -22, halfW: 0.08, halfH: 0.15, rampX: -0.25, rampY: -0.2, temp: 0.5 },
  { index: 6, back: true, az: -3, el: 24, roll: -5, halfW: 0.5, halfH: 0.06, rampX: 0, rampY: -0.4, temp: -0.25 },
  { index: 4, back: false, az: -14, el: 42, roll: 0, halfW: 0.085, halfH: 0.02, rampX: 0, rampY: 0, temp: 0.25 },
  { index: 5, back: false, az: 22, el: -34, roll: 9, halfW: 0.13, halfH: 0.011, rampX: 0, rampY: 0, temp: -0.1 },
];

type V3 = [number, number, number];
const DEG = Math.PI / 180;
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lit = (v: number) => (Object.is(v, -0) ? 0 : v).toFixed(5);
const vec3 = (v: V3) => `vec3(${lit(v[0])}, ${lit(v[1])}, ${lit(v[2])})`;

function term(light: StudioLight): string {
  const az = light.az * DEG;
  const el = light.el * DEG;
  const roll = light.roll * DEG;
  const c: V3 = [Math.sin(az) * Math.cos(el), Math.sin(el), (light.back ? -1 : 1) * Math.cos(az) * Math.cos(el)];
  const h = unit(cross([0, 1, 0], c));
  const v = cross(c, h);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const ax: V3 = [h[0] * cr + v[0] * sr, h[1] * cr + v[1] * sr, h[2] * cr + v[2] * sr];
  const ay: V3 = [v[0] * cr - h[0] * sr, v[1] * cr - h[1] * sr, v[2] * cr - h[2] * sr];
  const head = `  col += uEnvCol[${light.index}] * ((1.0 + warmth * ${lit(light.temp)}) * `;
  const inv = `vec2(${lit(1 / light.halfW)}, ${lit(1 / light.halfH)})`;
  // Front lights are only ever seen in reflection: small, soft-ended, so a highlight never shows a corner.
  if (!light.back) return `${head}studioGlow(d, ${vec3(c)}, ${vec3(ax)}, ${vec3(ay)}, ${inv} / soft));`;
  return `${head}studioPool(d, ${vec3(c)}, ${vec3(ax)}, ${vec3(ay)}, ${inv} * size, vec2(${lit(light.rampX)}, ${lit(light.rampY)})));`;
}

const backTerms = LIGHTS.map((l) => (l.back ? term(l) : '')).filter(Boolean).join('\n');
const frontTerms = LIGHTS.map((l) => (l.back ? '' : term(l))).filter(Boolean).join('\n');

/** Requires the SHARED block (uEnvCol). */
export const STUDIO = /* glsl */ `
// A soft pool of light: no edge anywhere (between a gaussian and e^(−r⁴)), with a gentle ramp across it.
float studioPool(vec3 d, vec3 c, vec3 ax, vec3 ay, vec2 inv, vec2 ramp) {
  float w = dot(d, c);
  vec2 p = vec2(dot(d, ax), dot(d, ay)) / max(w, 0.05) * inv;
  float t = dot(p, p);
  return exp(-t * (0.6 + 0.4 * t)) * smoothstep(0.0, 0.25, w) * (1.0 + dot(ramp, clamp(p, -1.5, 1.5)));
}

float studioGlow(vec3 d, vec3 c, vec3 ax, vec3 ay, vec2 inv) {
  float w = dot(d, c);
  vec2 p = vec2(dot(d, ax), dot(d, ay)) / max(w, 0.05) * inv;
  return exp(-dot(p, p)) * smoothstep(0.0, 0.25, w);
}

// Lights behind the matter. d must be normalised and in the ray frame.
vec3 studioBack(vec3 d, float soft, float warmth) {
  vec3 col = vec3(0.0);
  float size = 1.0 / (0.55 + 0.45 * soft);
${backTerms}
  return col;
}

// The whole studio (what a reflection can see).
vec3 studioAll(vec3 d, float soft, float warmth) {
  vec3 col = vec3(0.0);
  float size = 1.0 / (0.55 + 0.45 * soft);
${backTerms}
${frontTerms}
  return col;
}
`;
