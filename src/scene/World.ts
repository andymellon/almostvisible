import {
  ColorManagement,
  LinearSRGBColorSpace,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
  Euler,
} from 'three';
import type { Input } from '../interaction/Input';
import { clamp, damp, smoothstep, type Perception } from '../state/Perception';
import { Filaments } from './Filaments';
import { Membrane } from './Membrane';
import { ParticleField } from './ParticleField';
import { Post } from './post';
import { Traces } from './Traces';
import { shared, type Quality } from './uniforms';

const DIST_MIN = 2.5;
const DIST_MAX = 11.5;
const DIST_HOME = 7.2;

/**
 * Owns the renderer, the camera (a curious, slow observer) and the mapping
 * from the perceptual model onto every shader uniform.
 */
export class World {
  readonly renderer: WebGLRenderer;
  readonly focus = new Vector3();
  /** Focus projected to screen UV, for the grade pass and the reticle. */
  focusU = 0.5;
  focusV = 0.5;
  closeness = 0;
  dist = DIST_HOME;

  private scene = new Scene();
  private camera = new PerspectiveCamera(38, 1, 0.1, 80);
  private post: Post;
  private traces = new Traces();
  private pr = 1;
  private maxPr: number;
  private w = 1;
  private h = 1;

  private distT = DIST_HOME;
  private yaw = 0;
  private yawVel = 0;
  private pitch = 0;
  private pitchVel = 0;
  private look = new Vector3();
  private focusT = new Vector3();
  // springs
  private pull = 0;
  private pullVel = 0;
  private tiltX = 0;
  private tiltY = 0;
  private tiltVX = 0;
  private tiltVY = 0;
  // scratch (no allocation in the loop)
  private dir = new Vector3();
  private fwd = new Vector3();
  private tmp = new Vector3();
  private euler = new Euler();
  private quat = new Quaternion();
  private quat2 = new Quaternion();
  private m4 = new Matrix4();
  // adaptive quality
  private frames = 0;
  private acc = 0;

