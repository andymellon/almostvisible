/**
 * OpticalCompositePass — the last pass of the chain. Turns the linear HDR scene
 * (display-referred values, highlights above 1 allowed) into the final image:
 *
 *   radial dispersion → exposure → filmic shoulder → vignette → fade → grain + dither
 *
 * Tone curve: identity up to a knee (what a material writes below ~0.62 is what the
 * visitor sees), then an exponential shoulder that asymptotes to 1 — highlights roll
 * off and keep detail instead of clipping. It is applied to the peak channel so hue
 * is preserved, with a gentle bleach toward white only for very hot values.
 *
 * Black stays black: every stage is multiplicative or maps 0 → 0. The only additive
 * term is a ±0.5 LSB dither, which cannot lift a zero pixel after 8-bit rounding, plus
 * film grain whose amplitude is weighted by luminance and is exactly zero at black.
 *
 * Output: opaque RGB, alpha 1, written to the screen (or the write buffer).
 */
import { NoBlending, ShaderMaterial, Vector2, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2 uAspect;      // (1, 1/aspect) for landscape, (aspect, 1) for portrait
  uniform float uExposure;
  uniform float uDispersion; // relative radial shift of the red/blue planes at the long edge
  uniform float uGrain;      // grain amplitude at full weight (display units)
  uniform float uFade;       // 0 normal … 1 black
  uniform float uTime;
  varying vec2 vUv;

  const float KNEE = 0.62;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float shoulder(float x) {
    return x <= KNEE ? x : KNEE + (1.0 - KNEE) * (1.0 - exp(-(x - KNEE) / (1.0 - KNEE)));
  }

  vec3 filmic(vec3 c) {
    float peak = max(c.r, max(c.g, c.b));
    if (peak <= KNEE) return c;
    float mapped = shoulder(peak);
    vec3 held = c * (mapped / peak);                       // hue-preserving roll-off
    float bleach = smoothstep(1.0, 5.0, peak) * 0.55;      // only true highlights whiten
    return mix(held, vec3(mapped), bleach);
  }

  void main() {
    vec2 c = vUv - 0.5;
    vec2 ca = c * uAspect;
    float r2 = dot(ca, ca);                                // 0 centre … 0.25 at the long edge

    #ifdef DISPERSION
      // Lateral colour: zero on axis, growing with the square of the field radius.
      vec2 off = c * (r2 * 4.0) * uDispersion;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv - off).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv + off).b);
    #else
      vec3 col = texture2D(tDiffuse, vUv).rgb;
    #endif

    col = max(col, 0.0) * uExposure;
    col = filmic(col);

    // Natural-feeling falloff; multiplicative, so it cannot lift anything.
    float vig = 1.0 - smoothstep(0.03, 0.42, r2) * 0.34;
    col *= vig * (1.0 - uFade);

    // Film grain, weighted to the lower mids and absent from pure black.
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float weight = lum / (lum + 0.09) * (1.0 - 0.5 * lum);
    vec2 px = gl_FragCoord.xy;
    float t = fract(uTime);
    float n1 = hash12(px + t * vec2(417.13, 283.71));
    float n2 = hash12(px * 1.37 + 61.7 + t * vec2(197.91, 331.17));
    col += (n1 + n2 - 1.0) * uGrain * weight;              // triangular distribution

    // Dither: ±0.5 LSB, breaks banding in the near-black gradients without lifting zero.
    col += (hash12(px + 19.19 + t * vec2(113.5, 271.9)) - 0.5) / 255.0;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export interface OpticalCompositeOptions {
  /** Three-tap radial dispersion. Off on the lite tier (single tap). */
  dispersion: boolean;
  /** Freeze the grain pattern instead of animating it (reduced motion). */
  staticGrain: boolean;
}

export class OpticalCompositePass extends Pass {
  /** Linear exposure multiplier applied before the tone curve. */
  exposure = 1;
  /** Relative radial shift of the red/blue planes at the long edge (≈ 0 … 0.006). */
  dispersion = 0;
  /** Grain amplitude in display units at full weight (≈ 0 … 0.04). */
  grain = 0;
  /** 0 = normal, 1 = full black. */
  fade = 0;

  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly staticGrain: boolean;
  private readonly aspect = new Vector2(1, 1);
  private time = 0;

  constructor(options: OpticalCompositeOptions) {
    super();
    this.needsSwap = true;
    this.staticGrain = options.staticGrain;
    this.material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uAspect: { value: this.aspect },
        uExposure: { value: 1 },
        uDispersion: { value: 0 },
        uGrain: { value: 0 },
        uFade: { value: 0 },
        uTime: { value: 0 },
      },
      defines: options.dispersion ? { DISPERSION: '' } : {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  override setSize(width: number, height: number): void {
    const a = Math.max(width, 1) / Math.max(height, 1);
    // Normalise so the radial terms are circular and reach the same value on the long edge.
    if (a >= 1) this.aspect.set(1, 1 / a);
    else this.aspect.set(a, 1);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget, deltaTime: number): void {
    const u = this.material.uniforms;
    if (!this.staticGrain) this.time = (this.time + Math.min(Math.max(deltaTime, 0), 0.1)) % 64;
    u.tDiffuse.value = readBuffer.texture;
    u.uExposure.value = this.exposure;
    u.uDispersion.value = this.dispersion;
    u.uGrain.value = this.grain;
    u.uFade.value = this.fade;
    u.uTime.value = this.time;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
