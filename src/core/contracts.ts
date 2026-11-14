/**
 * ALMOST VISIBLE — module contracts.
 *
 * Every module is written against these interfaces and nothing else. If an
 * implementation needs something that is not here, add an *optional* member
 * and keep the existing ones stable.
 *
 * Module map (who exports what):
 *   src/core/harmony.ts      createHarmony(seed)                     → Harmony
 *   src/core/bridge.ts       createBridge(), stepBridge(bridge, harmony, dt), clearWaves(bridge) → Bridge
 *   src/core/memory.ts       createMemory()                          → Memory
 *   src/core/math.ts         damp, clamp, smoothstep, Spring, Spring3, mulberry32
 *   src/audio/AudioEngine.ts createAudioEngine(bridge)               → AudioEngine
 *   src/render/materials.ts  createMatter, createFilament, createVolumeField,
 *                            createParticles, syncShared             (see below)
 *   src/render/Stage.ts      createStage(canvas, quality)            → Stage
 *   src/core/Interaction.ts  createInteraction(canvas)               → Interaction
 *   src/ui/Interface.ts      createInterface(handlers)               → UI
 *   src/chapters/ChapterN.ts createChapterN()                        → Chapter   (N = 1..5)
 *   src/core/Director.ts     createDirector(ctx, chapters, hooks)    → Director
 *   src/main.ts              boot, frame loop, fallback
 */
import type { Camera, Object3D, PerspectiveCamera, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer } from 'three';

export const MAX_WAVES = 8;
/** Target chapter lengths in seconds (sum = 300). */
export const CHAPTER_SECONDS = [35, 55, 65, 80, 65] as const;

export type Vec3Like = { x: number; y: number; z: number };

export interface Quality {
  /** Reduced tier for phones / tablets / weak GPUs. */
  lite: boolean;
  reducedMotion: boolean;
}

// ───────────────────────────────────────────────────────────── harmony ──

export interface Harmony {
  readonly seed: number;
  /** Fundamental in Hz (46–62). */
  readonly root: number;
  readonly modeName: string;
  /** Ascending just-intonation ratios within one octave; ratios[0] === 1. */
  readonly ratios: readonly number[];
  /** Frequency of a scale degree. Degree wraps into higher octaves; `octave` shifts further. */
  freq(degree: number, octave?: number): number;
  /** Nearest in-tune frequency (any octave of the collection) to `hz`. */
  nearest(hz: number): number;
  /** Signed distance in cents from `hz` to nearest(hz). */
  cents(hz: number): number;
  /** Seeded PRNG, 0..1. Use this, never Math.random, for anything that should differ per visit. */
  rand(): number;
}

// ────────────────────────────────────────────────────────────── bridge ──

/**
 * One explicitly modelled wave source. Chapters own slots (index 0..MAX_WAVES-1)
 * and write `position`, `freq` and `level`; the bridge integrates `amp` and `phase`.
 * AudioEngine voice ids are the same indices, so sound and image share one model.
 */
export interface WaveSource {
  readonly position: Vector3;
  /** Hz. 0 = unused slot. */
  freq: number;
  /** Target level 0..1, set by the owner. */
  level: number;
  /** Smoothed level actually used by shaders (read only for owners). */
  amp: number;
  /**
   * Modelled phase in radians. Advances at a common rate plus a term proportional to
   * the source's detune from the harmonic collection, so in-tune sources produce a
   * standing interference pattern and detuned ones make it crawl at the beat rate.
   */
  phase: number;
}

/** The single audio ⇄ visual parameter bus. Plain mutable data, no events. */
export interface Bridge {
  time: number;
  dt: number;
  /** Hz, from the Harmony. */
  fundamental: number;
  readonly waves: WaveSource[];
  /** Number of sources with amp > 0.02 (harmonic complexity). */
  activeWaves: number;

  // Measured from the real output signal (AnalyserNode). When audio is off or muted
  // the bridge synthesises plausible values from the modelled sources instead.
  amplitude: number; // smoothed RMS, 0..1
  centroid: number; // spectral centroid, 0..1 (log-scaled)
  low: number;
  mid: number;
  high: number;
  /** True when the five values above come from the analyser rather than the model. */
  measured: boolean;

  /** Note-attack impulse: set to 1 by strikes, decays to 0 in ~0.6 s. */
  attack: number;
  /** World position of the most recent attack. */
  readonly attackAt: Vector3;

  /** 0 = rough / beating, 1 = coherent. Written by the active chapter. */
  stability: number;
  /** 0 = void, 1 = world fully present. Master visibility, written by the Director. */
  presence: number;
  /** 0 = monochrome … 1 = full iridescence. Written by Director + chapters. */
  spectral: number;
  /** 0 = sounding … 1 = everything has dissolved. */
  silence: number;

