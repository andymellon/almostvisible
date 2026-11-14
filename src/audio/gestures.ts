/**
 * The five composed transformation gestures — one per chapter's signature moment.
 * None is a riser and none is percussive: each is a small piece of voice-leading
 * written in the visit's own mode (degree 4 is always the pure fifth 3/2, degree 1
 * the 9/8 whose octave is the fifth of the fifth).
 *
 *   signal      I    three tones enter one by one — root, fifth, octave — over a low
 *                    octave, and a sub resonance lands under the open fifth they form
 *   consonance  II   the chord blooms bottom-up into pure stacked fifths
 *                    (1 · 3/2 · 9/4 · 3 · 9/2), swells slowly, and lets go
 *   lattice     III  an arpeggio climbing the mode the way an overtone series climbs —
 *                    wide steps below, close steps above — fanned outward across the
 *                    stereo field, leaving a high fifth standing
 *   balance     IV   earth, air and light as one body taking two breaths
 *   final       V    one soft low resonance, a struck bowl two octaves wide
 */
import type { Harmony, ResolveKind } from '../core/contracts';
import type { Notes } from './notes';
import type { Space } from './space';
import type { Strikes } from './strikes';

export function playResolve(kind: ResolveKind, h: Harmony, notes: Notes, strikes: Strikes, space: Space): void {
  switch (kind) {
    case 'signal': {
      space.swell(0.5, 2.5, 1.5, 4);
      notes.play({ freq: h.freq(0, 1), at: 0.3, attack: 0.7, hold: 4.4, release: 1.5, level: 0.03, wave: 'soft', depth: 0.2 });
      notes.play({ freq: h.freq(0, 2), at: 0, attack: 0.45, hold: 4.2, release: 1.5, level: 0.034, pan: -0.5, wave: 'soft' });
      notes.play({ freq: h.freq(4, 2), at: 0.95, attack: 0.45, hold: 3.6, release: 1.6, level: 0.03, pan: 0.5, wave: 'soft' });
      notes.play({ freq: h.freq(0, 3), at: 1.9, attack: 0.4, hold: 3.0, release: 1.8, level: 0.022, pan: 0, wave: 'glass', depth: 0.5, echo: 0.2 });
      notes.play({ freq: h.root, at: 2.7, attack: 0.09, hold: 0.5, release: 1.3, level: 0.085, wave: 'sine', depth: 0 });
      break;
    }

    case 'consonance': {
      space.swell(0.9, 3.5, 2, 5);
      // [degree, octave, level, pan]
      const stack: readonly (readonly [number, number, number, number])[] = [
        [0, 1, 0.034, 0],
        [4, 1, 0.03, 0],
        [0, 2, 0.03, -0.25],
        [4, 2, 0.028, 0.25],
        [1, 3, 0.022, -0.5],
        [4, 3, 0.016, 0.5],
        [1, 4, 0.01, -0.75],
      ];
      for (let i = 0; i < stack.length; i++) {
        const [degree, octave, level, pan] = stack[i];
        const at = i * 0.42;
        notes.play({
          freq: h.freq(degree, octave),
          at,
          attack: 1.1,
          hold: 6.2 - at,
          release: 1.9 + i * 0.12,
          level,
          pan,
          wave: i >= 5 ? 'sine' : 'soft',
          depth: 0.25 + i * 0.06,
          send: 0.15,
        });
      }
      break;
    }

    case 'lattice': {
      space.swell(0.6, 1.8, 1.2, 4);
      const steps: readonly (readonly [number, number])[] = [
        [0, 2],
        [4, 2],
        [0, 3],
        [2, 3],
        [4, 3],
        [6, 3],
        [0, 4],
        [1, 4],
        [2, 4],
        [4, 4],
        [0, 5],
      ];
      const n = steps.length;
      let at = 0;
      for (let i = 0; i < n; i++) {
        const [degree, octave] = steps[i];
        const k = i / (n - 1);
        notes.play({
          freq: h.freq(degree, octave),
          at,
          attack: 0.012,
          hold: 0.06,
          release: 0.95 - 0.5 * k,
          level: 0.042 - 0.024 * k,
          pan: (i % 2 === 0 ? -1 : 1) * 0.92 * k,
          wave: 'glass',
          depth: 0.2 + 0.4 * k,
          echo: 0.28,
        });
        at += 0.22 - 0.09 * k;
      }
      // What remains standing once the arpeggio has passed.
      notes.play({ freq: h.freq(0, 3), at: at + 0.1, attack: 0.6, hold: 3.2, release: 1.6, level: 0.016, pan: -0.4, wave: 'soft', depth: 0.5 });
      notes.play({ freq: h.freq(4, 4), at: at + 0.3, attack: 0.7, hold: 3.0, release: 1.6, level: 0.01, pan: 0.4, wave: 'sine', depth: 0.6 });
      break;
    }

    case 'balance': {
      space.swell(0.5, 2, 5, 4);
      for (let breath = 0; breath < 2; breath++) {
        const at = breath * 4.3;
        const s = breath === 0 ? 1 : 0.72;
        const rel = breath === 0 ? 0.85 : 1.7;
        // earth
        notes.play({ freq: h.freq(0, 1), at, attack: 0.9, hold: 2.5, release: rel, level: 0.036 * s, pan: -0.15, wave: 'soft', depth: 0.15 });
        notes.play({ freq: h.freq(4, 1), at: at + 0.1, attack: 0.9, hold: 2.5, release: rel, level: 0.026 * s, pan: 0.15, wave: 'soft', depth: 0.2 });
        // air
        notes.play({ freq: h.freq(0, 4), at: at + 0.2, attack: 0.8, hold: 2.3, release: rel, level: 0.011 * s, pan: 0.3, depth: 0.5, airQ: 3 });
        notes.play({ freq: h.freq(4, 3), at: at + 0.25, attack: 0.8, hold: 2.3, release: rel, level: 0.009 * s, pan: -0.3, depth: 0.5, airQ: 9 });
        // light
        notes.play({ freq: h.freq(2, 4), at: at + 0.4, attack: 1.0, hold: 2.3, release: rel * 1.2, level: 0.009 * s, pan: -0.7, wave: 'sine', depth: 0.6, echo: 0.2 });
        notes.play({ freq: h.freq(4, 4), at: at + 0.5, attack: 1.0, hold: 2.3, release: rel * 1.2, level: 0.008 * s, pan: 0.7, wave: 'sine', depth: 0.6, echo: 0.2 });
        notes.play({ freq: h.freq(0, 5), at: at + 0.6, attack: 1.0, hold: 2.2, release: rel * 1.2, level: 0.006 * s, pan: 0, wave: 'sine', depth: 0.7 });
      }
      break;
    }

    case 'final': {
      space.swell(0.35, 0.6, 2, 5);
      const r = h.root;
      // [harmonic of the root, level, release]
      const bowl: readonly (readonly [number, number, number])[] = [
        [2, 0.05, 3.2],
        [1, 0.04, 4.0],
        [3, 0.02, 2.1],
        [4, 0.014, 1.5],
        [6, 0.006, 0.9],
        [8, 0.003, 0.6],
      ];
      for (const [harmonic, level, release] of bowl) {
        notes.play({ freq: r * harmonic, at: 0, attack: 0.045, hold: 0.2, release, level, wave: 'sine', depth: 0.35, send: 0.2 });
      }
      strikes.ping(r, 0.45, 'sub', 0, 0.2);
      break;
    }
  }
}
