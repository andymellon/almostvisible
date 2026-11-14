/**
 * CHAPTER I — THE FIRST SIGNAL.  "Before form, there is vibration."
 *
 * Black, near silence, one faint point of light. Three resonators are hidden in the dark as
 * tiny optical distortions that strengthen as the pointer comes near. Touching the point
 * sends out a faint pulse under which the hidden ones glimmer; touching a resonator wakes
 * it: a bell at its degree of the visit's mode, a wave source in its bridge slot, and a
 * sustained pure voice, so the chord accumulates. The membrane behind them is what makes the
 * wavefronts visible, a little more with every tone. When all three sound, the wavefronts
 * overlap and the darkness folds into one interference surface.
 *
 * Bridge slots: 0..2 = the resonators (also their AudioEngine voice ids), 3 = the pulse of
 * the first point (wave only, no voice). All are released on dispose.
 * Colour: monochrome (warmth 0 everywhere); bridge.spectral is left to the Director.
 */
import { Group, Vector3 } from 'three';
import type { CameraPose, Chapter, ChapterContext, Interactive, Matter, Particles } from '../core/contracts';
import { clamp, damp, ease, lerp, smoothstep } from '../core/math';
import { createMatter, createParticles } from '../render/materials';
import {
  RESONATOR_COUNT,
  ResonatorPuzzle,
  assignTones,
  distanceToRay,
  generateSeats,
  proximity,
  safeFrame,
  seatToWorld,
  type ResonatorTone,
  type SafeFrame,
} from '../puzzles/resonators';

const FOCUS = { x: 0, y: 0.12, z: 0 };
const CAMERA_DISTANCE = 6.2;
/** Static, wide, slightly below centre. */
const CAMERA: CameraPose = { position: { x: 0, y: -0.42, z: CAMERA_DISTANCE }, target: FOCUS, fov: 35 };

const MEMBRANE_Z = -0.3;
const TILT_REST = -0.24;
const TILT_FOLDED = -0.52;
const YAW_FOLDED = 0.14;
/** Resonators float just in front of the sheet. */
const LIFT = 0.16;
const DEPTH_RANGE = 0.07;

const HIT_RADIUS = 0.55;
const POINT_SLOT = 3;
const PULSE_SPEED = 1.5; // world units per second
const PULSE_LIFE = 3.2;

/** Seconds the third bell rings before the signature begins. */
const PRE_ROLL = 1.1;
const SIGNATURE_SECONDS = 6;
const EXIT_SECONDS = 3.6;
const AUTO_INTERVAL = 1.5;
const GUIDE_INTERVAL = 5.2;

/** Indexed by the number of resonators awake. */
const MEMBRANE_REVEAL = [0, 0.25, 0.5, 0.62] as const;
const MEMBRANE_COHERENCE = [0.2, 0.3, 0.42, 0.55] as const;
const DUST_REVEAL = [0, 0.07, 0.11, 0.15] as const;

/**
 * Audio levels are fractions of each instrument's nominal full level (1 ≈ −21 dBFS peak).
 * The drone begins as a distant subharmonic, barely audible, and gains a little with every tone.
 */
const DRONE_LEVEL = 0.22;
const VOICE_LEVEL = 0.3;
const VOICE_LEVEL_FOLDED = 0.42;

const TONE_NAME: Record<number, string> = { 0: 'the root', 4: 'the fifth', 2: 'the third' };
const TONE_CAPTION: Record<number, string> = {
  0: 'A low tone wakes. The ground.',
  4: 'A tone wakes, a fifth above the ground.',
  2: 'A bright tone wakes. The third.',
};

interface Resonator {
  matter: Matter;
  interactive: Interactive;
  tone: ResonatorTone;
  /** World position (the chapter root is untransformed). */
  position: Vector3;
  hovered: boolean;
  /** Smoothed pointer proximity 0..1. */
  near: number;
  /** Flash as the first point's pulse passes through. */
  glimmer: number;
  /** Guidance (assist 2) amount 0..1. */
  pulse: number;
}