  /** Current chapter 0..4 (5 = ending). */
  chapter: number;
  /** Puzzle progress of the current chapter, 0..1. */
  progress: number;

  /** Pointer projected into the world (camera-facing plane through the scene focus). */
  readonly pointer: Vector3;
  /** Smoothed pointer speed, 0..1. */
  pointerEnergy: number;
}

// ────────────────────────────────────────────────────────────── memory ──

export interface MemorySnapshot {
  /** Scale degrees of resonators in the order they were woken (chapter I). */
  resonators: number[];
  /**
   * Ratio of the tuned voice to its anchor at the moment chapter II was solved, and how long it
   * took. The target is the mode's tenth over the anchor (2·ratios[2] ≈ 2.4–2.5), so consumers
   * fold it into one octave (≈ 1.2–1.25) before using it as an interval. Default 1.5.
   */
  tuning: { ratio: number; seconds: number };
  /** Final fragment positions of the chapter III constellation, and their degrees. */
  constellation: { positions: Vec3Like[]; degrees: number[] };
  /** Final chapter IV mix. */
  balance: { earth: FieldMix; air: FieldMix; light: FieldMix };
  /** Seconds (since start) of every deliberate gesture; used as rhythm in chapter V. */
  gestures: number[];
}

export interface Memory {
  readonly data: MemorySnapshot;
  gesture(time: number): void;
  reset(): void;
}

// ─────────────────────────────────────────────────────────────── audio ──

export interface FieldMix {
  /** 0..1 — proximity. */
  level: number;
  /** 0..1 — height → spectral brightness. */
  brightness: number;
  /** 0..1 — depth → diffusion / reverb send. */
  diffusion: number;
  /** 0..1 — rotation → modulation depth. */
  modulation: number;
}

export type VoiceTimbre = 'pure' | 'glass' | 'fm' | 'breath';
export type StrikeTimbre = 'bell' | 'glass' | 'sub';
export type ResolveKind = 'signal' | 'consonance' | 'lattice' | 'balance' | 'final';

/**
 * Procedural instrument (Tone.js + Web Audio). All methods are safe to call before
 * start() or when audio is unavailable — they simply do nothing. Parameter changes
 * are smoothed internally (no zipper noise, no clicks). Nothing may be left sounding
 * after reset().
 */
export interface AudioEngine {
  readonly started: boolean;
  /** Call from a user gesture. Resolves false if audio cannot start; the piece then runs silent. */
  start(): Promise<boolean>;
  setMuted(muted: boolean): void;
  setPaused(paused: boolean): void;
  setHarmony(h: Harmony): void;
  /** Once per frame: runs analysis and writes amplitude/centroid/bands into the bridge. */
  update(dt: number): void;

  /** Sustained, continuously tunable voice. `id` is the bridge.waves slot it sonifies. */
  voiceOn(id: number, freq: number, opts?: { level?: number; timbre?: VoiceTimbre; pos?: Vec3Like }): void;
  voiceSet(id: number, p: { freq?: number; level?: number; brightness?: number; pos?: Vec3Like }): void;
  voiceOff(id: number, release?: number): void;

  /** One-shot resonator. Also sets bridge.attack / bridge.attackAt. */
  strike(freq: number, opts?: { velocity?: number; pos?: Vec3Like; timbre?: StrikeTimbre }): void;

  /** Sub drone on the root. level 0 fades it out. */
  setDrone(level: number, brightness?: number): void;
  /** Chapter IV ecosystems. A level of 0 silences that field. */
  setFields(f: { earth: FieldMix; air: FieldMix; light: FieldMix }): void;
  /** 0..1 — global roughness ↔ coherence (detune spread, reverb bloom). */
  setStability(s: number): void;
  /** A composed transformation gesture for each chapter's signature moment. */
  resolve(kind: ResolveKind): void;
  /** Chapter V: build the personalised composition from what the visitor did. `intensity` 0..1. */
  setMemory(m: MemorySnapshot): void;
  setFinale(intensity: number): void;
  /** Ending: highs go first, then melody, then drone. */
  dissolve(seconds: number): void;

  /** Stop and release everything immediately but gracefully (≤ 0.5 s). */
  reset(): void;
  dispose(): void;
  /** Peak output level in dBFS since the last call to reset() — for clip testing. */
  readonly peakDb: number;
}

// ─────────────────────────────────────────────────────────── rendering ──

export type MatterVariant = 'membrane' | 'body' | 'crystal' | 'earth' | 'air' | 'light';

