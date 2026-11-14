/**
 * Materials — Resonant Matter and its companions.
 *
 *   createMatter(variant, opts, quality)  the signature: instanced glass lamellae riding the wave field
 *   createFilament(quality)               a thin luminous connection between two points
 *   createVolumeField(quality)            the interference lattice, raymarched
 *   createParticles(count, quality)       dust in a void
 *   syncShared(bridge, camera, viewport)  Bridge → the one shared uniforms object (./shared.ts)
 *
 * Conventions shared by everything here:
 *   - colours are display-referred (three's ColorManagement is off; the composite pass tone-maps);
 *   - output is PREMULTIPLIED alpha with NormalBlending (dst = src.rgb + dst·(1 − src.a)),
 *     depthWrite off — matter can therefore absorb as well as emit: black stays black;
 *   - every material holds the shared uniforms BY REFERENCE, so one syncShared() per frame
 *     updates them all; per-object params are copied by that object's sync();
 *   - nothing allocates after construction.
 */
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  Points,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  Vector4,
  type Camera,
  type IUniform,
} from 'three';
import type {
  Filament,
  Matter,
  MatterOptions,
  MatterParams,
  MatterVariant,
  Particles,
  Quality,
  Vec3Like,
  VolumeField,
} from '../core/contracts';
import { MAX_WAVES } from '../core/contracts';
import { clamp, mulberry32 } from '../core/math';
import { FILAMENT_FRAG, FILAMENT_VERT } from './glsl/filament';
import { MATTER_FRAG, MATTER_VERT } from './glsl/matter';
import { MAX_IMPULSES, PARTICLES_FRAG, PARTICLES_VERT } from './glsl/particles';
import { VOLUME_FRAG, VOLUME_VERT } from './glsl/volume';
import { shared, sharedState } from './shared';

export { syncShared } from './shared';

type Uniforms = Record<string, IUniform>;

// ───────────────────────────────────────────────────────────── presets ──

/**
 * A variant is a preset over one program. Lengths marked (u) are in "units": for open sheets
 * one unit is a world unit (shrinking for small sheets), for closed bodies it is the radius —
 * so a mote of 4 cm and a torus of 70 cm deform in proportion.
 */
interface Preset {
  layers: number;
  /** Displacement per unit of field (u). All (u) values are tuned on bodies; see Form for sheets. */
  disp: number;
  /** Half thickness of the fully fanned stack (u). */
  gap: number;
  /** Share of the fan that is open with a single pitch sounding. */
  fanBase: number;
  /** Wave-number multiplier (sheets) / waves across the radius (bodies). */
  kScale: number;
  /** Phase lag between neighbouring lamellae: the silk shear. */
  lag: number;
  noiseAmp: number;
  /** Noise frequency per unit. */
  noiseFreq: number;
  timeScale: number;
  /** Amplitude of the object's own standing mode (params.freq). */
  localAmp: number;
  /** Lobes of that mode across the extent: base + per octave above the fundamental. */
  localModes: number;
  localModesOct: number;
  /** Strips a lamella tears into at coherence 0. */
  stripes: number;
  /** Drift of torn strips (u). */
  tear: number;
  hoverAmp: number;
  /** Reach of the hover lean (u). */
  hoverReach: number;
  exciteAmp: number;
  /** Ripples across the extent, and sharpness of the travelling packet. */
  exciteWaves: number;
  exciteSharp: number;
  /** Opacity of one lamella's interior: how much it absorbs. */
  alpha: number;
  deep: number;
  transGain: number;
  /** Closed bodies only: the studio's front lights mirrored in the outer shell. */
  reflGain: number;
  lineGain: number;
  lineLum: number;
  /** Closed bodies only: weight of the rim line. */
  silGain: number;
  /** Open sheets only: the flow-aligned silk sheen. */
  sheen: number;
  /** Closed bodies only: pixel-sized glints, and the luminous core a tiny body is drawn with. */
  glint: number;
  core: number;
  shine: number;
  /** Softness of the studio lights as this material sees them (1 = as built). */
  envSoft: number;
  /** Closed bodies only: 0 = optics from wave tilt alone … 1 = from the true normal. */
  optic: number;
  /** Closed bodies only: how much of the far side shows through. */
  backGain: number;
  film: number;
  flash: number;
  facet: boolean;
}

