/**
 * Chapter V — THE IMPERCEPTIBLE.  "You have been composing all along."
 *
 * Nothing here is new: the world is rebuilt from what the visitor did.
 *
 *   chapter I    the three woken degrees        → three luminous points, slowly orbiting
 *   chapter II   the ratio they settled on      → the spacing of the stacked membranes
 *                (and the time it took          → how far the stack twists as it opens)
 *   chapter III  the constellation              → three crystal nodes joined by filaments
 *   chapter IV   the balance                    → the mix, scale and place of earth / air / light
 *   every gesture                               → the pulse the instrument answers in
 *
 *   play      0 – 24 s   the whole world is one instrument: pointer position chooses the pitch,
 *                        pointer speed the force; at most one note per pulse (≥ 350 ms)
 *   unfold   24 – 39 s   the membranes open through the volume, all eight wave sources sound
 *                        together in tune, full iridescence, the camera pulls back and holds
 *   dissolve 39 – 54 s   highs first: sources release from the top, coherence goes, then matter
 *   point    54 s →      one point of light. Touch it (or wait 20 s) and it goes out.
 *
 * Wave slots: 0 earth · 1 air · 2 light (as in chapter IV, so the hand-off is seamless) ·
 * 3–5 the three points · 6 follows the pointer · 7 the root at the centre.
 *
 * The chapter starts from the exact state chapter IV's exit leaves behind (HANDOFF), so there is
 * no cut between them. Entered on its own it simply fades up from black.
 */
import { Group, Vector3 } from 'three';
import { MAX_WAVES } from '../core/contracts';
import type {
  CameraPose,
  Chapter,
  ChapterContext,
  FieldMix,
  Filament,
  Interactive,
  Matter,
  Particles,
  StrikeTimbre,
  Vec3Like,
  VolumeField,
} from '../core/contracts';
import { clamp, damp, ease, lerp, smoothstep, TAU } from '../core/math';
import { createFilament, createMatter, createParticles, createVolumeField } from '../render/materials';
import { composeArrangement, createMix, createPose, poseFromMix, type FieldPose } from '../puzzles/balance';
import {
  FIELD_SLOTS,
  HANDOFF,
  MEMBRANE_TILT,
  ROOT_SLOT,
  SILENT_FIELDS,
  buildField,
  buildMembrane,
  createMote,
  fieldFreq,
  fieldScale,
  fieldSpread,
  fieldWarmth,
  fieldWaveLevel,
  frameDistance,
  type FieldBody,
  type Mote,
} from './Chapter4';

const T_PLAY = 24;
const T_UNFOLD = 15;
const T_DISSOLVE = 15;
const T_UNFOLD_AT = T_PLAY;
const T_DISSOLVE_AT = T_PLAY + T_UNFOLD;
const T_POINT_AT = T_PLAY + T_UNFOLD + T_DISSOLVE;
const POINT_WAIT = 20;
const OUT_TOUCHED = 3.2;
const OUT_ALONE = 3;
const FORCED_EXIT = 1.5;

const POINT_SLOTS: readonly number[] = [3, 4, 5];
const POINTER_SLOT = 6;
const WIDEN = 1.45;
const STACK_OPEN = 1.7;
const MIN_PULSE = 0.35;
const LAST_LINE = 'Some things become visible only when we listen.';
const DEFAULT_DEGREES = [0, 4, 2];
const DEFAULT_SITES: readonly Vec3Like[] = [
  { x: -1.2, y: -0.5, z: 0 },
  { x: 1.2, y: -0.5, z: 0.2 },
  { x: 0, y: 1.1, z: -0.3 },
];
const POINT_TINTS = [
  [1, 0.965, 0.9],
  [0.86, 0.93, 1],
  [1, 0.9, 0.76],
] as const;

type Phase = 'play' | 'unfold' | 'dissolve' | 'point' | 'out' | 'done' | 'exit' | 'exited';

interface Sheet {
  readonly matter: Matter;
  readonly holder: Group;
  /** Place in the stack: 0 is the membrane inherited from chapter IV. */
  readonly j: number;
  readonly zOpen: number;
  readonly delay: number;
}

interface Layer {
  readonly body: FieldBody;
  readonly mix: FieldMix;
  readonly home: Vector3;
  readonly lean: Vector3;
  rotation: number;
  near: number;
}

interface Crystal {
  readonly matter: Matter;
  readonly holder: Group;
  readonly home: Vector3;
  near: number;
}

interface Point {
  readonly mote: Mote;
  angle: number;
  readonly radius: number;
  readonly depth: number;
  readonly freq: number;
  excite: number;
  near: number;
}

interface World {
  readonly root: Group;
  readonly stack: Group;
  readonly sheets: Sheet[];
  readonly layers: Layer[];
  readonly crystals: Crystal[];
  readonly edges: Filament[];
  readonly points: Point[];
  readonly volume: VolumeField;
  readonly particles: Particles;
  readonly last: Mote;
  readonly lastInteractive: Interactive;
}

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** The visitor's own tempo: the median gap between their gestures, folded into 0.35–0.7 s. */
function pulseFrom(gestures: readonly number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < gestures.length; i++) {
    const g = gestures[i] - gestures[i - 1];
    if (g > 0.15 && g < 4) gaps.push(g);
  }
  if (gaps.length < 3) return 0.45;
  gaps.sort((a, b) => a - b);
  let m = gaps[gaps.length >> 1];
  while (m > MIN_PULSE * 2) m *= 0.5;
  while (m < MIN_PULSE) m *= 2;
  return m;
}

