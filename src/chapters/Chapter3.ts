/**
 * Chapter III — Hidden Order.   "Every relationship has a shape."
 *
 * The membrane of chapter II returns, half torn, sounds one quiet chord, and finishes
 * tearing into five crystal fragments that drift apart. Three belong together — their pitches are the
 * simplest triad of the visit's mode — and two do not. Each fragment is a wave source
 * (bridge.waves slot = fragment index = audio voice id) exactly as far as it sounds:
 * hover → soft glass preview, press → bell, hold / drag → a sustained FM voice.
 *
 * The rule (see puzzles/constellation.ts): every bonded pair wants a distance
 * proportional to its Tenney harmonic distance. A filament appears between two bonded
 * fragments inside capture range and tightens as they approach the ideal length; the
 * fragments lean toward it magnetically; unrelated fragments are pushed away. When all
 * three sides are within tolerance for one second the figure locks, orbits its centroid
 * and unfolds into the lattice while the camera falls far back.
 *
 * Timeline
 *   0.0 – 5.3 s   opening: the sheet returns, a chord on it, tear, fragments leave low → high
 *                 (the bonds show for a moment as they stretch and let go)
 *   play          the puzzle; assist(1) hint, assist(2) pulse + arpeggio + ghost
 *                 filaments, assist(3) the three drift into place over 4 s
 *   lock          +0.0 resolve('lattice') · +0.9 lattice unfolds for 7 s, camera pulls
 *                 back · +7.5 slow push-in · +10.9 complete
 *   exit          3.6 s: lattice thins to a remnant, fragments and filaments go out
 *
 * Ownership of a fragment's position: Interaction integrates it while dragging and
 * while its release spring settles (onMove fires); otherwise this chapter does
 * (magnetic relaxation, slow wander, scripted moves). The two never write in the same frame.
 */
import { Box3, Group, Vector3 } from 'three';
import type { Chapter, ChapterContext, Filament, Interactive, Matter, Particles, StrikeTimbre, VolumeField } from '../core/contracts';
import { clamp, damp, ease, lerp, smoothstep } from '../core/math';
import { createFilament, createMatter, createParticles, createVolumeField } from '../render/materials';
import {
  createEvaluation,
  designConstellation,
  evaluate,
  magnetStep,
  relate,
  scatter,
  solveArrangement,
  type ConstellationSpec,
  type Evaluation,
  type Relations,
} from '../puzzles/constellation';

// ── register and framing ─────────────────────────────────────────────────
/** Fragments sound two octaves above the root: 184–500 Hz. */
const OCTAVE = 2;
const FOV = 36;
const DEG = Math.PI / 180;
/** CameraRig widens the vertical fov below this aspect to keep the horizontal extent. Mirrored here so the play volume fits. */
const RIG_PORTRAIT_ASPECT = 0.8;
const RIG_MAX_TAN = Math.tan(50 * DEG);
/**
 * The sheet chapter II leaves behind: same place, tilt and size as its opened membrane
 * (11 × 7 scaled 1.3 × 1.1, at (0, −0.1, −1), tilted −0.6 rad). II's outro has already begun
 * to tear it and let it sink, so it returns here half torn, over MEMBRANE_IN seconds, and
 * this chapter finishes the tear.
 */
const MEMBRANE_WIDTH = 14.3;
const MEMBRANE_HEIGHT = 7.7;
const MEMBRANE_Y = -0.1;
const MEMBRANE_Z = -1;
const MEMBRANE_TILT = -0.6;
const MEMBRANE_IN = 0.7;
const MEMBRANE_REVEAL = 0.9;
const MEMBRANE_COHERENCE = 0.6;
const MEMBRANE_WARMTH = -0.22;

// ── timeline ─────────────────────────────────────────────────────────────
const CHORD_AT = 0.12;
const TEAR_START = 0.5;
const TEAR_SECONDS = 3.6;
const DEPART_START = 0.8;
const DEPART_STAGGER = 0.34;
const TRAVEL_SECONDS = 3.1;
const MEMBRANE_GONE = 5.6;
const SOLVE_HOLD = 1.0;
const AUTO_SECONDS = 4.0;
const SNAP_SECONDS = 1.4;
const LATTICE_DELAY = 0.9;
const LATTICE_SECONDS = 7.0;
const LATTICE_REST = 4.5;
const PULL_BACK_SECONDS = 6.6;
const PUSH_IN_SECONDS = 11;
const EXIT_SECONDS = 3.6;

// ── feel ─────────────────────────────────────────────────────────────────
/** Fraction of the length error the magnet removes from the drag target. */
const MAGNET_DRAG = 0.34;
const MAGNET_SETTLE = 0.9;
/** Rate (1/s) at which free fragments relax toward their magnetic target. */
const RELAX_RATE = 1.7;
const HOVER_COOLDOWN = 0.7;
const PULSE_PERIOD = 3.4;
const ARPEGGIO_STEP = 0.21;
const GHOST_REVEAL = 0.12;
/** Frames during which everything is drawn (at zero reveal) so programs compile during the entry, not at the signature. */
const PREWARM_FRAMES = 3;

// ── lattice ──────────────────────────────────────────────────────────────
/**
 * World half-extent of the lattice volume: from the size of the constellation to LATTICE_FRAME_FACTOR ×
 * the half-diagonal of the pulled-back frame, so the camera ends up inside it and no boundary is in view.
 * (Converted to VolumeField.params.scale with the measured unit — see measureVolumeUnit.)
 */
const LATTICE_RADIUS_FROM = 0.75;
const LATTICE_FRAME_FACTOR = 2;
const LATTICE_DENSITY_FROM = 0.9;
const LATTICE_DENSITY_TO = 2.6;
const LATTICE_REMNANT = 0.1;
/** Camera distance during the signature, as multiples of the play distance. */
const FAR_FACTOR = 3.3;
const NEAR_FACTOR = 2.45;