const MEMBRANE: Preset = {
  layers: 14,
  disp: 0.125,
  gap: 0.077,
  fanBase: 0.22,
  kScale: 1,
  lag: 0.22,
  noiseAmp: 0.22,
  noiseFreq: 1.12,
  timeScale: 0.22,
  localAmp: 0.22,
  localModes: 3,
  localModesOct: 1.2,
  stripes: 4,
  tear: 0.32,
  hoverAmp: 0.16,
  hoverReach: 1.25,
  exciteAmp: 0.16,
  exciteWaves: 2.5,
  exciteSharp: 5,
  alpha: 0.11,
  deep: 0.5,
  transGain: 1.55,
  reflGain: 4,
  lineGain: 0.95,
  lineLum: 1.25,
  silGain: 0.85,
  sheen: 0.3,
  glint: 2,
  core: 0,
  shine: 1200,
  envSoft: 1,
  optic: 0.75,
  backGain: 0.3,
  film: 1,
  flash: 1,
  facet: false,
};

const PRESETS: Record<MatterVariant, Preset> = {
  membrane: MEMBRANE,
  // A small closed object: a bead of nested shells that keeps its form and breathes.
  body: {
    ...MEMBRANE,
    layers: 7,
    disp: 0.06,
    gap: 0.07,
    fanBase: 0.5,
    kScale: 0.6,
    lag: 0.25,
    noiseAmp: 0.07,
    noiseFreq: 0.9,
    timeScale: 0.26,
    localAmp: 0.16,
    localModes: 1.6,
    localModesOct: 0.5,
    stripes: 6,
    tear: 0.45,
    hoverAmp: 0.16,
    hoverReach: 1.5,
    exciteAmp: 0.22,
    exciteWaves: 2.5,
    exciteSharp: 5,
    alpha: 0.16,
    deep: 0.5,
    transGain: 2,
    reflGain: 4,
    lineGain: 0.9,
    silGain: 1,
    glint: 2.2,
    shine: 420,
    optic: 0.75,
    backGain: 0.3,
  },
  // Condensed and faceted: nested cages with hard, sharp optics.
  crystal: {
    ...MEMBRANE,
    layers: 5,
    disp: 0.06,
    gap: 0.11,
    fanBase: 0.55,
    kScale: 0.7,
    lag: 0.3,
    noiseAmp: 0.05,
    noiseFreq: 1.1,
    timeScale: 0.14,
    localAmp: 0.16,
    localModes: 1.6,
    localModesOct: 0.5,
    stripes: 5,
    tear: 0.5,
    hoverAmp: 0.1,
    hoverReach: 1.8,
    exciteAmp: 0.14,
    exciteWaves: 2,
    exciteSharp: 4,
    alpha: 0.2,
    deep: 0.42,
    transGain: 1.8,
    reflGain: 4.5,
    lineGain: 0.9,
    silGain: 0,
    glint: 3,
    shine: 600,
    envSoft: 0.5,
    optic: 1,
    backGain: 0.35,
    film: 0.8,
    flash: 1.2,
    facet: true,
  },
  // Thick, slow, low k, heavy absorption: dark glass that barely lets its light out.
  earth: {
    ...MEMBRANE,
    layers: 9,
    disp: 0.11,
    gap: 0.13,
    fanBase: 0.6,
    kScale: 0.55,
    lag: 0.9,
    noiseAmp: 0.22,
    noiseFreq: 0.8,
    timeScale: 0.1,
    localAmp: 0.3,
    localModes: 1.8,
    localModesOct: 0.6,
    stripes: 4,
    tear: 0.35,
    hoverAmp: 0.12,
    hoverReach: 1.4,
    exciteAmp: 0.22,
    exciteWaves: 1.6,
    exciteSharp: 3,
    alpha: 0.3,
    deep: 1.1,
    transGain: 1.3,
    reflGain: 2.6,
    lineGain: 0.7,
    lineLum: 0.95,
    silGain: 0.7,
    glint: 1,
    shine: 160,
    envSoft: 1.6,
    optic: 0.8,
    backGain: 0.2,
    film: 0.7,
    flash: 0.8,
  },
  // Many faint fast shells, noisy and nearly weightless.
  air: {
    ...MEMBRANE,
    layers: 18,
    disp: 0.11,
    gap: 0.24,
    fanBase: 0.7,
    kScale: 1.25,
    lag: 1.3,
    noiseAmp: 0.3,
    noiseFreq: 1.5,
    timeScale: 0.6,
    localAmp: 0.24,
    localModes: 3,
    localModesOct: 1.2,
    stripes: 7,
    tear: 0.7,
    hoverAmp: 0.22,
    hoverReach: 1.8,
    exciteAmp: 0.24,
    exciteWaves: 3.5,
    exciteSharp: 6,
    alpha: 0.03,
    deep: 0.25,
    transGain: 1.3,
    reflGain: 2,
    lineGain: 0.45,
    lineLum: 0.9,
    silGain: 0.42,
    glint: 0.4,
    shine: 300,
    envSoft: 1.3,
    optic: 0.6,
    backGain: 0.6,
    film: 1.1,
    flash: 0.9,
  },
  // Sharp, sparse, high k: a few hard shells and strong glints.
  light: {
    ...MEMBRANE,
    layers: 6,
    disp: 0.05,
    gap: 0.1,
    fanBase: 0.5,
    kScale: 1.4,
    lag: 0.3,
    noiseAmp: 0.05,
    noiseFreq: 2.2,
    timeScale: 0.4,
    localAmp: 0.1,
    localModes: 3,
    localModesOct: 1,
    stripes: 8,
    tear: 0.5,
    hoverAmp: 0.14,
    hoverReach: 1.6,
    exciteAmp: 0.16,
    exciteWaves: 4.5,
    exciteSharp: 9,
    alpha: 0.07,
    deep: 0.3,
    transGain: 1.8,
    reflGain: 6,
    lineGain: 1,
    lineLum: 1.5,
    silGain: 1.1,
    glint: 3,
    core: 1.6,
    shine: 900,
    envSoft: 0.6,
    optic: 0.85,
    backGain: 0.45,
    film: 1.2,
    flash: 1.4,
  },
};