  constructor(canvas: HTMLCanvasElement, private q: Quality) {
    ColorManagement.enabled = false;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    this.maxPr = Math.min(window.devicePixelRatio || 1, q.lite ? 1.5 : 2);
    this.pr = this.maxPr;

    this.scene.add(new ParticleField(q).points, new Membrane(q).mesh, new Filaments(q).lines, this.traces.group);
    this.post = new Post(this.renderer, this.scene, this.camera, q);
    this.camera.position.set(0, 0, DIST_HOME);
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.renderer.setPixelRatio(this.pr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, this.pr);
    this.camera.aspect = w / h;
    // keep the form framed on portrait screens
    this.camera.fov = w / h < 0.8 ? 54 : 38;
    this.camera.updateProjectionMatrix();
    shared.uPixelRatio.value = this.pr;
    shared.uViewH.value = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  reset() {
    this.distT = DIST_HOME;
    this.traces.clear();
  }

  update(dt: number, p: Perception, inp: Input) {
    const t = p.time;
    const motion = this.q.reduced ? 0.25 : 1;

    // ── camera: slow, floating, inertial ──────────────────────────────
    this.distT = clamp(this.distT * Math.exp(inp.zoomDelta * 0.0011), DIST_MIN, DIST_MAX);
    this.dist = damp(this.dist, this.distT, 2.0, dt);
    this.yawVel += -inp.dragX * 5.5;
    this.pitchVel += inp.dragY * 3.5;
    inp.consume();
    this.yaw += this.yawVel * dt;
    this.pitch = clamp(this.pitch + this.pitchVel * dt, -0.7, 0.7);
    this.yawVel *= Math.exp(-dt * 1.6);
    this.pitchVel *= Math.exp(-dt * 2.2);
    this.pitch = damp(this.pitch, 0, 0.05, dt);

    const still = 1 - p.still * 0.8;
    const yaw = this.yaw + t * 0.018 * motion * still + Math.sin(t * 0.043) * 0.12 * motion - inp.x * 0.07;
    const pitch = this.pitch + Math.sin(t * 0.031 + 1) * 0.1 * motion + inp.y * 0.05;
    const d = this.dist * (1 + 0.025 * Math.sin(t * 0.07) * motion) * (1 - 0.07 * p.coherence);
    this.camera.position.set(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d);
    this.tmp.copy(this.focus).multiplyScalar(0.12 + 0.1 * p.hold);
    this.look.lerp(this.tmp, 1 - Math.exp(-dt * 1.2));
    this.camera.lookAt(this.look);
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(this.fwd);

    // ── point of attention: pointer ray ∩ plane through the form ──────
    this.dir.set(inp.x, inp.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const denom = this.dir.dot(this.fwd);
    const tt = -this.camera.position.dot(this.fwd) / (denom || 1e-3);
    this.focusT.copy(this.camera.position).addScaledVector(this.dir, tt);
    if (this.focusT.length() > 4.5) this.focusT.setLength(4.5);
    this.focus.lerp(this.focusT, 1 - Math.exp(-dt * 6));
    this.tmp.copy(this.focus).project(this.camera);
    this.focusU = this.tmp.x * 0.5 + 0.5;
    this.focusV = this.tmp.y * 0.5 + 0.5;

    this.closeness = 1 - smoothstep(2.8, 5.6, this.dist);

    // ── springs: the structure answers with soft elastic motion ───────
    const pullT = p.hold * 0.3 + p.energy * 0.07;
    this.pullVel += ((pullT - this.pull) * 26 - this.pullVel * 3.2) * dt;
    this.pull += this.pullVel * dt;
    this.tiltVX += (-this.tiltX * 9 - this.tiltVX * 1.9 + inp.dx * 0.5 * motion) * dt;
    this.tiltVY += (-this.tiltY * 9 - this.tiltVY * 1.9 + (inp.y - this.tiltY) * p.energy * 0.6 * motion) * dt;
    this.tiltX = clamp(this.tiltX + this.tiltVX * dt, -0.6, 0.6);
    this.tiltY = clamp(this.tiltY + this.tiltVY * dt, -0.6, 0.6);

    this.euler.set(t * 0.021 * motion + 0.5, t * 0.033 * motion, t * 0.012 * motion);
    this.quat.setFromEuler(this.euler);
    this.euler.set(-this.tiltY * 0.5, this.tiltX, 0);
    this.quat2.setFromEuler(this.euler);
    this.quat.premultiply(this.quat2);
    shared.uFormRot.value.setFromMatrix4(this.m4.makeRotationFromQuaternion(this.quat));

    // ── morph: three topologies, never quite arriving at any one ──────
    const ph = p.morphPhase;
    let a = Math.pow(Math.cos(ph * Math.PI * 2) * 0.5 + 0.5, 1.6);
    let b = Math.pow(Math.cos((ph - 1 / 3) * Math.PI * 2) * 0.5 + 0.5, 1.6);
    let c = Math.pow(Math.cos((ph - 2 / 3) * Math.PI * 2) * 0.5 + 0.5, 1.6);
    const s = a + b + c;
    shared.uMorph.value.set(a / s, b / s, c / s);

    // ── one model, every system ───────────────────────────────────────
    shared.uTime.value = t;
    shared.uFocus.value.copy(this.focus);
    shared.uPull.value = this.pull;
    shared.uCoherence.value = p.coherence;
    shared.uEnergy.value = p.energy;
    shared.uTurb.value = p.turbulence;
    shared.uHold.value = p.hold;
    shared.uColor.value = p.color;
    shared.uMemory.value = p.memory;
    shared.uStill.value = p.still;
    shared.uDeform.value = 0.1 + 0.3 * p.turbulence + 0.08 * p.energy + 0.05 * Math.sin(t * 0.09);
    shared.uFormVis.value = 1 - smoothstep(8.2, 11, this.dist);
    shared.uDetail.value = this.closeness;
    shared.uCamDir.value.copy(this.fwd);
    shared.uFocusDist.value = damp(shared.uFocusDist.value, this.camera.position.distanceTo(this.focus), 1.5, dt);

    this.traces.update(this.focus, t, inp.touched ? p.energy : 0);

    const g = this.post.grade.uniforms;
    g.uTime.value = t;
    g.uAb.value = 0.004 + 0.012 * p.color + 0.018 * p.turbulence;
    g.uGrain.value = 0.05 - 0.015 * p.coherence;
    g.uGlow.value = inp.touched ? 0.05 * p.energy + 0.1 * p.hold : 0;
    g.uFocus.value.set(this.focusU, this.focusV);
    g.uColor.value = p.color;
    this.post.bloom.strength = 0.4 + 0.16 * p.coherence + 0.12 * p.hold;
    this.post.persistence = 0.72 + 0.16 * p.energy + 0.06 * p.memory;

    this.post.composer.render(dt);
    this.adapt(dt);
  }

  /** Step resolution down if the device cannot hold a fluid frame rate. */
  private adapt(dt: number) {
    this.acc += dt;
    if (++this.frames < 90) return;
    const avg = this.acc / this.frames;
    this.frames = 0;
    this.acc = 0;
    if (avg > 1 / 42 && this.pr > 0.75) {
      this.pr = Math.max(0.75, this.pr - 0.25);
      this.resize(this.w, this.h);
    }
  }
}
