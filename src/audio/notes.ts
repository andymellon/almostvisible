/**
 * Scheduled single tones with slow envelopes — the material of the composed
 * transformation gestures. Each note is its own small patch, scheduled sample-accurately
 * ahead of time and freed when its release has finished.
 */
import { Patch, clamp01, depthGain, depthSend, type Rig } from './graph';
import type { Space } from './space';

export interface NoteSpec {
  freq: number;
  /** Onset, seconds from now. */
  at: number;
  /** Attack time constant (s). The tone reaches ~95 % after three of these. */
  attack: number;
  /** Seconds from onset until the release begins. */
  hold: number;
  /** Release time constant (s). */
  release: number;
  /** Peak, linear. */
  level: number;
  pan?: number;
  /** 0 close … 1 far. */
  depth?: number;
  wave?: 'sine' | 'soft' | 'glass';
  /** Additional reverb send, and delay send. */
  send?: number;
  echo?: number;
  /** If set, the note is a band of breath (noise through a resonance of this Q) instead of a tone. */
  airQ?: number;
}

interface Live {
  patch: Patch;
  amp: GainNode;
  end: number;
}

const MAX_NOTES = 48;

export class Notes {
  private readonly live: Live[] = [];
  private readonly top: number;

  constructor(
    private readonly rig: Rig,
    private readonly space: Space,
  ) {
    this.top = rig.sampleRate * 0.45;
  }

  play(n: NoteSpec): void {
    if (!(n.freq > 0) || !Number.isFinite(n.freq) || n.freq >= this.top || !(n.level > 0)) return;
    const now = this.rig.now;
    this.prune(now);
    if (this.live.length >= MAX_NOTES) return;

    const p = new Patch(this.rig);
    const t0 = now + 0.01 + Math.max(0, n.at);
    const depth = clamp01(n.depth ?? 0.3);
    const amp = p.gain(0);
    const pan = p.pan(Math.max(-1, Math.min(1, n.pan ?? 0)));
    const send = p.gain(depthSend(depth) + (n.send ?? 0));
    amp.connect(pan);
    pan.connect(this.space.dry);
    pan.connect(send);
    send.connect(this.space.reverbIn);
    if (n.echo) {
      const echo = p.gain(n.echo);
      pan.connect(echo);
      echo.connect(this.space.delayIn);
    }

    let level = n.level * depthGain(depth);
    if (n.airQ) {
      const src = p.noise(n.freq * 0.0071 + n.at);
      const bp = p.filter('bandpass', n.freq, n.airQ);
      src.connect(bp);
      bp.connect(amp);
      // Narrow-band noise is far quieter than a tone of the same peak; bring it to a comparable loudness.
      level *= 4 * Math.sqrt(Math.max(1, n.airQ));
    } else {
      const wave = n.wave === 'glass' ? this.rig.glassWave : n.wave === 'sine' ? 'sine' : this.rig.softWave;
      const o = p.osc(wave, n.freq, t0);
      o.connect(amp);
    }

    const attack = Math.max(0.003, n.attack);
    const release = Math.max(0.01, n.release);
    const hold = Math.max(attack, n.hold);
    amp.gain.setValueAtTime(0, t0);
    amp.gain.setTargetAtTime(level, t0, attack);
    amp.gain.setTargetAtTime(0, t0 + hold, release);
    // Nine release time constants: the oscillator is stopped 78 dB under the note's own peak.
    const end = t0 + hold + release * 9;
    p.freeAt(end);
    this.live.push({ patch: p, amp, end });
  }

  private prune(now: number): void {
    const l = this.live;
    for (let i = l.length - 1; i >= 0; i--) {
      if (l[i].end <= now || l[i].patch.dead) {
        l[i] = l[l.length - 1];
        l.pop();
      }
    }
  }

  /** Release every sounding or pending note within ~0.25 s. */
  silence(): void {
    const now = this.rig.now;
    for (const n of this.live) {
      if (n.patch.dead) continue;
      n.amp.gain.cancelScheduledValues(now);
      n.amp.gain.setTargetAtTime(0, now, 0.04);
      n.patch.freeAt(now + 0.4);
    }
    this.live.length = 0;
  }
}