export interface MatterParams {
  /** 0 invisible … 1 fully present. */
  reveal: number;
  /** Impulse 0..1 (set to 1 on strike; owner decays it). */
  excite: number;
  /** 0..1 pointer proximity / hover. */
  hover: number;
  /** 0 slack / liquid … 1 taut / glassy. */
  tension: number;
  /** 0 torn apart into filaments … 1 one coherent sheet stack. */
  coherence: number;
  /** Hz of this object's own pitch (0 = none); adds a local standing wave. */
  freq: number;
  /** Per-object random 0..1. */
  seed: number;
  /** -1 cool (ice blue) … +1 warm (champagne). */
  warmth: number;
  /** How far the lamellae fan apart, 0..1. */
  spread: number;
}

/**
 * Resonant Matter applied to a geometry. `object` is ready to add to the scene
 * (it may be an InstancedMesh of lamellae). Mutate `params`, then call sync().
 */
export interface Matter {
  readonly object: Object3D;
  readonly material: ShaderMaterial;
  readonly params: MatterParams;
  sync(): void;
  dispose(): void;
}

export interface MatterOptions {
  /** 'plane': a (width × height) sheet in local XY. 'sphere' | 'ico' | 'torus': closed body of `radius`. */
  shape: 'plane' | 'disc' | 'sphere' | 'ico' | 'torus';
  width?: number;
  height?: number;
  radius?: number;
  /** Number of stacked sheets (lite tier may clamp). Default depends on variant. */
  layers?: number;
  /** Tessellation hint 0..1. */
  detail?: number;
  init?: Partial<MatterParams>;
}

export interface Filament {
  readonly object: Object3D;
  /** Endpoints are copied; call whenever they move. */
  setEndpoints(a: Vec3Like, b: Vec3Like): void;
  readonly params: { reveal: number; energy: number; tension: number; warmth: number };
  sync(): void;
  dispose(): void;
}

export interface VolumeField {
  readonly object: Object3D;
  readonly params: { reveal: number; density: number; structure: number; scale: number };
  sync(): void;
  dispose(): void;
}

export interface Particles {
  readonly object: Object3D;
  readonly params: { reveal: number; drift: number };
  /** Radial push from a world position. */
  impulse(at: Vec3Like, strength: number): void;
  sync(): void;
  dispose(): void;
}

/*
 * src/render/materials.ts must export exactly:
 *
 *   export function createMatter(variant: MatterVariant, opts: MatterOptions, quality: Quality): Matter
 *   export function createFilament(quality: Quality): Filament
 *   export function createVolumeField(quality: Quality): VolumeField
 *   export function createParticles(count: number, quality: Quality): Particles
 *   // copies Bridge → shared uniforms (wave sources, scalars, camera, viewport). Once per frame.
 *   export function syncShared(bridge: Bridge, camera: Camera, viewport: { width: number; height: number; pixelRatio: number }): void
 */
export type SyncShared = (bridge: Bridge, camera: Camera, viewport: { width: number; height: number; pixelRatio: number }) => void;

export interface CameraPose {
  position: Vec3Like;
  target: Vec3Like;
  fov?: number;
}

/** A directed camera. Never an orbit control. */
export interface CameraRig {
  readonly camera: PerspectiveCamera;
  /** Ease to a pose over `seconds` (critically damped / cubic in-out). */
  moveTo(pose: CameraPose, seconds: number): void;
  /** Jump (only used while the screen is black). */
  cut(pose: CameraPose): void;
  /** 0..1 amount of slow autonomous drift and pointer parallax. */
  drift: number;
  update(dt: number, pointerNdc: { x: number; y: number }): void;
}

export interface Stage {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly rig: CameraRig;
  readonly quality: Quality;
  readonly viewport: { width: number; height: number; pixelRatio: number };
  /** Grade controls, eased internally. */
  readonly grade: { exposure: number; bloom: number; dispersion: number; grain: number; fade: number };
  resize(width: number, height: number): void;
  /** Syncs shared uniforms and renders one frame. Also runs adaptive resolution. */
  render(bridge: Bridge, dt: number): void;
  dispose(): void;
}

// ───────────────────────────────────────────────────────── interaction ──

export interface Interactive {
  /** Accessible name, announced when focused by keyboard. */
  label: string;
  /** Position source; a forgiving sphere of `radius` (world units) around it is the hit target. */
  object: Object3D;
  radius: number;
  enabled?: boolean;
  draggable?: boolean;
  /** Clamp / project the desired drag position in place (path or volume constraint). */
  constrain?(desired: Vector3): void;
  /** Optional attractor: mutate `desired` toward a magnetic target (called after constrain). */
  magnet?(desired: Vector3, dragging: boolean): void;
  onHover?(hovering: boolean): void;
  /** Press without (or before) drag. */
  onPress?(worldPoint: Vector3): void;
  /** Called every frame while the object is moving because of a drag or its settle. */
  onMove?(position: Vector3, dragging: boolean): void;
  onRelease?(): void;
  /** Wheel while hovered/dragged, or Q/E keys while focused. delta in radians. */
  onRotate?(delta: number): void;
}