export function createChapter1(): Chapter {
  let root: Group | null = null;
  let live: ChapterContext | null = null;
  let membrane: Matter | null = null;
  let point: Matter | null = null;
  let pointInteractive: Interactive | null = null;
  let dust: Particles | null = null;
  let puzzle: ResonatorPuzzle | null = null;
  const resonators: Resonator[] = [];
  const positions: Vector3[] = [];

  let time = 0;
  let side = 1;
  let solvedT = -1;
  let signatureStarted = false;
  let complete = false;
  let exitT = -1;
  let exited = false;
  let voicesReleased = false;

  let pulseT = -1;
  let pulseAnnounced = false;
  let pointHovered = false;
  let pointNear = 0;

  let hinted = false;
  let guide = false;
  let guided = -1;
  let guideClock = 0;
  let auto = false;
  let autoClock = 0;

  let sentStability = -1;
  let exitReveal = 0;
  let exitTension = 0;
  let exitSpread = 0;
  let exitDust = 0;

  const frame: SafeFrame = { halfW: 1, halfH: 1 };
  const pointPosition = new Vector3();
  const signaturePose: CameraPose = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 35 };

  /** Depth of the tilted membrane under a world (x, y). */
  const sheetZ = (x: number, y: number, tilt: number, yaw: number) => MEMBRANE_Z + (y - FOCUS.y) * Math.tan(tilt) - x * Math.sin(yaw) * Math.cos(tilt);

  /** Seat the resonators in the live camera frame, floating just in front of the tilted sheet. */
  function place(fovDeg: number, aspect: number, tilt: number, yaw: number): void {
    if (!puzzle) return;
    safeFrame(fovDeg, aspect, CAMERA_DISTANCE, frame);
    for (let i = 0; i < resonators.length; i++) {
      const r = resonators[i];
      seatToWorld(puzzle.seats[i], frame, FOCUS, DEPTH_RANGE, r.position);
      r.position.z += sheetZ(r.position.x, r.position.y, tilt, yaw) + LIFT;
      r.matter.object.position.copy(r.position);
    }
  }

  function strikeAt(ctx: ChapterContext, r: Resonator, velocity: number): void {
    ctx.audio.strike(r.tone.hz, { velocity, pos: r.position, timbre: 'bell' });
    // The image never depends on audio having started: mark the attack on the bridge too.
    ctx.bridge.attack = 1;
    ctx.bridge.attackAt.copy(r.position);
    r.matter.params.excite = 1;
    if (membrane) membrane.params.excite = 1;
  }

  function wake(index: number, ctx: ChapterContext): void {
    if (!puzzle || exitT >= 0 || !puzzle.wake(index)) return;
    const r = resonators[index];
    const { bridge, audio } = ctx;
    strikeAt(ctx, r, 0.85);

    const wave = bridge.waves[index];
    wave.position.copy(r.position);
    wave.freq = r.tone.hz;
    wave.level = 1;
    // The tone stays, softly, so the chord accumulates.
    audio.voiceOn(index, r.tone.hz, { level: VOICE_LEVEL, timbre: 'pure', pos: r.position });
    audio.setDrone(DRONE_LEVEL + 0.07 * puzzle.woken, 0.1 + 0.05 * puzzle.woken);

    r.matter.params.freq = r.tone.hz;
    r.interactive.label = `Resonator ${index + 1} of ${RESONATOR_COUNT}, sounding ${TONE_NAME[r.tone.degree] ?? 'a tone'}`;
    dust?.impulse(r.position, 0.7);
    ctx.ui.announce(TONE_CAPTION[r.tone.degree] ?? 'A tone wakes.');
    ctx.memory.data.resonators = puzzle.order.slice();

    if (guided === index) guided = -1;
    if (puzzle.solved) {
      solvedT = 0;
      guide = false;
      auto = false;
      if (hinted) {
        ctx.ui.hint(null);
        hinted = false;
      }
    }
  }

  function press(index: number): void {
    const ctx = live;
    if (!ctx || !puzzle || exitT >= 0) return;
    if (!puzzle.awake[index]) wake(index, ctx);
    else strikeAt(ctx, resonators[index], 0.45);
  }

  /** The first point answers a touch with a faint pulse; hidden resonators glimmer as it passes. */
  function pulse(): void {
    const ctx = live;
    if (!ctx || !point || exitT >= 0) return;
    pulseT = 0;
    ctx.audio.strike(ctx.harmony.freq(0, 1), { velocity: 0.32, pos: pointPosition, timbre: 'sub' });
    ctx.bridge.attack = Math.max(ctx.bridge.attack, 0.6);
    ctx.bridge.attackAt.copy(pointPosition);
    point.params.excite = 1;
    dust?.impulse(pointPosition, 0.3);
    if (!pulseAnnounced) {
      pulseAnnounced = true;
      ctx.ui.announce('A faint pulse spreads into the dark.');
    }
  }

  function removeInteractives(ctx: ChapterContext): void {
    for (const r of resonators) ctx.interaction.remove(r.interactive);
    if (pointInteractive) ctx.interaction.remove(pointInteractive);
  }

  function releaseVoices(ctx: ChapterContext, seconds: number): void {
    if (voicesReleased || !puzzle) return;
    voicesReleased = true;
    for (let i = 0; i < resonators.length; i++) if (puzzle.awake[i]) ctx.audio.voiceOff(i, seconds);
  }

  function teardown(ctx: ChapterContext): void {
    if (!root) return;
    removeInteractives(ctx);
    ctx.stage.scene.remove(root);
    for (const r of resonators) r.matter.dispose();
    membrane?.dispose();
    point?.dispose();
    dust?.dispose();
    releaseVoices(ctx, 0.4);
    for (let i = 0; i <= POINT_SLOT; i++) {
      ctx.bridge.waves[i].freq = 0;
      ctx.bridge.waves[i].level = 0;
    }
    if (hinted) ctx.ui.hint(null);
    hinted = false;
    resonators.length = 0;
    positions.length = 0;
    root = null;
    membrane = null;
    point = null;
    pointInteractive = null;
    dust = null;
    puzzle = null;
    live = null;
  }

  const chapter: Chapter = {
    index: 0,
    numeral: 'I',
    name: 'The First Signal',
    line: 'Before form, there is vibration.',

    get progress() {
      return puzzle ? puzzle.progress : complete ? 1 : 0;
    },
    get complete() {
      return complete;
    },
    get exited() {
      return exited;
    },

    enter(ctx: ChapterContext) {
      teardown(ctx);
      live = ctx;
      const { harmony, quality, bridge, audio, rig } = ctx;

      time = 0;
      solvedT = -1;
      signatureStarted = false;
      complete = false;
      exitT = -1;
      exited = false;
      voicesReleased = false;
      pulseT = -1;
      pulseAnnounced = false;
      pointHovered = false;
      pointNear = 0;
      hinted = false;
      guide = false;
      guided = -1;
      guideClock = 0;
      auto = false;
      autoClock = 0;
      sentStability = -1;

      const seats = generateSeats(harmony.rand);
      const tones = assignTones(harmony);
      puzzle = new ResonatorPuzzle(seats, tones);
      side = harmony.rand() < 0.5 ? -1 : 1;

      root = new Group();
      root.name = 'chapter-1';

      const sheet: Matter = createMatter(
        'membrane',
        {
          shape: 'plane',
          width: 17,
          height: 10.5,
          detail: 0.9,
          init: { reveal: 0, excite: 0, hover: 0, tension: 0.2, coherence: MEMBRANE_COHERENCE[0], freq: 0, seed: harmony.rand(), warmth: 0, spread: 0.06 },
        },
        quality,
      );
      sheet.object.position.set(FOCUS.x, FOCUS.y, MEMBRANE_Z);
      sheet.object.rotation.set(TILT_REST, 0, 0);
      root.add(sheet.object);
      membrane = sheet;

      const mote: Matter = createMatter(
        'light',
        {
          shape: 'sphere',
          radius: 0.045,
          detail: 0.3,
          init: { reveal: 0, excite: 0, hover: 0, tension: 0.9, coherence: 1, freq: harmony.freq(0, 4), seed: harmony.rand(), warmth: 0, spread: 0.1 },
        },
        quality,
      );
      pointPosition.set(FOCUS.x, FOCUS.y, sheetZ(FOCUS.x, FOCUS.y, TILT_REST, 0) + 0.22);
      mote.object.position.copy(pointPosition);
      root.add(mote.object);
      point = mote;
      pointInteractive = {
        label: 'A faint point of light',
        object: mote.object,
        radius: 0.3,
        enabled: true,
        draggable: false,
        onHover: (h) => {
          pointHovered = h;
        },
        onPress: () => pulse(),
      };
      ctx.interaction.add(pointInteractive);

      for (let i = 0; i < RESONATOR_COUNT; i++) {
        const matter: Matter = createMatter(
          'body',
          {
            shape: 'sphere',
            radius: 0.2,
            detail: 0.55,
            init: { reveal: 0, excite: 0, hover: 0, tension: 0.45, coherence: 0.55, freq: 0, seed: harmony.rand(), warmth: 0, spread: 0.1 },
          },
          quality,
        );
        const position = new Vector3();
        const resonator: Resonator = {
          matter,
          tone: tones[i],
          position,
          hovered: false,
          near: 0,
          glimmer: 0,
          pulse: 0,
          interactive: {
            label: `Hidden resonator ${i + 1} of ${RESONATOR_COUNT}`,
            object: matter.object,
            radius: HIT_RADIUS,
            enabled: true,
            draggable: false,
            onHover: (h) => {
              resonator.hovered = h;
            },
            onPress: () => press(i),
          },
        };
        resonators.push(resonator);
        positions.push(position);
        root.add(matter.object);
        ctx.interaction.add(resonator.interactive);
      }

      place(rig.camera.fov, rig.camera.aspect, TILT_REST, 0);

      const motes: Particles = createParticles(quality.lite ? 320 : 800, quality);
      motes.params.reveal = 0;
      motes.params.drift = quality.reducedMotion ? 0.04 : 0.14;
      root.add(motes.object);
      dust = motes;

      ctx.stage.scene.add(root);

      // Slot 3: the first point's pulse. Low pitch → broad rings. Silent until touched.
      const pulseWave = bridge.waves[POINT_SLOT];
      pulseWave.position.copy(pointPosition);
      pulseWave.freq = harmony.freq(0, 1);
      pulseWave.level = 0;

      if (bridge.presence < 0.02) rig.cut(CAMERA);
      else rig.moveTo(CAMERA, 3);
      rig.drift = quality.reducedMotion ? 0 : 0.22;

      // A distant subharmonic, barely there.
      audio.setDrone(DRONE_LEVEL, 0.1);
      audio.setStability(0.2);
    },

    update(dt: number, ctx: ChapterContext) {
      if (!root || !puzzle || !membrane || !point) return;
      const { bridge, audio, rig, interaction, quality } = ctx;
      const camera = rig.camera;
      time += dt;

      // ── timeline ───────────────────────────────────────────────────────
      if (solvedT >= 0) solvedT += dt;
      if (solvedT >= PRE_ROLL && !signatureStarted) {
        signatureStarted = true;
        const k = quality.reducedMotion ? 0.5 : 1;
        signaturePose.position.x = side * 0.95 * k;
        signaturePose.position.y = lerp(CAMERA.position.y, -0.22, k);
        signaturePose.position.z = lerp(CAMERA_DISTANCE, 5.6, k);
        signaturePose.target.x = side * 0.08 * k;
        signaturePose.target.y = FOCUS.y;
        signaturePose.target.z = -0.15 * k;
        rig.moveTo(signaturePose, quality.reducedMotion ? SIGNATURE_SECONDS * 1.3 : SIGNATURE_SECONDS);
        audio.resolve('signal');
        audio.setDrone(0.6, 0.3);
        for (let i = 0; i < resonators.length; i++) audio.voiceSet(i, { level: VOICE_LEVEL_FOLDED, brightness: 0.5 });
        ctx.ui.announce('Three tones overlap. The darkness folds into a surface.');
      }
      const sigU = signatureStarted ? clamp((solvedT - PRE_ROLL) / SIGNATURE_SECONDS) : 0;
      const fold = ease(sigU);
      if (sigU >= 1) complete = true;

      let exitU = 0;
      if (exitT >= 0) {
        exitT += dt;
        exitU = clamp(exitT / EXIT_SECONDS);
        if (exitU >= 1) exited = true;
      }
      const exiting = exitT >= 0;
      const woken = puzzle.woken;

      // ── assistance ─────────────────────────────────────────────────────
      const pointerSeen = interaction.pointer.seen;
      if (auto && !puzzle.solved && !exiting) {
        autoClock -= dt;
        if (autoClock <= 0) {
          autoClock = AUTO_INTERVAL;
          wake(puzzle.nextAsleep(), ctx);
        }
      }
      if (guide && !puzzle.solved && !exiting) {
        if (guided < 0 || puzzle.awake[guided]) {
          guided = pointerSeen ? puzzle.nearestAsleep(bridge.pointer.x, bridge.pointer.y, positions) : puzzle.nextAsleep();
          guideClock = 0;
        }
        guideClock -= dt;
        if (guideClock <= 0 && guided >= 0) {
          guideClock = GUIDE_INTERVAL;
          const r = resonators[guided];
          audio.strike(r.tone.hz, { velocity: 0.16, pos: r.position, timbre: 'glass' });
          r.glimmer = Math.max(r.glimmer, 0.8);
        }
      } else {
        guided = -1;
      }

      // ── the membrane's pose, and the resonators that float on it ───────
      const tilt = lerp(TILT_REST, TILT_FOLDED, fold);
      const yaw = side * YAW_FOLDED * fold;
      membrane.object.rotation.set(tilt, yaw, 0);

      place(camera.fov, camera.aspect, tilt, yaw);

      // ── the first point and its pulse ──────────────────────────────────
      let pulseEnv = 0;
      let pulseRadius = 0;
      if (pulseT >= 0) {
        pulseT += dt;
        if (pulseT >= PULSE_LIFE) pulseT = -1;
        else {
          const k = 1 - pulseT / PULSE_LIFE;
          pulseEnv = k * k;
          pulseRadius = pulseT * PULSE_SPEED;
        }
      }
      const pulseWave = bridge.waves[POINT_SLOT];
      pulseWave.position.copy(pointPosition);
      pulseWave.level = exiting ? 0 : pulseEnv;

      const pointDistance = pointerSeen ? distanceToRay(pointPosition, camera.position, bridge.pointer) : Infinity;
      pointNear = damp(pointNear, Math.max(proximity(pointDistance, 0.15, 1.2), pointHovered ? 1 : 0), 5, dt);
      const pp = point.params;
      const pointIn = smoothstep(0.6, 5.5, time);
      const breath = quality.reducedMotion ? 0 : 0.07 * Math.sin(time * 1.1);
      const pointTarget = pointIn * (0.5 + breath + 0.3 * pointNear) * (1 - 0.7 * fold) * (1 - smoothstep(0, 0.5, exitU));
      pp.reveal = damp(pp.reveal, pointTarget, 4, dt);
      pp.hover = pointNear;
      pp.excite = Math.max(0, pp.excite - dt / 1.2);
      point.sync();

      // ── resonators ─────────────────────────────────────────────────────
      const bodiesOut = 1 - smoothstep(0.05, 0.6, exitU);
      for (let i = 0; i < resonators.length; i++) {
        const r = resonators[i];
        const p = r.matter.params;
        const awake = puzzle.awake[i];

        const distance = pointerSeen ? distanceToRay(r.position, camera.position, bridge.pointer) : Infinity;
        r.near = damp(r.near, Math.max(proximity(distance), r.hovered ? 1 : 0), 6, dt);

        if (pulseEnv > 0) {
          const d = (pulseRadius - r.position.distanceTo(pointPosition)) / 0.4;
          r.glimmer = Math.max(r.glimmer, Math.exp(-d * d) * Math.sqrt(pulseEnv));
        }
        r.glimmer *= Math.exp(-2.4 * dt);
        r.pulse = damp(r.pulse, guide && guided === i && !awake ? 1 : 0, 3, dt);

        let reveal: number;
        if (awake) {
          reveal = 0.86 + 0.14 * fold;
          p.coherence = damp(p.coherence, 1, 3, dt);
          p.tension = damp(p.tension, 0.72, 3, dt);
          p.spread = damp(p.spread, 0.36, 3, dt);
        } else {
          // Asleep: a tiny optical distortion that strengthens as the pointer nears.
          const breathing = 0.3 + 0.16 * Math.sin(time * 2.1);
          reveal = 0.03 + 0.34 * r.near * r.near + 0.4 * r.glimmer + r.pulse * breathing;
        }
        p.reveal = damp(p.reveal, clamp(reveal) * bodiesOut, awake ? 3.5 : 7, dt);
        p.hover = Math.max(r.near, r.pulse * 0.5);
        p.excite = Math.max(0, p.excite - dt / 1.4);
        r.matter.sync();

        const wave = bridge.waves[i];
        if (awake) {
          wave.position.copy(r.position);
          wave.level = exiting ? 0.4 * (1 - smoothstep(0.3, 0.75, exitU)) : 1;
        }
      }

      // ── the membrane: what makes the wavefronts visible ────────────────
      const mp = membrane.params;
      mp.excite = Math.max(0, mp.excite - dt / 1.6);
      if (!exiting) {
        const reveal = lerp(MEMBRANE_REVEAL[woken], 1, fold);
        const hush = woken === 0 ? 1 : 0.4;
        mp.reveal = damp(mp.reveal, reveal + pulseEnv * 0.07 * hush * (1 - reveal), 2.2, dt);
        mp.coherence = damp(mp.coherence, lerp(MEMBRANE_COHERENCE[woken], 1, fold), 2.2, dt);
        mp.tension = damp(mp.tension, lerp(0.2 + 0.08 * woken, 0.85, fold), 2.2, dt);
        mp.spread = damp(mp.spread, lerp(0.06 + 0.06 * woken, 0.7, fold), 2.2, dt);
      } else {
        // Relax to a calm, low sheet, then let it go.
        const calm = smoothstep(0, 0.4, exitU);
        const gone = smoothstep(0.35, 1, exitU);
        mp.reveal = lerp(exitReveal, Math.min(exitReveal, 0.2), calm) * (1 - gone);
        mp.tension = lerp(exitTension, 0.35, calm);
        mp.spread = lerp(exitSpread, 0.12, calm);
      }
      membrane.sync();

      if (dust) {
        if (!exiting) dust.params.reveal = damp(dust.params.reveal, lerp(DUST_REVEAL[woken], 0.2, fold), 1.5, dt);
        else dust.params.reveal = exitDust * (1 - smoothstep(0, 0.8, exitU));
        dust.sync();
      }

      // ── coherence of the whole ─────────────────────────────────────────
      bridge.stability = damp(bridge.stability, lerp(0.2 + 0.1 * woken, 1, fold), 2, dt);
      if (Math.abs(bridge.stability - sentStability) > 0.01) {
        sentStability = bridge.stability;
        audio.setStability(sentStability);
      }
    },

    assist(level: 1 | 2 | 3, ctx: ChapterContext) {
      if (!puzzle || puzzle.solved || exitT >= 0) return;
      if (level === 1) {
        ctx.ui.hint('Something answers when you come near.');
        hinted = true;
      } else if (level === 2) {
        // The nearest sleeper breathes into view, with a faint glass tone.
        guide = true;
        guided = -1;
      } else {
        // The remaining resonators wake by themselves, one by one.
        guide = false;
        auto = true;
        autoClock = 0.5;
      }
    },

    exit(ctx: ChapterContext) {
      if (exitT >= 0) return;
      exitT = 0;
      guide = false;
      auto = false;
      removeInteractives(ctx);
      releaseVoices(ctx, 3.2);
      if (hinted) {
        ctx.ui.hint(null);
        hinted = false;
      }
      exitReveal = membrane ? membrane.params.reveal : 0;
      exitTension = membrane ? membrane.params.tension : 0;
      exitSpread = membrane ? membrane.params.spread : 0;
      exitDust = dust ? dust.params.reveal : 0;
      if (!root) exited = true;
    },

    dispose(ctx: ChapterContext) {
      teardown(ctx);
    },
  };

  return chapter;
}
