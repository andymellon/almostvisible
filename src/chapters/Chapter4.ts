/**
 * Chapter IV — THE LIVING COMPOSITION.  "Give every sound its own space."
 *
 * Three sculptural sound fields — EARTH (heavy ring), AIR (a veil of faint sheets), LIGHT (a sharp
 * faceted body) — begin crowded on top of the listener, masking one another: the sound is mud and
 * the central membrane is torn and turbulent. Each can be dragged in three dimensions and turned.
 *
 *   proximity → level · height → brightness · depth → diffusion · rotation → modulation
 *
 * (all of it in src/puzzles/balance.ts). As the three find their own region and register the
 * membrane draws taut and coherent, filaments appear between every pair that is clear of each
 * other, and after two seconds of held balance the signature plays: the bodies glide into one
 * composed, asymmetric sculpture around the membrane, a volume begins to breathe on a period taken
 * from the root, colour is let in — and then everything is held almost perfectly still.
 *
 * Wave slots: 0 earth · 1 air · 2 light · 7 the root at the centre (signature only).
 *
 * Hand-off: exit() does not fade. The sculpture loosens and widens into the exact state recorded
 * in HANDOFF, and chapter V starts from that state, so the cut between the two is invisible.
 * The small shared pieces chapter V needs (mote, field bodies, membrane, framing) are exported here.
 */