/**
 * Pointer / touch / keyboard → hover, press, sprung drag with inertia and soft release.
 * Drag moves on the camera-facing plane through the object; wheel or two-finger pinch
 * (or W/S keys) moves it in depth unless the Interactive defines onRotate, in which case
 * the wheel rotates and Shift+wheel moves in depth.
 * Keyboard: Tab / Shift+Tab focus, arrows move, W/S depth, Q/E rotate, Enter/Space press.
 */
export interface Interaction {
  add(i: Interactive): void;
  remove(i: Interactive): void;
  clear(): void;
  readonly pointer: { ndc: Vector2; world: Vector3; energy: number; down: boolean; seen: boolean };
  readonly hovered: Interactive | null;
  readonly dragging: Interactive | null;
  /** Seconds since any input. */
  readonly idle: number;
  /** Fires for every deliberate gesture (press, drag end). */
  onGesture: (() => void) | null;
  update(dt: number, camera: Camera, bridge: Bridge): void;
  dispose(): void;
}

// ──────────────────────────────────────────────────────────────── ui ──

export interface UI {
  /** Chapter numeral + name, e.g. ("I", "The First Signal"). */
  chapter(numeral: string, name: string): void;
  /** The chapter's one line of text. Empty string clears. */
  caption(text: string): void;
  /** Progressive, poetic assistance. null clears. */
  hint(text: string | null): void;
  /** Screen-reader announcement and visual caption of a sound/puzzle event. */
  announce(text: string): void;
  /** 0..1 journey progress for the thin timeline. */
  progress(t: number): void;
  /** Title / ending cards. */
  showTitle(visible: boolean): void;
  showEnding(visible: boolean): void;
  setMuted(m: boolean): void;
  setPaused(p: boolean): void;
  update(dt: number, bridge: Bridge): void;
}

export interface UIHandlers {
  onBegin(): void; // first user gesture: unlock audio, start chapter I
  onMute(muted: boolean): void;
  onPause(paused: boolean): void;
  onRestart(): void; // same seed
  onReenter(): void; // new seed
}

// ─────────────────────────────────────────────────────────── chapters ──

export interface ChapterContext {
  readonly stage: Stage;
  readonly rig: CameraRig;
  readonly audio: AudioEngine;
  readonly bridge: Bridge;
  readonly interaction: Interaction;
  readonly harmony: Harmony;
  readonly memory: Memory;
  readonly quality: Quality;
  readonly ui: UI;
}

/**
 * A chapter owns bridge.waves slots, its interactives and its scene subtree for
 * as long as it is active. It must be re-enterable after dispose() (replay).
 */
export interface Chapter {
  readonly index: number; // 0..4
  readonly numeral: string; // "I".."V"
  readonly name: string;
  readonly line: string;
  /** Build objects, add `root` to ctx.stage.scene, register interactives, start sound, move camera. */
  enter(ctx: ChapterContext): void;
  update(dt: number, ctx: ChapterContext): void;
  /** Puzzle progress 0..1 (continuous, drives feedback). */
  readonly progress: number;
  /** True once the puzzle is solved AND the signature moment has played out. */
  readonly complete: boolean;
  /**
   * Adaptive assistance, called by the Director with increasing level if the visitor
   * is behind the target pace: 1 = poetic hint (ui.hint), 2 = visible/audible guidance,
   * 3 = the world gently completes the puzzle itself over a few seconds.
   */
  assist(level: 1 | 2 | 3, ctx: ChapterContext): void;
  /** Begin the outro (≤ 4 s). The Director calls dispose() when `exited` becomes true. */
  exit(ctx: ChapterContext): void;
  readonly exited: boolean;
  /** Remove from scene, free geometries/materials, release wave slots, voices, interactives. */
  dispose(ctx: ChapterContext): void;
}

export interface Director {
  /** Start (or restart) the journey from chapter I with the given seed. */
  begin(seed: number): void;
  /** Jump straight to a chapter (dev / tests): `?chapter=3`. */
  jump(index: number): void;
  update(dt: number): void;
  readonly chapterIndex: number;
  /** Seconds since begin(), paused time excluded. */
  readonly elapsed: number;
  readonly ended: boolean;
  dispose(): void;
}
