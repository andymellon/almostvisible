/**
 * RESONANT MATTER — material proof.
 *
 * A standalone page (matter.html): its own minimal renderer on black, no Stage, Director, UI or
 * audio. One membrane and one body ride a few self-animated, in-tune wave sources.
 *
 *   pointer   hover: the matter leans toward the pointer and its rim brightens
 *   click     excite: a strike — a radial wavefront from the point touched
 *   1 – 6     variant: membrane · body · crystal · earth · air · light
 *   S         sweep bridge.spectral 0 → 1 (colour is earned)
 *   C         toggle coherence (whole sheets ⇄ torn into drifting strips)
 *   D         detune one source (the standing pattern starts to crawl) / retune
 *   R         replay the reveal
 *   space     pause / resume
 *
 * Query: ?seed=7  ?lite  ?variant=membrane  ?paused
 *
 * In DEV, window.__matter = { step(n, dt), params, bridge, … } advances frames deterministically
 * without requestAnimationFrame (the first call to step() pauses the animation loop).
 *
 * The renderer mirrors the stage's colour pipeline: ColorManagement off, linear-as-display into a
 * half-float target, then one resolve pass with the same filmic shoulder as the optical composite
 * (no bloom, no grain, no MSAA — what is judged here is the material alone).
 */
import {
  ColorManagement,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NoBlending,
  NoToneMapping,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { createBridge, stepBridge } from '../core/bridge';
import type { Matter, MatterVariant, Quality } from '../core/contracts';
import { createHarmony } from '../core/harmony';
import { clamp, damp, smoothstep, TAU } from '../core/math';
import { createMatter, syncShared } from '../render/materials';

const VARIANTS: readonly MatterVariant[] = ['membrane', 'body', 'crystal', 'earth', 'air', 'light'];

/** Shape and attitude of the small closed object for each variant. */
const BODY_SHAPE: Record<MatterVariant, { shape: 'sphere' | 'ico' | 'torus'; detail: number; tilt: number }> = {
  membrane: { shape: 'sphere', detail: 0.8, tilt: 0 },
  body: { shape: 'sphere', detail: 0.8, tilt: 0 },
  crystal: { shape: 'ico', detail: 0.34, tilt: 0.3 },
  earth: { shape: 'torus', detail: 0.7, tilt: 1.05 },
  air: { shape: 'sphere', detail: 0.7, tilt: 0 },
  light: { shape: 'sphere', detail: 0.8, tilt: 0 },
};

const FOCUS = new Vector3(0, -0.25, 0);
const CAMERA_HOME = new Vector3(0, 0.9, 7.6);
const MEMBRANE_POSITION = new Vector3(0, 0.12, -0.3);
const MEMBRANE_TILT = -0.6;
const BODY_POSITION = new Vector3(1.9, 0.85, 1.6);
const BODY_RADIUS = 0.5;

/** Wave sources: scale degree, octave, level, and a slow orbit (centre, radii, rate, phase). */
const SOURCES = [
  { degree: 0, octave: 0, level: 0.9, centre: [-2.4, -0.2, 0.6], radius: [0.7, 0.2, 0.5], rate: 0.05, phase: 0.0 },
  { degree: 4, octave: 0, level: 0.75, centre: [2.1, -0.9, 1.4], radius: [0.5, 0.15, 0.6], rate: 0.037, phase: 1.9 },
  { degree: 0, octave: 1, level: 0.6, centre: [0.5, 0.3, -1.6], radius: [0.8, 0.2, 0.4], rate: 0.043, phase: 4.1 },
  { degree: 4, octave: 1, level: 0.45, centre: [-0.8, -0.6, 2.2], radius: [0.6, 0.1, 0.5], rate: 0.031, phase: 2.7 },
] as const;
const DETUNED_SOURCE = 1;
const DETUNE_HZ = 1.4;

const RESOLVE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// The optical composite's tone curve: identity to the knee, exponential shoulder, hue preserved.
const RESOLVE_FRAG = /* glsl */ `
uniform sampler2D tScene;
varying vec2 vUv;
const float KNEE = 0.62;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec3 c = max(texture2D(tScene, vUv).rgb, 0.0);
  float peak = max(c.r, max(c.g, c.b));
  if (peak > KNEE) {
    float mapped = KNEE + (1.0 - KNEE) * (1.0 - exp(-(peak - KNEE) / (1.0 - KNEE)));
    vec3 held = c * (mapped / peak);
    c = mix(held, vec3(mapped), smoothstep(1.0, 5.0, peak) * 0.55);
  }
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

function boot(canvas: HTMLCanvasElement): void {
  const query = new URLSearchParams(window.location.search);
  const seed = Number(query.get('seed') ?? 7) || 7;
  const quality: Quality = {
    lite: query.has('lite'),
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  };

  ColorManagement.enabled = false;
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.setClearColor(0x000000, 1);

  const viewport = { width: 2, height: 2, pixelRatio: 1 };
  const target = new WebGLRenderTarget(2, 2, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: true });
  const resolveMaterial = new ShaderMaterial({
    uniforms: { tScene: { value: target.texture } },
    vertexShader: RESOLVE_VERT,
    fragmentShader: RESOLVE_FRAG,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const resolveScene = new Scene();
  const resolveCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const resolveQuad = new Mesh(new PlaneGeometry(2, 2), resolveMaterial);
  resolveQuad.frustumCulled = false;
  resolveScene.add(resolveQuad);

  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.1, 200);
  camera.position.copy(CAMERA_HOME);
  camera.lookAt(FOCUS);

  const harmony = createHarmony(seed);
  const bridge = createBridge();
  bridge.fundamental = harmony.root;
  bridge.stability = 0.85;
  bridge.spectral = 1;

  // ── state ──────────────────────────────────────────────────────────────
  const state = {
    variant: (VARIANTS as readonly string[]).includes(query.get('variant') ?? '') ? (query.get('variant') as MatterVariant) : 'membrane',
    time: 0,
    frame: 0,
    paused: query.has('paused'),
    coherent: true,
    detuned: false,
    /** Seconds into the spectral sweep; < 0 = not sweeping. */
    sweep: -1,
    /** Seconds since the reveal began. */
    revealClock: 0,
    nextStrike: 9,
  };
  const SWEEP_SECONDS = 12;
  const REVEAL_SECONDS = 6;

  let membrane!: Matter;
  let body!: Matter;
  let built = false;
  const seeds = { membrane: harmony.rand(), body: harmony.rand() };

  const build = (variant: MatterVariant): void => {
    const keep = built ? { m: { ...membrane.params }, b: { ...body.params } } : null;
    if (built) {
      membrane.dispose();
      body.dispose();
    }
    built = true;
    membrane = createMatter(
      variant,
      {
        shape: 'plane',
        width: 17,
        height: 10.5,
        detail: 0.9,
        init: { reveal: 0, excite: 0, hover: 0, tension: 0.28, coherence: 1, freq: 0, seed: seeds.membrane, warmth: 0, spread: 0.85 },
      },
      quality,
    );
    membrane.object.position.copy(MEMBRANE_POSITION);
    membrane.object.rotation.set(MEMBRANE_TILT, 0, 0);

    const form = BODY_SHAPE[variant];
    body = createMatter(
      variant === 'membrane' ? 'body' : variant,
      {
        shape: form.shape,
        radius: BODY_RADIUS,
        detail: form.detail,
        init: { reveal: 0, excite: 0, hover: 0, tension: 0.6, coherence: 1, freq: harmony.freq(2, 1), seed: seeds.body, warmth: 0.25, spread: 0.7 },
      },
      quality,
    );
    body.object.position.copy(BODY_POSITION);
    body.object.rotation.set(form.tilt, 0.4, 0.15);

    if (keep) {
      Object.assign(membrane.params, keep.m);
      Object.assign(body.params, keep.b, { freq: harmony.freq(2, 1) });
    }
    scene.add(membrane.object, body.object);
    state.variant = variant;
    legend();
  };

  // ── pointer ────────────────────────────────────────────────────────────
  const pointer = { x: 0, y: 0, seen: false, inside: false };
  const ray = { origin: new Vector3(), dir: new Vector3() };
  const scratch = new Vector3();
  const planeNormal = new Vector3();
  const hit = new Vector3();

  const castPointer = (): void => {
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.dir.set(pointer.x, pointer.y, 0.5).unproject(camera).sub(ray.origin).normalize();
  };
  /** Intersect the pointer ray with the plane through `point` with normal `normal`; false if it misses. */
  const intersect = (point: Vector3, normal: Vector3, out: Vector3): boolean => {
    const denom = ray.dir.dot(normal);
    if (Math.abs(denom) < 1e-5) return false;
    const t = scratch.copy(point).sub(ray.origin).dot(normal) / denom;
    if (t <= 0) return false;
    out.copy(ray.dir).multiplyScalar(t).add(ray.origin);
    return true;
  };
  /** Distance from the pointer ray to a point. */
  const rayDistance = (point: Vector3): number => {
    scratch.copy(point).sub(ray.origin);
    const along = scratch.dot(ray.dir);
    return Math.sqrt(Math.max(scratch.lengthSq() - along * along, 0));
  };

  const setPointer = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    pointer.y = -(((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
    pointer.seen = true;
    pointer.inside = true;
  };

  const strike = (at: Vector3, strength: number): void => {
    bridge.attack = clamp(strength);
    bridge.attackAt.copy(at);
  };

  const press = (): void => {
    camera.updateMatrixWorld();
    castPointer();
    if (rayDistance(body.object.position) < BODY_RADIUS * 1.25) {
      body.params.excite = 1;
      strike(body.object.position, 1);
      return;
    }
    planeNormal.set(0, 0, 1).applyQuaternion(membrane.object.quaternion);
    if (!intersect(membrane.object.position, planeNormal, hit)) {
      planeNormal.copy(ray.dir).negate();
      intersect(FOCUS, planeNormal, hit);
    }
    membrane.params.excite = 1;
    strike(hit, 1);
  };

  canvas.addEventListener('pointermove', setPointer);
  canvas.addEventListener('pointerdown', (e) => {
    setPointer(e);
    press();
  });
  canvas.addEventListener('pointerleave', () => {
    pointer.inside = false;
  });

  // ── keys ───────────────────────────────────────────────────────────────
  const legendEl = document.getElementById('legend');
  function legend(): void {
    if (!legendEl) return;
    const flags = [
      state.variant,
      `spectral ${bridge.spectral.toFixed(2)}`,
      state.coherent ? 'coherent' : 'torn',
      state.detuned ? 'detuned' : 'in tune',
      quality.lite ? 'lite' : '',
      state.paused ? 'paused' : '',
    ].filter(Boolean);
    legendEl.textContent = `1–6 variant · S spectral · C coherence · D detune · R reveal · click to strike    ${flags.join(' · ')}`;
  }

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '6') build(VARIANTS[Number(k) - 1]);
    else if (k === 's') state.sweep = 0;
    else if (k === 'c') state.coherent = !state.coherent;
    else if (k === 'd') state.detuned = !state.detuned;
    else if (k === 'r') state.revealClock = 0;
    else if (k === ' ') {
      state.paused = !state.paused;
      e.preventDefault();
    } else return;
    legend();
  });

  // ── resize ─────────────────────────────────────────────────────────────
  const resize = (): void => {
    const width = Math.max(2, Math.floor(canvas.clientWidth || window.innerWidth));
    const height = Math.max(2, Math.floor(canvas.clientHeight || window.innerHeight));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, quality.lite ? 1.5 : 2);
    if (width === viewport.width && height === viewport.height && pixelRatio === viewport.pixelRatio) return;
    viewport.width = width;
    viewport.height = height;
    viewport.pixelRatio = pixelRatio;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    target.setSize(Math.floor(width * pixelRatio), Math.floor(height * pixelRatio));
    camera.aspect = width / height;
    // Keep the composition's width on narrow screens.
    camera.fov = camera.aspect >= 1.2 ? 35 : (2 * Math.atan(Math.tan((35 * Math.PI) / 360) * (1.2 / camera.aspect)) * 180) / Math.PI;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  // ── simulation ─────────────────────────────────────────────────────────
  const sourcePosition = new Vector3();
  const strikeAt = new Vector3();
  const drift = quality.reducedMotion ? 0.25 : 1;

  const advance = (dt: number): void => {
    state.time += dt;
    state.frame++;
    const t = state.time;

    // sources: slow orbits, in tune (one may be detuned on request)
    for (let i = 0; i < SOURCES.length; i++) {
      const s = SOURCES[i];
      const a = t * s.rate * TAU * drift + s.phase;
      sourcePosition.set(
        s.centre[0] + s.radius[0] * Math.sin(a),
        s.centre[1] + s.radius[1] * Math.sin(a * 0.7 + 1.3),
        s.centre[2] + s.radius[2] * Math.cos(a * 0.9),
      );
      const w = bridge.waves[i];
      w.position.copy(sourcePosition);
      w.freq = harmony.freq(s.degree, s.octave) + (state.detuned && i === DETUNED_SOURCE ? DETUNE_HZ : 0);
      w.level = s.level * smoothstep(0.2 + i * 0.9, 1.6 + i * 0.9, state.revealClock);
    }

    // a quiet strike now and then, so the wavefront is seen without a hand
    if (t >= state.nextStrike) {
      const w = bridge.waves[Math.floor(harmony.rand() * SOURCES.length) % SOURCES.length];
      strike(strikeAt.copy(w.position), 0.7);
      state.nextStrike = t + 7 + harmony.rand() * 6;
    }

    // bridge scalars
    state.revealClock += dt;
    if (state.sweep >= 0) {
      state.sweep += dt;
      const u = clamp(state.sweep / SWEEP_SECONDS);
      bridge.spectral = u * u * (3 - 2 * u);
      if (u >= 1) state.sweep = -1;
      if (state.frame % 6 === 0 || u >= 1) legend();
    }
    bridge.presence = damp(bridge.presence, 1, 1.2, dt);
    bridge.stability = damp(bridge.stability, state.detuned ? 0.3 : 0.9, 1.5, dt);
    stepBridge(bridge, harmony, dt);

    // pointer → world, on the camera-facing plane through the focus
    camera.position.set(
      damp(camera.position.x, CAMERA_HOME.x + (pointer.seen ? pointer.x * 0.35 * drift : 0), 1.5, dt),
      damp(camera.position.y, CAMERA_HOME.y + (pointer.seen ? pointer.y * 0.2 * drift : 0), 1.5, dt),
      CAMERA_HOME.z,
    );
    camera.lookAt(FOCUS);
    camera.updateMatrixWorld();
    const hovering = pointer.seen && pointer.inside;
    if (pointer.seen) {
      castPointer();
      planeNormal.copy(ray.dir).negate();
      if (intersect(FOCUS, planeNormal, hit)) bridge.pointer.copy(hit);
    }
    const nearBody = hovering ? 1 - smoothstep(BODY_RADIUS * 1.2, BODY_RADIUS * 2.6, rayDistance(body.object.position)) : 0;

    // object params
    const reveal = smoothstep(0, REVEAL_SECONDS, state.revealClock);
    const coherence = state.coherent ? 1 : 0.22;
    const m = membrane.params;
    m.reveal = reveal;
    m.coherence = damp(m.coherence, coherence, 1.1, dt);
    m.hover = damp(m.hover, hovering ? 1 - nearBody : 0, 5, dt);
    m.excite = Math.max(0, m.excite - dt / 1.6);
    const b = body.params;
    b.reveal = smoothstep(1.5, REVEAL_SECONDS, state.revealClock);
    b.coherence = damp(b.coherence, state.coherent ? 1 : 0.3, 1.1, dt);
    b.hover = damp(b.hover, nearBody, 5, dt);
    b.excite = Math.max(0, b.excite - dt / 1.2);
    body.object.position.y = BODY_POSITION.y + 0.05 * Math.sin(t * 0.5) * drift;
    body.object.rotation.y = 0.4 + t * 0.05 * drift;
    membrane.sync();
    body.sync();
  };

  const render = (): void => {
    syncShared(bridge, camera, viewport);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(resolveScene, resolveCamera);
  };

  // ── loop ───────────────────────────────────────────────────────────────
  let running = true;
  let last = -1;
  const frame = (now: number): void => {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = last < 0 ? 1 / 60 : clamp((now - last) / 1000, 0, 0.05);
    last = now;
    resize();
    if (!state.paused) advance(dt);
    render();
  };

  build(state.variant);
  resize();
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    const api = {
      /** Advance n frames of dt seconds (default 1/60) and draw once. Stops the animation loop. */
      step(n = 1, dt = 1 / 60): void {
        running = false;
        resize();
        for (let i = 0; i < n; i++) advance(dt);
        render();
      },
      /** Hand the page back to requestAnimationFrame. */
      resume(): void {
        if (running) return;
        running = true;
        last = -1;
        requestAnimationFrame(frame);
      },
      get params() {
        return { membrane: membrane.params, body: body.params };
      },
      bridge,
      state,
      setVariant: build,
      camera,
      renderer,
    };
    (window as unknown as { __matter: typeof api }).__matter = api;
  }
}

const canvas = document.getElementById('matter');
if (canvas instanceof HTMLCanvasElement) {
  try {
    boot(canvas);
  } catch (err) {
    const legendEl = document.getElementById('legend');
    if (legendEl) legendEl.textContent = `WebGL unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}
