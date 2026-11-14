/**
 * Stage — renderer, scene, directed camera and the one composer chain:
 *
 *   RenderPass → UnrealBloomPass (restrained) → OpticalCompositePass
 *
 * Colour: three's ColorManagement is off and the renderer writes linear values straight
 * to the display. Materials write display-referred colour into a half-float buffer
 * (values above 1 are highlights); the composite pass owns exposure and the tone curve.
 *
 * Grade units (what callers set on stage.grade; all eased internally):
 *   exposure    linear multiplier, 1 = nominal
 *   bloom       0..1 (clamped to 0..2) → bloom strength = bloom × 0.6; only values above ~0.8 bloom
 *   dispersion  0..1 → radial red/blue shift, ≈ 0.3 % of the half-width at 1 (ignored on lite)
 *   grain       0..1 → luminance-weighted film grain; 0 still dithers
 *   fade        0 = normal … 1 = full black (time constant 0.1 s)
 *
 * Adaptive resolution: real frame intervals are averaged over windows of 30 frames.
 * Two consecutive slow windows (> 22 ms) step the render scale down by 15 % (floor
 * 0.6 × CSS px). Stepping back up needs several seconds of uninterrupted headroom, and
 * every failed attempt doubles that wait, so the scale settles instead of oscillating.
 */
import { ColorManagement, LinearSRGBColorSpace, NoToneMapping, Scene, Vector2, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Bridge, Quality, Stage } from '../core/contracts';
import { clamp, damp } from '../core/math';
import { createCameraRig } from './CameraRig';
import { createProgramKeepers } from './keepalive';
import { syncShared } from './materials';
import { OpticalCompositePass } from './OpticalCompositePass';
import { createVoid } from './Void';

const BLOOM_THRESHOLD = 0.8;
const BLOOM_RADIUS = 0.3;
const BLOOM_GAIN = 0.6;
const DISPERSION_MAX = 0.006;
const GRAIN_MAX = 0.045;

const MIN_SCALE = 0.6;
const SLOW_MS = 22;
const FAST_MS = 14;
/** A display locked to 60 Hz never reports < 14 ms; a clean vsync lock also counts as headroom. */
const LOCKED_MS = 18;
const LOCKED_WORST_MS = 26;
const WINDOW_FRAMES = 30;
const STEP_DOWN = 0.85;
const STEP_UP = 1.12;
const SETTLE_SECONDS = 1.2;
const UP_WAIT_MIN = 4;
const UP_WAIT_MAX = 60;