/**
 * What depends on the FORM rather than the variant. An open sheet is optically absent where it
 * is undisturbed (only the wave-borne tilt bends light) and its lamellae end on cut edges; a
 * closed body refracts with its true normal and has a silhouette instead of edges.
 */
interface Form {
  /** Share of the sheet's width over which the lamellae end one after another (the stair of cut edges), fully fanned. */
  terrace: number;
  bend: number;
  tiltGain: number;
  /** Preset lengths are tuned on bodies (in radii); a wide sheet moves, fans and tears on a larger scale. */
  dispScale: number;
  gapScale: number;
  noiseFreqScale: number;
  rippleScale: number;
  stripeScale: number;
}
const SHEET: Form = {
  terrace: 1,
  bend: 1.35,
  tiltGain: 1.15,
  dispScale: 3.2,
  gapScale: 2.6,
  noiseFreqScale: 0.32,
  rippleScale: 2.8,
  stripeScale: 2.4,
};
const CLOSED: Form = {
  terrace: 0,
  bend: 1,
  tiltGain: 1,
  dispScale: 1,
  gapScale: 1,
  noiseFreqScale: 1,
  rippleScale: 1,
  stripeScale: 1,
};

const DEFAULT_PARAMS: MatterParams = {
  reveal: 1,
  excite: 0,
  hover: 0,
  tension: 0.5,
  coherence: 1,
  freq: 0,
  seed: 0,
  warmth: 0,
  spread: 0.5,
};