const ORDINALS = ['one', 'two', 'three', 'four', 'five'];

type Phase = 'opening' | 'play' | 'auto' | 'locked';

interface Frame {
  aspect: number;
  /** Camera distance from the z = 0 plane. */
  dist: number;
  camX: number;
  /** Tangent of half the effective vertical field of view. */
  tanHalf: number;
  /** Play volume at z = 0: x relative to camX, y relative to 0. */
  left: number;
  right: number;
  halfY: number;
  halfZ: number;
}

interface Fragment {
  index: number;
  member: boolean;
  freq: number;
  holder: Group;
  matter: Matter;
  item: Interactive;
  /** Where it leaves the membrane, and where it comes to rest. */
  origin: Vector3;
  home: Vector3;
  depart: number;
  departed: boolean;
  /** Tumble axis / rate and bob phase. */
  axis: Vector3;
  spin: number;
  phase: number;
  /** 0..1 — how strongly it is sounding (strike decay or sustain). Drives the wave level. */
  ring: number;
  held: boolean;
  voiced: boolean;
  hovering: boolean;
  lastSoft: number;
  /** Frame number of the last Interaction.onMove: while recent, Interaction owns the position. */
  movedFrame: number;
  /** Strongest closeness among its bonds (0..1), from the last evaluation. */
  bond: number;
  /** assist(3) path. */
  from: Vector3;
  to: Vector3;
}

interface Bond {
  /** Index into evaluation.pairs. */
  pair: number;
  i: number;
  j: number;
  compat: number;
  filament: Filament;
  reveal: number;
}

interface World {
  root: Group;
  spec: ConstellationSpec;
  rel: Relations;
  evaluation: Evaluation;
  fragments: Fragment[];
  positions: Vector3[];
  bonds: Bond[];
  membrane: Matter | null;
  volume: VolumeField;
  particles: Particles;
  phase: Phase;
  clock: number;
  frameNo: number;
  progress: number;
  hold: number;
  autoT: number;
  lockT: number;
  exitT: number;
  exiting: boolean;
  exited: boolean;
  complete: boolean;
  chordStruck: boolean;
  tearStruck: boolean;
  assistLevel: number;
  pendingAuto: boolean;
  pulseClock: number;
  arpeggioNext: number;
  pulledBack: boolean;
  pushedIn: boolean;
  pairAnnounced: boolean;
  stabilitySent: number;
  /** World half-extent of the volume per unit of params.scale. */
  volumeUnit: number;
  /** params.scale at the start and end of the unfolding. */
  latticeFrom: number;
  latticeTo: number;
  latticeReveal: number;
  latticeDensity: number;
  exitReveal: number;
  exitDensity: number;
  dustReveal: number;
}

/** Camera distance and play volume for an aspect ratio: right two-thirds in landscape, full width in portrait. */
function computeFrame(aspect: number, f: Frame): void {
  const a = Math.max(aspect, 0.25);
  const wide = smoothstep(0.85, 1.45, a);
  const tanHalf = Math.min(RIG_MAX_TAN, Math.tan(FOV * 0.5 * DEG) * (a < RIG_PORTRAIT_ASPECT ? RIG_PORTRAIT_ASPECT / a : 1));
  const needHalfW = lerp(1.85, 4.5, wide);
  const needHalfH = lerp(3.0, 2.3, wide);
  const dist = Math.max(needHalfW / (tanHalf * a), needHalfH / tanHalf);
  const halfH = dist * tanHalf;
  const halfW = halfH * a;
  const leftFrac = lerp(-0.84, -0.3, wide);
  const rightFrac = lerp(0.84, 0.88, wide);
  f.aspect = aspect;
  f.dist = dist;
  f.tanHalf = tanHalf;
  f.camX = -0.5 * (leftFrac + rightFrac) * halfW;
  f.left = leftFrac * halfW;
  f.right = rightFrac * halfW;
  f.halfY = lerp(0.66, 0.74, wide) * halfH;
  f.halfZ = lerp(0.8, 1.1, wide);
}

/**
 * World half-extent of a VolumeField per unit of params.scale. The contract leaves that unit open
 * (a world size, or a multiple of some natural size), so it is measured once at enter: the lattice
 * is then sized in world units whichever it is. Falls back to "scale is the world half-extent" when
 * the object's size does not follow params.scale.
 */
function measureVolumeUnit(volume: VolumeField): number {
  const box = new Box3();
  const size = new Vector3();
  const halfExtentAt = (scale: number): number => {
    volume.params.scale = scale;
    volume.sync();
    volume.object.updateMatrixWorld(true);
    box.setFromObject(volume.object).getSize(size);
    return 0.5 * Math.max(size.x, size.y, size.z);
  };
  const one = halfExtentAt(1);
  const two = halfExtentAt(2);
  const linear = Number.isFinite(one) && one > 1e-3 && Math.abs(two / one - 2) < 0.2;
  return linear ? one : 1;
}