export function createStage(canvas: HTMLCanvasElement, quality: Quality): Stage {
  ColorManagement.enabled = false;

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    throw new Error(`WebGL unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (renderer.getContext().isContextLost()) {
    renderer.dispose();
    throw new Error('WebGL unavailable: context lost at creation');
  }
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.setClearColor(0x000000, 1);
  renderer.autoClear = true;

  const deviceRatio = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const maxScale = Math.min(deviceRatio, quality.lite ? 1.5 : 2);
  const minScale = Math.min(MIN_SCALE, maxScale);

  const initialWidth = Math.max(2, Math.floor(canvas.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 2)));
  const initialHeight = Math.max(2, Math.floor(canvas.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 2)));
  const viewport = { width: initialWidth, height: initialHeight, pixelRatio: maxScale };

  renderer.setPixelRatio(viewport.pixelRatio);
  renderer.setSize(viewport.width, viewport.height, true);

  const scene = new Scene();
  const rig = createCameraRig(viewport.width / viewport.height, quality.reducedMotion);
  const environment = createVoid(quality);
  scene.add(environment.object);
  // Holds each material program for the whole session (draws nothing): see ./keepalive.ts.
  const keepers = createProgramKeepers(quality);
  scene.add(keepers.object);

  // ── composer ────────────────────────────────────────────────────────────
  const composer = new EffectComposer(renderer); // half-float targets: highlights survive to the tone curve
  const renderPass = new RenderPass(scene, rig.camera);
  const bloom = new UnrealBloomPass(new Vector2(256, 256), 0, BLOOM_RADIUS, BLOOM_THRESHOLD);
  if (quality.lite) {
    // Half-resolution bloom chain on the lite tier.
    const fullSize = bloom.setSize.bind(bloom);
    bloom.setSize = (w: number, h: number) => fullSize(Math.max(2, w * 0.5), Math.max(2, h * 0.5));
  }
  const composite = new OpticalCompositePass({ dispersion: !quality.lite, staticGrain: quality.reducedMotion });
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(composite);
  composer.setPixelRatio(viewport.pixelRatio);
  composer.setSize(viewport.width, viewport.height);

  // ── grade ───────────────────────────────────────────────────────────────
  const grade = { exposure: 1, bloom: 0.5, dispersion: 0.3, grain: 0.5, fade: 0 };
  const eased = { exposure: 1, bloom: 0.5, dispersion: 0.3, grain: 0.5, fade: 0 };
  let gradePrimed = false;

  const easeGrade = (dt: number) => {
    const exposure = clamp(grade.exposure, 0, 8);
    const bloomAmount = clamp(grade.bloom, 0, 2);
    const dispersion = clamp(grade.dispersion, 0, 1);
    const grain = clamp(grade.grain, 0, 1);
    const fade = clamp(grade.fade, 0, 1);
    if (!gradePrimed) {
      // First frame shows exactly what was asked for (e.g. start from black).
      gradePrimed = true;
      eased.exposure = exposure;
      eased.bloom = bloomAmount;
      eased.dispersion = dispersion;
      eased.grain = grain;
      eased.fade = fade;
    } else {
      eased.exposure = damp(eased.exposure, exposure, 3, dt);
      eased.bloom = damp(eased.bloom, bloomAmount, 3, dt);
      eased.dispersion = damp(eased.dispersion, dispersion, 3, dt);
      eased.grain = damp(eased.grain, grain, 3, dt);
      eased.fade = damp(eased.fade, fade, 10, dt);
      if (Math.abs(eased.fade - fade) < 0.002) eased.fade = fade;
    }
    const strength = eased.bloom * BLOOM_GAIN;
    bloom.strength = strength;
    bloom.enabled = strength > 0.002 && eased.fade < 0.999;
    composite.exposure = eased.exposure;
    composite.dispersion = eased.dispersion * DISPERSION_MAX;
    composite.grain = eased.grain * GRAIN_MAX;
    composite.fade = eased.fade;
  };

  // ── adaptive resolution ─────────────────────────────────────────────────
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let lastStamp = -1;
  let windowMs = 0;
  let windowWorst = 0;
  let windowFrames = 0;
  let slowWindows = 0;
  let headroomSeconds = 0;
  let settle = SETTLE_SECONDS * 1.5; // ignore start-up shader compilation
  let upWait = UP_WAIT_MIN;
  let sinceStepUp = Infinity;
  let calmSeconds = 0;

  const resetWindow = () => {
    windowMs = 0;
    windowWorst = 0;
    windowFrames = 0;
  };

  const applyScale = (scale: number) => {
    if (Math.abs(scale - viewport.pixelRatio) < 1e-3) return;
    viewport.pixelRatio = scale;
    renderer.setPixelRatio(scale);
    composer.setPixelRatio(scale);
    settle = SETTLE_SECONDS;
    slowWindows = 0;
    headroomSeconds = 0;
    resetWindow();
  };

  const adapt = (dt: number) => {
    const stamp = now();
    const interval = lastStamp < 0 ? 0 : stamp - lastStamp;
    lastStamp = stamp;
    // Tab switches, pauses and long hitches say nothing about steady-state cost.
    if (dt > 0.1 || interval <= 0 || interval > 100) {
      resetWindow();
      return;
    }
    const seconds = interval / 1000;
    sinceStepUp += seconds;
    if (settle > 0) {
      settle -= seconds;
      return;
    }
    windowMs += interval;
    if (interval > windowWorst) windowWorst = interval;
    if (++windowFrames < WINDOW_FRAMES) return;

    const mean = windowMs / windowFrames;
    const span = windowMs / 1000;
    const worst = windowWorst;
    resetWindow();

    if (mean > SLOW_MS) {
      headroomSeconds = 0;
      calmSeconds = 0;
      if (++slowWindows >= 2 && viewport.pixelRatio > minScale + 1e-3) {
        // A step up that could not be held: wait twice as long before trying again.
        if (sinceStepUp < 12) upWait = Math.min(UP_WAIT_MAX, upWait * 2);
        applyScale(Math.max(minScale, viewport.pixelRatio * STEP_DOWN));
      }
      return;
    }
    slowWindows = 0;

    const headroom = mean < FAST_MS || (mean < LOCKED_MS && worst < LOCKED_WORST_MS);
    if (!headroom) {
      headroomSeconds = 0;
      return;
    }
    // Long calm stretches slowly forgive earlier failures.
    calmSeconds += span;
    if (calmSeconds > 90) {
      calmSeconds = 0;
      upWait = Math.max(UP_WAIT_MIN, upWait * 0.5);
    }
    if (viewport.pixelRatio >= maxScale - 1e-3) return;
    headroomSeconds += span;
    if (headroomSeconds >= upWait) {
      sinceStepUp = 0;
      applyScale(Math.min(maxScale, viewport.pixelRatio * STEP_UP));
    }
  };

  // ── context loss ────────────────────────────────────────────────────────
  const onContextLost = (e: Event) => e.preventDefault();
  canvas.addEventListener('webglcontextlost', onContextLost, false);

  let disposed = false;

  const stage: Stage = {
    renderer,
    scene,
    rig,
    quality,
    viewport,
    grade,

    resize(width: number, height: number) {
      const w = Math.max(2, Math.floor(width));
      const h = Math.max(2, Math.floor(height));
      rig.setAspect(w / h);
      if (w === viewport.width && h === viewport.height) return;
      viewport.width = w;
      viewport.height = h;
      renderer.setSize(w, h, true);
      composer.setSize(w, h);
      settle = Math.max(settle, SETTLE_SECONDS * 0.5);
      resetWindow();
    },

    render(bridge: Bridge, dt: number) {
      if (disposed) return;
      adapt(dt);
      const step = clamp(dt, 0, 0.1);
      syncShared(bridge, rig.camera, viewport);
      environment.update(bridge, step);
      easeGrade(step);
      composer.render(step);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      environment.dispose();
      keepers.dispose();
      bloom.dispose();
      composite.dispose();
      renderPass.dispose();
      composer.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
    },
  };

  return stage;
}
