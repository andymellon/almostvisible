/**
 * ALMOST VISIBLE — the procedural instrument.
 *
 * createAudioEngine(bridge) returns the AudioEngine of core/contracts.ts. Nothing is
 * constructed and no AudioContext is touched until start(); every other method is a
 * safe no-op until then (and forever, if audio is unavailable — the piece runs silent
 * and the bridge model drives the image).
 *
 * See README.md in this folder for the signal flow and every parameter mapping.
 */
import './quiet';
import * as Tone from 'tone';
import { MAX_WAVES } from '../core/contracts';
import type {
  AudioEngine,
  Bridge,
  FieldMix,
  Harmony,
  MemorySnapshot,
  ResolveKind,
  StrikeTimbre,
  Vec3Like,
  VoiceTimbre,
} from '../core/contracts';
import { createHarmony } from '../core/harmony';
import { mulberry32 } from '../core/math';
import { Analysis } from './analysis';
import { Drone } from './drone';
import { Fields } from './fields';
import { Finale } from './finale';
import { playResolve } from './gestures';
import { Rig, clamp01, fin, sstep } from './graph';
import { Notes } from './notes';
import { Space } from './space';
import { Strikes } from './strikes';
import { Voices } from './voices';

interface Core {
  rig: Rig;
  space: Space;
  analysis: Analysis;
  drone: Drone;
  voices: Voices;
  strikes: Strikes;
  fields: Fields;
  notes: Notes;
  finale: Finale;
}

type FieldSet = { earth: FieldMix; air: FieldMix; light: FieldMix };

/** What the piece last asked of one sustained voice — kept so a late start() can honour it. */
interface Wanted {
  on: boolean;
  freq: number;
  level: number;
  bright: number;
  timbre: VoiceTimbre;
  placed: boolean;
  pos: { x: number; y: number; z: number };
}

const DEFAULT_STABILITY = 0.7;
const START_TIMEOUT_MS = 8000;
const VOICE_TIMBRES: readonly VoiceTimbre[] = ['pure', 'glass', 'fm', 'breath'];
const STRIKE_TIMBRES: readonly StrikeTimbre[] = ['bell', 'glass', 'sub'];

const hasWebAudio = (): boolean => {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return typeof w.AudioContext === 'function' || typeof w.webkitAudioContext === 'function';
};

export interface AudioEngineOptions {
  /**
   * Reduced tier (Quality.lite): a 3.6 s room instead of 6.5 s, six strike resonators instead
   * of ten, four grain voices instead of eight, half-size analysis windows. When omitted the
   * engine decides by the rule main.ts uses for the image: `?lite`, a coarse pointer, or a
   * viewport whose short side is under 560 px.
   */
  lite?: boolean;
}

function detectLite(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as {
      matchMedia?: (q: string) => { matches: boolean };
      innerWidth?: number;
      innerHeight?: number;
      location?: { search?: string };
    };
    const query = new URLSearchParams(w.location?.search ?? '');
    if (query.has('lite') && query.get('lite') !== '0' && query.get('lite') !== 'false') return true;
    if (typeof w.matchMedia === 'function' && w.matchMedia('(pointer: coarse)').matches) return true;
    const short = Math.min(fin(w.innerWidth, Infinity), fin(w.innerHeight, Infinity));
    return short < 560;
  } catch {
    return false;
  }
}

