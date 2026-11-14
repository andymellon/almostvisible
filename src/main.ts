/**
 * ALMOST VISIBLE — boot, frame loop, fallback.
 *
 * Query parameters
 *   ?seed=N      fixed harmonic world (Reenter then walks a deterministic sequence from it)
 *   ?lite        force the reduced tier (also chosen for coarse pointers and small screens)
 *   ?static      show the static fallback instead of the live piece
 *   ?chapter=N   1..5 — after Begin, jump straight to that chapter
 *   ?autostart=1 DEV only — begin at once, no title card, no audio
 *
 * The stylesheet is linked from index.html so the title card is styled before any script runs.
 */
import { createAudioEngine } from './audio/AudioEngine';
import { createChapter1 } from './chapters/Chapter1';
import { createChapter2 } from './chapters/Chapter2';
import { createChapter3 } from './chapters/Chapter3';
import { createChapter4 } from './chapters/Chapter4';
import { createChapter5 } from './chapters/Chapter5';
import { createBridge, stepBridge } from './core/bridge';
import type { Chapter, ChapterContext, Quality, Stage } from './core/contracts';
import { createDirector } from './core/Director';
import { createHarmony } from './core/harmony';
import { createInteraction } from './core/Interaction';
import { createMemory } from './core/memory';
import { createStage } from './render/Stage';
import { createInterface, showFallback } from './ui/Interface';

const MAX_DT = 0.05;
const MIN_DT = 0.001;
const AUDIO_START_TIMEOUT_MS = 2500;
const SILENT_MESSAGE = 'Sound is unavailable — the piece continues in silence.';
const LOST_MESSAGE = 'The graphics context was lost, and with it the image. Reload the page to reenter.';