export function createChapter5(): Chapter {
  // Scratch owned by this instance.
  const outMixes: FieldMix[] = [createMix(), createMix(), createMix()];
  const outFields = { earth: outMixes[0], air: outMixes[1], light: outMixes[2] };
  const camPose: CameraPose = { position: { x: 0, y: 0.2, z: 8 }, target: { x: 0, y: 0, z: 0 } };
  const strikeOpts: { velocity: number; pos: Vec3Like; timbre: StrikeTimbre } = { velocity: 0.3, pos: new Vector3(), timbre: 'bell' };
  const releaseAt = new Float32Array(MAX_WAVES);
  const voiceAt = new Vector3();
  const tmp = new Vector3();

  let world: World | null = null;
  let phase: Phase = 'play';
  let t = 0;
  let pointT = 0;
  let outT = 0;
  let exitT = 0;
  let outFrom = 0;
  let touched = false;
  let complete = false;
  let exited = false;
  let handed = false;
  let pool: number[] = DEFAULT_DEGREES;
  let pulse = 0.45;
  let strikeClock = 0;
  let lastFreq = 0;
  let finale = 0;
  let twist = 0.1;
  let dir = 1;
  let orbit0 = 0;
  let breathPeriod = 9;
  let lastHover = 0;
  let aspect = 0;
  let moveEnd = 0;
  let centralExcite = 0;

  const aim = (ctx: ChapterContext, seconds: number): void => {
    const p = camPose.position;
    const g = camPose.target;
    g.x = 0;
    g.y = 0;
    g.z = 0;
    if (phase === 'play') {
      // One long move: a slow push in and an arc to one side.
      p.x = 2.3 * dir;
      p.y = 0.75;
      p.z = frameDistance(aspect, 7.1);
      g.y = 0.08;
    } else if (phase === 'unfold') {
      p.x = -0.9 * dir;
      p.y = 0.5;
      p.z = frameDistance(aspect, 15.5);
    } else if (phase === 'dissolve') {
      p.x = -0.3 * dir;
      p.y = 0.2;
      p.z = frameDistance(aspect, 12.8);
    } else {
      p.x = 0;
      p.y = 0;
      p.z = frameDistance(aspect, 9);
    }
    moveEnd = t + seconds;
    ctx.rig.moveTo(camPose, seconds);
  };

  const frame = (ctx: ChapterContext): void => {
    const vp = ctx.stage.viewport;
    const a = vp.height > 0 ? vp.width / vp.height : ctx.rig.camera.aspect;
    if (Math.abs(a - aspect) > 0.02) {
      const first = aspect === 0;
      aspect = a;
      // Re-frame for the new shape without hurrying a long directed move that is still under way.
      if (!first && phase !== 'exit' && phase !== 'exited') aim(ctx, Math.max(2, moveEnd - t));
    }
  };

  const touch = (ctx: ChapterContext, w: World): void => {
    if (phase !== 'point') return;
    touched = true;
    w.lastInteractive.enabled = false;
    ctx.interaction.remove(w.lastInteractive);
    ctx.audio.resolve('final');
    ctx.ui.announce('A last soft resonance, then silence.');
    phase = 'out';
    outT = 0;
    outFrom = w.last.brightness;
  };

  /** One note of the instrument: pitch from where the pointer is, force from how fast it moves. */
  const play = (ctx: ChapterContext, w: World, energy: number): void => {
    const ptr = ctx.interaction.pointer;
    const at = ptr.world;

    // The nearest element answers.
    let kind = -1;
    let index = 0;
    let best = Infinity;
    for (let i = 0; i < w.layers.length; i++) {
      const d = at.distanceTo(w.layers[i].body.holder.position);
      if (d < best) {
        best = d;
        kind = 0;
        index = i;
      }
    }
    for (let i = 0; i < w.crystals.length; i++) {
      const d = at.distanceTo(w.crystals[i].holder.position);
      if (d < best) {
        best = d;
        kind = 1;
        index = i;
      }
    }
    for (let i = 0; i < w.points.length; i++) {
      const d = at.distanceTo(w.points[i].mote.position);
      if (d < best) {
        best = d;
        kind = 2;
        index = i;
      }
    }

    const n = pool.length;
    const column = Math.min(n - 1, Math.floor(clamp(0.5 + 0.5 * ptr.ndc.x) * n));
    const octave = 1 + Math.min(2, Math.floor(clamp(0.5 + 0.5 * ptr.ndc.y) * 3));
    let freq = ctx.harmony.freq(pool[column], octave);
    if (freq === lastFreq) freq = ctx.harmony.freq(pool[(column + 1) % n], octave);
    lastFreq = freq;

    let timbre: StrikeTimbre = 'bell';
    const pos = strikeOpts.pos as Vector3;
    pos.copy(at);
    if (best < 1.8) {
      if (kind === 0) {
        const layer = w.layers[index];
        layer.body.matter.params.excite = 1;
        pos.copy(layer.body.holder.position);
        const own = layer.body.style.strike;
        timbre = own === 'sub' && octave > 1 ? 'bell' : own;
      } else if (kind === 1) {
        const crystal = w.crystals[index];
        crystal.matter.params.excite = 1;
        pos.copy(crystal.holder.position);
        timbre = 'glass';
      } else {
        const point = w.points[index];
        point.excite = 1;
        pos.copy(point.mote.position);
      }
    } else if (octave === 1) {
      timbre = 'glass';
    }
    centralExcite = Math.min(1, centralExcite + 0.35);
    w.particles.impulse(pos, 0.25 + 0.5 * energy);

    strikeOpts.velocity = (0.12 + 0.45 * energy) * (phase === 'unfold' ? 0.55 : 1);
    strikeOpts.timbre = timbre;
    ctx.audio.strike(freq, strikeOpts);
  };

  const chapter: Chapter = {
    index: 4,
    numeral: 'V',
    name: 'The Imperceptible',
    line: 'You have been composing all along.',

    get progress() {
      return clamp(t / T_POINT_AT);
    },
    get complete() {
      return complete;
    },
    get exited() {
      return exited;
    },

    enter(ctx: ChapterContext) {
      if (world) chapter.dispose(ctx);
      const { harmony, quality, bridge, audio } = ctx;
      const mem = ctx.memory.data;
      const rand = () => harmony.rand();

      phase = 'play';
      t = pointT = outT = exitT = outFrom = moveEnd = 0;
      touched = complete = exited = false;
      strikeClock = 0;
      lastFreq = 0;
      lastHover = 0;
      centralExcite = 0;
      finale = 0.12;
      handed = HANDOFF.valid && HANDOFF.harmonySeed === harmony.seed;
      HANDOFF.valid = false;
      dir = rand() < 0.5 ? -1 : 1;
      orbit0 = rand() * TAU;
      breathPeriod = 512 / Math.max(harmony.root, 20);
      pulse = pulseFrom(mem.gestures);

      // ── what is remembered ──
      const scaleSize = Math.max(harmony.ratios.length, 1);
      const resonators: number[] = [];
      const nodes: number[] = [];
      for (let i = 0; i < 3; i++) {
        resonators.push(Math.round(finite(mem.resonators[i], DEFAULT_DEGREES[i])));
        nodes.push(Math.round(finite(mem.constellation.degrees[i], DEFAULT_DEGREES[i])));
      }
      const seen = new Set<number>();
      for (const d of resonators.concat(nodes)) seen.add(((d % scaleSize) + scaleSize) % scaleSize);
      for (let i = 0; seen.size < 3 && i < DEFAULT_DEGREES.length; i++) seen.add(DEFAULT_DEGREES[i] % scaleSize);
      pool = Array.from(seen).sort((a, b) => a - b);
      // Chapter II stores the interval above its anchor, which is a tenth (≈ 2.4–2.5): fold it into
      // one octave so the spacing follows what was tuned instead of pinning at the clamp.
      let tuned = finite(mem.tuning.ratio, 1.5);
      if (!(tuned > 0)) tuned = 1.5;
      while (tuned >= 2) tuned *= 0.5;
      while (tuned < 1) tuned *= 2;
      const ratio = clamp(tuned, 1.15, 2);
      twist = lerp(0.05, 0.16, clamp(finite(mem.tuning.seconds, 20) / 60)) * (rand() < 0.5 ? -1 : 1);
      const mixes = [mem.balance.earth, mem.balance.air, mem.balance.light];

      const root = new Group();
      root.name = 'chapter-5';

      // ── the stack of membranes; spacing grows by the ratio the visitor tuned in chapter II ──
      const stack = new Group();
      stack.rotation.set(MEMBRANE_TILT.x, MEMBRANE_TILT.y, MEMBRANE_TILT.z);
      stack.scale.setScalar(HANDOFF.membrane.scale);
      root.add(stack);
      const sheets: Sheet[] = [];
      const reach = quality.lite ? 1 : 2;
      for (let j = -reach; j <= reach; j++) {
        const holder = new Group();
        let matter: Matter;
        if (j === 0) {
          matter = buildMembrane(handed ? HANDOFF.membraneSeed : rand(), quality);
          const p = matter.params;
          p.reveal = handed ? HANDOFF.membrane.reveal : 0;
          p.tension = HANDOFF.membrane.tension;
          p.coherence = HANDOFF.membrane.coherence;
          p.spread = HANDOFF.membrane.spread;
          p.warmth = HANDOFF.membrane.warmth;
        } else {
          matter = createMatter(
            'membrane',
            {
              shape: 'plane',
              width: 5.2,
              height: 3.4,
              layers: 3,
              detail: 0.7,
              init: { reveal: 0, excite: 0, hover: 0, tension: 0.45, coherence: 1, freq: 0, seed: rand(), warmth: clamp(j * 0.28, -1, 1), spread: 0.25 },
            },
            quality,
          );
          holder.rotation.x = j * 0.5;
          holder.scale.setScalar(0.6);
        }
        const steps = Math.abs(j);
        const zOpen = Math.sign(j) * 0.5 * ((Math.pow(ratio, steps) - 1) / (ratio - 1));
        matter.sync();
        holder.add(matter.object);
        stack.add(holder);
        sheets.push({ matter, holder, j, zOpen, delay: steps * 0.7 + (j > 0 ? 0.25 : 0) });
      }

      // ── earth / air / light, where chapter IV left them (or where their mix says they were) ──
      const places: FieldPose[] = [createPose(), createPose(), createPose()];
      if (handed) {
        for (let i = 0; i < 3; i++) {
          places[i].x = HANDOFF.positions[i].x;
          places[i].y = HANDOFF.positions[i].y;
          places[i].z = HANDOFF.positions[i].z;
          places[i].rotation = HANDOFF.rotations[i];
        }
      } else {
        const airSide = rand() < 0.5 ? -1 : 1;
        for (let i = 0; i < 3; i++) poseFromMix(mixes[i], i === 0 ? -dir : i === 2 ? dir : airSide, places[i]);
        composeArrangement(places, places);
        for (let i = 0; i < 3; i++) {
          places[i].x *= WIDEN;
          places[i].y *= WIDEN;
          places[i].z *= WIDEN;
        }
      }
      const layers: Layer[] = [];
      for (let i = 0; i < 3; i++) {
        const mix: FieldMix = {
          level: clamp(finite(mixes[i].level, 0.5), 0.2, 0.95),
          brightness: clamp(finite(mixes[i].brightness, 0.5)),
          diffusion: clamp(finite(mixes[i].diffusion, 0.5)),
          modulation: clamp(finite(mixes[i].modulation, 0.3)),
        };
        const body = buildField(i, handed ? HANDOFF.seeds[i] : rand(), quality);
        const p = body.matter.params;
        p.reveal = handed ? HANDOFF.field.reveal : 0;
        p.coherence = HANDOFF.field.coherence;
        p.spread = HANDOFF.field.spread;
        p.tension = body.style.tension * HANDOFF.field.tension;
        p.warmth = fieldWarmth(body.style, mix);
        p.freq = fieldFreq(harmony, i);
        body.holder.position.set(places[i].x, places[i].y, places[i].z);
        body.holder.rotation.y = places[i].rotation;
        body.holder.scale.setScalar(fieldScale(mix.level));
        body.matter.sync();
        root.add(body.holder);
        layers.push({ body, mix, home: new Vector3(places[i].x, places[i].y, places[i].z), lean: new Vector3(), rotation: places[i].rotation, near: 0 });
      }

      // ── the constellation: three crystal nodes, in the shape the visitor assembled ──
      const sites: Vec3Like[] = [];
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let i = 0; i < 3; i++) {
        const src = mem.constellation.positions[i];
        const fallback = DEFAULT_SITES[i];
        const site = { x: finite(src?.x, fallback.x), y: finite(src?.y, fallback.y), z: finite(src?.z, fallback.z) };
        sites.push(site);
        cx += site.x / 3;
        cy += site.y / 3;
        cz += site.z / 3;
      }
      let extent = 0;
      for (const s of sites) extent = Math.max(extent, Math.hypot(s.x - cx, s.y - cy, s.z - cz));
      const fit = 1.35 / Math.max(extent, 0.35);
      const crystals: Crystal[] = [];
      for (let i = 0; i < 3; i++) {
        const matter = createMatter(
          'crystal',
          {
            shape: 'ico',
            radius: 0.2,
            detail: 0.3,
            init: { reveal: 0, excite: 0, hover: 0, tension: 0.9, coherence: 1, freq: harmony.freq(nodes[i], 3), seed: rand(), warmth: 0.3, spread: 0.3 },
          },
          quality,
        );
        const holder = new Group();
        const home = new Vector3((sites[i].x - cx) * fit, (sites[i].y - cy) * fit + 0.05, (sites[i].z - cz) * fit + 0.45);
        holder.position.copy(home);
        holder.rotation.set(rand() * TAU, rand() * TAU, 0);
        holder.add(matter.object);
        matter.sync();
        root.add(holder);
        crystals.push({ matter, holder, home, near: 0 });
      }
      const edges: Filament[] = [];
      for (let k = 0; k < 3; k++) {
        const filament = createFilament(quality);
        filament.params.reveal = 0;
        filament.params.energy = 0.3;
        filament.params.tension = 0.85;
        filament.params.warmth = 0.3;
        filament.setEndpoints(crystals[k].home, crystals[(k + 1) % 3].home);
        filament.sync();
        root.add(filament.object);
        edges.push(filament);
      }

      // ── the three resonators woken in chapter I: three luminous points on a slow orbit ──
      const points: Point[] = [];
      const phase0 = rand() * TAU;
      for (let i = 0; i < 3; i++) {
        const tint = POINT_TINTS[i];
        const mote = createMote(tint[0], tint[1], tint[2]);
        mote.size = 0.42;
        const degree = ((resonators[i] % scaleSize) + scaleSize) % scaleSize;
        const point: Point = {
          mote,
          angle: (TAU * degree) / scaleSize + i * 0.4 + phase0,
          radius: 2.15 + 0.3 * i,
          depth: (rand() - 0.5) * 1.6,
          freq: harmony.freq(resonators[i], 2),
          excite: 0,
          near: 0,
        };
        mote.position.set(Math.cos(point.angle) * point.radius, Math.sin(point.angle) * point.radius * 0.55, point.depth);
        root.add(mote.object);
        points.push(point);
      }

      const volume = createVolumeField(quality);
      volume.params.reveal = handed ? HANDOFF.volume.reveal : 0;
      volume.params.density = HANDOFF.volume.density;
      volume.params.structure = HANDOFF.volume.structure;
      volume.params.scale = HANDOFF.volume.scale;
      volume.sync();
      root.add(volume.object);

      const particles = createParticles(quality.lite ? 600 : 1800, quality);
      particles.params.reveal = handed ? HANDOFF.particles.reveal : 0;
      particles.params.drift = HANDOFF.particles.drift;
      particles.sync();
      root.add(particles.object);

      // ── the last point: drawn by its own shader, so silence cannot take it ──
      const last = createMote(1, 0.97, 0.92);
      last.size = 0.5;
      last.object.renderOrder = 80;
      root.add(last.object);
      const lastInteractive: Interactive = {
        label: 'The last point of light. Touch it, or press Enter.',
        object: last.object,
        radius: 0.95,
        enabled: false,
        draggable: false,
        onHover(hovering: boolean) {
          lastHover = hovering ? 1 : 0;
        },
        onPress() {
          if (world) touch(ctx, world);
        },
      };

      world = { root, stack, sheets, layers, crystals, edges, points, volume, particles, last, lastInteractive };
      ctx.stage.scene.add(root);

      // ── wave sources, set at once so nothing lapses between the chapters ──
      for (let i = 0; i < 3; i++) {
        const field = bridge.waves[FIELD_SLOTS[i]];
        field.position.copy(layers[i].home);
        field.freq = fieldFreq(harmony, i);
        field.level = fieldWaveLevel(layers[i].mix.level);
        const pt = bridge.waves[POINT_SLOTS[i]];
        pt.position.copy(points[i].mote.position);
        pt.freq = points[i].freq;
        pt.level = 0;
      }
      voiceAt.set(0, 0, 0.5);
      const voice = bridge.waves[POINTER_SLOT];
      voice.position.copy(voiceAt);
      voice.freq = harmony.freq(nodes[0], 3);
      voice.level = 0;
      const rootWave = bridge.waves[ROOT_SLOT];
      rootWave.position.set(0, 0, 0);
      rootWave.freq = harmony.freq(0, 0);
      rootWave.level = handed ? HANDOFF.rootLevel : 0;
      // Dissolution order: the highest pitch lets go first, the root last.
      const order: number[] = [];
      for (let s = 0; s < MAX_WAVES; s++) order.push(s);
      order.sort((a, b) => bridge.waves[b].freq - bridge.waves[a].freq);
      for (let rank = 0; rank < order.length; rank++) releaseAt[order[rank]] = 1.5 + rank * 1.25;

      // ── sound ──
      audio.setMemory(mem);
      audio.setFinale(finale);
      audio.setDrone(0.36, 0.45);
      audio.setStability(0.88);
      for (let i = 0; i < 3; i++) {
        outMixes[i].level = layers[i].mix.level;
        outMixes[i].brightness = layers[i].mix.brightness;
        outMixes[i].diffusion = layers[i].mix.diffusion;
        outMixes[i].modulation = layers[i].mix.modulation;
      }
      audio.setFields(outFields);

      aspect = 0;
      frame(ctx);
      aim(ctx, T_PLAY);
      ctx.rig.drift = 1;
    },

    update(dt: number, ctx: ChapterContext) {
      const w = world;
      if (!w || phase === 'exited') return;
      const { bridge, audio } = ctx;
      const ptr = ctx.interaction.pointer;
      t += dt;
      frame(ctx);

      // ── the score ──
      if (phase === 'play' && t >= T_UNFOLD_AT) {
        phase = 'unfold';
        aim(ctx, 10);
      } else if (phase === 'unfold' && t >= T_DISSOLVE_AT) {
        phase = 'dissolve';
        audio.dissolve(14);
        ctx.ui.caption('');
        aim(ctx, T_DISSOLVE);
      } else if (phase === 'dissolve' && t >= T_POINT_AT) {
        phase = 'point';
        pointT = 0;
        audio.setFields(SILENT_FIELDS);
        ctx.ui.caption(LAST_LINE);
        w.lastInteractive.enabled = true;
        ctx.interaction.add(w.lastInteractive);
        aim(ctx, 9);
      } else if (phase === 'point') {
        pointT += dt;
        if (pointT >= POINT_WAIT) {
          // Untouched: it goes out by itself.
          w.lastInteractive.enabled = false;
          ctx.interaction.remove(w.lastInteractive);
          phase = 'out';
          outT = 0;
          outFrom = w.last.brightness;
        }
      } else if (phase === 'out') {
        outT += dt;
        if (outT >= (touched ? OUT_TOUCHED : OUT_ALONE)) {
          phase = 'done';
          complete = true;
          audio.setDrone(0);
        }
      } else if (phase === 'exit') {
        exitT += dt;
        if (exitT >= FORCED_EXIT) {
          phase = 'exited';
          exited = true;
        }
      }

      const tB = Math.max(0, t - T_UNFOLD_AT);
      const tC = Math.max(0, t - T_DISSOLVE_AT);
      const playing = phase === 'play' || phase === 'unfold';
      const dissolving = !playing;
      const arrive = smoothstep(0, 5, t);
      const unfold = ease(clamp(tB / 8));
      const cK = dissolving && phase !== 'exit' ? clamp(tC / T_DISSOLVE) : 0;
      const forced = phase === 'exit' || phase === 'exited' ? 1 - ease(clamp(exitT / FORCED_EXIT)) : 1;
      const keepCoherence = 1 - smoothstep(0.12, 0.6, cK);
      const keepReveal = (1 - smoothstep(0.5, 0.94, cK)) * forced;
      const energy = playing && ptr.seen ? ptr.energy : 0;
      const breath = Math.sin((TAU * t) / breathPeriod) * arrive;
      // Reduced motion: idle bob, wobble and orbits slow to almost nothing.
      const calm = ctx.quality.reducedMotion ? 0.3 : 1;
      const life = arrive * calm;
      const rate = 2.5;

      // ── the instrument ──
      strikeClock += dt;
      if (playing && ptr.seen && t > 1.2 && energy > 0.1) {
        const interval = Math.max(MIN_PULSE, pulse * (energy > 0.6 ? 1 : energy > 0.3 ? 2 : 3));
        if (strikeClock >= interval) {
          strikeClock = 0;
          play(ctx, w, energy);
        }
      }
      centralExcite = damp(centralExcite, 0, 1.8, dt);

      // The great fabric must stay crisp: as it unfolds, bloom is withdrawn so sheets keep their
      // darkness and their edges (bloom at full reveal turned the peak into haze).
      ctx.stage.grade.bloom = lerp(0.5, 0.1, unfold);

      // ── membranes ──
      const H = HANDOFF;
      w.stack.scale.setScalar(lerp(H.membrane.scale, STACK_OPEN, unfold) * (1 + 0.08 * cK));
      w.stack.rotation.y = MEMBRANE_TILT.y + 0.04 * Math.sin(t * 0.07) * life;
      for (let i = 0; i < w.sheets.length; i++) {
        const sheet = w.sheets[i];
        const p = sheet.matter.params;
        if (sheet.j === 0) {
          p.reveal = damp(p.reveal, lerp(lerp(H.membrane.reveal, 0.6, arrive), 0.9, unfold) * keepReveal, rate, dt);
          p.tension = damp(p.tension, lerp(lerp(H.membrane.tension, 0.5, arrive), 0.92, unfold), rate, dt);
          p.coherence = damp(p.coherence, lerp(H.membrane.coherence, 1, Math.max(arrive * 0.5, unfold)) * keepCoherence, rate, dt);
          p.warmth = damp(p.warmth, lerp(H.membrane.warmth, 0, unfold), rate, dt);
          p.spread = H.membrane.spread;
          p.excite = centralExcite * 0.5 + energy * 0.2;
        } else {
          const steps = Math.abs(sheet.j);
          const k = ease(clamp((tB - sheet.delay) / 6.5));
          p.reveal = damp(p.reveal, (0.82 - 0.07 * steps) * k * keepReveal, rate, dt);
          p.tension = damp(p.tension, lerp(0.45, 0.92, k), rate, dt);
          p.coherence = damp(p.coherence, keepCoherence, rate, dt);
          p.spread = damp(p.spread, lerp(0.25, 1, k), rate, dt);
          p.excite = centralExcite * 0.25 * k;
          // Unfolding: from a closed fan about the shared axis to a parallel, slightly twisted stack.
          sheet.holder.rotation.x = sheet.j * 0.5 * (1 - k);
          sheet.holder.rotation.z = sheet.j * twist * k;
          sheet.holder.position.z = sheet.zOpen * k * (1 + 0.5 * cK);
          sheet.holder.scale.setScalar(lerp(0.6, 1 + 0.12 * steps, k));
        }
        sheet.matter.sync();
      }

      // ── earth / air / light ──
      for (let i = 0; i < w.layers.length; i++) {
        const layer = w.layers[i];
        const body = layer.body;
        const style = body.style;
        const holder = body.holder;
        const p = body.matter.params;
        const mix = layer.mix;
        const spreadOut = 1 + 0.12 * unfold + 0.25 * cK;
        holder.position.copy(layer.home).multiplyScalar(spreadOut);
        const dx = ptr.world.x - holder.position.x;
        const dy = ptr.world.y - holder.position.y;
        const dz = ptr.world.z - holder.position.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        layer.near = damp(layer.near, playing && ptr.seen ? 1 - smoothstep(0.4, 1.9, d) : 0, 4, dt);

        p.reveal = damp(p.reveal, lerp(lerp(H.field.reveal, 0.72, arrive), 0.88, unfold) * keepReveal, rate, dt);
        p.coherence = damp(p.coherence, lerp(lerp(H.field.coherence, 0.92, arrive), 1, unfold) * keepCoherence, rate, dt);
        p.spread = damp(p.spread, lerp(H.field.spread, fieldSpread(mix), arrive), rate, dt);
        p.tension = damp(p.tension, style.tension * lerp(H.field.tension, 1, arrive), rate, dt);
        p.warmth = fieldWarmth(style, mix);
        p.hover = layer.near;
        p.excite = damp(p.excite, 0, 2, dt);
        p.freq = fieldFreq(ctx.harmony, i);

        const scale = fieldScale(mix.level) * (1 + 0.15 * unfold);
        holder.scale.setScalar(scale);
        layer.rotation += dt * 0.02 * mix.modulation * life * (i === 1 ? -1 : 1);
        holder.rotation.y = layer.rotation;

        // The body leans toward the pointer that plays it.
        const reach = d > 0.05 ? (0.14 * layer.near) / d : 0;
        const lk = 1 - Math.exp(-2.5 * dt);
        layer.lean.x += (dx * reach - layer.lean.x) * lk;
        layer.lean.y += (dy * reach - layer.lean.y) * lk;
        layer.lean.z += (dz * reach - layer.lean.z) * lk;
        const c = Math.cos(layer.rotation);
        const s = Math.sin(layer.rotation);
        const bob = Math.sin(t * (0.37 + i * 0.11) + i * 2.1) * 0.035 * life;
        body.tilt.position.set((layer.lean.x * c - layer.lean.z * s) / scale, (layer.lean.y + bob) / scale, (layer.lean.x * s + layer.lean.z * c) / scale);
        body.tilt.rotation.set(style.tiltX, style.tiltY, style.tiltZ + mix.modulation * 0.14 * Math.sin(t * style.wobble * TAU * 0.25 + i) * life);
        body.matter.sync();

        const wave = bridge.waves[FIELD_SLOTS[i]];
        wave.position.copy(holder.position);
        wave.level = dissolving && tC >= releaseAt[FIELD_SLOTS[i]] ? 0 : fieldWaveLevel(mix.level) * forced;
      }

      // ── the constellation ──
      for (let i = 0; i < w.crystals.length; i++) {
        const crystal = w.crystals[i];
        const p = crystal.matter.params;
        const holder = crystal.holder;
        const spreadOut = 1 + 0.1 * unfold + 0.3 * cK;
        holder.position.copy(crystal.home).multiplyScalar(spreadOut);
        holder.position.y += Math.sin(t * (0.29 + i * 0.07) + i * 1.7) * 0.03 * life;
        holder.rotation.y += dt * 0.05 * calm;
        const d = ptr.world.distanceTo(holder.position);
        crystal.near = damp(crystal.near, playing && ptr.seen ? 1 - smoothstep(0.3, 1.5, d) : 0, 4, dt);
        p.reveal = damp(p.reveal, 0.85 * smoothstep(1.5 + i * 0.8, 5 + i * 0.8, t) * keepReveal, rate, dt);
        p.coherence = damp(p.coherence, keepCoherence, rate, dt);
        p.spread = damp(p.spread, 0.3 + 0.3 * unfold, rate, dt);
        p.hover = crystal.near;
        p.excite = damp(p.excite, 0, 2, dt);
        crystal.matter.sync();
      }
      const edgeReveal = 0.7 * smoothstep(4, 8, t) * (1 - smoothstep(0.05, 0.35, cK)) * forced;
      for (let k = 0; k < w.edges.length; k++) {
        const filament = w.edges[k];
        const a = w.crystals[k];
        const b = w.crystals[(k + 1) % w.crystals.length];
        const fp = filament.params;
        fp.reveal = damp(fp.reveal, edgeReveal, rate, dt);
        fp.energy = 0.3 + 0.2 * unfold + 0.4 * Math.max(a.matter.params.excite, b.matter.params.excite);
        fp.tension = 0.85;
        if (fp.reveal > 0.002) filament.setEndpoints(a.holder.position, b.holder.position);
        filament.sync();
      }

      // ── the three points ──
      const audible = Math.pow(1 - clamp(bridge.silence), 1.5) * forced;
      for (let i = 0; i < w.points.length; i++) {
        const point = w.points[i];
        const mote = point.mote;
        point.angle += dt * (0.018 + 0.02 * unfold) * dir * calm;
        mote.position.set(Math.cos(point.angle) * point.radius, Math.sin(point.angle) * point.radius * 0.55, point.depth + 0.3 * Math.sin(point.angle * 2));
        const d = ptr.world.distanceTo(mote.position);
        point.near = damp(point.near, playing && ptr.seen ? 1 - smoothstep(0.3, 1.6, d) : 0, 4, dt);
        point.excite = damp(point.excite, 0, 1.6, dt);
        const here = smoothstep(0.5 + i, 3.5 + i, t);
        mote.brightness = here * (0.3 + 0.25 * unfold + 0.7 * point.excite + 0.25 * point.near) * audible;
        mote.size = 0.42 + 0.3 * point.excite;
        mote.sync();

        const slot = POINT_SLOTS[i];
        const wave = bridge.waves[slot];
        wave.position.copy(mote.position);
        wave.level = dissolving && tC >= releaseAt[slot] ? 0 : lerp(0.16 + 0.45 * point.excite, 0.6, unfold) * here * forced;
      }

      // ── the source that follows the pointer, and the root ──
      {
        const theta = orbit0 + t * 0.05 * dir * calm;
        tmp.set(Math.cos(theta) * 2.6, 0.35 * Math.sin(theta * 0.7), Math.sin(theta) * 2.6);
        if (ptr.seen && playing) tmp.lerp(ptr.world, 1 - unfold);
        const k = 1 - Math.exp(-1.4 * dt);
        voiceAt.x += (tmp.x - voiceAt.x) * k;
        voiceAt.y += (tmp.y - voiceAt.y) * k;
        voiceAt.z += (tmp.z - voiceAt.z) * k;
        const voice = bridge.waves[POINTER_SLOT];
        voice.position.copy(voiceAt);
        voice.level = dissolving && tC >= releaseAt[POINTER_SLOT] ? 0 : lerp(ptr.seen ? 0.12 + 0.5 * energy : 0, 0.55, unfold) * forced;
        const rootWave = bridge.waves[ROOT_SLOT];
        rootWave.level = dissolving && tC >= releaseAt[ROOT_SLOT] ? 0 : lerp(H.rootLevel * (handed ? 1 : arrive), 0.6, unfold) * forced;
      }

      // ── volume and dust ──
      {
        const v = w.volume.params;
        v.reveal = damp(v.reveal, lerp(lerp(H.volume.reveal, 0.55, arrive), 0.9, unfold) * keepReveal, 2, dt);
        v.density = damp(v.density, lerp(H.volume.density, 0.5, arrive) + 0.08 * breath + 0.1 * energy, 2, dt);
        v.structure = damp(v.structure, lerp(lerp(H.volume.structure, 0.75, arrive), 1, unfold) * (0.35 + 0.65 * keepCoherence), 2, dt);
        v.scale = damp(v.scale, lerp(lerp(H.volume.scale, 1.4, arrive), 1.9, unfold) * (1 + 0.15 * cK), 2, dt);
        w.volume.sync();
        const pp = w.particles.params;
        pp.reveal = damp(pp.reveal, lerp(H.particles.reveal, 0.36, arrive) * keepReveal, rate, dt);
        pp.drift = damp(pp.drift, lerp(H.particles.drift, 0.75, arrive) + 1.2 * smoothstep(0, 0.5, cK), rate, dt);
        w.particles.sync();
      }

      // ── the last point ──
      {
        const last = w.last;
        if (phase === 'dissolve') {
          last.brightness = 0.7 * smoothstep(0.55, 1, cK);
          last.size = 0.5;
        } else if (phase === 'point') {
          last.brightness = damp(last.brightness, 0.86 + 0.07 * Math.sin(pointT * 0.9) + 0.14 * lastHover, 2, dt);
          last.size = damp(last.size, 0.5 + 0.08 * lastHover, 3, dt);
        } else if (phase === 'out') {
          if (touched) {
            // One gentle swell, then out.
            const rise = ease(clamp(outT / 0.9));
            const fall = 1 - ease(clamp((outT - 0.9) / (OUT_TOUCHED - 0.9)));
            last.brightness = lerp(outFrom, 1.45, rise) * fall;
            last.size = 0.5 + 0.34 * rise * fall;
          } else {
            last.brightness = outFrom * (1 - ease(clamp(outT / OUT_ALONE)));
          }
        } else if (phase === 'exit') {
          last.brightness = Math.min(last.brightness, forced);
        } else if (phase !== 'play' && phase !== 'unfold') {
          last.brightness = 0;
        }
        last.sync();
      }

      // ── bridge ──
      if (phase === 'unfold') {
        // The one moment of full iridescence.
        bridge.spectral = Math.max(bridge.spectral, lerp(0.75, 1, ease(clamp(tB / 9))));
        bridge.stability = lerp(0.88, 1, unfold);
      } else if (phase === 'play') {
        bridge.stability = 0.88;
      } else if (phase !== 'exit') {
        bridge.silence = Math.max(bridge.silence, ease(clamp(tC / 13)));
        bridge.spectral = Math.min(bridge.spectral, 1 - ease(clamp(tC / 9)));
        bridge.presence = Math.min(bridge.presence, lerp(1, 0.08, ease(cK)));
      }

      // ── sound ──
      if (playing) {
        const want = phase === 'play' ? lerp(0.15, 0.5, clamp(t / T_PLAY)) + 0.12 * energy : 0.78;
        finale = damp(finale, want, 0.8, dt);
        audio.setFinale(finale);
        audio.setStability(bridge.stability);
      }
      if (playing || phase === 'dissolve') {
        // Light leaves first, then air, then earth.
        for (let i = 0; i < 3; i++) {
          const mix = w.layers[i].mix;
          const gone = i === 2 ? smoothstep(0.02, 0.3, cK) : i === 1 ? smoothstep(0.2, 0.55, cK) : smoothstep(0.4, 0.85, cK);
          outMixes[i].level = mix.level * (1 - gone);
          outMixes[i].modulation = clamp(mix.modulation + 0.2 * energy);
        }
        audio.setFields(outFields);
      }

      // ── camera: full drift while playing, nearly still once the whole object is in view ──
      ctx.rig.drift = phase === 'play' ? 1 : phase === 'unfold' ? lerp(1, 0.12, smoothstep(7, 10, tB)) : phase === 'dissolve' ? 0.1 : 0.05;
    },

    assist(_level: 1 | 2 | 3, _ctx: ChapterContext) {
      // Nothing to solve here. The last point waits, and goes out by itself if left alone.
    },

    exit(ctx: ChapterContext) {
      const w = world;
      if (!w || complete) {
        exited = true;
        if (phase !== 'exited') phase = 'exited';
        return;
      }
      if (phase === 'exit' || phase === 'exited') return;
      // Called early (the Director's long stop): let everything go, quickly and quietly.
      w.lastInteractive.enabled = false;
      ctx.interaction.remove(w.lastInteractive);
      ctx.audio.setFields(SILENT_FIELDS);
      ctx.audio.setDrone(0);
      phase = 'exit';
      exitT = 0;
    },

    dispose(ctx: ChapterContext) {
      ctx.stage.grade.bloom = 0.5;
      const w = world;
      world = null;
      if (!w) return;
      ctx.interaction.remove(w.lastInteractive);
      for (let i = 0; i < w.sheets.length; i++) w.sheets[i].matter.dispose();
      for (let i = 0; i < w.layers.length; i++) w.layers[i].body.matter.dispose();
      for (let i = 0; i < w.crystals.length; i++) w.crystals[i].matter.dispose();
      for (let i = 0; i < w.edges.length; i++) w.edges[i].dispose();
      for (let i = 0; i < w.points.length; i++) w.points[i].mote.dispose();
      w.volume.dispose();
      w.particles.dispose();
      w.last.dispose();
      w.root.removeFromParent();
      w.root.clear();
      for (let s = 0; s < MAX_WAVES; s++) {
        ctx.bridge.waves[s].freq = 0;
        ctx.bridge.waves[s].level = 0;
      }
      ctx.bridge.silence = 0;
      ctx.audio.setFields(SILENT_FIELDS);
      ctx.audio.setDrone(0);
    },
  };

  return chapter;
}
