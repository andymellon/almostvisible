import { Vector3 } from 'three';

export const TAU = Math.PI * 2;
export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Cubic in-out easing on 0..1. */
export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Frame-rate independent exponential approach. `rate` ≈ 1/time-constant. */
export const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Damped spring, semi-implicit Euler; stable for dt ≤ 1/20 s. */
export class Spring {
  value: number;
  velocity = 0;
  target: number;
  constructor(value = 0, public stiffness = 120, public damping = 18) {
    this.value = this.target = value;
  }
  step(dt: number): number {
    const a = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
    this.velocity += a * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
  snap(v: number) {
    this.value = this.target = v;
    this.velocity = 0;
  }
}

/** Three-axis spring that writes straight into a Vector3 (no allocation per step). */
export class Spring3 {
  readonly velocity = new Vector3();
  readonly target = new Vector3();
  constructor(public stiffness = 90, public damping = 16) {}
  step(position: Vector3, dt: number): void {
    const v = this.velocity;
    const t = this.target;
    v.x += ((t.x - position.x) * this.stiffness - v.x * this.damping) * dt;
    v.y += ((t.y - position.y) * this.stiffness - v.y * this.damping) * dt;
    v.z += ((t.z - position.z) * this.stiffness - v.z * this.damping) * dt;
    position.x += v.x * dt;
    position.y += v.y * dt;
    position.z += v.z * dt;
  }
  get speed() {
    return this.velocity.length();
  }
}
