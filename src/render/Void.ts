/**
 * Void — the environment: an enormous space sensed but not seen.
 *
 * An inside-out backdrop drawn at infinity behind everything. Its luminance is a
 * sparse, fine-grained mottle sampled on a few concentric shells; each further shell
 * is exponentially dimmer and shifts less as the camera moves, which is the only cue
 * of depth. Peak output is clamped to 2/255 and most of the field is exactly zero, so
 * together with the composite pass' dither it reads as "not quite nothing".
 *
 * Output: opaque, display-referred, no blending. No stars, no nebula, no gradient.
 */
import { BackSide, IcosahedronGeometry, Mesh, ShaderMaterial } from 'three';
import type { Bridge, Quality } from '../core/contracts';
import { clamp, damp } from '../core/math';

export interface VoidEnvironment {
  readonly object: Mesh;
  /** Once per frame. Reads bridge.low and bridge.presence (and nothing else). */
  update(bridge: Bridge, dt: number): void;
  dispose(): void;
}

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // Rotation only: the backdrop is at infinity and never translates with the camera.
    vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    gl_Position = clip.xyww;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uLow;
  uniform float uPresence;
  varying vec3 vDir;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
          mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
          mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }

  // One shell of the space at the given radius: sparse fine mottle gated by a broad, slow mask.
  float shell(vec3 dir, float radius, float fine, float seed) {
    vec3 p = cameraPosition + dir * radius;
    vec3 flow = vec3(0.0, uTime * 0.02, uTime * 0.013);
    float mask = vnoise(p * (0.9 / radius) * 3.0 + flow * 0.25 + seed);
    mask = smoothstep(0.52, 0.86, mask);
    float grainA = vnoise(p * (fine / radius) + flow + seed * 3.7);
    float grainB = vnoise(p * (fine * 2.9 / radius) - flow * 1.6 + seed * 9.1);
    float g = grainA * 0.62 + grainB * 0.38;
    g = smoothstep(0.5, 0.9, g);
    return mask * g;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float lum = 0.0;
    // Exponential falloff with distance: each shell is e^(-r/L) of the one before.
    lum += shell(dir, 14.0, 46.0, 0.0);
    lum += shell(dir, 44.0, 78.0, 17.3) * 0.56;
    #ifndef LITE
    lum += shell(dir, 140.0, 128.0, 41.9) * 0.31;
    #endif

    // The low band is felt as the faintest swell; presence opens the space at all.
    float breathe = 1.0 + 0.32 * uLow + 0.06 * sin(uTime * 0.21);
    float level = lum * breathe * (0.22 + 0.78 * uPresence);
    level = min(level * 0.0066, 0.0078); // ≤ 2/255
    gl_FragColor = vec4(vec3(0.93, 0.965, 1.0) * level, 1.0);
  }
`;

export function createVoid(quality: Quality): VoidEnvironment {
  const geometry = new IcosahedronGeometry(1, 2);
  const uniforms = {
    uTime: { value: 0 },
    uLow: { value: 0 },
    uPresence: { value: 0 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: quality.lite ? { LITE: '' } : {},
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const object = new Mesh(geometry, material);
  object.name = 'void';
  object.frustumCulled = false;
  object.renderOrder = -1000;
  object.matrixAutoUpdate = false;

  const timeScale = quality.reducedMotion ? 0.35 : 1;
  let primed = false;

  return {
    object,
    update(bridge: Bridge, dt: number) {
      const step = clamp(dt, 0, 0.1);
      uniforms.uTime.value += step * timeScale;
      const low = clamp(bridge.low);
      const presence = clamp(bridge.presence);
      if (!primed) {
        primed = true;
        uniforms.uLow.value = low;
        uniforms.uPresence.value = presence;
        return;
      }
      // Slow on purpose: the space swells behind the sound, it never pulses with it.
      uniforms.uLow.value = damp(uniforms.uLow.value, low, 1.2, step);
      uniforms.uPresence.value = damp(uniforms.uPresence.value, presence, 0.8, step);
    },
    dispose() {
      object.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