/** Deterministic stand-in for a per-object random when the owner supplies none. */
let seedCounter = 0;
const nextSeed = (): number => {
  seedCounter++;
  const x = Math.sin(seedCounter * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const isOpen = (shape: MatterOptions['shape']): boolean => shape === 'plane' || shape === 'disc';

// ────────────────────────────────────────────────────────── geometries ──

interface Shared<T> {
  value: T;
  refs: number;
}
const geometryCache = new Map<string, Shared<BufferGeometry>>();

function acquire(key: string, build: () => BufferGeometry): BufferGeometry {
  let entry = geometryCache.get(key);
  if (!entry) {
    entry = { value: build(), refs: 0 };
    geometryCache.set(key, entry);
  }
  entry.refs++;
  return entry.value;
}

function release(key: string): void {
  const entry = geometryCache.get(key);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.value.dispose();
    geometryCache.delete(key);
  }
}

/** Distance of each vertex to the cut edge of an open sheet (local units); "far" for closed bodies. */
function withEdge(geometry: BufferGeometry, distance: (x: number, y: number) => number): BufferGeometry {
  const pos = geometry.getAttribute('position');
  const edge = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) edge[i] = distance(pos.getX(i), pos.getY(i));
  geometry.setAttribute('aEdge', new BufferAttribute(edge, 1));
  return geometry;
}

/** Faceted variants: un-indexed triangles carrying barycentric coordinates, displaced along a smooth normal. */
function faceted(source: BufferGeometry, radial: boolean): BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  const pos = geometry.getAttribute('position');
  const bary = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) bary[i * 3 + (i % 3)] = 1;
  geometry.setAttribute('aBary', new BufferAttribute(bary, 3));
  if (radial) {
    // One shared normal per corner (not per face), so displaced facets stay joined.
    const normal = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const l = Math.hypot(x, y, z) || 1;
      normal[i * 3] = x / l;
      normal[i * 3 + 1] = y / l;
      normal[i * 3 + 2] = z / l;
    }
    geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  }
  return geometry;
}

interface Built {
  key: string;
  geometry: BufferGeometry;
  /** Half diagonal (sheets) or radius (bodies), local units. */
  extent: number;
}

function buildGeometry(opts: MatterOptions, facet: boolean, lite: boolean): Built {
  const detail = clamp(opts.detail ?? 0.6);
  // Tessellation budget: 1 at detail 1 on the full tier; the lite tier draws about a third of the triangles.
  const density = (0.4 + 0.6 * detail) * (lite ? 0.58 : 1);
  const far = () => 1e3;

  switch (opts.shape) {
    case 'plane': {
      const width = Math.max(opts.width ?? 8, 1e-3);
      const height = Math.max(opts.height ?? width * 0.62, 1e-3);
      // 220 × 140 cells for a 11:7 sheet at detail 1, kept square for any aspect.
      const cells = facet ? 260 * density : 30800 * density * density;
      const cell = Math.sqrt((width * height) / cells);
      const sx = Math.max(2, Math.round(width / cell));
      const sy = Math.max(2, Math.round(height / cell));
      const key = `plane|${width}|${height}|${sx}|${sy}|${facet}`;
      const geometry = acquire(key, () => {
        const g = withEdge(new PlaneGeometry(width, height, sx, sy), (x, y) => Math.min(width / 2 - Math.abs(x), height / 2 - Math.abs(y)));
        return facet ? faceted(g, false) : g;
      });
      return { key, geometry, extent: 0.5 * Math.hypot(width, height) };
    }
    case 'disc': {
      const radius = Math.max(opts.radius ?? 0.5 * (opts.width ?? 6), 1e-3);
      const around = facet ? Math.max(6, Math.round(22 * density)) : Math.max(24, Math.round(288 * density));
      const rings = facet ? Math.max(2, Math.round(5 * density)) : Math.max(8, Math.round(110 * density));
      const key = `disc|${radius}|${around}|${rings}|${facet}`;
      const geometry = acquire(key, () => {
        const g = withEdge(new RingGeometry(radius * 2e-4, radius, around, rings), (x, y) => radius - Math.hypot(x, y));
        return facet ? faceted(g, false) : g;
      });
      return { key, geometry, extent: radius };
    }
    case 'sphere': {
      const radius = Math.max(opts.radius ?? 0.5, 1e-3);
      const around = facet ? Math.max(5, Math.round(12 * density)) : Math.max(16, Math.round(112 * density));
      const rows = facet ? Math.max(3, Math.round(8 * density)) : Math.max(10, Math.round(72 * density));
      const key = `sphere|${radius}|${around}|${rows}|${facet}`;
      const geometry = acquire(key, () => {
        const g = withEdge(new SphereGeometry(radius, around, rows), far);
        return facet ? faceted(g, true) : g;
      });
      return { key, geometry, extent: radius };
    }
    case 'ico': {
      const radius = Math.max(opts.radius ?? 0.5, 1e-3);
      const subdivisions = facet ? Math.round(detail * 3) : Math.max(4, Math.round(22 * density));
      const key = `ico|${radius}|${subdivisions}|${facet}`;
      const geometry = acquire(key, () => faceted(withEdge(new IcosahedronGeometry(radius, subdivisions), far), true));
      return { key, geometry, extent: radius };
    }
    case 'torus': {
      const radius = Math.max(opts.radius ?? 0.5, 1e-3);
      const ring = radius * 0.7;
      const tube = radius * 0.3;
      const across = facet ? Math.max(4, Math.round(8 * density)) : Math.max(10, Math.round(56 * density));
      const around = facet ? Math.max(6, Math.round(18 * density)) : Math.max(24, Math.round(168 * density));
      const key = `torus|${radius}|${across}|${around}|${facet}`;
      const geometry = acquire(key, () => {
        const g = withEdge(new TorusGeometry(ring, tube, across, around), far);
        return facet ? faceted(g, false) : g;
      });
      return { key, geometry, extent: radius };
    }
  }
}

