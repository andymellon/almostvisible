import type { FieldMix, Memory, MemorySnapshot } from './contracts';

const mix = (level: number, brightness: number, diffusion: number, modulation: number): FieldMix => ({ level, brightness, diffusion, modulation });

/** Sensible defaults so chapter V is beautiful even if a visitor jumps straight to it. */
const blank = (): MemorySnapshot => ({
  resonators: [0, 4, 2],
  tuning: { ratio: 1.5, seconds: 20 },
  constellation: {
    positions: [
      { x: -1.2, y: -0.5, z: 0 },
      { x: 1.2, y: -0.5, z: 0.2 },
      { x: 0, y: 1.1, z: -0.3 },
    ],
    degrees: [0, 4, 2],
  },
  balance: { earth: mix(0.6, 0.3, 0.5, 0.3), air: mix(0.5, 0.5, 0.6, 0.4), light: mix(0.5, 0.75, 0.4, 0.3) },
  gestures: [],
});

/** Everything the visitor did, kept so the finale can be composed from it. */
export function createMemory(): Memory {
  let data = blank();
  return {
    get data() {
      return data;
    },
    gesture(time: number) {
      if (data.gestures.length < 256) data.gestures.push(time);
    },
    reset() {
      data = blank();
    },
  };
}
