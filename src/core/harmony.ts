import type { Harmony } from './contracts';
import { mulberry32 } from './math';

/** Just-intoned modal collections. Each includes 3/2 so a pure fifth is always available. */
const MODES: { name: string; ratios: number[] }[] = [
  { name: 'dorian', ratios: [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 5 / 3, 9 / 5] },
  { name: 'lydian', ratios: [1, 9 / 8, 5 / 4, 45 / 32, 3 / 2, 5 / 3, 15 / 8] },
  { name: 'aeolian', ratios: [1, 9 / 8, 6 / 5, 4 / 3, 3 / 2, 8 / 5, 9 / 5] },
  { name: 'mixolydian', ratios: [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 7 / 4] },
  { name: 'harmonic', ratios: [1, 9 / 8, 5 / 4, 11 / 8, 3 / 2, 13 / 8, 7 / 4] },
];

/** A new harmonic world per seed: root between 46 and 62 Hz and one modal collection. */
export function createHarmony(seed: number): Harmony {
  const rand = mulberry32(seed);
  const root = 46 + rand() * 16;
  const mode = MODES[Math.floor(rand() * MODES.length) % MODES.length];
  const ratios = mode.ratios;
  const n = ratios.length;

  const freq = (degree: number, octave = 0) => {
    const o = Math.floor(degree / n);
    const d = ((degree % n) + n) % n;
    return root * ratios[d] * Math.pow(2, o + octave);
  };

  const nearest = (hz: number) => {
    if (!(hz > 0)) return root;
    const oct = Math.floor(Math.log2(hz / root));
    let best = root;
    let bestD = Infinity;
    for (let o = oct - 1; o <= oct + 1; o++) {
      for (let d = 0; d < n; d++) {
        const f = root * ratios[d] * Math.pow(2, o);
        const dist = Math.abs(Math.log2(hz / f));
        if (dist < bestD) {
          bestD = dist;
          best = f;
        }
      }
    }
    return best;
  };

  const cents = (hz: number) => (hz > 0 ? 1200 * Math.log2(hz / nearest(hz)) : 0);

  return { seed, root, modeName: mode.name, ratios, freq, nearest, cents, rand };
}

/** Cents between two frequencies (signed, b relative to a). */
export const centsBetween = (a: number, b: number) => 1200 * Math.log2(b / a);
