/**
 * CHAPTER II — THE SPACE BETWEEN.  "Listen to the space between."
 *
 * Three translucent bodies, three sustained glass voices, three wave sources.
 *   A  root × 4                 fixed
 *   B  a just fifth above A     fixed — with A, the stable pair
 *   C  the third voice, 35–70 cents away from where it would rest: the mode's tenth over A
 *      (A × 2·ratios[2]; see puzzles/tuning.ts for why this one ratio)
 * C can be drawn along a smooth S-shaped path; its position on the path is its pitch.
 * While it is out of tune the bridge makes the interference on the membrane crawl at the
 * beat rate, and the voice beats audibly against a quiet sympathetic tone that sounds where
 * C would rest (in the major modes this is the summation tone of the pair, A + B). Nearer:
 * the beating slows, surface tension rises, filaments appear between the bodies. Held within
 * six cents for 1.2 s, the competing patterns resolve into one coherent membrane.
 *
 * Bridge slots / voice ids: 0 = A, 1 = B, 2 = C (wave + glass voice each),
 * 3 = the sympathetic tone (voice only, no wave). All released on dispose.
 * Colour: ivory with a faint blue (warmth slightly negative); spectral is nudged to 0.3 at
 * the signature.
 *
 * The path ghost is the only material defined here: a hairline ribbon, additive,
 * display-referred, depth-tested but not depth-written.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, Mesh, Object3D, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { CameraPose, Chapter, ChapterContext, Filament, Interactive, Matter } from '../core/contracts';
import { clamp, damp, ease, lerp, smoothstep } from '../core/math';
import { createFilament, createMatter } from '../render/materials';
import { ALIGN_CENTS, TuningPath, TuningPuzzle, createTuning, magnetT, type TuningSpec } from '../puzzles/tuning';

const CAMERA_DISTANCE = 6.6;
const CAMERA: CameraPose = { position: { x: 0, y: 0.15, z: CAMERA_DISTANCE }, target: { x: 0, y: 0.05, z: 0 }, fov: 35 };
/** Back and up: the change of scale at the signature. */
const CAMERA_WIDE: CameraPose = { position: { x: 0, y: 2.7, z: 12.4 }, target: { x: 0, y: -0.15, z: -1 }, fov: 35 };

const MEMBRANE_Y = -0.1;
const MEMBRANE_Z = -1;
const TILT_REST = -0.34;
const TILT_OPEN = -0.6;

const RADIUS_A = 0.4;
const RADIUS_B = 0.33;
const RADIUS_C = 0.27;
const WARMTH = -0.22;

const SYMPATHETIC_SLOT = 3;
const SIGNATURE_SECONDS = 5;
const COMPLETE_AFTER = 5.4;
const SETTLE_SECONDS = 0.9;
const GLIDE_SECONDS = 3;
const EXIT_SECONDS = 3.9;
const SWAY = 0.012;
/** Voice levels as fractions of nominal full level: A, B, C, and the quiet sympathetic tone. */
const VOICE_LEVEL = [0.75, 0.62, 0.68, 0.14] as const;

const GHOST_VERTEX = /* glsl */ `
attribute vec3 aTangent;
attribute float aSide;
attribute float aT;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uTarget;
uniform float uGuide;
varying float vT;
varying float vSide;
void main() {
  vec4 centre = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 ahead = projectionMatrix * modelViewMatrix * vec4(position + aTangent * 0.05, 1.0);
  vec2 dir = (ahead.xy / ahead.w - centre.xy / centre.w) * uViewport;
  dir /= max(length(dir), 1e-5);
  float m = (aT - uTarget) / 0.012;
  float mark = uGuide * exp(-m * m);
  float halfWidth = uWidth * (1.0 + 2.2 * mark);
  centre.xy += vec2(-dir.y, dir.x) * aSide * halfWidth * 2.0 / uViewport * centre.w;
  gl_Position = centre;
  vT = aT;
  vSide = aSide;
}
`;