import { AdditiveBlending, Group, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import type {
  CameraPose,
  Chapter,
  ChapterContext,
  FieldMix,
  Filament,
  Harmony,
  Interactive,
  Matter,
  MatterOptions,
  MatterVariant,
  Particles,
  Quality,
  StrikeTimbre,
  VolumeField,
} from '../core/contracts';
import { clamp, damp, ease, lerp, smoothstep, TAU } from '../core/math';
import { createFilament, createMatter, createParticles, createVolumeField } from '../render/materials';
import {
  BOUNDS,
  PAIRS,
  TUNING,
  composeArrangement,
  copyMix,
  createBalanceState,
  createMix,
  createPose,
  crowdedStart,
  evaluateBalance,
  isSolved,
  levelBand,
  openRegion,
  solveArrangement,
  stepHold,
  type FieldPose,
} from '../puzzles/balance';

const DEG = Math.PI / 180;

// ═══════════════════════════════════════════════════════ shared with chapter V ══

/**
 * A mote: one camera-facing point (or thin ring) of light drawn by its own tiny shader.
 * It ignores bridge.silence and bridge.presence — its brightness is whatever the owner sets —
 * which is exactly what the last point of chapter V needs.
 *
 * Output is ADDITIVE, display-referred: colour × brightness is added to the frame, and the
 * falloff reaches exact zero inside the quad, so black stays black around it.
 */
export interface Mote {
  readonly object: Mesh;
  readonly position: Vector3;
  /** 0 = invisible (the mesh is hidden). 1 = a core just below white. */
  brightness: number;
  /** Width of the quad in world units; the visible core is ≈ 4 % of it. */
  size: number;
  /** 0 = point with a faint halo, 1 = thin ring (radius ≈ 0.31 × size). */
  ring: number;
  sync(): void;
  dispose(): void;
}

const MOTE_VERT = /* glsl */ `
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uSize;
    gl_Position = projectionMatrix * mv;
  }
`;

const MOTE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBrightness;
  uniform float uRing;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float edge = 1.0 - smoothstep(0.7, 1.0, r);
    float core = exp(-r * r * 160.0);
    float halo = exp(-r * r * 11.0) * 0.06;
    float d = r - 0.62;
    float line = exp(-d * d / 0.0009) * 0.5 + exp(-d * d / 0.02) * 0.045;
    float a = mix(core + halo, line, uRing) * edge * uBrightness;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

export function createMote(r = 1, g = 0.965, b = 0.9): Mote {
  const uniforms = {
    uColor: { value: new Vector3(r, g, b) },
    uBrightness: { value: 0 },
    uSize: { value: 0.5 },
    uRing: { value: 0 },
  };
  const geometry = new PlaneGeometry(1, 1);
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    blending: AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const object = new Mesh(geometry, material);
  object.name = 'mote';
  object.frustumCulled = false;
  object.renderOrder = 60;
  object.visible = false;
  const mote: Mote = {
    object,
    position: object.position,
    brightness: 0,
    size: 0.5,
    ring: 0,
    sync() {
      uniforms.uBrightness.value = mote.brightness;
      uniforms.uSize.value = mote.size;
      uniforms.uRing.value = mote.ring;
      object.visible = mote.brightness > 0.002;
    },
    dispose() {
      object.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
  return mote;
}

/** The character of one sound field: how it is built, how it sits, how it sounds when touched. */
export interface FieldStyle {
  readonly name: string;
  readonly label: string;
  readonly variant: MatterVariant;
  readonly options: MatterOptions;
  readonly tension: number;
  readonly warmth: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly tiltZ: number;
  /** Hit radius (world units, before the body's scale). */
  readonly radius: number;
  readonly strike: StrikeTimbre;
  /** Rate (rad/s) of the slow wobble that rotation/modulation adds. */
  readonly wobble: number;
}

const HOW = 'Drag to place it, W and S move it in depth, Q and E turn it.';

/** Index 0 earth, 1 air, 2 light — the order used everywhere (balance.ts, wave slots, memory). */
export const FIELD_STYLES: readonly FieldStyle[] = [
  {
    name: 'Earth',
    label: `Earth, a low and heavy field of sound. ${HOW}`,
    variant: 'earth',
    options: { shape: 'torus', radius: 0.68, detail: 0.6 },
    tension: 0.8,
    warmth: 0.5,
    tiltX: 1.05,
    tiltY: 0,
    tiltZ: 0.18,
    radius: 0.85,
    strike: 'sub',
    wobble: 0.31,
  },
  {
    name: 'Air',
    label: `Air, a field of faint moving sheets of sound. ${HOW}`,
    variant: 'air',
    options: { shape: 'plane', width: 2.1, height: 1.6, detail: 0.6 },
    tension: 0.22,
    warmth: -0.55,
    tiltX: -0.18,
    tiltY: 0.5,
    tiltZ: -0.08,
    radius: 0.9,
    strike: 'glass',
    wobble: 0.53,
  },
  {
    name: 'Light',
    label: `Light, a sharp and sparse field of sound. ${HOW}`,
    variant: 'light',
    options: { shape: 'ico', radius: 0.5, detail: 0.5 },
    tension: 0.95,
    warmth: 0.08,
    tiltX: 0.3,
    tiltY: 0.4,
    tiltZ: 0,
    radius: 0.75,
    strike: 'bell',
    wobble: 0.79,
  },
];

/** Wave slots of the three fields, and of the root that joins them at the centre. */
export const FIELD_SLOTS: readonly number[] = [0, 1, 2];
export const ROOT_SLOT = 7;

/** EARTH low (root, one octave up), AIR mid (the fifth), LIGHT high (the third, three octaves up). */
export function fieldFreq(harmony: Harmony, index: number): number {
  return index === 0 ? harmony.freq(0, 1) : index === 1 ? harmony.freq(4, 2) : harmony.freq(2, 3);
}
/** Mix level → wave-source level of the field. */
export const fieldWaveLevel = (level: number): number => 0.25 + 0.6 * level;
/** Mix level → scale of the body (nearer is larger, on top of perspective). */
export const fieldScale = (level: number): number => 0.85 + 0.3 * level;
/** Brightness cools the body's own warmth: high registers lean toward ice. */
export const fieldWarmth = (style: FieldStyle, mix: FieldMix): number => clamp(style.warmth - (mix.brightness - 0.5) * 0.5, -1, 1);
/** Diffusion fans the lamellae apart. */
export const fieldSpread = (mix: FieldMix): number => 0.2 + 0.65 * mix.diffusion;

export interface FieldBody {
  readonly index: number;
  readonly style: FieldStyle;
  /** Position, user rotation (about Y) and scale. This is the Interactive's object. */
  readonly holder: Group;
  /** Static tilt of the body, plus lean / bob / wobble. */
  readonly tilt: Group;
  readonly matter: Matter;
}

export function buildField(index: number, seed: number, quality: Quality): FieldBody {
  const style = FIELD_STYLES[index];
  const matter = createMatter(
    style.variant,
    {
      ...style.options,
      init: { reveal: 0, excite: 0, hover: 0, tension: style.tension, coherence: 1, freq: 0, seed, warmth: style.warmth, spread: 0.3 },
    },
    quality,
  );
  const holder = new Group();
  holder.name = `field-${style.name.toLowerCase()}`;
  const tilt = new Group();
  tilt.rotation.set(style.tiltX, style.tiltY, style.tiltZ);
  tilt.add(matter.object);
  holder.add(tilt);
  return { index, style, holder, tilt, matter };
}

/** Orientation of the central membrane (and of chapter V's stack of membranes). */
export const MEMBRANE_TILT = { x: -0.34, y: 0.22, z: 0.05 } as const;

export function buildMembrane(seed: number, quality: Quality): Matter {
  return createMatter(
    'membrane',
    {
      shape: 'plane',
      width: 5.2,
      height: 3.4,
      layers: 6,
      detail: 0.8,
      init: { reveal: 0, excite: 0, hover: 0, tension: 0.1, coherence: 0.1, freq: 0, seed, warmth: -0.2, spread: 0.7 },
    },
    quality,
  );
}

/**
 * Camera distance that keeps a composition of fixed width in frame. The rig itself widens the
 * field of view below an aspect of 0.8, so only the range 0.8–1.3 needs the camera pulled back.
 */
export function frameDistance(aspect: number, base: number): number {
  return base * clamp(1.3 / Math.max(aspect, 0.8), 1, 1.625);
}

/**
 * The state chapter IV ends in and chapter V begins from. The constants are the hand-off look;
 * the arrays are written at the end of IV's exit and consumed by V's enter.
 */
export const HANDOFF = {
  valid: false,
  harmonySeed: 0,
  positions: [new Vector3(), new Vector3(), new Vector3()],
  rotations: [0, 0, 0],
  seeds: [0, 0, 0],
  membraneSeed: 0,
  membrane: { reveal: 0.42, tension: 0.35, coherence: 0.82, spread: 1, scale: 1.25, warmth: 0.1 },
  volume: { reveal: 0.4, density: 0.42, structure: 0.6, scale: 1.25 },
  field: { reveal: 0.3, coherence: 0.6, spread: 0.9, tension: 0.6 },
  particles: { reveal: 0.06, drift: 0.5 },
  rootLevel: 0.4,
};

export const SILENT_FIELDS: { earth: FieldMix; air: FieldMix; light: FieldMix } = {
  earth: { level: 0, brightness: 0.3, diffusion: 0.5, modulation: 0 },
  air: { level: 0, brightness: 0.5, diffusion: 0.5, modulation: 0 },
  light: { level: 0, brightness: 0.7, diffusion: 0.5, modulation: 0 },
};

// ═══════════════════════════════════════════════════════════════ chapter IV ══

const CAM_BASE = 8.2;
/** Fraction of the frustum the bodies may use, and the room a body needs inside it. */
const FRAME_MARGIN = 0.84;
const BODY_MARGIN = 0.5;

const AUTO_SECONDS = 5;
const MERGE_SECONDS = 6;
const STILL_SECONDS = 5;
const EXIT_SECONDS = 3.6;
const EXIT_RATE = 1.7;
const WIDEN = 1.45;
const PAIR_WARMTH = [-0.15, 0.4, -0.5];
const HINT = "They are standing in each other's light.";

type Phase = 'play' | 'auto' | 'merge' | 'hold' | 'done' | 'exit' | 'exited';

interface FieldRig {
  readonly body: FieldBody;
  readonly interactive: Interactive;
  readonly lean: Vector3;
  rotation: number;
  rotationTarget: number;
  hoverTarget: number;
  lastStrike: number;
}

interface World {
  readonly root: Group;
  readonly fields: FieldRig[];
  readonly membrane: Matter;
  readonly membraneHolder: Group;
  readonly filaments: Filament[];
  readonly volume: VolumeField;
  readonly particles: Particles;
  readonly ring: Mote;
  readonly trail: Mote[];
}

export function createChapter4(): Chapter {
  // Scratch owned by this instance: allocated once, reused every frame and every replay.
  const poses: FieldPose[] = [createPose(), createPose(), createPose()];
  const targets: FieldPose[] = [createPose(), createPose(), createPose()];
  const state = createBalanceState();
  const frozen: FieldMix[] = [createMix(), createMix(), createMix()];
  const liveFields = { earth: state.mixes[0], air: state.mixes[1], light: state.mixes[2] };
  const frozenFields = { earth: frozen[0], air: frozen[1], light: frozen[2] };
  const from = [new Vector3(), new Vector3(), new Vector3()];
  const to = [new Vector3(), new Vector3(), new Vector3()];
  const ghostTarget = new Vector3();
  const ghostAt = new Vector3();
  const camPose: CameraPose = { position: { x: 0, y: 0.2, z: CAM_BASE }, target: { x: 0, y: 0, z: -0.4 } };

  let world: World | null = null;
  let phase: Phase = 'play';
  let t = 0;
  let phaseT = 0;
  let sigT = 0;
  let sigK = 0;
  let shown = 0;
  let held = 0;
  let still = 0;
  let complete = false;
  let exited = false;
  let recorded = false;
  let assistLevel = 0;
  let guideIndex = -1;
  let guideTimer = 0;
  let guideAmount = 0;
  let ghostPlaced = false;
  let spectralFrom = 0;
  let breathPeriod = 9;
  let side = 1;
  // Framing.
  let aspect = 0;
  let moveEnd = 0;
  let camDist = CAM_BASE;
  let tanHalf = Math.tan(17.5 * DEG);
  let camAspect = 1.6;
  let xLimit: number = BOUNDS.xMax;

  const constrain = (desired: Vector3): void => {
    desired.z = clamp(desired.z, BOUNDS.zMin, BOUNDS.zMax);
    const halfH = Math.max(camDist - desired.z, 1) * tanHalf;
    const yl = clamp(halfH * FRAME_MARGIN - BODY_MARGIN, 0.6, BOUNDS.yMax);
    const xl = clamp(halfH * camAspect * FRAME_MARGIN - BODY_MARGIN, 0.6, BOUNDS.xMax);
    desired.x = clamp(desired.x, -xl, xl);
    desired.y = clamp(desired.y, -yl, yl);
  };

  const aim = (ctx: ChapterContext, seconds: number): void => {
    const composed = phase === 'merge' || phase === 'hold' || phase === 'done';
    camPose.position.x = composed ? 0.9 * side : 0;
    camPose.position.y = composed ? 0.45 : 0.2;
    camPose.position.z = composed ? camDist * 0.94 : camDist;
    camPose.target.x = 0;
    camPose.target.y = composed ? 0.05 : 0;
    camPose.target.z = composed ? -0.2 : -0.4;
    moveEnd = t + seconds;
    ctx.rig.moveTo(camPose, seconds);
  };

  /** Keep the bounding volume inside whatever frustum the canvas currently has. */
  const frame = (ctx: ChapterContext): void => {
    const cam = ctx.rig.camera;
    tanHalf = Math.tan(cam.fov * 0.5 * DEG);
    camAspect = cam.aspect;
    const vp = ctx.stage.viewport;
    const a = vp.height > 0 ? vp.width / vp.height : cam.aspect;
    if (Math.abs(a - aspect) > 0.02) {
      const first = aspect === 0;
      aspect = a;
      camDist = frameDistance(a, CAM_BASE);
      // Re-frame for the new shape without hurrying a directed move that is still under way.
      if (!first && phase !== 'exit' && phase !== 'exited') aim(ctx, Math.max(1.5, moveEnd - t));
    }
    const halfH = (camDist - BOUNDS.zMax) * tanHalf;
    xLimit = clamp(halfH * camAspect * FRAME_MARGIN - BODY_MARGIN, 0.6, BOUNDS.xMax);
  };

  const release = (ctx: ChapterContext, w: World): void => {
    for (let i = 0; i < w.fields.length; i++) {
      const f = w.fields[i];
      f.interactive.enabled = false;
      f.hoverTarget = 0;
      ctx.interaction.remove(f.interactive);
    }
  };

  const record = (ctx: ChapterContext): void => {
    if (recorded) return;
    recorded = true;
    for (let i = 0; i < 3; i++) copyMix(state.mixes[i], frozen[i]);
    ctx.memory.data.balance = { earth: { ...frozen[0] }, air: { ...frozen[1] }, light: { ...frozen[2] } };
  };

  const glideFrom = (w: World): void => {
    for (let i = 0; i < 3; i++) from[i].copy(w.fields[i].body.holder.position);
  };

  const glide = (w: World, k: number, arc: number): void => {
    const lift = Math.sin(Math.PI * k) * arc;
    for (let i = 0; i < 3; i++) {
      const p = w.fields[i].body.holder.position;
      p.lerpVectors(from[i], to[i], k);
      p.z += lift * (i - 1);
    }
  };

  const beginAuto = (ctx: ChapterContext, w: World): void => {
    release(ctx, w);
    ctx.ui.hint(null);
    solveArrangement(poses, targets, xLimit);
    glideFrom(w);
    for (let i = 0; i < 3; i++) to[i].set(targets[i].x, targets[i].y, targets[i].z);
    phase = 'auto';
    phaseT = 0;
  };

  const beginSignature = (ctx: ChapterContext, w: World): void => {
    record(ctx);
    release(ctx, w);
    composeArrangement(poses, targets);
    glideFrom(w);
    for (let i = 0; i < 3; i++) to[i].set(targets[i].x, targets[i].y, targets[i].z);
    side = targets[2].x >= targets[0].x ? 1 : -1;
    spectralFrom = ctx.bridge.spectral;
    const rootWave = ctx.bridge.waves[ROOT_SLOT];
    rootWave.position.set(0, 0, 0);
    rootWave.freq = ctx.harmony.freq(0, 0);
    rootWave.level = 0;
    ctx.ui.hint(null);
    ctx.ui.announce('Earth, air and light each find their own space, and become one sculpture.');
    ctx.audio.resolve('balance');
    ctx.audio.setDrone(0.42, 0.5);
    phase = 'merge';
    phaseT = 0;
    sigT = 0;
    aim(ctx, MERGE_SECONDS + 1);
  };

  const makeRig = (ctx: ChapterContext, body: FieldBody, particles: Particles): FieldRig => {
    const style = body.style;
    const index = body.index;
    const rig: FieldRig = {
      body,
      lean: new Vector3(),
      rotation: 0,
      rotationTarget: 0,
      hoverTarget: 0,
      lastStrike: -10,
      interactive: {
        label: style.label,
        object: body.holder,
        radius: style.radius,
        enabled: true,
        draggable: true,
        constrain,
        magnet(desired: Vector3, dragging: boolean) {
          // Guidance (assist 2): the open region catches a body that is brought near it.
          if (!dragging || guideIndex !== index || guideAmount < 0.5) return;
          const d = desired.distanceTo(ghostTarget);
          if (d < 0.8) desired.lerp(ghostTarget, (1 - d / 0.8) * 0.45);
        },
        onHover(hovering: boolean) {
          rig.hoverTarget = hovering ? 1 : 0;
        },
        onPress() {
          if (t - rig.lastStrike < 0.45) return;
          rig.lastStrike = t;
          body.matter.params.excite = 1;
          particles.impulse(body.holder.position, 0.5);
          ctx.audio.strike(fieldFreq(ctx.harmony, index), { velocity: 0.28, pos: body.holder.position, timbre: style.strike });
        },
        onRotate(delta: number) {
          rig.rotationTarget += delta;
        },
      },
    };
    return rig;
  };

  const chapter: Chapter = {
    index: 3,
    numeral: 'IV',
    name: 'The Living Composition',
    line: 'Give every sound its own space.',

    get progress() {
      return phase === 'play' || phase === 'auto' ? clamp(shown) : 1;
    },
    get complete() {
      return complete;
    },
    get exited() {
      return exited;
    },

    enter(ctx: ChapterContext) {
      if (world) chapter.dispose(ctx);
      const { harmony, quality, bridge } = ctx;
      const rand = () => harmony.rand();

      phase = 'play';
      t = phaseT = sigT = sigK = moveEnd = 0;
      shown = held = still = 0;
      complete = exited = recorded = false;
      assistLevel = 0;
      guideIndex = -1;
      guideTimer = 0;
      guideAmount = 0;
      ghostPlaced = false;
      spectralFrom = bridge.spectral;
      side = 1;
      breathPeriod = 512 / Math.max(harmony.root, 20); // nine octaves below the root: 8–11 s
      HANDOFF.valid = false;

      const root = new Group();
      root.name = 'chapter-4';

      const membraneSeed = rand();
      const membrane = buildMembrane(membraneSeed, quality);
      const membraneHolder = new Group();
      membraneHolder.rotation.set(MEMBRANE_TILT.x, MEMBRANE_TILT.y, MEMBRANE_TILT.z);
      membraneHolder.add(membrane.object);
      root.add(membraneHolder);
      HANDOFF.membraneSeed = membraneSeed;

      const volume = createVolumeField(quality);
      volume.params.reveal = 0;
      volume.params.density = 0.5;
      volume.params.structure = 0.3;
      volume.params.scale = 1;
      volume.sync();
      root.add(volume.object);

      const particles = createParticles(quality.lite ? 500 : 1400, quality);
      particles.params.reveal = 0;
      particles.params.drift = 1;
      particles.sync();
      root.add(particles.object);

      crowdedStart(rand, poses);
      const fields: FieldRig[] = [];
      for (let i = 0; i < 3; i++) {
        const seed = rand();
        HANDOFF.seeds[i] = seed;
        const body = buildField(i, seed, quality);
        const rig = makeRig(ctx, body, particles);
        body.holder.position.set(poses[i].x, poses[i].y, poses[i].z);
        rig.rotation = rig.rotationTarget = poses[i].rotation;
        body.holder.rotation.y = rig.rotation;
        body.holder.scale.setScalar(fieldScale(0.88));
        body.matter.params.freq = fieldFreq(harmony, i);
        body.matter.sync();
        root.add(body.holder);
        fields.push(rig);
      }

      const filaments: Filament[] = [];
      for (let k = 0; k < PAIRS.length; k++) {
        const filament = createFilament(quality);
        filament.params.reveal = 0;
        filament.params.energy = 0.25;
        filament.params.tension = 0.4;
        filament.params.warmth = PAIR_WARMTH[k];
        filament.setEndpoints(poses[PAIRS[k][0]], poses[PAIRS[k][1]]);
        filament.sync();
        root.add(filament.object);
        filaments.push(filament);
      }

      const ring = createMote(0.82, 0.9, 1);
      ring.ring = 1;
      ring.size = 1.5;
      root.add(ring.object);
      const trail: Mote[] = [];
      for (let j = 0; j < 3; j++) {
        const mote = createMote(0.82, 0.9, 1);
        mote.size = 0.22;
        root.add(mote.object);
        trail.push(mote);
      }

      world = { root, fields, membrane, membraneHolder, filaments, volume, particles, ring, trail };
      ctx.stage.scene.add(root);
      for (let i = 0; i < 3; i++) ctx.interaction.add(fields[i].interactive);

      // The three wave sources start where the bodies are; their level rises with the reveal.
      for (let i = 0; i < 3; i++) {
        const wave = bridge.waves[FIELD_SLOTS[i]];
        wave.position.copy(fields[i].body.holder.position);
        wave.freq = fieldFreq(harmony, i);
        wave.level = 0;
      }
      evaluateBalance(poses, state);

      ctx.audio.setDrone(0.3, 0.3);
      ctx.audio.setStability(0);
      ctx.audio.setFields(liveFields);
      bridge.stability = 0;

      aspect = 0;
      frame(ctx);
      aim(ctx, 3.5);
      ctx.rig.drift = 0.6;
    },

    update(dt: number, ctx: ChapterContext) {
      const w = world;
      if (!w || phase === 'exited') return;
      const { bridge, audio, harmony } = ctx;
      t += dt;
      phaseT += dt;
      frame(ctx);

      // ── poses: where the visitor (or the chapter) has put the three bodies ──
      for (let i = 0; i < 3; i++) {
        const f = w.fields[i];
        f.rotation = damp(f.rotation, f.rotationTarget, 7, dt);
        const p = f.body.holder.position;
        poses[i].x = p.x;
        poses[i].y = p.y;
        poses[i].z = p.z;
        poses[i].rotation = f.rotation;
      }

      // ── puzzle ──
      if (phase === 'play' || phase === 'auto') {
        evaluateBalance(poses, state);
        held = stepHold(held, state.balance, dt);
        if (phase === 'play') {
          // Solved after the hold — but let go of the visitor's hand first (within reason).
          if (isSolved(held) && (ctx.interaction.dragging === null || held >= TUNING.holdSeconds + 2.5)) beginSignature(ctx, w);
        } else if (phaseT >= AUTO_SECONDS && (isSolved(held) || phaseT >= AUTO_SECONDS + 3)) {
          beginSignature(ctx, w);
        }
      }

      // ── motion owned by the chapter ──
      if (phase === 'auto') {
        glide(w, ease(clamp(phaseT / AUTO_SECONDS)), 0.18);
      } else if (phase === 'merge') {
        glide(w, ease(clamp(phaseT / MERGE_SECONDS)), 0.3);
        if (phaseT >= MERGE_SECONDS) {
          phase = 'hold';
          phaseT = 0;
        }
      } else if (phase === 'hold') {
        if (phaseT >= STILL_SECONDS) {
          phase = 'done';
          complete = true;
        }
      } else if (phase === 'exit') {
        glide(w, ease(clamp(phaseT / EXIT_SECONDS)), 0);
      }

      const live = phase === 'play' || phase === 'auto';
      const exiting = phase === 'exit';
      const signature = !live;
      if (signature) sigT += dt;
      const mergeK = phase === 'merge' ? ease(clamp(phaseT / MERGE_SECONDS)) : signature ? 1 : 0;
      sigK = damp(sigK, signature ? 1 : 0, 0.9, dt);
      still = damp(still, phase === 'merge' ? 0.6 * mergeK : signature ? 1 : 0, 1.5, dt);
      shown = damp(shown, live ? state.balance : 1, live ? 3 : 1.2, dt);
      // Reduced motion: the idle bob and wobble all but stop; directed transitions are unchanged.
      const moving = (1 - still) * (ctx.quality.reducedMotion ? 0.3 : 1);
      const rate = exiting ? EXIT_RATE : 3;
      const exitK = exiting ? ease(clamp(phaseT / EXIT_SECONDS)) : 0;
      const intro = smoothstep(0.2, 3.4, t);

      // Slow harmonic breathing of the merged sculpture (period = root ÷ 2⁹, and a fifth below it).
      const breath = Math.sin((TAU * sigT) / breathPeriod) * sigK * (1 - exitK);
      const breath2 = Math.sin((TAU * sigT) / (breathPeriod * 1.5)) * sigK * (1 - exitK);

      // ── guidance (assist 2): a ghost ring on the open region, a trail toward it, a lean ──
      const guiding = assistLevel >= 2 && phase === 'play' && state.balance < TUNING.solved - 0.02;
      guideAmount = damp(guideAmount, guiding ? 1 : 0, 2, dt);
      if (guiding) {
        guideTimer -= dt;
        if (guideTimer <= 0) {
          guideTimer = 0.6;
          const most = state.mostMasked;
          if (guideIndex < 0 || (most !== guideIndex && (state.perField[most] > state.perField[guideIndex] + 0.15 || state.perField[guideIndex] < 0.1))) {
            guideIndex = most;
          }
          openRegion(guideIndex, poses, ghostTarget, xLimit);
          if (!ghostPlaced) {
            ghostPlaced = true;
            ghostAt.copy(ghostTarget);
          }
        }
      }
      if (ghostPlaced) {
        const k = 1 - Math.exp(-3 * dt);
        ghostAt.x += (ghostTarget.x - ghostAt.x) * k;
        ghostAt.y += (ghostTarget.y - ghostAt.y) * k;
        ghostAt.z += (ghostTarget.z - ghostAt.z) * k;
      }
      w.ring.position.copy(ghostAt);
      w.ring.brightness = ghostPlaced ? guideAmount * (0.2 + 0.06 * Math.sin(t * 1.3)) : 0;
      w.ring.sync();
      for (let j = 0; j < w.trail.length; j++) {
        const mote = w.trail[j];
        if (ghostPlaced && guideIndex >= 0 && guideAmount > 0.01) {
          const u = (t * 0.16 + j / w.trail.length) % 1;
          mote.position.lerpVectors(w.fields[guideIndex].body.holder.position, ghostAt, 0.15 + 0.75 * u);
          mote.brightness = guideAmount * 0.35 * Math.sin(Math.PI * u);
        } else {
          mote.brightness = 0;
        }
        mote.sync();
      }

      // ── the three bodies ──
      for (let i = 0; i < 3; i++) {
        const f = w.fields[i];
        const body = f.body;
        const style = body.style;
        const p = body.matter.params;
        const mix = live ? state.mixes[i] : frozen[i];
        const masked = live ? clamp(state.perField[i]) : 0;
        const band = live ? levelBand(mix.level) : 1;
        const arrive = smoothstep(0.2 + i * 0.5, 2.6 + i * 0.5, t);

        let revealT = arrive * lerp(0.45, 0.95, band);
        let coherenceT = lerp(1, 0.2, masked);
        let spreadT = fieldSpread(mix) + 0.12 * breath2;
        let tensionT = style.tension * lerp(0.55, 1, 1 - masked);
        if (exiting) {
          revealT = HANDOFF.field.reveal;
          coherenceT = HANDOFF.field.coherence;
          spreadT = HANDOFF.field.spread;
          tensionT = style.tension * HANDOFF.field.tension;
        }
        p.reveal = damp(p.reveal, revealT, rate, dt);
        p.coherence = damp(p.coherence, coherenceT, rate, dt);
        p.spread = damp(p.spread, spreadT, rate, dt);
        p.tension = damp(p.tension, tensionT, rate, dt);
        p.warmth = damp(p.warmth, fieldWarmth(style, mix), 3, dt);
        p.hover = damp(p.hover, f.hoverTarget, 6, dt);
        p.excite = damp(p.excite, masked * 0.1, 2.2, dt);
        p.freq = fieldFreq(harmony, i);

        const holder = body.holder;
        holder.rotation.y = f.rotation;
        const scale = damp(holder.scale.x, fieldScale(mix.level), 3, dt);
        holder.scale.setScalar(scale);

        // Lean toward the open region (assist 2), unless the visitor is holding this body.
        let lx = 0;
        let ly = 0;
        let lz = 0;
        if (i === guideIndex && ghostPlaced && guideAmount > 0.01 && ctx.interaction.dragging !== f.interactive) {
          const dx = ghostAt.x - holder.position.x;
          const dy = ghostAt.y - holder.position.y;
          const dz = ghostAt.z - holder.position.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d > 0.05) {
            const amount = (Math.min(d, 1) * 0.22 * guideAmount * (0.75 + 0.25 * Math.sin(t * 1.1))) / d;
            lx = dx * amount;
            ly = dy * amount;
            lz = dz * amount;
          }
        }
        const lk = 1 - Math.exp(-2.5 * dt);
        f.lean.x += (lx - f.lean.x) * lk;
        f.lean.y += (ly - f.lean.y) * lk;
        f.lean.z += (lz - f.lean.z) * lk;
        // World-space lean → the holder's rotated, scaled local space.
        const c = Math.cos(f.rotation);
        const s = Math.sin(f.rotation);
        const bob = Math.sin(t * (0.37 + i * 0.11) + i * 2.1) * 0.035 * moving;
        body.tilt.position.set((f.lean.x * c - f.lean.z * s) / scale, (f.lean.y + bob) / scale, (f.lean.x * s + f.lean.z * c) / scale);
        body.tilt.rotation.set(style.tiltX, style.tiltY, style.tiltZ + mix.modulation * 0.14 * Math.sin(t * style.wobble * TAU * 0.25 + i) * moving);
        body.matter.sync();

        const wave = bridge.waves[FIELD_SLOTS[i]];
        wave.position.copy(holder.position);
        wave.freq = fieldFreq(harmony, i);
        wave.level = fieldWaveLevel(mix.level) * arrive * (1 + 0.08 * breath);
      }

      // ── the root joins at the centre once the three are one ──
      if (signature) {
        const rootWave = bridge.waves[ROOT_SLOT];
        rootWave.position.set(0, 0, 0);
        rootWave.freq = harmony.freq(0, 0);
        rootWave.level = HANDOFF.rootLevel * mergeK;
      }

      // ── membrane: tension and coherence ARE the balance ──
      {
        const p = w.membrane.params;
        let revealT = 0.85 * intro + 0.05 * sigK;
        let tensionT = lerp(0.1, 0.92, shown);
        let coherenceT = lerp(0.08, 1, shown);
        let spreadT = lerp(0.7, 0.4, shown) + 0.15 * sigK + 0.04 * breath2;
        let warmthT = lerp(-0.25, 0.12, shown);
        let scaleT = 1 + 0.06 * sigK;
        if (exiting) {
          revealT = HANDOFF.membrane.reveal;
          tensionT = HANDOFF.membrane.tension;
          coherenceT = HANDOFF.membrane.coherence;
          spreadT = HANDOFF.membrane.spread;
          warmthT = HANDOFF.membrane.warmth;
          scaleT = HANDOFF.membrane.scale;
        }
        p.reveal = damp(p.reveal, revealT, rate, dt);
        p.tension = damp(p.tension, tensionT, rate, dt);
        p.coherence = damp(p.coherence, coherenceT, rate, dt);
        p.spread = damp(p.spread, spreadT, rate, dt);
        p.warmth = damp(p.warmth, warmthT, rate, dt);
        p.excite = damp(p.excite, live ? (1 - shown) * 0.3 : 0, 3, dt);
        p.hover = 0;
        p.freq = 0;
        w.membraneHolder.scale.setScalar(damp(w.membraneHolder.scale.x, scaleT, exiting ? EXIT_RATE : 1.2, dt));
        w.membrane.sync();
      }

      // ── filaments: only between pairs that are clear of each other ──
      for (let k = 0; k < w.filaments.length; k++) {
        const filament = w.filaments[k];
        const a = PAIRS[k][0];
        const b = PAIRS[k][1];
        let clear = 1;
        if (live) clear = smoothstep(0.6, 0.92, 1 - state.pairs[k]) * Math.min(levelBand(state.mixes[a].level), levelBand(state.mixes[b].level));
        if (exiting) clear = 0;
        const fp = filament.params;
        fp.reveal = damp(fp.reveal, clear * intro * 0.9, exiting ? EXIT_RATE : 2.5, dt);
        fp.energy = 0.25 + 0.5 * shown + 0.08 * breath;
        fp.tension = lerp(0.35, 0.9, shown);
        fp.warmth = PAIR_WARMTH[k];
        if (fp.reveal > 0.002) filament.setEndpoints(w.fields[a].body.holder.position, w.fields[b].body.holder.position);
        filament.sync();
      }

      // ── volume: the breathing interior of the merged sculpture ──
      {
        const v = w.volume.params;
        let revealT = 0.8 * mergeK;
        let densityT = 0.5 + 0.1 * breath;
        let structureT = lerp(0.3, 0.85, mergeK) + 0.05 * breath2;
        let scaleT = 1 + 0.04 * breath;
        if (exiting) {
          revealT = HANDOFF.volume.reveal;
          densityT = HANDOFF.volume.density;
          structureT = HANDOFF.volume.structure;
          scaleT = HANDOFF.volume.scale;
        }
        const vr = exiting ? EXIT_RATE : 2;
        v.reveal = damp(v.reveal, revealT, vr, dt);
        v.density = damp(v.density, densityT, vr, dt);
        v.structure = damp(v.structure, structureT, vr, dt);
        v.scale = damp(v.scale, scaleT, vr, dt);
        w.volume.sync();
      }

      // ── dust: turbulent while masked, almost at rest in balance ──
      {
        const pp = w.particles.params;
        pp.reveal = damp(pp.reveal, exiting ? HANDOFF.particles.reveal : 0.28 * intro, rate, dt);
        pp.drift = damp(pp.drift, exiting ? HANDOFF.particles.drift : lerp(1, 0.35, shown) * (0.15 + 0.85 * moving), rate, dt);
        w.particles.sync();
      }

      // ── bridge, sound, camera ──
      bridge.stability = shown;
      if (signature) {
        // Selective spectral colour: let in for the merged sculpture, held through the hand-off.
        const want = lerp(spectralFrom, Math.max(spectralFrom, 0.7), ease(clamp(sigT / 4.5)));
        bridge.spectral = Math.max(bridge.spectral, want);
      }
      audio.setFields(live ? liveFields : frozenFields);
      audio.setStability(shown);
      ctx.rig.drift = lerp(0.6, 0.06, still);

      // ── hand-off ──
      if (exiting && phaseT >= EXIT_SECONDS) {
        for (let i = 0; i < 3; i++) {
          const f = w.fields[i];
          const body = f.body;
          const p = body.matter.params;
          body.holder.position.copy(to[i]);
          body.holder.scale.setScalar(fieldScale(frozen[i].level));
          body.tilt.position.set(0, 0, 0);
          body.tilt.rotation.set(body.style.tiltX, body.style.tiltY, body.style.tiltZ);
          p.reveal = HANDOFF.field.reveal;
          p.coherence = HANDOFF.field.coherence;
          p.spread = HANDOFF.field.spread;
          p.tension = body.style.tension * HANDOFF.field.tension;
          p.warmth = fieldWarmth(body.style, frozen[i]);
          p.hover = 0;
          p.excite = 0;
          body.matter.sync();
          HANDOFF.positions[i].copy(to[i]);
          HANDOFF.rotations[i] = f.rotation;
        }
        HANDOFF.harmonySeed = harmony.seed;
        HANDOFF.valid = true;
        phase = 'exited';
        exited = true;
      }
    },

    assist(level: 1 | 2 | 3, ctx: ChapterContext) {
      const w = world;
      if (!w || phase !== 'play') return;
      assistLevel = Math.max(assistLevel, level);
      if (level === 1) {
        if (state.balance < TUNING.solved) ctx.ui.hint(HINT);
      } else if (level === 2) {
        guideTimer = 0;
      } else if (!isSolved(held)) {
        beginAuto(ctx, w);
      }
    },

    exit(ctx: ChapterContext) {
      const w = world;
      if (!w || phase === 'exit' || phase === 'exited') {
        if (!w) exited = true;
        return;
      }
      // Leaving unsolved (the Director's long stop): what stands now is what is remembered.
      record(ctx);
      release(ctx, w);
      ctx.ui.hint(null);
      glideFrom(w);
      for (let i = 0; i < 3; i++) to[i].copy(from[i]).multiplyScalar(WIDEN);
      const rootWave = ctx.bridge.waves[ROOT_SLOT];
      rootWave.position.set(0, 0, 0);
      rootWave.freq = ctx.harmony.freq(0, 0);
      phase = 'exit';
      phaseT = 0;
    },

    dispose(ctx: ChapterContext) {
      const w = world;
      world = null;
      if (!w) return;
      for (let i = 0; i < w.fields.length; i++) {
        const f = w.fields[i];
        ctx.interaction.remove(f.interactive);
        f.body.matter.dispose();
      }
      for (let k = 0; k < w.filaments.length; k++) w.filaments[k].dispose();
      w.membrane.dispose();
      w.volume.dispose();
      w.particles.dispose();
      w.ring.dispose();
      for (let j = 0; j < w.trail.length; j++) w.trail[j].dispose();
      w.root.removeFromParent();
      w.root.clear();
      for (let i = 0; i < 3; i++) {
        const wave = ctx.bridge.waves[FIELD_SLOTS[i]];
        wave.freq = 0;
        wave.level = 0;
      }
      const rootWave = ctx.bridge.waves[ROOT_SLOT];
      rootWave.freq = 0;
      rootWave.level = 0;
      ctx.audio.setFields(SILENT_FIELDS);
      ctx.ui.hint(null);
    },
  };

  return chapter;
}
