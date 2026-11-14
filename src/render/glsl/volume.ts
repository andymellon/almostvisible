/**
 * VOLUME FIELD — the architecture hidden inside sound.
 *
 * A soft-bounded ball in which every wave source is seen as what it is in three dimensions: a
 * set of nested spherical wavefronts, thin as glass. A thin shell is all but invisible where a
 * ray meets it face-on and bright where the ray grazes it, so each shell is drawn by its LIMB:
 * a fine line of light with a hard outer edge and a soft fall inward. That limb is found
 * analytically — per source, from the ray's impact parameter b:
 *
 *   x = (kⱼ·b − φⱼ) / 2π          shells sit at the integers; s = 1 − fract(x) is how far inside
 *   limb(s) = (√(s+h) − √s) / √h   the chord a ray cuts through a shell of thickness h
 *
 * so the lines are exact, anti-aliased, and as fine as the pixel grid allows at any world size
 * (no ray-march, no step length to alias against).
 *
 * At the point where the ray grazes the shell, the superposition the matter rides is evaluated:
 *
 *   cs = Σ aᵢ fall(rᵢ) · e^{i(kᵢ rᵢ − φᵢ)},   en = |cs| / Σ aᵢ fall(rᵢ)   (0 node … 1 antinode)
 *
 * and the shell is lit by how much the sources AGREE there. The families of shells of the
 * different sources cross one another and survive around the antinodes: nested shells that
 * close into a lattice. In tune, the figure of agreement stands still while the shells travel
 * outward through it; detuned, it crawls. Where nothing agrees it stays black.
 *
 * structure 0 → only a soft glow about each source; structure 1 → the shells.
 *
 * The figure lives in "lattice space" so that it reads at ANY world size and for ANY pitches
 * (see createVolumeField): positions are scaled about the centre by uMag (the ball has radius
 * uBall there); every wave number is scaled by uKNorm, which gives the lowest sounding source a
 * fixed number of shells across the ball (the ratios between sources — the shape of the figure —
 * are kept, up to a cap; shells too fine for the pixel grid merge into their mean, never alias);
 * and the sources are spread about the centre by uSrcMag until they sit a few shells apart.
 *
 * Output: PREMULTIPLIED alpha (NormalBlending, premultipliedAlpha = true), BackSide box,
 * depthTest and depthWrite off. Almost purely emissive.
 *
 * Defines: WAVE_TERMS.
 */
import { SHARED } from './common';

export const VOLUME_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const VOLUME_FRAG = /* glsl */ `
${SHARED}
uniform vec3 uCentre;
uniform float uReveal;
uniform float uDensity;
uniform float uStructure;
uniform float uMag;
uniform float uBall;
uniform float uKNorm;
uniform float uSrcMag;
varying vec3 vWorld;

const float WAVE_FALL = 0.018;
const float SHELL = 0.012;       // thickness of a shell, in units of the spacing between shells
const float K_CAP = 2.4;         // highest wave number kept, as a multiple of the lowest source's

void main() {
  float amount = uReveal * uState.y * uDensity * (1.0 - smoothstep(0.5, 1.0, uState.w));
  vec3 rd = normalize(vWorld - uCamPos);
  float pix = length(fwidth(rd)) * 0.75;                 // the angle one pixel subtends
  if (amount < 0.002 || uWaveCount < 1) discard;

  // the ball, in lattice space (centred on the origin, radius uBall)
  vec3 pl = (uCamPos - uCentre) * uMag;
  vec3 cm = pl - rd * dot(pl, rd);
  if (dot(cm, cm) > uBall * uBall) discard;

  float wk[WAVE_TERMS];
  float wgt[WAVE_TERMS];
  vec3 src[WAVE_TERMS];
  float kLow = 1e3;
  for (int j = 0; j < WAVE_TERMS; j++) {
    if (j < uWaveCount) kLow = min(kLow, uWave[j].x);
  }
  for (int j = 0; j < WAVE_TERMS; j++) {
    wk[j] = min(uWave[j].x, kLow * K_CAP) * uKNorm;
    wgt[j] = uWave[j].y;
    src[j] = (uWavePos[j] - uCentre) * uSrcMag;
  }

  float crisp = clamp(uStructure, 0.0, 1.0);
  float spectral = uState.z;
  vec3 cool = uEnvCol[0] * 1.5 + 0.1;
  vec3 pale = uEnvCol[1] * 1.3 + 0.14;
  vec3 hot = uEnvCol[4] + uEnvCol[2] * (0.5 * spectral);
  float inv = 1.0 / uBall;

  vec3 acc = vec3(0.0);
  for (int j = 0; j < WAVE_TERMS; j++) {
    if (j >= uWaveCount) break;
    // where this ray passes closest to the source: there it grazes one of its shells
    float tj = dot(src[j] - pl, rd);
    vec3 c = pl + rd * tj;
    vec3 dj = c - src[j];
    float b = sqrt(dot(dj, dj) + 1e-5);
    float w = wgt[j] * smoothstep(0.0, 0.08 * uBall, tj) * (1.0 - smoothstep(0.5, 1.0, length(c) * inv)) / (1.0 + WAVE_FALL * b * b);
    if (w > 1e-4) {
      // how much the sources agree at that point
      vec2 cs = vec2(0.0);
      float sum = 0.0;
      for (int i = 0; i < WAVE_TERMS; i++) {
        if (i >= uWaveCount) break;
        vec3 d = c - src[i];
        float r = sqrt(dot(d, d) + 0.02);
        float a = wgt[i] / (1.0 + WAVE_FALL * r * r);
        float ph = wk[i] * r - uWave[i].z;
        cs += a * vec2(cos(ph), sin(ph));
        sum += a;
      }
      float en = length(cs) / (sum + 1e-4);

      // the limb of the nearest shell outside b
      float x = (wk[j] * b - uWave[j].z) / TAU;
      float fw = wk[j] * max(tj, 0.0) * pix / TAU + 1e-4;   // shells per pixel
      float f = fract(x);
      float s = 1.0 - f;
      float limb = (sqrt(s + SHELL) - sqrt(s)) * inversesqrt(SHELL);
      limb = max(limb, 1.0 - f / fw);                        // its hard outer edge, anti-aliased
      limb = mix(0.11, limb, 1.0 - smoothstep(0.18, 0.5, fw)); // too fine to resolve: the mean
      float shell = limb * (0.1 + 0.9 * en * en);
      float glow = exp(-b * b * inv * inv * 14.0) * en * 0.3;
      vec3 col = mix(mix(cool, pale, en), hot, en * en * en);
      acc += col * (w * mix(glow, shell, crisp));
    }
  }

  acc *= amount * uWaveNorm * 2.6;
  gl_FragColor = vec4(acc, min(dot(acc, vec3(0.3)), 0.5));
}
`;