export function createAudioEngine(bridge: Bridge, options?: AudioEngineOptions): AudioEngine {
  let core: Core | null = null;
  let started = false;
  let starting: Promise<boolean> | null = null;
  let disposed = false;

  // Desired state. Plain data, kept even before start() so that whatever the piece
  // asked for while audio was still unlocking is there the moment it does.
  let harmony: Harmony = createHarmony(0x414c4d);
  let seededFor: Harmony | null = null;
  let rand: () => number = mulberry32(0x5eed);
  let muted = false;
  let paused = false;
  let stability = DEFAULT_STABILITY;
  let droneLevel = 0;
  let droneBright = 0.3;
  let droneMul = 1;
  let fieldSet: FieldSet | null = null;
  let memory: MemorySnapshot | null = null;
  let finale = 0;
  let dissolveAt = -1;
  let dissolveFor = 1;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  const wanted: Wanted[] = [];
  for (let i = 0; i < MAX_WAVES; i++) {
    wanted.push({ on: false, freq: 0, level: 0, bright: 0.5, timbre: 'pure', placed: false, pos: { x: 0, y: 0, z: 0 } });
  }

  const slot = (id: number): Wanted | null => (id >= 0 && id < MAX_WAVES ? wanted[Math.floor(id)] : null);
  const finitePos = (p: Vec3Like | undefined): p is Vec3Like =>
    !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

  function build(ctx: Tone.BaseContext): Core {
    const rig = new Rig(ctx, options?.lite ?? detectLite());
    try {
      const space = new Space(rig);
      const analysis = new Analysis(space.analyser, space.analyserL, space.analyserR, rig.sampleRate);
      const drone = new Drone(rig, space, harmony.root);
      const voices = new Voices(rig, space);
      const strikes = new Strikes(rig, space);
      const fields = new Fields(rig, space, strikes, harmony);
      const notes = new Notes(rig, space);
      const fin = new Finale(rig, space, strikes, fields, harmony);
      return { rig, space, analysis, drone, voices, strikes, fields, notes, finale: fin };
    } catch (err) {
      rig.dispose();
      throw err;
    }
  }

  function applyState(c: Core): void {
    c.space.setStability(stability);
    c.drone.setStability(stability);
    c.fields.setStability(stability);
    c.finale.setStability(stability);
    c.drone.set(droneLevel * droneMul, droneBright, 0.7);
    if (fieldSet) c.fields.set(fieldSet);
    if (memory) c.finale.setMemory(memory);
    c.finale.setIntensity(finale);
    // Voices that were asked for while the context was still locked.
    for (let i = 0; i < MAX_WAVES; i++) {
      const w = wanted[i];
      if (!w.on) continue;
      c.voices.on(i, w.freq, w.level, w.timbre, w.placed ? w.pos : undefined);
      c.voices.set(i, { brightness: w.bright });
    }
    if (muted) c.space.setMuted(true);
  }

  /**
   * A context that is not running although the piece is — the unlocking gesture did not count,
   * or the system interrupted audio (a call, another tab; Safari reports 'interrupted') — is
   * asked again from inside every later gesture, which is the only place a browser honours it.
   */
  let unlockArmed = false;
  const onGesture = (): void => {
    const c = core;
    if (!c || paused || disposed) return;
    if (c.rig.ctx.state !== 'running') c.rig.ctx.resume().catch(() => undefined);
  };
  const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;
  function armUnlock(on: boolean): void {
    if (on === unlockArmed || typeof window === 'undefined') return;
    const w = window as unknown as {
      addEventListener?: (type: string, fn: () => void, opts?: unknown) => void;
      removeEventListener?: (type: string, fn: () => void, opts?: unknown) => void;
    };
    if (typeof w.addEventListener !== 'function' || typeof w.removeEventListener !== 'function') return;
    unlockArmed = on;
    for (const type of GESTURES) {
      if (on) w.addEventListener(type, onGesture, { capture: true, passive: true });
      else w.removeEventListener(type, onGesture, { capture: true });
    }
  }

  function teardown(): void {
    const c = core;
    core = null;
    started = false;
    armUnlock(false);
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    if (c) {
      try {
        c.rig.dispose();
      } catch {
        /* context already gone */
      }
    }
  }

  function start(): Promise<boolean> {
    if (started && core) return Promise.resolve(true);
    if (disposed) return Promise.resolve(false);
    if (starting) return starting;
    starting = (async (): Promise<boolean> => {
      try {
        if (!hasWebAudio()) return false;
        // Everything up to the first await runs synchronously inside the caller's user gesture:
        // the context is resumed and the instrument exists before this function returns.
        // Tone.getContext() constructs the AudioContext on first use and Tone.start() calls its
        // resume(): both happen here, in the same task as the click (Safari requires exactly that).
        // The graph built next is small — the room's impulse response, the noise and every
        // layer that is not sounding yet are made later, a slice per frame (see update()).
        const ctx = Tone.getContext();
        const resumed = Tone.start();
        if (!core) {
          core = build(ctx);
          applyState(core);
        }
        armUnlock(true);
        await Promise.race([resumed.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, START_TIMEOUT_MS))]);
        if (disposed || !core) return false;
        if (ctx.state !== 'running' && !paused) {
          // Not unlocked. The instrument stays built and silent; if a later gesture gets the
          // context running, update() notices and the piece gains its sound where it is.
          return false;
        }
        go();
        return true;
      } catch {
        teardown();
        return false;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  /** The context runs (or is deliberately paused): the instrument is live. */
  function go(): void {
    if (started || !core) return;
    try {
      Tone.getTransport().start();
    } catch {
      /* the transport carries nothing essential */
    }
    started = true;
    if (paused) setPaused(true);
  }

  function setMuted(m: boolean): void {
    muted = !!m;
    if (core) core.space.setMuted(muted);
  }

  function setPaused(p: boolean): void {
    paused = !!p;
    const c = core;
    if (!c) return;
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    const transport = Tone.getTransport();
    if (paused) {
      c.space.setGate(false);
      try {
        if (transport.state === 'started') transport.pause();
      } catch {
        /* ignore */
      }
      // Let the gate close (≈ 60 ms) before the context stops, so pausing never clicks.
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        if (!paused || core !== c) return;
        const raw = c.rig.ctx.rawContext as AudioContext;
        if (typeof raw.suspend === 'function' && raw.state === 'running') raw.suspend().catch(() => undefined);
      }, 90);
    } else {
      c.rig.ctx.resume().catch(() => undefined);
      c.space.setGate(true);
      try {
        if (transport.state !== 'started') transport.start();
      } catch {
        /* ignore */
      }
    }
  }

  function setHarmony(h: Harmony): void {
    if (!h || !(h.root > 0) || !h.ratios || h.ratios.length === 0) return;
    harmony = h;
    if (h !== seededFor) {
      // One draw from the visit's generator seeds a private stream for grains and rare notes.
      // The shared generator is advanced exactly once per Harmony (never per frame, and not
      // again if the same Harmony is passed twice), so everything else that draws from it
      // stays reproducible for a given seed.
      seededFor = h;
      rand = mulberry32(Math.floor(h.rand() * 4294967296) >>> 0);
    }
    const c = core;
    if (!c) return;
    c.drone.retune(h.root);
    c.fields.retune(h);
    c.finale.retune(h);
  }

  function update(dt: number): void {
    const c = core;
    if (c) {
      // Deferred construction, one bounded slice per frame: first the room, then the noise.
      if (c.space.prepare() && !c.rig.noiseReady) c.rig.warm();
      // A context that came up late (see start()).
      if (!started && !starting && !paused && c.rig.ctx.state === 'running') go();
    }
    if (!c || !started) {
      bridge.measured = false;
      return;
    }
    const step = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0;
    const running = !paused && c.rig.ctx.state === 'running';
    if (running) {
      // Dissolve: highs (master low-pass, Light) → Air, voices, melody → pad, Earth → drone.
      let light = 1;
      let air = 1;
      let earth = 1;
      let voice = 1;
      let pad = 1;
      let melody = true;
      droneMul = 1;
      if (dissolveAt >= 0) {
        const p = (c.rig.now - dissolveAt) / dissolveFor;
        light = 1 - sstep(0, 0.3, p);
        air = 1 - sstep(0.1, 0.5, p);
        voice = 1 - sstep(0.15, 0.55, p);
        melody = p < 0.4;
        pad = 1 - sstep(0.3, 0.68, p);
        earth = 1 - sstep(0.35, 0.75, p);
        droneMul = 1 - sstep(0.5, 0.92, p);
      }
      const tc = dissolveAt >= 0 ? Math.max(0.1, dissolveFor * 0.03) : 0.7;
      c.fields.setFade(light, air, earth);
      c.voices.setFade(voice, 0.25);
      c.drone.set(droneLevel * droneMul, droneBright, tc);
      c.fields.update(step, rand);
      c.finale.update(step, rand, bridge, melody, pad);
      c.strikes.prune();
      c.rig.sweep();
    }
    c.analysis.update(step, bridge, running && !muted);
  }

  function voiceOn(id: number, freq: number, opts?: { level?: number; timbre?: VoiceTimbre; pos?: Vec3Like }): void {
    const timbre = opts?.timbre && VOICE_TIMBRES.includes(opts.timbre) ? opts.timbre : 'pure';
    const level = clamp01(fin(opts?.level, 0.7));
    const pos = finitePos(opts?.pos) ? opts?.pos : undefined;
    const w = slot(id);
    if (w && freq > 0 && Number.isFinite(freq)) {
      if (!w.on || w.timbre !== timbre) w.bright = 0.5;
      w.on = true;
      w.freq = freq;
      w.level = level;
      w.timbre = timbre;
      if (pos) {
        w.placed = true;
        w.pos.x = pos.x;
        w.pos.y = pos.y;
        w.pos.z = pos.z;
      }
    }
    if (core) core.voices.on(id, freq, level, timbre, pos);
  }

  function voiceSet(id: number, p: { freq?: number; level?: number; brightness?: number; pos?: Vec3Like }): void {
    if (!p) return;
    const w = slot(id);
    if (w && w.on) {
      if (p.freq !== undefined && p.freq > 0 && Number.isFinite(p.freq)) w.freq = p.freq;
      if (p.level !== undefined) w.level = clamp01(fin(p.level, w.level));
      if (p.brightness !== undefined) w.bright = clamp01(fin(p.brightness, w.bright));
      if (finitePos(p.pos)) {
        w.placed = true;
        w.pos.x = p.pos.x;
        w.pos.y = p.pos.y;
        w.pos.z = p.pos.z;
      }
    }
    if (core) core.voices.set(id, p);
  }

  function voiceOff(id: number, release?: number): void {
    const w = slot(id);
    if (w) {
      w.on = false;
      w.placed = false;
    }
    if (core) core.voices.off(id, fin(release, 1.2));
  }

  function strike(freq: number, opts?: { velocity?: number; pos?: Vec3Like; timbre?: StrikeTimbre }): void {
    // The image answers a strike whether or not it can be heard.
    bridge.attack = 1;
    const pos = finitePos(opts?.pos) ? opts?.pos : undefined;
    if (pos) bridge.attackAt.set(pos.x, pos.y, pos.z);
    if (!core) return;
    const timbre = opts?.timbre && STRIKE_TIMBRES.includes(opts.timbre) ? opts.timbre : 'bell';
    core.strikes.strike(freq, fin(opts?.velocity, 0.7), timbre, pos);
  }

  function setDrone(level: number, brightness?: number): void {
    droneLevel = clamp01(fin(level, 0));
    if (brightness !== undefined) droneBright = clamp01(fin(brightness, droneBright));
    if (core) core.drone.set(droneLevel * droneMul, droneBright, 0.7);
  }

  function setFields(f: FieldSet): void {
    if (!f) return;
    fieldSet = f;
    if (core) core.fields.set(f);
  }

  function setStability(s: number): void {
    stability = clamp01(fin(s, stability));
    const c = core;
    if (!c) return;
    c.space.setStability(stability);
    c.drone.setStability(stability);
    c.fields.setStability(stability);
    c.finale.setStability(stability);
  }

  function resolve(kind: ResolveKind): void {
    const c = core;
    if (!c) return;
    // The last resonance is asked for after the dissolve has closed the master: let it through
    // (dark, alone — every other source has already been faded at its own gain), then close for good.
    if (kind === 'final' && dissolveAt >= 0) c.space.afterglow();
    playResolve(kind, harmony, c.notes, c.strikes, c.space);
  }

  function setMemory(m: MemorySnapshot): void {
    if (!m) return;
    memory = m;
    if (core) core.finale.setMemory(m);
  }

  function setFinale(intensity: number): void {
    finale = clamp01(fin(intensity, 0));
    if (core) core.finale.setIntensity(finale);
  }

  function dissolve(seconds: number): void {
    const c = core;
    if (!c) return;
    dissolveFor = Math.max(0.5, fin(seconds, 8));
    dissolveAt = c.rig.now;
    c.space.dissolve(dissolveFor);
  }

  function reset(): void {
    droneLevel = 0;
    droneMul = 1;
    fieldSet = null;
    memory = null;
    finale = 0;
    dissolveAt = -1;
    stability = DEFAULT_STABILITY;
    for (let i = 0; i < MAX_WAVES; i++) {
      wanted[i].on = false;
      wanted[i].placed = false;
    }
    const c = core;
    if (!c) return;
    c.voices.allOff(0.12);
    c.voices.setFade(1, 0.05);
    c.strikes.silence();
    c.notes.silence();
    c.drone.silence();
    c.fields.silence();
    c.finale.stop();
    c.space.hush();
    c.space.setStability(stability);
    c.drone.setStability(stability);
    c.fields.setStability(stability);
    c.finale.setStability(stability);
    c.analysis.resetPeak();
  }

  function dispose(): void {
    disposed = true;
    if (core) {
      try {
        const transport = Tone.getTransport();
        if (transport.state !== 'stopped') transport.stop();
      } catch {
        /* ignore */
      }
    }
    teardown();
    bridge.measured = false;
  }

  return {
    get started() {
      return started;
    },
    start,
    setMuted,
    setPaused,
    setHarmony,
    update,
    voiceOn,
    voiceSet,
    voiceOff,
    strike,
    setDrone,
    setFields,
    setStability,
    resolve,
    setMemory,
    setFinale,
    dissolve,
    reset,
    dispose,
    get peakDb() {
      return core ? core.analysis.peakDb : -Infinity;
    },
  };
}
