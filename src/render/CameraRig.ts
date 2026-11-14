/**
 * CameraRig — a directed camera. Never an orbit control.
 *
 * Seven scalar channels (position xyz, look-target xyz, fov) are eased together with
 * cubic in-out. A moveTo() issued mid-flight starts from the current eased state and
 * carries the current velocity into the new move (a short decaying "carry" term), so
 * an interrupted move never shows a kink.
 *
 * On top of the directed pose: `drift` 0..1 adds a slow autonomous float (two
 * incommensurate sines per axis, amplitude proportional to subject distance) and a
 * restrained, smoothed pointer parallax. With reducedMotion both are forced to zero;
 * directed moves are unchanged.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import type { CameraPose, CameraRig } from '../core/contracts';
import { clamp, damp, ease } from '../core/math';

/** CameraRig plus the two members Stage needs to keep the projection current. */
export interface StageCameraRig extends CameraRig {
  /** Keep the projection in step with the canvas. Called by Stage.resize. */
  setAspect(aspect: number): void;
  /** True while a moveTo() is still easing. */
  readonly moving: boolean;
}

const CHANNELS = 7; // px py pz  tx ty tz  fov
const DEFAULT_FOV = 35;
const NEAR = 0.05;
const FAR = 400;
/** Below this aspect the vertical fov widens so the horizontal extent of the composition is kept. */
const PORTRAIT_ASPECT = 0.8;
const MAX_FOV = 100;
/** Seconds over which velocity inherited from an interrupted move bleeds away. */
const CARRY_SECONDS = 1.2;
/** Float amplitude and pointer parallax, as fractions of the camera→target distance. */
const FLOAT_AMOUNT = 0.011;
const PARALLAX_AMOUNT = 0.028;
const DEG = Math.PI / 180;