// ────────────────────────────────────────────────────────────── matter ──

const waveDefines = (quality: Quality): Record<string, string | number> =>
  quality.lite ? { WAVE_TERMS: 4, LITE: '' } : { WAVE_TERMS: 8 };

export function createMatter(variant: MatterVariant, opts: MatterOptions, quality: Quality): Matter {
  sharedState.lite = quality.lite;
  const preset = PRESETS[variant];
  const open = isOpen(opts.shape);
  const { key, geometry, extent } = buildGeometry(opts, preset.facet, quality.lite);

  const wanted = Math.max(1, Math.round(opts.layers ?? preset.layers));
  const layers = quality.lite ? Math.max(Math.min(wanted, 2), Math.ceil(wanted / 2)) : wanted;

  // One unit of deformation: a world unit for large sheets, the radius for bodies.
  const unit = open ? clamp(extent / 6, 0.3, 1) : extent;
  const form = open ? SHEET : CLOSED;
  const motion = quality.reducedMotion ? 0.5 : 1;

  const params: MatterParams = { ...DEFAULT_PARAMS, seed: nextSeed(), ...opts.init };

  const own: Uniforms = {
    uReveal: { value: 0 },
    uExcite: { value: 0 },
    uHover: { value: 0 },
    uTension: { value: 0.5 },
    uCoherence: { value: 1 },
    uSeed: { value: 0 },
    uWarmth: { value: 0 },
    uSpread: { value: 0.5 },
    uLocalK: { value: 0 },

    uLayers: { value: layers },
    // Sheets: set per frame (far lamella first). Bodies: the outer shell is instance 0, always drawn.
    uFlip: { value: open ? 1 : -1 },
    uOpen: { value: open ? 1 : 0 },
    uDisc: { value: opts.shape === 'disc' ? 1 : 0 },
    uExtent: { value: extent },
    uUnit: { value: unit },
    uFanBase: { value: preset.fanBase },
    uDisp: { value: preset.disp * form.dispScale },
    uGap: { value: preset.gap * form.gapScale },
    uKScale: { value: open ? preset.kScale : preset.kScale / extent },
    uLag: { value: preset.lag },
    uNoiseAmp: { value: preset.noiseAmp },
    uNoiseFreq: { value: (preset.noiseFreq * form.noiseFreqScale) / unit },
    uTimeScale: { value: preset.timeScale * motion },
    uLocalAmp: { value: preset.localAmp },
    uStripes: { value: Math.round(preset.stripes * form.stripeScale) },
    uTear: { value: preset.tear },
    uHoverAmp: { value: preset.hoverAmp },
    uHoverReach: { value: preset.hoverReach },
    uExciteAmp: { value: preset.exciteAmp },
    uExciteK: { value: preset.exciteWaves * form.rippleScale * Math.PI * 2 },
    uExciteW: { value: preset.exciteSharp * form.rippleScale },
    uFacet: { value: preset.facet ? 1 : 0 },
    uTerrace: { value: form.terrace },
    // Fewer sheets absorb less: the lite tier's halved stack is compensated in full, an explicitly
    // thin stack only in part (it is meant to be lighter).
    uAlpha: { value: 1 - Math.pow(1 - preset.alpha, (wanted / layers) * Math.sqrt(preset.layers / wanted)) },
    uDeep: { value: preset.deep },
    uTransGain: { value: preset.transGain },
    uReflGain: { value: open ? 0 : preset.reflGain },
    uLineGain: { value: preset.lineGain },
    uLineLum: { value: preset.lineLum },
    uSilGain: { value: open ? 0 : preset.silGain },
    uSheen: { value: open ? preset.sheen : 0 },
    uGlint: { value: open ? 0 : preset.glint },
    uCore: { value: open ? 0 : preset.core },
    uShine: { value: preset.shine },
    uEnvSoft: { value: preset.envSoft },
    uOptic: { value: open ? 0 : preset.optic },
    uBend: { value: form.bend },
    uTiltGain: { value: form.tiltGain },
    uBackGain: { value: open ? 1 : preset.backGain },
    uFilm: { value: preset.film },
    uFlash: { value: preset.flash },
  };

  const material = new ShaderMaterial({
    name: `matter-${variant}`,
    uniforms: { ...shared, ...own },
    defines: waveDefines(quality),
    vertexShader: MATTER_VERT,
    fragmentShader: MATTER_FRAG,
    side: DoubleSide,
    transparent: true,
    blending: NormalBlending,
    premultipliedAlpha: true,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  const mesh = new InstancedMesh(geometry, material, layers);
  mesh.name = `matter-${variant}`;
  mesh.frustumCulled = false;

  if (open) {
    // Lamellae are drawn in instance order: keep the far one first whichever side the camera is on.
    mesh.onBeforeRender = (_renderer, _scene, camera: Camera) => {
      const m = mesh.matrixWorld.elements;
      const c = camera.matrixWorld.elements;
      const facing = (c[12] - m[12]) * m[8] + (c[13] - m[13]) * m[9] + (c[14] - m[14]) * m[10];
      own.uFlip.value = facing >= 0 ? 1 : -1;
    };
  }

  const sync = (): void => {
    own.uReveal.value = clamp(params.reveal);
    own.uExcite.value = clamp(params.excite);
    own.uHover.value = clamp(params.hover);
    own.uTension.value = clamp(params.tension);
    own.uCoherence.value = clamp(params.coherence);
    own.uSeed.value = params.seed;
    own.uWarmth.value = clamp(params.warmth, -1, 1);
    own.uSpread.value = clamp(params.spread);
    if (params.freq > 0) {
      const octaves = clamp(Math.log2(Math.max(params.freq / sharedState.fundamental, 1)), 0, 6);
      own.uLocalK.value = (preset.localModes + preset.localModesOct * octaves) / extent;
    } else {
      own.uLocalK.value = 0;
    }
    // Draw only the lamellae that have unfolded (the shader fades the last one in; the complexity
    // read here is last frame's, hence one sheet of margin).
    const fan = own.uSpread.value * (preset.fanBase + (1 - preset.fanBase) * shared.uComplexity.value);
    mesh.count = Math.min(layers, Math.ceil(1 + fan * 1.6 * (layers - 1)) + 1);
  };
  sync();

  let disposed = false;
  return {
    object: mesh,
    material,
    params,
    sync,
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.removeFromParent();
      mesh.dispose();
      material.dispose();
      release(key);
    },
  };
}

// ──────────────────────────────────────────────────────────── filament ──

const FILAMENT_KEY = 'filament';

function buildRibbon(segments: number): BufferGeometry {
  const rows = segments + 1;
  const position = new Float32Array(rows * 2 * 3);
  const index = new Uint16Array(segments * 6);
  for (let i = 0; i < rows; i++) {
    const t = i / segments;
    position.set([t, -1, 0, t, 1, 0], i * 6);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], i * 6);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

export function createFilament(quality: Quality): Filament {
  sharedState.lite = quality.lite;
  const segments = quality.lite ? 48 : 96;
  const key = `${FILAMENT_KEY}|${segments}`;
  const geometry = acquire(key, () => buildRibbon(segments));

  const params = { reveal: 0, energy: 0.3, tension: 0.5, warmth: 0 };
  const a = new Vector3(-1, 0, 0);
  const b = new Vector3(1, 0, 0);
  const own: Uniforms = {
    uA: { value: a },
    uB: { value: b },
    uReveal: { value: 0 },
    uEnergy: { value: 0.3 },
    uTension: { value: 0.5 },
    uWarmth: { value: 0 },
    uSeed: { value: nextSeed() },
  };

  const material = new ShaderMaterial({
    name: 'filament',
    uniforms: { ...shared, ...own },
    vertexShader: FILAMENT_VERT,
    fragmentShader: FILAMENT_FRAG,
    side: DoubleSide,
    transparent: true,
    blending: NormalBlending,
    premultipliedAlpha: true,
    depthTest: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'filament';
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;

  let disposed = false;
  return {
    object: mesh,
    params,
    setEndpoints(pa: Vec3Like, pb: Vec3Like) {
      a.set(pa.x, pa.y, pa.z);
      b.set(pb.x, pb.y, pb.z);
    },
    sync() {
      own.uReveal.value = clamp(params.reveal);
      own.uEnergy.value = clamp(params.energy);
      own.uTension.value = clamp(params.tension);
      own.uWarmth.value = clamp(params.warmth, -1, 1);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.removeFromParent();
      material.dispose();
      release(key);
    },
  };
}

// ──────────────────────────────────────────────────────── volume field ──

const VOLUME_KEY = 'volume-box';
/**
 * The field is sampled in "lattice space": whatever its world size, the volume frames a ball of
 * the interference figure about LATTICE_RADIUS·(1 + r)^¼ units in radius around its centre (capped) —
 * a handful of fringes when it is a seed in the hand, a wider architecture once it has grown vast.
 */
const LATTICE_RADIUS = 5.5;
const LATTICE_RADIUS_MAX = 11;
/** Shells of the lowest sounding source across the radius of the ball, whatever its pitch. */
const LATTICE_SHELLS = 26;
/** How far from the centre the sources are spread in lattice space, in shells of the lowest one. */
const LATTICE_SPREAD = 2.6;

export function createVolumeField(quality: Quality): VolumeField {
  sharedState.lite = quality.lite;
  const geometry = acquire(VOLUME_KEY, () => new BoxGeometry(1, 1, 1));

  /** scale = radius of the field in world units (times any scale the owner puts on `object`). */
  const params = { reveal: 0, density: 0.5, structure: 0.5, scale: 1 };
  const centre = new Vector3();
  const own: Uniforms = {
    uCentre: { value: centre },
    uReveal: { value: 0 },
    uDensity: { value: 0.5 },
    uStructure: { value: 0.5 },
    uMag: { value: 1 },
    uBall: { value: LATTICE_RADIUS },
    uKNorm: { value: 1 },
    uSrcMag: { value: 1 },
  };

  const material = new ShaderMaterial({
    name: 'volume-field',
    uniforms: { ...shared, ...own },
    defines: { WAVE_TERMS: quality.lite ? 4 : 8 },
    vertexShader: VOLUME_VERT,
    fragmentShader: VOLUME_FRAG,
    side: BackSide,
    transparent: true,
    blending: NormalBlending,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  // The owner positions (and may scale) `object`; params.scale sizes the box inside it.
  const object = new Object3D();
  object.name = 'volume-field';
  const mesh = new Mesh(geometry, material);
  mesh.name = 'volume-field-box';
  mesh.frustumCulled = false;
  mesh.renderOrder = -4;
  object.add(mesh);

  mesh.onBeforeRender = () => {
    const e = mesh.matrixWorld.elements;
    centre.set(e[12], e[13], e[14]);
    // World radius of the ball inscribed in the box (uniform scale assumed; x is as good as any).
    const radius = 0.5 * Math.hypot(e[0], e[1], e[2]);
    const ball = Math.min(LATTICE_RADIUS * Math.pow(1 + radius, 0.25), LATTICE_RADIUS_MAX);
    own.uBall.value = ball;
    own.uMag.value = ball / Math.max(radius, 1e-3);

    // The lowest sounding source sets the scale of the figure: LATTICE_SHELLS of its wavefronts
    // across the ball. The sources are then spread about the centre until they sit a few shells apart.
    const count = Math.min(shared.uWaveCount.value, quality.lite ? 4 : MAX_WAVES);
    let kLow = Infinity;
    let spread = 0;
    for (let i = 0; i < count; i++) {
      kLow = Math.min(kLow, shared.uWave.value[i].x);
      spread += shared.uWavePos.value[i].distanceTo(centre);
    }
    if (count > 0 && kLow > 1e-4) {
      const spacing = ball / LATTICE_SHELLS;
      own.uKNorm.value = (2 * Math.PI) / (spacing * kLow);
      own.uSrcMag.value = clamp((LATTICE_SPREAD * spacing * count) / Math.max(spread, 1e-3), 1, 14);
    }
  };

  const sync = (): void => {
    own.uReveal.value = clamp(params.reveal);
    own.uDensity.value = clamp(params.density, 0, 4);
    own.uStructure.value = clamp(params.structure);
    mesh.scale.setScalar(Math.max(params.scale, 1e-3) * 2);
  };
  sync();

  let disposed = false;
  return {
    object,
    params,
    sync,
    dispose() {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      material.dispose();
      release(VOLUME_KEY);
    },
  };
}

// ─────────────────────────────────────────────────────────── particles ──

/** The room the dust hangs in (world units, centred a little behind the scene focus). */
const DUST_HALF = new Vector3(13, 7.5, 7);
const DUST_CENTRE = new Vector3(0, 0, -1.5);

export function createParticles(count: number, quality: Quality): Particles {
  sharedState.lite = quality.lite;
  const n = Math.max(1, Math.floor(count));
  const rand = mulberry32(0x5eed + n * 7919);
  const position = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    position[i * 3] = DUST_CENTRE.x + (rand() * 2 - 1) * DUST_HALF.x;
    position[i * 3 + 1] = DUST_CENTRE.y + (rand() * 2 - 1) * DUST_HALF.y;
    position[i * 3 + 2] = DUST_CENTRE.z + (rand() * 2 - 1) * DUST_HALF.z;
    seed[i] = rand();
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seed, 1));

  const params = { reveal: 0, drift: 0.2 };
  const impulses = Array.from({ length: MAX_IMPULSES }, () => new Vector4(0, 0, 0, -1e3));
  const gains = new Float32Array(MAX_IMPULSES);
  const own: Uniforms = {
    uReveal: { value: 0 },
    uDrift: { value: 0.2 },
    uImpulse: { value: impulses },
    uImpulseGain: { value: gains },
  };

  const material = new ShaderMaterial({
    name: 'particles',
    uniforms: { ...shared, ...own },
    defines: { WAVE_TERMS: quality.lite ? 4 : 8 },
    vertexShader: PARTICLES_VERT,
    fragmentShader: PARTICLES_FRAG,
    transparent: true,
    blending: NormalBlending,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  const points = new Points(geometry, material);
  points.name = 'particles';
  points.frustumCulled = false;
  points.renderOrder = 6;

  let disposed = false;
  return {
    object: points,
    params,
    impulse(at: Vec3Like, strength: number) {
      // Reuse the slot whose push has faded the most (the shader lets go as e^(−0.4·age)).
      const now = shared.uTime.value;
      let slot = 0;
      let least = Infinity;
      for (let i = 0; i < MAX_IMPULSES; i++) {
        const age = now - impulses[i].w;
        const residual = age < 0 ? 0 : gains[i] * Math.exp(-0.4 * age);
        if (residual < least) {
          least = residual;
          slot = i;
        }
      }
      impulses[slot].set(at.x, at.y, at.z, now);
      gains[slot] = clamp(strength, 0, 2);
    },
    sync() {
      own.uReveal.value = clamp(params.reveal);
      own.uDrift.value = clamp(params.drift, 0, 2);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      points.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