export function createChapter3(): Chapter {
  // Scratch and fixed-size state, allocated once; nothing in update() allocates.
  const tmp = new Vector3();
  const tmp2 = new Vector3();
  const centroid = new Vector3();
  const orbitAxis = new Vector3(0, 0, 1);
  const relFrom = [new Vector3(), new Vector3(), new Vector3()];
  const relTo = [new Vector3(), new Vector3(), new Vector3()];
  const targets = [new Vector3(), new Vector3(), new Vector3()];
  const frame: Frame = { aspect: 1, dist: 8, camX: 0, tanHalf: Math.tan(FOV * 0.5 * DEG), left: -2, right: 2, halfY: 2, halfZ: 1 };
  const pose = { position: new Vector3(), target: new Vector3(), fov: FOV };
  const voiceMove = { pos: new Vector3(), brightness: 0.5 };
  const voicePlace = { pos: new Vector3() };

  let world: World | null = null;
  let live: ChapterContext | null = null;

  // ── volume ─────────────────────────────────────────────────────────────

  /** Clamp a position into the play volume (a slice of the view frustum, so it fits at every depth). */
  const constrainVolume = (p: Vector3): void => {
    p.z = clamp(p.z, -frame.halfZ, frame.halfZ);
    const s = (frame.dist - p.z) / frame.dist;
    p.x = clamp(p.x, frame.camX + frame.left * s, frame.camX + frame.right * s);
    p.y = clamp(p.y, -frame.halfY * s, frame.halfY * s);
  };

  const playPose = () => {
    pose.position.set(frame.camX, 0, frame.dist);
    pose.target.set(frame.camX, 0, 0);
    pose.fov = FOV;
    return pose;
  };

  // ── sound ──────────────────────────────────────────────────────────────

  /**
   * Strike a fragment where it is. AudioEngine.strike marks every strike as a full attack on the
   * bridge; here the wavefront is made as strong as the strike is loud (`front` 0..1), so a hover
   * preview is a whisper in the image too.
   */
  const strikeFragment = (f: Fragment, velocity: number, timbre: StrikeTimbre, front: number): void => {
    if (!live) return;
    const b = live.bridge;
    const before = b.attack;
    const at = f.holder.position;
    live.audio.strike(f.freq, { velocity, pos: at, timbre });
    b.attack = Math.max(before, front);
    b.attackAt.copy(at);
  };

  const softStrike = (w: World, f: Fragment, velocity: number): void => {
    if (!live) return;
    strikeFragment(f, velocity, 'glass', clamp(0.1 + velocity));
    f.ring = Math.max(f.ring, 0.35 + velocity);
    f.matter.params.excite = Math.max(f.matter.params.excite, 0.3 + velocity);
    f.lastSoft = w.clock;
  };

  const releaseVoice = (f: Fragment, seconds: number): void => {
    f.held = false;
    if (f.voiced) {
      f.voiced = false;
      live?.audio.voiceOff(f.index, seconds);
    }
  };

  // ── interactives ───────────────────────────────────────────────────────

  const makeItem = (w: World, index: number, holder: Group, radius: number, label: string): Interactive => ({
    label,
    object: holder,
    radius,
    enabled: false,
    draggable: true,
    constrain: constrainVolume,
    magnet(desired, dragging) {
      magnetStep(index, desired, w.positions, w.rel, dragging ? MAGNET_DRAG : MAGNET_SETTLE, desired);
      constrainVolume(desired);
    },
    onHover(hovering) {
      const f = w.fragments[index];
      f.hovering = hovering;
      if (!hovering || !live || w.exiting || (w.phase !== 'play' && w.phase !== 'auto')) return;
      if (live.interaction.dragging || w.clock - f.lastSoft < HOVER_COOLDOWN) return;
      softStrike(w, f, 0.22);
    },
    onPress() {
      if (!live || w.exiting || (w.phase !== 'play' && w.phase !== 'auto')) return;
      const f = w.fragments[index];
      const at = holder.position;
      strikeFragment(f, 0.8, 'bell', 1);
      live.audio.voiceOn(index, f.freq, { level: 0.5, timbre: 'fm', pos: at });
      f.voiced = true;
      f.held = true;
      f.ring = 1;
      f.lastSoft = w.clock;
      f.matter.params.excite = 1;
      w.particles.impulse(at, 0.45);
    },
    onMove(position) {
      const f = w.fragments[index];
      f.movedFrame = w.frameNo;
      if (f.held && live) {
        // Height opens the voice; the position carries it through the room.
        voiceMove.pos.copy(position);
        voiceMove.brightness = clamp(0.5 + (0.4 * position.y) / frame.halfY);
        live.audio.voiceSet(index, voiceMove);
      }
    },
    onRelease() {
      const f = w.fragments[index];
      if (f.held) releaseVoice(f, 1.8);
    },
  });

  // ── phase changes ──────────────────────────────────────────────────────

  /** assist(3): the three that belong drift into the nearest solved figure. */
  const startAuto = (w: World): void => {
    if (w.phase === 'opening') {
      w.pendingAuto = true;
      return;
    }
    if (w.phase !== 'play' || w.exiting) return;
    w.phase = 'auto';
    w.autoT = 0;
    solveArrangement(w.positions, w.rel, w.spec.members, targets);
    // Slide the whole figure, rigidly, until it sits inside the volume.
    for (let pass = 0; pass < 4; pass++) {
      for (let k = 0; k < 3; k++) {
        tmp.copy(targets[k]);
        constrainVolume(tmp);
        tmp.sub(targets[k]);
        if (tmp.lengthSq() > 1e-10) for (let m = 0; m < 3; m++) targets[m].add(tmp);
      }
    }
    for (let k = 0; k < 3; k++) {
      const f = w.fragments[w.spec.members[k]];
      f.item.enabled = false;
      f.item.draggable = false;
      f.hovering = false;
      releaseVoice(f, 1.8);
      f.from.copy(f.holder.position);
      f.to.copy(targets[k]);
    }
  };

  /** The signature: lock, orbit, unfold. */
  const lock = (w: World, ctx: ChapterContext): void => {
    w.phase = 'locked';
    w.lockT = 0;
    w.progress = 1;
    const members = w.spec.members;

    // The figure eases from where the visitor left it to the exact one, about the same centroid.
    solveArrangement(w.positions, w.rel, members, targets);
    centroid.set(0, 0, 0);
    for (let k = 0; k < 3; k++) centroid.add(w.positions[members[k]]);
    centroid.multiplyScalar(1 / 3);
    for (let k = 0; k < 3; k++) {
      relFrom[k].copy(w.positions[members[k]]).sub(centroid);
      relTo[k].copy(targets[k]).sub(centroid);
    }
    tmp.copy(relTo[1]).sub(relTo[0]);
    tmp2.copy(relTo[2]).sub(relTo[0]);
    orbitAxis.crossVectors(tmp, tmp2);
    if (orbitAxis.lengthSq() < 1e-8) orbitAxis.set(0, 0, 1);
    orbitAxis.normalize();
    if (orbitAxis.z < 0) orbitAxis.negate(); // always turns the same way as seen from the camera

    ctx.memory.data.constellation = {
      positions: relTo.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      degrees: members.map((m) => w.spec.degrees[m]),
    };

    for (let i = 0; i < w.fragments.length; i++) {
      const f = w.fragments[i];
      f.item.enabled = false;
      f.item.draggable = false;
      f.hovering = false;
      f.held = false;
      if (f.member) {
        // The three keep sounding, quietly, as one chord for as long as the lattice stands.
        if (f.voiced) ctx.audio.voiceSet(f.index, { level: 0.3, pos: f.holder.position });
        else ctx.audio.voiceOn(f.index, f.freq, { level: 0.3, timbre: 'fm', pos: f.holder.position });
        f.voiced = true;
        f.ring = Math.max(f.ring, 0.8);
        f.matter.params.excite = 1;
      } else {
        releaseVoice(f, 2.5);
      }
    }

    ctx.audio.resolve('lattice');
    ctx.audio.setDrone(0.5, 0.45);
    ctx.ui.hint(null);
    ctx.ui.announce('Three fragments hold one shape. A lattice unfolds from it.');
    ctx.bridge.attack = Math.max(ctx.bridge.attack, 0.7);
    ctx.bridge.attackAt.copy(centroid);
    ctx.rig.drift = 0.35;

    // The lattice grows from the figure itself to well beyond what the pulled-back camera sees.
    const farHalfDiagonal = frame.dist * FAR_FACTOR * frame.tanHalf * Math.sqrt(1 + frame.aspect * frame.aspect);
    w.latticeFrom = LATTICE_RADIUS_FROM / w.volumeUnit;
    w.latticeTo = Math.max((LATTICE_FRAME_FACTOR * farHalfDiagonal) / w.volumeUnit, w.latticeFrom * 4);
    w.volume.params.scale = w.latticeFrom;
    w.volume.object.position.copy(centroid);
  };

  // ── chapter ────────────────────────────────────────────────────────────

  const chapter: Chapter = {
    index: 2,
    numeral: 'III',
    name: 'Hidden Order',
    line: 'Every relationship has a shape.',

    get progress() {
      return world ? world.progress : 0;
    },
    get complete() {
      return world ? world.complete : false;
    },
    get exited() {
      return world ? world.exited : false;
    },

    enter(ctx: ChapterContext) {
      if (world) chapter.dispose(ctx);
      live = ctx;
      const { harmony, quality, stage, bridge, audio } = ctx;
      const rand = harmony.rand;

      computeFrame(stage.viewport.width / Math.max(1, stage.viewport.height), frame);

      const spec = designConstellation(harmony.ratios, rand);
      const rel = relate(spec.pitches);
      const evaluation = createEvaluation(rel.n);
      const n = rel.n;

      // Scatter inside a box that fits the volume at its nearest depth, so every start is in frame.
      const sNear = (frame.dist - frame.halfZ) / frame.dist;
      const halfX = 0.5 * (frame.right - frame.left) * sNear - Math.abs(frame.camX) * (1 - sNear) - 0.05;
      const start = scatter(rel, { x: halfX * 0.96, y: frame.halfY * sNear * 0.96, z: frame.halfZ }, rand);

      const root = new Group();
      root.name = 'chapter-3';

      const membrane = createMatter(
        'membrane',
        {
          shape: 'plane',
          width: MEMBRANE_WIDTH,
          height: MEMBRANE_HEIGHT,
          detail: 0.8,
          init: { reveal: 0, excite: 0, hover: 0, tension: 0.9, coherence: MEMBRANE_COHERENCE, freq: 0, seed: rand(), warmth: MEMBRANE_WARMTH, spread: 1 },
        },
        quality,
      );
      membrane.object.position.set(0, MEMBRANE_Y, MEMBRANE_Z);
      membrane.object.rotation.set(MEMBRANE_TILT, 0, 0);
      membrane.sync();
      const tiltCos = Math.cos(MEMBRANE_TILT);
      const tiltSin = Math.sin(MEMBRANE_TILT);
      root.add(membrane.object);

      // Pitch rank (0 = lowest) decides size and the order in which fragments leave the membrane.
      const rank = spec.pitches.map((p) => spec.pitches.filter((q) => q < p).length);

      const volume = createVolumeField(quality);
      const volumeUnit = measureVolumeUnit(volume);

      const w: World = {
        root,
        spec,
        rel,
        evaluation,
        fragments: [],
        positions: [],
        bonds: [],
        membrane,
        volume,
        particles: createParticles(quality.lite ? 280 : 800, quality),
        phase: 'opening',
        clock: 0,
        frameNo: 0,
        progress: 0,
        hold: 0,
        autoT: 0,
        lockT: 0,
        exitT: 0,
        exiting: false,
        exited: false,
        complete: false,
        chordStruck: false,
        tearStruck: false,
        assistLevel: 0,
        pendingAuto: false,
        pulseClock: PULSE_PERIOD,
        arpeggioNext: 3,
        pulledBack: false,
        pushedIn: false,
        pairAnnounced: false,
        stabilitySent: -1,
        volumeUnit,
        latticeFrom: LATTICE_RADIUS_FROM / volumeUnit,
        latticeTo: (LATTICE_RADIUS_FROM * 40) / volumeUnit,
        latticeReveal: 0,
        latticeDensity: LATTICE_DENSITY_FROM,
        exitReveal: 0,
        exitDensity: 0,
        dustReveal: 0,
      };

      for (let i = 0; i < n; i++) {
        const member = spec.degrees[i] >= 0;
        const radius = lerp(0.34, 0.24, rank[i] / Math.max(1, n - 1));
        const freq = harmony.root * Math.pow(2, OCTAVE) * spec.pitches[i];
        const matter = createMatter(
          'crystal',
          {
            shape: 'ico',
            radius,
            detail: 0.15,
            init: {
              reveal: 0,
              excite: 0,
              hover: 0,
              // The two that do not belong are slack, slightly torn, cool and half as present.
              tension: member ? 0.85 : 0.3,
              coherence: member ? 1 : 0.62,
              freq,
              seed: rand(),
              warmth: member ? 0.25 : -0.35,
              spread: member ? 0.35 : 0.15,
            },
          },
          quality,
        );
        matter.sync();
        const holder = new Group();
        holder.add(matter.object);
        const home = new Vector3(start[i].x, start[i].y, start[i].z);
        // It leaves the sheet from the point of the (tilted) sheet in front of 42 % of its way home.
        const sheetY = (home.y * 0.42 - MEMBRANE_Y) / tiltCos;
        const origin = new Vector3(home.x * 0.42, MEMBRANE_Y + sheetY * tiltCos, MEMBRANE_Z + sheetY * tiltSin);
        holder.position.copy(origin);
        root.add(holder);

        const axis = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5);
        if (axis.lengthSq() < 1e-4) axis.set(0.3, 1, 0.2);
        axis.normalize();

        const label = `Fragment ${ORDINALS[rank[i]] ?? String(rank[i] + 1)} of ${ORDINALS[n - 1] ?? String(n)}`;
        const item = makeItem(w, i, holder, Math.max(0.5, radius * 1.8), label);
        w.fragments.push({
          index: i,
          member,
          freq,
          holder,
          matter,
          item,
          origin,
          home,
          depart: DEPART_START + rank[i] * DEPART_STAGGER,
          departed: false,
          axis,
          spin: (0.1 + rand() * 0.12) * (rand() < 0.5 ? -1 : 1),
          phase: rand() * Math.PI * 2,
          ring: 0,
          held: false,
          voiced: false,
          hovering: false,
          lastSoft: -10,
          movedFrame: -10,
          bond: 0,
          from: new Vector3(),
          to: new Vector3(),
        });
        w.positions.push(holder.position);
        ctx.interaction.add(item);

        const wave = bridge.waves[i];
        wave.position.copy(origin);
        wave.freq = freq;
        wave.level = 0;
      }

      evaluate(w.positions, rel, evaluation);
      for (let k = 0; k < evaluation.pairs.length; k++) {
        const pair = evaluation.pairs[k];
        if (!pair.bonded) continue;
        const filament = createFilament(quality);
        filament.params.reveal = 0;
        filament.params.energy = pair.compat;
        filament.params.tension = 0.3;
        filament.params.warmth = 0.15;
        filament.setEndpoints(w.positions[pair.i], w.positions[pair.j]);
        filament.sync();
        root.add(filament.object);
        w.bonds.push({ pair: k, i: pair.i, j: pair.j, compat: pair.compat, filament, reveal: 0 });
      }

      w.volume.params.reveal = 0;
      w.volume.params.density = LATTICE_DENSITY_FROM;
      w.volume.params.structure = 0;
      w.volume.params.scale = w.latticeFrom;
      w.volume.sync();
      root.add(w.volume.object);

      w.particles.params.reveal = 0;
      w.particles.params.drift = 0.25;
      w.particles.sync();
      root.add(w.particles.object);

      stage.scene.add(root);
      world = w;

      ctx.rig.drift = 0.5;
      ctx.rig.moveTo(playPose(), 4.5);
      audio.setDrone(0.34, 0.3);
    },

    update(dt: number, ctx: ChapterContext) {
      const w = world;
      if (!w) return;
      live = ctx;
      const { bridge, audio, quality, interaction } = ctx;
      const fragments = w.fragments;
      const members = w.spec.members;
      const outsiders = w.spec.outsiders;
      const count = fragments.length;
      const motion = quality.reducedMotion ? 0 : 1;
      w.clock += dt;
      w.frameNo++;
      const t = w.clock;
      const prewarm = w.frameNo <= PREWARM_FRAMES;

      // ── framing follows the viewport ─────────────────────────────────
      const aspect = ctx.stage.viewport.width / Math.max(1, ctx.stage.viewport.height);
      if (Math.abs(aspect - frame.aspect) > 0.01) {
        computeFrame(aspect, frame);
        if (w.phase !== 'locked' && !w.exiting) ctx.rig.moveTo(playPose(), 1.4);
      }

      // ── exit envelope ────────────────────────────────────────────────
      let fade = 1;
      let exitK = 0;
      if (w.exiting) {
        w.exitT += dt;
        exitK = clamp(w.exitT / EXIT_SECONDS);
        fade = 1 - ease(clamp(exitK / 0.85));
        if (exitK >= 1) w.exited = true;
      }

      // ── opening: the chord, the tear, the departure ──────────────────
      if (w.phase === 'opening') {
        if (!w.chordStruck && t >= CHORD_AT) {
          w.chordStruck = true;
          // Before anything is apart, the three that belong sound once, together.
          for (let k = 0; k < members.length; k++) {
            const f = fragments[members[k]];
            strikeFragment(f, 0.16, 'glass', 0.3);
            f.ring = Math.max(f.ring, 0.55);
          }
        }
        if (!w.tearStruck && t >= TEAR_START) {
          w.tearStruck = true;
          if (w.membrane) w.membrane.params.excite = 0.6;
          w.particles.impulse(tmp.set(0, MEMBRANE_Y, MEMBRANE_Z), 0.7);
        }
        let arrived = 0;
        for (let i = 0; i < count; i++) {
          const f = fragments[i];
          const u = clamp((t - f.depart) / TRAVEL_SECONDS);
          if (!f.departed && t >= f.depart) {
            f.departed = true;
            strikeFragment(f, 0.26, 'glass', 0.45);
            f.ring = Math.max(f.ring, 0.7);
            f.matter.params.excite = 0.7;
          }
          const e = ease(u);
          const p = f.holder.position;
          p.lerpVectors(f.origin, f.home, e);
          // Leave the sheet toward the viewer before settling into depth.
          p.z += Math.sin(Math.PI * e) * 0.45 * (f.home.z >= 0 ? 1 : 0.5);
          if (u >= 1) arrived++;
        }
        if (arrived === count) {
          w.phase = 'play';
          for (let i = 0; i < count; i++) {
            const f = fragments[i];
            f.holder.position.copy(f.home);
            f.item.enabled = !w.exiting;
          }
          if (w.pendingAuto) {
            w.pendingAuto = false;
            startAuto(w);
          }
        }
      }

      // ── membrane tears and goes out ──────────────────────────────────
      if (w.membrane) {
        const m = w.membrane;
        const tear = ease(clamp((t - TEAR_START) / TEAR_SECONDS));
        m.params.coherence = MEMBRANE_COHERENCE * (1 - tear);
        m.params.tension = lerp(0.9, 0.12, tear);
        m.params.warmth = lerp(MEMBRANE_WARMTH, 0, tear);
        m.params.reveal = MEMBRANE_REVEAL * smoothstep(0, MEMBRANE_IN, t) * (1 - smoothstep(2.3, MEMBRANE_GONE - 0.2, t)) * fade;
        m.params.excite = damp(m.params.excite, 0, 1.6, dt);
        m.object.visible = m.params.reveal > 0.002 || prewarm;
        m.sync();
        if (t >= MEMBRANE_GONE || (w.exiting && fade <= 0.001)) {
          w.root.remove(m.object);
          m.dispose();
          w.membrane = null;
        }
      }

      // ── free fragments: magnetic relaxation, slow wander, bounds ─────
      if ((w.phase === 'play' || w.phase === 'auto') && !w.exiting) {
        const relax = 1 - Math.exp(-RELAX_RATE * dt);
        const settle = 1 - Math.exp(-6 * dt);
        for (let i = 0; i < count; i++) {
          const f = fragments[i];
          if (w.phase === 'auto' && f.member) continue;
          if (interaction.dragging === f.item || w.frameNo - f.movedFrame <= 1) continue;
          const p = f.holder.position;
          magnetStep(i, p, w.positions, w.rel, 1, tmp);
          p.lerp(tmp, relax);
          if (motion > 0) {
            // Unbonded fragments float; a fragment that has found another holds still.
            const drift = 0.028 * (1 - f.bond) * dt;
            p.x += Math.sin(t * 0.21 + f.phase) * drift;
            p.y += Math.cos(t * 0.17 + f.phase * 1.7) * drift;
            p.z += Math.sin(t * 0.13 + f.phase * 2.3) * drift * 0.6;
          }
          tmp.copy(p);
          constrainVolume(tmp);
          p.lerp(tmp, settle);
        }
      }

      // ── assist(3): the three find each other ─────────────────────────
      if (w.phase === 'auto' && !w.exiting) {
        w.autoT += dt;
        const u = ease(clamp(w.autoT / AUTO_SECONDS));
        for (let k = 0; k < members.length; k++) {
          const f = fragments[members[k]];
          f.holder.position.lerpVectors(f.from, f.to, u);
        }
      }

      // ── puzzle state ─────────────────────────────────────────────────
      if (w.phase !== 'locked') {
        evaluate(w.positions, w.rel, w.evaluation);
        w.progress = w.phase === 'opening' ? 0 : w.evaluation.progress;
        if ((w.phase === 'play' || w.phase === 'auto') && !w.exiting) {
          if (w.evaluation.solved) w.hold += dt;
          else w.hold = Math.max(0, w.hold - dt * 2);
          if (w.hold >= SOLVE_HOLD) lock(w, ctx);
        }
      }

      // ── locked: orbit, lattice, camera ───────────────────────────────
      let lockK = 0;
      if (w.phase === 'locked') {
        w.lockT += dt;
        const lt = w.lockT;
        lockK = smoothstep(0, 1.6, lt);
        const snap = ease(clamp(lt / SNAP_SECONDS));
        const omega = motion > 0 ? 0.14 : 0.05;
        const ramp = 2.5;
        const angle = lt < ramp ? (omega * lt * lt) / (2 * ramp) : omega * (lt - ramp * 0.5);
        for (let k = 0; k < 3; k++) {
          tmp.lerpVectors(relFrom[k], relTo[k], snap).applyAxisAngle(orbitAxis, angle);
          fragments[members[k]].holder.position.copy(centroid).add(tmp);
        }
        // The two that never belonged drift off and come apart.
        for (let k = 0; k < outsiders.length; k++) {
          const p = fragments[outsiders[k]].holder.position;
          tmp.copy(p).sub(centroid);
          const d = tmp.length();
          if (d > 1e-4) p.addScaledVector(tmp, (0.14 * dt) / d);
        }

        const u = clamp((lt - LATTICE_DELAY) / LATTICE_SECONDS);
        const grow = 1 - Math.pow(1 - u, 3);
        w.latticeReveal = ease(clamp(u * 1.7));
        w.latticeDensity = lerp(LATTICE_DENSITY_FROM, LATTICE_DENSITY_TO, ease(u));
        w.volume.params.structure = ease(u);
        w.volume.params.scale = w.latticeFrom * Math.pow(w.latticeTo / w.latticeFrom, grow);

        if (!w.exiting) {
          // Reduced motion: the same fall back, taken more slowly.
          const pullSeconds = PULL_BACK_SECONDS * (motion > 0 ? 1 : 1.35);
          if (!w.pulledBack && lt >= LATTICE_DELAY) {
            w.pulledBack = true;
            const d = frame.dist * FAR_FACTOR;
            pose.position.set(centroid.x - d * 0.1, centroid.y + d * 0.08, centroid.z + d);
            pose.target.copy(centroid);
            pose.fov = FOV;
            ctx.rig.moveTo(pose, pullSeconds);
          }
          if (!w.pushedIn && lt >= LATTICE_DELAY + pullSeconds) {
            w.pushedIn = true;
            const d = frame.dist * NEAR_FACTOR;
            pose.position.set(centroid.x + d * 0.04, centroid.y + d * 0.03, centroid.z + d);
            pose.target.copy(centroid);
            pose.fov = FOV;
            ctx.rig.moveTo(pose, PUSH_IN_SECONDS);
          }
          if (lt >= LATTICE_DELAY + LATTICE_SECONDS + LATTICE_REST) w.complete = true;
        }
        // Silver, with a little warmth: held above the Director's baseline while the lattice stands.
        bridge.spectral = Math.max(bridge.spectral, 0.45 * smoothstep(0, 4, lt));
      } else {
        bridge.spectral = Math.max(bridge.spectral, 0.22 + 0.14 * w.progress);
      }

      // ── assist(2): the three pulse together, a quiet arpeggio ────────
      let ghost = 0;
      if (w.assistLevel >= 2 && (w.phase === 'play' || w.phase === 'auto') && !w.exiting) {
        w.pulseClock += dt;
        if (w.pulseClock >= PULSE_PERIOD) {
          w.pulseClock = 0;
          w.arpeggioNext = 0;
          for (let k = 0; k < members.length; k++) {
            const p = fragments[members[k]].matter.params;
            p.excite = Math.max(p.excite, 0.75);
          }
        }
        while (w.arpeggioNext < members.length && w.pulseClock >= w.arpeggioNext * ARPEGGIO_STEP) {
          const f = fragments[members[w.arpeggioNext]];
          w.arpeggioNext++;
          // The visitor's own note always has priority over the guide.
          if (!interaction.dragging && !f.held) softStrike(w, f, 0.18);
        }
        ghost = GHOST_REVEAL + 0.1 * Math.exp(-w.pulseClock * 1.3);
      }

      // ── filaments ────────────────────────────────────────────────────
      for (let i = 0; i < count; i++) fragments[i].bond = 0;
      let anyFit = false;
      for (let k = 0; k < w.bonds.length; k++) {
        const b = w.bonds[k];
        const pair = w.evaluation.pairs[b.pair];
        const fi = fragments[b.i];
        const fj = fragments[b.j];
        let closeness = pair.closeness;
        let target: number;
        if (w.phase === 'locked') {
          closeness = lerp(closeness, 1, lockK);
          target = lerp(Math.max(closeness, ghost), 1, lockK);
        } else if (w.phase === 'opening') {
          // While the membrane tears, the bonds are briefly visible: stretched, then gone.
          target = closeness * 0.55;
        } else {
          target = Math.max(closeness, ghost);
          if (pair.fit >= 1) anyFit = true;
        }
        if (closeness > fi.bond) fi.bond = closeness;
        if (closeness > fj.bond) fj.bond = closeness;
        b.reveal = damp(b.reveal, target, target > b.reveal ? 5 : 3, dt);
        const activity = Math.max(fi.ring, fj.ring, lockK);
        const fil = b.filament;
        fil.setEndpoints(fi.holder.position, fj.holder.position);
        fil.params.reveal = b.reveal * fade;
        fil.params.energy = clamp(b.compat * (0.55 + 0.45 * activity) * (1 + 0.25 * lockK));
        fil.params.tension = 0.25 + 0.75 * closeness;
        fil.params.warmth = 0.15 + 0.45 * lockK;
        fil.object.visible = fil.params.reveal > 0.002 || prewarm;
        fil.sync();
      }
      if (anyFit && !w.pairAnnounced && w.phase === 'play' && !w.exiting) {
        w.pairAnnounced = true;
        ctx.ui.announce('A filament holds between two fragments.');
      }

      // ── fragments: matter and waves ──────────────────────────────────
      let memberRing = 0;
      let outsiderRing = 0;
      const chord = w.phase === 'locked' ? 0.55 * smoothstep(0, 1.5, w.lockT) : 0;
      const gone = w.phase === 'locked' ? smoothstep(0.2, 3.4, w.lockT) : 0;
      for (let i = 0; i < count; i++) {
        const f = fragments[i];
        f.ring = f.held ? 1 : damp(f.ring, 0, 0.8, dt);
        if (f.member) memberRing = Math.max(memberRing, f.ring);
        else outsiderRing = Math.max(outsiderRing, f.ring);

        const p = f.matter.params;
        const born = smoothstep(0, 1.5, t - f.depart);
        p.excite = damp(p.excite, 0, 2.4, dt);
        p.hover = damp(p.hover, f.hovering || f.held ? 1 : 0, 8, dt);
        if (f.member) {
          p.reveal = born * fade;
          p.tension = lerp(0.85, 1, lockK);
          p.warmth = lerp(0.25, 0.65, lockK);
          p.spread = clamp(0.35 + 0.3 * f.ring + 0.2 * f.bond + 0.15 * lockK);
        } else {
          // Duller, slacker, cooler — and after the lock they come apart entirely.
          p.reveal = born * 0.5 * (1 - gone) * fade;
          p.coherence = lerp(0.62, 0, gone);
          p.spread = clamp(0.15 + 0.2 * f.ring + 0.5 * gone);
        }
        const body = f.matter.object;
        body.rotateOnAxis(f.axis, f.spin * dt * (0.3 + 0.7 * motion) * (1 + 2 * f.ring));
        body.position.set(0, Math.sin(t * 0.6 + f.phase) * 0.035 * motion, 0);
        body.visible = p.reveal > 0.002 || prewarm;
        f.matter.sync();

        // A fragment is a wave source exactly as far as it is sounding.
        const wave = bridge.waves[i];
        wave.position.copy(f.holder.position);
        wave.freq = f.freq;
        wave.level = Math.max(f.ring, f.member ? chord : 0) * fade;
      }
      if (w.phase === 'locked' && !w.exiting && (w.frameNo & 7) === 0) {
        // The chord travels with the orbit.
        for (let k = 0; k < members.length; k++) {
          voicePlace.pos.copy(fragments[members[k]].holder.position);
          audio.voiceSet(members[k], voicePlace);
        }
      }

      // ── lattice ──────────────────────────────────────────────────────
      {
        const v = w.volume;
        let reveal = w.latticeReveal;
        let density = w.latticeDensity;
        if (w.exiting) {
          // Thin to a faint remnant, then let even that go so nothing is cut off at disposal.
          const thin = ease(clamp(exitK / 0.6));
          const last = 1 - smoothstep(0.8, 1, exitK);
          reveal = lerp(w.exitReveal, Math.min(w.exitReveal, LATTICE_REMNANT), thin) * last;
          density = lerp(w.exitDensity, w.exitDensity * 0.4, thin);
        }
        v.params.reveal = reveal;
        v.params.density = density;
        v.object.visible = reveal > 0.001 || prewarm;
        v.sync();
      }

      // ── dust ─────────────────────────────────────────────────────────
      {
        const tearBell = w.phase === 'opening' ? Math.sin(Math.PI * clamp((t - TEAR_START) / (TEAR_SECONDS + 1))) : 0;
        const target = (0.06 + 0.22 * tearBell + 0.1 * w.latticeReveal) * fade;
        w.dustReveal = damp(w.dustReveal, target, 1.5, dt);
        w.particles.params.reveal = w.dustReveal;
        w.particles.params.drift = (0.2 + 0.5 * tearBell) * (0.3 + 0.7 * motion);
        w.particles.sync();
      }

      // ── stability ────────────────────────────────────────────────────
      {
        // An unrelated fragment ringing against the others roughens everything.
        const rough = outsiderRing * (memberRing > 0.15 ? 1 : 0.4);
        const target = w.phase === 'locked' ? 1 : clamp(0.32 + 0.6 * w.progress - 0.3 * rough);
        bridge.stability = damp(bridge.stability, target, 2.5, dt);
        bridge.progress = w.progress;
        if (Math.abs(bridge.stability - w.stabilitySent) > 0.01) {
          w.stabilitySent = bridge.stability;
          audio.setStability(bridge.stability);
        }
      }
    },

    assist(level: 1 | 2 | 3, ctx: ChapterContext) {
      const w = world;
      if (!w || w.phase === 'locked' || w.exiting) return;
      live = ctx;
      if (level >= 1 && w.assistLevel < 1) ctx.ui.hint('Some of these were never apart.');
      if (level >= 2 && w.assistLevel < 2) w.pulseClock = PULSE_PERIOD; // first pulse on the next frame
      if (level >= 3 && w.assistLevel < 3) startAuto(w);
      w.assistLevel = Math.max(w.assistLevel, level);
    },

    exit(ctx: ChapterContext) {
      const w = world;
      if (!w || w.exiting) return;
      live = ctx;
      w.exiting = true;
      w.exitT = 0;
      w.exitReveal = w.latticeReveal;
      w.exitDensity = w.latticeDensity;
      for (let i = 0; i < w.fragments.length; i++) {
        const f = w.fragments[i];
        f.item.enabled = false;
        f.item.draggable = false;
        f.hovering = false;
        releaseVoice(f, 3);
      }
      ctx.ui.hint(null);
    },

    dispose(ctx: ChapterContext) {
      const w = world;
      world = null;
      live = null;
      if (!w) return;
      for (let i = 0; i < w.fragments.length; i++) {
        const f = w.fragments[i];
        ctx.interaction.remove(f.item);
        ctx.audio.voiceOff(f.index, 0.3);
        const wave = ctx.bridge.waves[f.index];
        wave.freq = 0;
        wave.level = 0;
        f.matter.dispose();
      }
      for (let k = 0; k < w.bonds.length; k++) w.bonds[k].filament.dispose();
      if (w.membrane) w.membrane.dispose();
      w.volume.dispose();
      w.particles.dispose();
      ctx.stage.scene.remove(w.root);
      w.root.clear();
      ctx.ui.hint(null);
    },
  };

  return chapter;
}