const GHOST_FRAGMENT = /* glsl */ `
precision highp float;
uniform float uC;
uniform float uTarget;
uniform float uHover;
uniform float uGuide;
uniform float uFade;
uniform float uTime;
varying float vT;
varying float vSide;
void main() {
  float edge = 1.0 - smoothstep(0.25, 1.0, abs(vSide));
  float d = (vT - uC) / 0.11;
  float near = exp(-0.5 * d * d);
  float ends = smoothstep(0.0, 0.04, vT) * smoothstep(1.0, 0.96, vT);
  float line = (uHover * near * 0.3 + uGuide * (0.13 + 0.17 * near)) * ends;
  float m = (vT - uTarget) / 0.012;
  float mark = uGuide * exp(-m * m) * (0.7 + 0.2 * sin(uTime * 2.2));
  // Ivory with a faint blue; the mark at the resting place is a little warmer and brighter.
  vec3 colour = mix(vec3(0.78, 0.84, 0.94), vec3(0.98, 0.96, 0.9), clamp(mark, 0.0, 1.0));
  float alpha = (line + mark) * edge * uFade;
  gl_FragColor = vec4(colour * alpha, 1.0);
}
`;

interface Ghost {
  mesh: Mesh;
  geometry: BufferGeometry;
  material: ShaderMaterial;
  positions: Float32Array;
  tangents: Float32Array;
}