function randomSeed(): number {
  try {
    const word = new Uint32Array(1);
    crypto.getRandomValues(word);
    return word[0] >>> 0;
  } catch {
    return (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
  }
}

/** Deterministic successor (an integer hash), so a fixed ?seed still yields a new world on Reenter. */
function successor(seed: number): number {
  let x = (seed + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = (x ^ (x >>> 15)) >>> 0;
  return x === seed ? (x + 1) >>> 0 : x;
}

function boot(): void {
  const stageElement = document.getElementById('stage');
  if (!(stageElement instanceof HTMLCanvasElement)) throw new Error('main: #stage canvas is missing from index.html');
  const canvas: HTMLCanvasElement = stageElement;

  const query = new URLSearchParams(window.location.search);
  const flag = (name: string) => query.has(name) && query.get(name) !== '0' && query.get(name) !== 'false';

  if (flag('static')) {
    showFallback();
    return;
  }

  const quality: Quality = {
    lite: flag('lite') || window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 560,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };

  let stage: Stage;
  try {
    stage = createStage(canvas, quality);
  } catch (err) {
    console.warn('[almost visible] WebGL unavailable, showing the static fallback.', err);
    showFallback();
    return;
  }

  const seedParam = query.has('seed') ? Number(query.get('seed')) : NaN;
  const fixedSeed = Number.isFinite(seedParam);
  let seed = fixedSeed ? Math.floor(Math.abs(seedParam)) >>> 0 : randomSeed();

  const chapterParam = query.has('chapter') ? Math.floor(Number(query.get('chapter'))) : NaN;
  const startChapter = chapterParam >= 1 && chapterParam <= 5 ? chapterParam : 0;

  const bridge = createBridge();
  const memory = createMemory();
  const audio = createAudioEngine(bridge);
  const interaction = createInteraction(canvas);

  let muted = false;
  let userPaused = false;
  let dead = false;
  let starting = false;
  /** DEV: the test harness is stepping frames by hand; rAF stays off. */
  let manual = false;
  let raf = 0;
  let last = 0;

  const ui = createInterface({
    onBegin: () => void beginWithAudio(),
    onMute: (m) => {
      muted = m;
      audio.setMuted(m);
      ui.setMuted(m);
    },
    onPause: (p) => setPaused(p),
    onRestart: () => {
      if (dead) return;
      if (userPaused) setPaused(false);
      director.begin(seed);
    },
    onReenter: () => {
      if (dead) return;
      if (userPaused) setPaused(false);
      const previous = seed;
      seed = fixedSeed ? successor(previous) : randomSeed();
      if (seed === previous) seed = successor(previous);
      director.begin(seed);
    },
  });

  interaction.onFocus = (label) => ui.announce(label);

  const chapters: Chapter[] = [createChapter1(), createChapter2(), createChapter3(), createChapter4(), createChapter5()];

  // The Director replaces ctx.harmony on every begin(); everything else is fixed for the session.
  const ctx: ChapterContext = {
    stage,
    rig: stage.rig,
    audio,
    bridge,
    interaction,
    harmony: createHarmony(seed),
    memory,
    quality: stage.quality,
    ui,
  };
  bridge.fundamental = ctx.harmony.root;

  const director = createDirector(ctx, chapters, {
    onEnded: () => {
      // The Director has faded to black and raised the ending card; nothing more to do here.
    },
    setHarmony: (s) => createHarmony(s),
  });

  // ── frame ──────────────────────────────────────────────────────────────

  const frame = (dt: number) => {
    interaction.update(dt, stage.rig.camera, bridge);
    stepBridge(bridge, ctx.harmony, dt);
    audio.update(dt);
    director.update(dt);
    stage.rig.update(dt, interaction.pointer.ndc);
    ui.update(dt, bridge);
    stage.render(bridge, dt);
  };

  const shouldRun = () => !dead && !manual && !userPaused && !document.hidden;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(MAX_DT, Math.max(MIN_DT, (now - last) / 1000));
    last = now;
    frame(dt);
  };

  const startLoop = () => {
    if (raf || !shouldRun()) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };

  const stopLoop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  function setPaused(p: boolean): void {
    if (dead) return;
    userPaused = p;
    audio.setPaused(p || document.hidden);
    ui.setPaused(p);
    // Paused: time stops and the last frame stays on the canvas.
    if (p) stopLoop();
    else startLoop();
  }

  // ── begin ──────────────────────────────────────────────────────────────

  function launch(): void {
    if (dead) return;
    director.begin(seed);
    if (startChapter) director.jump(startChapter - 1);
    canvas.focus({ preventScroll: true });
  }

  /**
   * Resolves true / false with the engine's answer, or null if it has not answered in time
   * (the journey then starts anyway and sound joins if and when the context comes up).
   */
  function startAudio(): Promise<boolean | null> {
    return new Promise((resolve) => {
      let settled = false;
      const late = (ok: boolean) => {
        if (dead) return;
        if (!ok) {
          ui.announce(SILENT_MESSAGE);
          return;
        }
        audio.setHarmony(ctx.harmony);
        audio.setMuted(muted);
        audio.setPaused(userPaused || document.hidden);
      };
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, AUDIO_START_TIMEOUT_MS);
      const answer = (ok: boolean) => {
        window.clearTimeout(timer);
        if (settled) {
          late(ok);
          return;
        }
        settled = true;
        resolve(ok);
      };
      let pending: Promise<boolean>;
      try {
        pending = audio.start(); // called synchronously inside the user gesture
      } catch {
        answer(false);
        return;
      }
      pending.then(answer, () => answer(false));
    });
  }

  async function beginWithAudio(): Promise<void> {
    if (starting || dead) return;
    starting = true;
    const ok = await startAudio();
    starting = false;
    if (dead) return;
    if (ok === false) ui.announce(SILENT_MESSAGE);
    audio.setMuted(muted);
    launch();
  }

  // ── environment ────────────────────────────────────────────────────────

  const onResize = () => {
    if (dead) return;
    stage.resize(window.innerWidth, window.innerHeight);
    // Resizing clears the drawing buffer; while paused, redraw the frozen moment once.
    if (!raf && !manual && !document.hidden) stage.render(bridge, 1 / 60);
  };

  const onVisibility = () => {
    if (dead) return;
    if (document.hidden) {
      stopLoop();
      audio.setPaused(true);
    } else {
      audio.setPaused(userPaused);
      startLoop();
      // Some browsers drop the drawing buffer of a hidden tab: redraw the frozen moment.
      if (userPaused && !manual) stage.render(bridge, 1 / 60);
    }
  };

  function die(reason: string): void {
    if (dead) return;
    dead = true;
    stopLoop();
    try {
      audio.dispose();
    } catch (err) {
      console.warn('[almost visible] audio did not shut down cleanly.', err);
    }
    showFallback(reason);
  }

  const onContextLost = (ev: Event) => {
    ev.preventDefault();
    die(LOST_MESSAGE);
  };

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onContextLost);

  stage.resize(window.innerWidth, window.innerHeight);
  startLoop();

  // ── development ────────────────────────────────────────────────────────

  if (import.meta.env.DEV) {
    const dev = {
      director,
      bridge,
      stage,
      audio,
      interaction,
      memory,
      ctx,
      chapters,
      ui,
      get seed(): number {
        return seed;
      },
      /** Cancels rAF and runs the exact frame-loop body n times synchronously. */
      step(n: number, dt = 1 / 60): void {
        manual = true;
        stopLoop();
        for (let i = 0; i < n; i++) frame(dt);
      },
      /** Same as pressing Begin, without audio. `chapter` is 1..5, like ?chapter. */
      begin(nextSeed?: number, chapter?: number): void {
        if (typeof nextSeed === 'number' && Number.isFinite(nextSeed)) seed = Math.floor(Math.abs(nextSeed)) >>> 0;
        ui.showTitle(false);
        if (userPaused) setPaused(false);
        director.begin(seed);
        const target = chapter === undefined ? startChapter : Math.floor(chapter);
        if (target >= 1) director.jump(Math.min(target, chapters.length) - 1);
      },
      /** Hand the loop back to requestAnimationFrame after step(). */
      resume(): void {
        manual = false;
        startLoop();
      },
    };
    (window as unknown as { __av?: typeof dev }).__av = dev;

    if (flag('autostart')) dev.begin();

    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        dead = true;
        stopLoop();
        window.removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', onVisibility);
        canvas.removeEventListener('webglcontextlost', onContextLost);
        director.dispose();
        interaction.dispose();
        ui.dispose();
        audio.dispose();
        stage.dispose();
        delete (window as unknown as { __av?: typeof dev }).__av;
      });
    }
  }
}

boot();