export function createCameraRig(aspect: number, reducedMotion = false): StageCameraRig {
  const camera = new PerspectiveCamera(DEFAULT_FOV, Math.max(aspect, 1e-3), NEAR, FAR);
  camera.position.set(0, 0, 8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  // Directed state (before float / parallax).
  const cur = new Float64Array([0, 0, 8, 0, 0, 0, DEFAULT_FOV]);
  const prev = new Float64Array(cur);
  const vel = new Float64Array(CHANNELS);
  // Active move:  cur = from + delta·ease(u) + v0·carry(t)
  const from = new Float64Array(cur);
  const delta = new Float64Array(CHANNELS);
  const v0 = new Float64Array(CHANNELS);
  let duration = 0;
  let carrySeconds = 0;
  let elapsed = 0;
  let moving = false;

  let currentAspect = Math.max(aspect, 1e-3);
  let floatTime = 0;
  let driftEased = 0;
  let parallaxX = 0;
  let parallaxY = 0;

  const eye = new Vector3();
  const look = new Vector3();
  const forward = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  const worldUp = new Vector3(0, 1, 0);

  const writePose = (out: Float64Array, pose: CameraPose, fallbackFov: number) => {
    out[0] = pose.position.x;
    out[1] = pose.position.y;
    out[2] = pose.position.z;
    out[3] = pose.target.x;
    out[4] = pose.target.y;
    out[5] = pose.target.z;
    out[6] = pose.fov !== undefined && pose.fov > 0 ? pose.fov : fallbackFov;
  };

  const goal = new Float64Array(cur);

  const effectiveFov = (fov: number) => {
    if (currentAspect >= PORTRAIT_ASPECT) return fov;
    const widened = 2 * Math.atan(Math.tan(fov * 0.5 * DEG) * (PORTRAIT_ASPECT / currentAspect)) / DEG;
    return Math.min(MAX_FOV, widened);
  };

  const apply = () => {
    eye.set(cur[0], cur[1], cur[2]);
    look.set(cur[3], cur[4], cur[5]);

    const d = driftEased;
    if (d > 1e-4) {
      forward.subVectors(look, eye);
      const dist = Math.max(forward.length(), 1e-3);
      forward.multiplyScalar(1 / dist);
      right.crossVectors(forward, worldUp);
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      right.normalize();
      up.crossVectors(right, forward);

      const t = floatTime;
      const a = dist * FLOAT_AMOUNT * d;
      // Two incommensurate sines per axis: never repeats within a visit.
      const fx = Math.sin(t * 0.0731 + 1.3) * 0.62 + Math.sin(t * 0.1193 + 4.1) * 0.38;
      const fy = Math.sin(t * 0.0587 + 2.9) * 0.6 + Math.sin(t * 0.1009 + 0.4) * 0.4;
      const fz = Math.sin(t * 0.0443 + 5.2) * 0.65 + Math.sin(t * 0.0811 + 3.3) * 0.35;
      const p = dist * PARALLAX_AMOUNT;
      const ox = fx * a + parallaxX * p;
      const oy = fy * a * 0.7 + parallaxY * p * 0.7;
      const oz = fz * a * 0.5;
      eye.addScaledVector(right, ox).addScaledVector(up, oy).addScaledVector(forward, oz);
      // The gaze wanders a fraction of what the body does, so the subject stays held.
      look.addScaledVector(right, ox * 0.12).addScaledVector(up, oy * 0.12);
    }

    camera.position.copy(eye);
    camera.up.copy(worldUp);
    camera.lookAt(look);

    const fov = effectiveFov(cur[6]);
    if (Math.abs(camera.fov - fov) > 1e-4 || Math.abs(camera.aspect - currentAspect) > 1e-6) {
      camera.fov = fov;
      camera.aspect = currentAspect;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  };

  const rig: StageCameraRig = {
    camera,
    drift: 0,

    get moving() {
      return moving;
    },

    moveTo(pose: CameraPose, seconds: number) {
      writePose(goal, pose, moving ? from[6] + delta[6] + (v0[6] * carrySeconds) / 3 : cur[6]);
      if (!(seconds > 1e-3)) {
        rig.cut(pose);
        return;
      }
      duration = seconds;
      carrySeconds = Math.min(seconds, CARRY_SECONDS);
      elapsed = 0;
      for (let i = 0; i < CHANNELS; i++) {
        from[i] = cur[i];
        v0[i] = moving ? vel[i] : 0;
        // The carry term ends displaced by v0·Tc/3; the eased part covers the rest.
        delta[i] = goal[i] - from[i] - (v0[i] * carrySeconds) / 3;
      }
      moving = true;
    },

    cut(pose: CameraPose) {
      writePose(goal, pose, moving ? from[6] + delta[6] + (v0[6] * carrySeconds) / 3 : cur[6]);
      for (let i = 0; i < CHANNELS; i++) {
        cur[i] = prev[i] = from[i] = goal[i];
        vel[i] = v0[i] = delta[i] = 0;
      }
      moving = false;
      apply();
    },

    setAspect(a: number) {
      currentAspect = Math.max(a, 1e-3);
      apply();
    },

    update(dt: number, pointerNdc: { x: number; y: number }) {
      const step = clamp(dt, 0, 0.1);

      if (moving) {
        elapsed += step;
        const u = clamp(elapsed / duration);
        const e = ease(u);
        const uc = carrySeconds > 0 ? clamp(elapsed / carrySeconds) : 1;
        const inv = 1 - uc;
        const carry = (carrySeconds * (1 - inv * inv * inv)) / 3;
        for (let i = 0; i < CHANNELS; i++) cur[i] = from[i] + delta[i] * e + v0[i] * carry;
        if (u >= 1) moving = false;
      }
      if (step > 1e-5) {
        const inv = 1 / step;
        for (let i = 0; i < CHANNELS; i++) {
          vel[i] = (cur[i] - prev[i]) * inv;
          prev[i] = cur[i];
        }
      }

      const driftTarget = reducedMotion ? 0 : clamp(rig.drift);
      driftEased = damp(driftEased, driftTarget, 1.5, step);
      if (driftEased < 1e-4 && driftTarget === 0) driftEased = 0;
      floatTime += step;

      const px = clamp(pointerNdc.x, -1, 1) * driftEased;
      const py = clamp(pointerNdc.y, -1, 1) * driftEased;
      parallaxX = damp(parallaxX, px, 1.8, step);
      parallaxY = damp(parallaxY, py, 1.8, step);

      apply();
    },
  };

  return rig;
}