function createGhost(path: TuningPath): Ghost {
  const n = path.count;
  const positions = new Float32Array(n * 2 * 3);
  const tangents = new Float32Array(n * 2 * 3);
  const sides = new Float32Array(n * 2);
  const ts = new Float32Array(n * 2);
  const index = new Uint16Array((n - 1) * 6);
  for (let i = 0; i < n; i++) {
    sides[i * 2] = -1;
    sides[i * 2 + 1] = 1;
    ts[i * 2] = ts[i * 2 + 1] = i / (n - 1);
    if (i < n - 1) {
      const a = i * 2;
      index.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], i * 6);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aTangent', new BufferAttribute(tangents, 3));
  geometry.setAttribute('aSide', new BufferAttribute(sides, 1));
  geometry.setAttribute('aT', new BufferAttribute(ts, 1));
  geometry.setIndex(new BufferAttribute(index, 1));
  const material = new ShaderMaterial({
    vertexShader: GHOST_VERTEX,
    fragmentShader: GHOST_FRAGMENT,
    uniforms: {
      uViewport: { value: new Vector2(1280, 720) },
      uWidth: { value: 1.25 },
      uC: { value: 0 },
      uTarget: { value: 0.5 },
      uHover: { value: 0 },
      uGuide: { value: 0 },
      uFade: { value: 0 },
      uTime: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = 'tuning-path-ghost';
  return { mesh, geometry, material, positions, tangents };
}

export function createChapter2(): Chapter {
  let root: Group | null = null;
  let live: ChapterContext | null = null;
  let membrane: Matter | null = null;
  let bodyA: Matter | null = null;
  let bodyB: Matter | null = null;
  let bodyC: Matter | null = null;
  let filAB: Filament | null = null;
  let filAC: Filament | null = null;
  let filBC: Filament | null = null;
  let ghost: Ghost | null = null;
  let handle: Object3D | null = null;
  let interactiveA: Interactive | null = null;
  let interactiveB: Interactive | null = null;
  let interactiveC: Interactive | null = null;
  let spec: TuningSpec | null = null;
  let puzzle: TuningPuzzle | null = null;
  const path = new TuningPath();

  let time = 0;
  let aspect = 0;
  let fov = 0;
  let phaseA = 0;
  let phaseB = 0;

  let cT = 0;
  let cLive = false;
  let touched = false;
  let hoverA = false;
  let hoverB = false;
  let hoverC = false;
  let hoverAmtA = 0;
  let hoverAmtB = 0;
  let hoverAmtC = 0;
  let invite = 1;
  let stab = 0;

  let hinted = false;
  let guide = false;
  let guideAmt = 0;
  let glideU = -1;
  let glideFrom = 0;

  let solvedT = -1;
  let settleFrom = 0;
  let complete = false;
  let exitT = -1;
  let exited = false;
  let voicesOn = false;

  let zone = 0;
  let announceClock = 0;
  let sentHz = 0;
  let sentLevel = 0;
  let sentStability = -1;
  let exitReveal = 0;
  let exitCoherence = 0;

  const baseA = new Vector3();
  const baseB = new Vector3();
  const posA = new Vector3();
  const posB = new Vector3();
  const posC = new Vector3();
  const sentPosC = new Vector3();
  const scratchA = new Vector3();
  const scratchB = new Vector3();
  /** Reused parameter objects for the per-frame voice updates (no allocation while dragging). */
  const tuneParam: { freq: number } = { freq: 0 };
  const tuneMoveParam: { freq: number; pos: Vector3 } = { freq: 0, pos: sentPosC };
  const levelParam: { level: number } = { level: 0 };
  const widePose: CameraPose = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 35 };

  /** Fit the composition to the frame: pair low, the path across (landscape) or up (portrait) the frame. */
  function layout(nextAspect: number, nextFov: number): void {
    aspect = nextAspect;
    fov = nextFov;
    const halfH = Math.tan((fov * Math.PI) / 360) * CAMERA_DISTANCE;
    const w = Math.min(halfH * aspect * 0.82, 3);
    const h = Math.min(halfH, 2.6);
    const tall = 1 - smoothstep(0.75, 1.25, aspect);
    path.rebuild(w, h, tall);
    baseA.set(lerp(-0.42, -0.52, tall) * w, lerp(-0.36, -0.5, tall) * h, 0.12);
    baseB.set(lerp(0.3, 0.46, tall) * w, lerp(-0.46, -0.62, tall) * h, -0.22);

    if (ghost) {
      const n = path.count;
      const p = ghost.positions;
      const tg = ghost.tangents;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        path.point(t, scratchA);
        path.tangent(t, scratchB);
        for (let k = 0; k < 2; k++) {
          const o = (i * 2 + k) * 3;
          p[o] = scratchA.x;
          p[o + 1] = scratchA.y;
          p[o + 2] = scratchA.z;
          tg[o] = scratchB.x;
          tg[o + 1] = scratchB.y;
          tg[o + 2] = scratchB.z;
        }
      }
      ghost.geometry.attributes.position.needsUpdate = true;
      ghost.geometry.attributes.aTangent.needsUpdate = true;
    }
    // The handle keeps its place on the (new) path.
    if (handle) path.point(cT, handle.position);
  }

  function ring(ctx: ChapterContext, matter: Matter, hz: number, position: Vector3, velocity: number): void {
    ctx.audio.strike(hz, { velocity, pos: position, timbre: 'glass' });
    ctx.bridge.attack = Math.max(ctx.bridge.attack, velocity);
    ctx.bridge.attackAt.copy(position);
    matter.params.excite = 1;
  }

  function releaseC(ctx: ChapterContext): void {
    if (!cLive) return;
    cLive = false;
    if (interactiveC) ctx.interaction.remove(interactiveC);
    hoverC = false;
  }

  function removeInteractives(ctx: ChapterContext): void {
    releaseC(ctx);
    if (interactiveA) ctx.interaction.remove(interactiveA);
    if (interactiveB) ctx.interaction.remove(interactiveB);
    hoverA = hoverB = false;
  }

  function releaseVoices(ctx: ChapterContext, seconds: number): void {
    if (!voicesOn) return;
    voicesOn = false;
    for (let i = 0; i <= SYMPATHETIC_SLOT; i++) ctx.audio.voiceOff(i, seconds);
  }

  function setFilament(f: Filament, a: Vector3, ra: number, b: Vector3, rb: number): void {
    scratchA.subVectors(b, a);
    const len = scratchA.length();
    if (len < 1e-5) return;
    scratchA.multiplyScalar(1 / len);
    scratchB.copy(b).addScaledVector(scratchA, -Math.min(rb, len * 0.45));
    scratchA.multiplyScalar(Math.min(ra, len * 0.45)).add(a);
    f.setEndpoints(scratchA, scratchB);
  }

  function teardown(ctx: ChapterContext): void {
    if (!root) return;
    removeInteractives(ctx);
    ctx.stage.scene.remove(root);
    membrane?.dispose();
    bodyA?.dispose();
    bodyB?.dispose();
    bodyC?.dispose();
    filAB?.dispose();
    filAC?.dispose();
    filBC?.dispose();
    if (ghost) {
      ghost.geometry.dispose();
      ghost.material.dispose();
    }
    releaseVoices(ctx, 0.4);
    for (let i = 0; i <= SYMPATHETIC_SLOT; i++) {
      ctx.bridge.waves[i].freq = 0;
      ctx.bridge.waves[i].level = 0;
    }
    if (hinted) ctx.ui.hint(null);
    hinted = false;
    root = null;
    membrane = bodyA = bodyB = bodyC = null;
    filAB = filAC = filBC = null;
    ghost = null;
    handle = null;
    interactiveA = interactiveB = interactiveC = null;
    spec = null;
    puzzle = null;
    live = null;
  }

  const chapter: Chapter = {
    index: 1,
    numeral: 'II',
    name: 'The Space Between',
    line: 'Listen to the space between.',

    get progress() {
      return complete || (puzzle !== null && puzzle.solved) ? 1 : clamp(stab);
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
      touched = false;
      hoverA = hoverB = hoverC = false;
      hoverAmtA = hoverAmtB = hoverAmtC = 0;
      invite = 1;
      hinted = false;
      guide = false;
      guideAmt = 0;
      glideU = -1;
      solvedT = -1;
      complete = false;
      exitT = -1;
      exited = false;
      zone = 0;
      announceClock = 0;
      sentStability = -1;

      const tuning = createTuning(harmony);
      spec = tuning;
      puzzle = new TuningPuzzle(tuning);
      cT = tuning.startT;
      stab = puzzle.stability;
      phaseA = harmony.rand() * Math.PI * 2;
      phaseB = harmony.rand() * Math.PI * 2;

      root = new Group();
      root.name = 'chapter-2';

      const sheet: Matter = createMatter(
        'membrane',
        {
          shape: 'plane',
          width: 11,
          height: 7,
          detail: 0.9,
          init: { reveal: 0, excite: 0, hover: 0, tension: 0.15, coherence: 0.3, freq: 0, seed: harmony.rand(), warmth: WARMTH, spread: 0.2 },
        },
        quality,
      );
      sheet.object.position.set(0, MEMBRANE_Y, MEMBRANE_Z);
      sheet.object.rotation.set(TILT_REST, 0, 0);
      root.add(sheet.object);
      membrane = sheet;

      const body = (radius: number, hz: number, coherence: number): Matter =>
        createMatter(
          'body',
          {
            shape: 'sphere',
            radius,
            detail: 0.7,
            init: { reveal: 0, excite: 0, hover: 0, tension: 0.7, coherence, freq: hz, seed: harmony.rand(), warmth: WARMTH, spread: 0.3 },
          },
          quality,
        );
      const a = body(RADIUS_A, tuning.anchorHz, 1);
      const b = body(RADIUS_B, tuning.fifthHz, 1);
      const c = body(RADIUS_C, puzzle.hz, 0.5);
      bodyA = a;
      bodyB = b;
      bodyC = c;
      root.add(a.object, b.object, c.object);

      const group = root;
      const filament = (): Filament => {
        const f: Filament = createFilament(quality);
        f.params.reveal = 0;
        f.params.energy = 0.3;
        f.params.tension = 0.3;
        f.params.warmth = WARMTH;
        group.add(f.object);
        return f;
      };
      filAB = filament();
      filAC = filament();
      filBC = filament();

      ghost = createGhost(path);
      ghost.material.uniforms.uTarget.value = tuning.targetT;
      root.add(ghost.mesh);

      handle = new Object3D();
      handle.name = 'tuning-handle';
      root.add(handle);

      layout(rig.camera.aspect, rig.camera.fov);
      posA.copy(baseA);
      posB.copy(baseB);
      path.point(cT, posC);
      sentPosC.copy(posC);
      a.object.position.copy(posA);
      b.object.position.copy(posB);
      c.object.position.copy(posC);

      interactiveA = {
        label: 'The low tone, at rest',
        object: a.object,
        radius: 0.5,
        enabled: true,
        draggable: false,
        onHover: (h) => {
          hoverA = h;
        },
        onPress: () => {
          if (live && spec && exitT < 0) ring(live, a, spec.anchorHz, posA, 0.5);
        },
      };
      interactiveB = {
        label: 'The fifth above it, at rest',
        object: b.object,
        radius: 0.45,
        enabled: true,
        draggable: false,
        onHover: (h) => {
          hoverB = h;
        },
        onPress: () => {
          if (live && spec && exitT < 0) ring(live, b, spec.fifthHz, posB, 0.45);
        },
      };
      interactiveC = {
        label: 'The third tone, not yet at rest. Draw it along its path.',
        object: handle,
        radius: 0.6,
        enabled: true,
        draggable: true,
        constrain: (desired) => {
          path.point(path.nearestT(desired.x, desired.y, desired.z), desired);
        },
        magnet: (desired, dragging) => {
          if (!spec) return;
          const t = path.nearestT(desired.x, desired.y, desired.z);
          path.point(magnetT(spec, t, dragging), desired);
        },
        onHover: (h) => {
          hoverC = h;
        },
        onPress: () => {
          touched = true;
          if (live && puzzle && exitT < 0) ring(live, c, puzzle.hz, posC, 0.4);
        },
      };
      cLive = true;
      // C first: it is the one to find by keyboard.
      ctx.interaction.add(interactiveC);
      ctx.interaction.add(interactiveA);
      ctx.interaction.add(interactiveB);

      ctx.stage.scene.add(root);

      const hz = [tuning.anchorHz, tuning.fifthHz, puzzle.hz];
      const at = [posA, posB, posC];
      for (let i = 0; i < 3; i++) {
        const wave = bridge.waves[i];
        wave.position.copy(at[i]);
        wave.freq = hz[i];
        wave.level = 0;
        // Voices open silent and rise with the image (see update).
        audio.voiceOn(i, hz[i], { level: 0, timbre: 'glass', pos: at[i] });
      }
      // Where C would rest, something already sounds, very quietly, in the space between the pair.
      scratchA.addVectors(posA, posB).multiplyScalar(0.5);
      audio.voiceOn(SYMPATHETIC_SLOT, tuning.targetHz, { level: 0, timbre: 'pure', pos: scratchA });
      voicesOn = true;
      sentHz = puzzle.hz;
      sentLevel = 0;
      audio.setDrone(0.5, 0.2);
      audio.setStability(stab);

      if (bridge.presence < 0.02) rig.cut(CAMERA);
      else rig.moveTo(CAMERA, quality.reducedMotion ? 4.2 : 3.2);
      rig.drift = quality.reducedMotion ? 0 : 0.3;
    },

    update(dt: number, ctx: ChapterContext) {
      if (!root || !spec || !puzzle || !membrane || !bodyA || !bodyB || !bodyC || !filAB || !filAC || !filBC || !ghost || !handle) return;
      const { bridge, audio, rig, interaction, quality } = ctx;
      const calm = quality.reducedMotion;
      time += dt;

      const camera = rig.camera;
      if (exitT < 0 && solvedT < 0 && (Math.abs(camera.aspect - aspect) > 0.005 || Math.abs(camera.fov - fov) > 0.05)) layout(camera.aspect, camera.fov);

      // ── timeline ───────────────────────────────────────────────────────
      if (solvedT >= 0) solvedT += dt;
      const sigU = solvedT >= 0 ? clamp(solvedT / SIGNATURE_SECONDS) : 0;
      const open = ease(sigU);
      if (solvedT >= COMPLETE_AFTER) complete = true;
      let exitU = 0;
      if (exitT >= 0) {
        exitT += dt;
        exitU = clamp(exitT / EXIT_SECONDS);
        if (exitU >= 1) exited = true;
      }
      const exiting = exitT >= 0;
      const fadeIn = smoothstep(0.3, 3.5, time);
      const dissolve = smoothstep(0, 0.4, exitU);

      // ── where C is ─────────────────────────────────────────────────────
      const dragging = cLive && interaction.dragging === interactiveC;
      if (dragging) touched = true;
      const engaged = dragging || hoverC;
      // Idle, C sways a little along its path: an invitation that fades once it is taken up.
      const inviting = cLive && !engaged && glideU < 0 && solvedT < 0 && !exiting;
      invite = damp(invite, inviting ? (touched ? 0.4 : 1) * (1 - smoothstep(0.45, 0.85, puzzle.stability)) : 0, 3, dt);
      if (solvedT >= 0) {
        // Come exactly to rest.
        cT = lerp(settleFrom, spec.targetT, ease(clamp(solvedT / SETTLE_SECONDS)));
      } else if (glideU >= 0) {
        glideU = Math.min(1, glideU + dt / GLIDE_SECONDS);
        cT = lerp(glideFrom, spec.targetT, ease(glideU));
      } else if (cLive) {
        const sway = Math.sin(time * 0.9) * SWAY * invite * (calm ? 0.5 : 1);
        cT = clamp(path.nearestT(handle.position.x, handle.position.y, handle.position.z) + sway);
      }
      path.point(cT, posC);

      // ── the puzzle ─────────────────────────────────────────────────────
      if (puzzle.step(exiting ? 0 : dt, cT)) {
        solvedT = 0;
        settleFrom = cT;
        guide = false;
        releaseC(ctx);
        ctx.memory.data.tuning = { ratio: puzzle.ratio, seconds: puzzle.seconds };
        if (hinted) {
          ctx.ui.hint(null);
          hinted = false;
        }
        ctx.ui.announce('The beating stops. Three tones, one surface.');
        audio.resolve('consonance');
        audio.setDrone(0.65, 0.35);
        for (let i = 0; i < 3; i++) audio.voiceSet(i, { brightness: 0.7 });
        const k = calm ? 0.55 : 1;
        widePose.position.x = 0;
        widePose.position.y = lerp(CAMERA.position.y, CAMERA_WIDE.position.y, k);
        widePose.position.z = lerp(CAMERA.position.z, CAMERA_WIDE.position.z, k);
        widePose.target.x = 0;
        widePose.target.y = lerp(CAMERA.target.y, CAMERA_WIDE.target.y, k);
        widePose.target.z = lerp(CAMERA.target.z, CAMERA_WIDE.target.z, k);
        rig.moveTo(widePose, calm ? SIGNATURE_SECONDS * 1.3 : SIGNATURE_SECONDS);
      }
      const solved = puzzle.solved;
      stab = damp(stab, puzzle.stability, 6, dt);

      // Captions for what the ear is told by the beating.
      announceClock -= dt;
      if (!solved && !exiting) {
        const error = Math.abs(puzzle.cents);
        const next = error <= ALIGN_CENTS ? 2 : error < (zone === 0 ? 22 : 28) ? 1 : 0;
        if (next !== zone && announceClock <= 0) {
          if (next === 2) ctx.ui.announce(glideU >= 0 ? 'Almost still.' : 'Almost still. Hold it there.');
          else if (next === 1 && zone === 0) ctx.ui.announce('The beating slows.');
          else if (next === 0) ctx.ui.announce('The beating quickens.');
          zone = next;
          announceClock = 3.5;
        }
      }

      // ── bodies ─────────────────────────────────────────────────────────
      const bob = calm ? 0.015 : 0.05;
      posA.set(baseA.x, baseA.y + Math.sin(time * 0.47 + phaseA) * bob, baseA.z + Math.cos(time * 0.31 + phaseA) * bob * 0.6 - 0.6 * dissolve);
      posB.set(baseB.x, baseB.y + Math.sin(time * 0.39 + phaseB) * bob, baseB.z + Math.cos(time * 0.27 + phaseB) * bob * 0.6 - 0.5 * dissolve);
      posC.z -= 0.6 * dissolve;
      bodyA.object.position.copy(posA);
      bodyB.object.position.copy(posB);
      bodyC.object.position.copy(posC);

      hoverAmtA = damp(hoverAmtA, hoverA ? 1 : 0, 6, dt);
      hoverAmtB = damp(hoverAmtB, hoverB ? 1 : 0, 6, dt);
      hoverAmtC = damp(hoverAmtC, engaged ? 1 : 0, 6, dt);
      guideAmt = damp(guideAmt, guide && !solved ? 1 : 0, 2.5, dt);
      const bodyReveal = fadeIn * (1 - dissolve);
      const guidePulse = guideAmt * (0.5 + 0.5 * Math.sin(time * 2.4));

      const pa = bodyA.params;
      pa.reveal = 0.9 * bodyReveal;
      pa.hover = hoverAmtA;
      pa.excite = Math.max(0, pa.excite - dt / 1.4);
      pa.coherence = 1 - 0.8 * dissolve;
      pa.tension = 0.72 + 0.15 * open;
      bodyA.sync();

      const pb = bodyB.params;
      pb.reveal = 0.9 * bodyReveal;
      pb.hover = hoverAmtB;
      pb.excite = Math.max(0, pb.excite - dt / 1.4);
      pb.coherence = 1 - 0.8 * dissolve;
      pb.tension = 0.72 + 0.15 * open;
      bodyB.sync();

      // C is visibly unsettled: slack, fanned apart, torn — until it is in tune.
      const pc = bodyC.params;
      pc.reveal = (0.82 + 0.1 * stab) * bodyReveal;
      pc.hover = Math.max(hoverAmtC, 0.6 * guidePulse);
      pc.excite = Math.max(Math.max(0, pc.excite - dt / 1.4), 0.45 * guidePulse);
      pc.coherence = (0.45 + 0.55 * stab) * (1 - 0.8 * dissolve);
      pc.tension = 0.28 + 0.6 * stab;
      pc.spread = 0.3 + 0.3 * (1 - stab);
      pc.freq = puzzle.hz;
      bodyC.sync();

      // ── sound and wave sources share one model ─────────────────────────
      const waveLevel = fadeIn * (1 - smoothstep(0.35, 0.8, exitU));
      const wa = bridge.waves[0];
      wa.position.copy(posA);
      wa.level = waveLevel;
      const wb = bridge.waves[1];
      wb.position.copy(posB);
      wb.level = 0.85 * waveLevel;
      const wc = bridge.waves[2];
      wc.position.copy(posC);
      wc.freq = puzzle.hz;
      wc.level = 0.9 * waveLevel;

      if (voicesOn) {
        if (fadeIn - sentLevel > 0.02 || (fadeIn >= 1 && sentLevel < 1)) {
          sentLevel = fadeIn;
          for (let i = 0; i <= SYMPATHETIC_SLOT; i++) {
            levelParam.level = VOICE_LEVEL[i] * sentLevel;
            audio.voiceSet(i, levelParam);
          }
        }
        if (Math.abs(puzzle.hz - sentHz) > 0.01) {
          sentHz = puzzle.hz;
          if (sentPosC.distanceToSquared(posC) > 0.01) {
            sentPosC.copy(posC);
            tuneMoveParam.freq = sentHz;
            audio.voiceSet(2, tuneMoveParam);
          } else {
            tuneParam.freq = sentHz;
            audio.voiceSet(2, tuneParam);
          }
        }
      }

      const stability = solved ? Math.max(stab, open) : stab;
      bridge.stability = damp(bridge.stability, stability, 5, dt);
      if (Math.abs(bridge.stability - sentStability) > 0.01) {
        sentStability = bridge.stability;
        audio.setStability(sentStability);
      }
      if (solved) bridge.spectral = Math.max(bridge.spectral, 0.3 * open);

      // ── the membrane ───────────────────────────────────────────────────
      const mp = membrane.params;
      if (!exiting) {
        // Surface tension rises as the beating slows; at the signature everything opens to 1.
        mp.reveal = lerp(fadeIn * (0.42 + 0.2 * stab), 1, open);
        mp.coherence = lerp(0.3 + 0.4 * stab, 1, open);
        mp.tension = lerp(0.15 + 0.55 * stab, 0.92, open);
        mp.spread = lerp(0.2 + 0.15 * stab, 1, open);
      } else {
        // The bodies have gone into it; it holds, then tears.
        const tear = smoothstep(0.5, 0.92, exitU);
        mp.coherence = exitCoherence * (1 - tear);
        mp.reveal = exitReveal * (1 - smoothstep(0.62, 1, exitU));
      }
      membrane.object.rotation.x = lerp(TILT_REST, TILT_OPEN, open);
      membrane.object.scale.set(lerp(1, 1.3, open), lerp(1, 1.1, open), 1);
      membrane.sync();

      // ── filaments: reveal ∝ stability ──────────────────────────────────
      const threads = fadeIn * (1 - dissolve);
      const taut = 0.3 + 0.7 * stab;
      setFilament(filAB, posA, RADIUS_A, posB, RADIUS_B);
      filAB.params.reveal = threads * (0.16 + 0.5 * stab);
      filAB.params.energy = 0.3;
      filAB.params.tension = taut;
      filAB.sync();
      const toC = threads * 0.9 * Math.pow(stab, 1.4);
      const restless = lerp(0.9, 0.3, stab);
      setFilament(filAC, posA, RADIUS_A, posC, RADIUS_C);
      filAC.params.reveal = toC;
      filAC.params.energy = restless;
      filAC.params.tension = taut;
      filAC.sync();
      setFilament(filBC, posB, RADIUS_B, posC, RADIUS_C);
      filBC.params.reveal = toC;
      filBC.params.energy = restless;
      filBC.params.tension = taut;
      filBC.sync();

      // ── the ghost of the path ──────────────────────────────────────────
      const u = ghost.material.uniforms;
      const viewport = ctx.stage.viewport;
      (u.uViewport.value as Vector2).set(viewport.width * viewport.pixelRatio, viewport.height * viewport.pixelRatio);
      u.uWidth.value = 1.25 * viewport.pixelRatio;
      u.uC.value = cT;
      u.uHover.value = Math.max(hoverAmtC, 0.3 * invite);
      u.uGuide.value = guideAmt;
      u.uTime.value = calm ? 0 : time;
      u.uFade.value = fadeIn * bridge.presence * (1 - bridge.silence) * (solvedT >= 0 ? 1 - smoothstep(0, 1.2, solvedT) : 1) * (1 - dissolve);
    },

    assist(level: 1 | 2 | 3, ctx: ChapterContext) {
      if (!puzzle || !spec || puzzle.solved || exitT >= 0) return;
      if (level === 1) {
        ctx.ui.hint('One of them is not yet at rest.');
        hinted = true;
      } else if (level === 2) {
        // C glows; its path shows clearly, with a brighter mark where it would rest.
        guide = true;
        if (bodyC) ring(ctx, bodyC, puzzle.hz, posC, 0.22);
      } else if (glideU < 0) {
        // The third tone finds its own way, over three seconds.
        guide = true;
        releaseC(ctx);
        glideFrom = cT;
        glideU = 0;
      }
    },

    exit(ctx: ChapterContext) {
      if (exitT >= 0) return;
      exitT = 0;
      guide = false;
      removeInteractives(ctx);
      releaseVoices(ctx, 3.4);
      if (hinted) {
        ctx.ui.hint(null);
        hinted = false;
      }
      exitReveal = membrane ? membrane.params.reveal : 0;
      exitCoherence = membrane ? membrane.params.coherence : 0;
      if (!root) exited = true;
    },

    dispose(ctx: ChapterContext) {
      teardown(ctx);
    },
  };

  return chapter;
}
