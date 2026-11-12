import type { Input } from '../interaction/Input';

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. */
export const damp = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

export const STATES = [
  { num: '00', name: 'ABSENCE', kicker: 'A field of possibility', line: 'There is more here than you can see.' },
  { num: '01', name: 'DETECTION', kicker: 'A property of attention', line: 'Every movement leaves a trace.' },
  { num: '02', name: 'REVELATION', kicker: 'A coherent form', line: 'The unseen has a shape.' },
  { num: '03', name: 'AFTERIMAGE', kicker: 'A spatial memory', line: 'Not everything that disappears is gone.' },
] as const;

/**
 * The single perceptual model. Everything visible, audible and typographic
 * reads from these few numbers; nothing else holds state about the encounter.
 */
export class Perception {
  time = 0;
  energy = 0; // immediate interaction energy
  attention = 0; // accumulated, sustained attention
  coherence = 0; // how far the form has condensed
  turbulence = 0; // fragmentation from fast gestures
  hold = 0; // focused attention (press)
  color = 0; // spectral colour, earned by depth
  memory = 0; // residue after the encounter
  still = 0; // periodic approach to stillness
  murmur = 0; // autonomous half-emergence while unobserved
  morphPhase = 0; // which topology the organism leans toward
  state = 0;

  private discover = 0;
  private peak = 0;
  private dwell = 0;

  reset() {
    this.energy = this.attention = this.coherence = this.turbulence = 0;
    this.hold = this.color = this.memory = this.discover = this.peak = 0;
    this.state = 0;
    this.dwell = 0;
  }

  update(dt: number, inp: Input, closeness: number, reduced: boolean) {
    this.time += dt;
    const sp = inp.speed;
    const moving = clamp(sp / 0.8);

    const holdT = inp.down ? 1 : 0;
    this.hold = damp(this.hold, holdT, holdT > this.hold ? 1.3 : 2.0, dt);

    const turbT = smoothstep(2.2, 6.0, sp) * (reduced ? 0.35 : 1);
    this.turbulence = damp(this.turbulence, turbT, turbT > this.turbulence ? 5 : 0.8, dt);

    const eT = Math.max(moving, this.hold * 0.75);
    this.energy = damp(this.energy, eT, eT > this.energy ? 3.2 : 0.5, dt);

    // Slow gestures and holding accumulate attention; haste scatters it.
    let gain = 0;
    if (moving > 0.03) gain += 0.075 * (1 - this.turbulence);
    gain += this.hold * 0.17;
    gain -= this.turbulence * 0.12;
    const decay = inp.idle > 2 ? 0.055 : inp.idle > 0.6 ? 0.015 : 0;
    this.attention = clamp(this.attention + (gain - decay) * dt);

    // Left alone, the field occasionally almost resolves on its own.
    const m = Math.sin(this.time * 0.145) * Math.sin(this.time * 0.061 + 1.3);
    this.murmur = smoothstep(0.5, 0.95, m) * 0.24;

    const cT = Math.max(
      smoothstep(0.3, 0.92, this.attention) * (1 - 0.75 * this.turbulence),
      this.murmur * (1 - this.attention),
    );
    this.coherence = damp(this.coherence, cT, cT > this.coherence ? 0.9 : 0.4, dt);

    // Colour is a deeper layer: earned by sustained revelation and proximity.
    this.discover = clamp(this.discover + dt * (0.045 * smoothstep(0.45, 0.9, this.coherence) - (inp.idle > 4 ? 0.006 : 0)));
    const colT = clamp(this.discover * 0.85 + closeness * 0.45) * smoothstep(0.2, 0.65, Math.max(this.coherence, this.memory * 0.55));
    this.color = damp(this.color, colT, 0.5, dt);

    // Memory rises with what was seen and fades over most of a minute.
    const seen = Math.max(smoothstep(0.3, 0.92, this.attention), this.attention * 0.6);
    if (seen > this.memory) this.memory = damp(this.memory, seen, 1.5, dt);
    else this.memory = Math.max(0, this.memory - dt / 55);
    this.peak = Math.max(this.peak, this.attention);

    // The whole composition periodically approaches complete stillness.
    const s = Math.sin((this.time * Math.PI * 2) / 74 - 1.2) * 0.5 + 0.5;
    this.still = smoothstep(0.8, 1.0, s) * (1 - clamp(this.energy * 2));

    this.morphPhase += dt * (0.011 + 0.02 * this.turbulence) + inp.dx * 0.02 * this.coherence;

    // State machine with a dwell so captions never flicker.
    let next = this.state;
    if (this.coherence > 0.5 && this.attention > 0.4) next = 2;
    else if (inp.idle > 3 && this.peak > 0.22 && this.memory > 0.06) next = 3;
    else if (this.attention > 0.035 || this.energy > 0.12) next = this.state === 2 && this.coherence > 0.38 ? 2 : 1;
    else next = 0;
    this.dwell += dt;
    if (next !== this.state && this.dwell > 2.2) {
      this.state = next;
      this.dwell = 0;
      if (next === 0) this.peak = 0;
    }
  }
}
