/**
 * Director — the journey's clock. Enters, paces and retires the five chapters.
 *
 * Phases
 *   idle     nothing begun (title card)
 *   closing  begin() was called over a live chapter: a short dip to black before teardown
 *   hold     black hold before chapter I
 *   active   a chapter is running; adaptive assistance against its target length
 *   exiting  the chapter plays its outro; when `exited` (or after 6 s) it is disposed
 *   ended    chapter V has dissolved and the ending card is up
 *
 * Bridge fields owned here: chapter, progress, presence, and the per-chapter *baseline*
 * of spectral. Spectral is eased toward the baseline before the chapter updates, so a
 * chapter that writes max(current, x) holds it higher for as long as it keeps writing.
 *
 * stage.grade.fade is used in exactly two places: the fade to black after chapter V,
 * and the dip to black when the visitor restarts mid-journey.
 */
import { clearWaves } from './bridge';
import { CHAPTER_SECONDS, type Chapter, type ChapterContext, type Director, type Harmony } from './contracts';
import { clamp, damp, smoothstep } from './math';

export interface DirectorHooks {
  /** Chapter V has dissolved and the ending card is showing. */
  onEnded(): void;
  /** Build the harmonic world for a seed. The Director assigns the result to ctx.harmony. */
  setHarmony(seed: number): Harmony;
}

type Phase = 'idle' | 'closing' | 'hold' | 'active' | 'exiting' | 'ended';

const JOURNEY_SECONDS = 300;
const BLACK_HOLD = 1.5;
const CLOSE_SECONDS = 0.7;
const CAPTION_IN = 1.5;
const CAPTION_HOLD = 9;
const EXIT_TIMEOUT = 6;
const FINAL_FADE_SECONDS = 3.5;
/** Fractions of a chapter's target length at which assist(1|2|3) is issued. */
const ASSIST_AT = [0.55, 0.85, 1.1] as const;
/**
 * Seconds a chapter is given after its last assist before it is retired unfinished. Measured from
 * the chapter's NOMINAL length, not the shortened leash of a late visitor: assistance comes sooner
 * for someone who is behind, but a signature moment (or chapter V's fixed score) is never cut short.
 */
const LONG_STOP_GRACE = 25;
/** Master visibility per chapter. */
const PRESENCE = [0.82, 0.9, 0.95, 1, 1] as const;
/** Colour baseline per chapter: monochrome → iridescent. */
const SPECTRAL = [0, 0.12, 0.28, 0.5, 0.75] as const;

export function createDirector(ctx: ChapterContext, chapters: Chapter[], hooks: DirectorHooks): Director {
  const order = chapters.slice().sort((a, b) => a.index - b.index);
  const { bridge, ui, audio, interaction, memory, stage } = ctx;
  const mutable = ctx as { harmony: Harmony };

  let phase: Phase = 'idle';
  let index = 0;
  let current: Chapter | null = null;
  let elapsed = 0;
  let ended = false;
  let seed = ctx.harmony.seed;

  let holdT = 0;
  let closeT = 0;
  let chapterT = 0;
  let exitT = 0;
  let target = CHAPTER_SECONDS[0] as number;
  /** Chapter time at which a chapter that has not reported complete is retired anyway. */
  let longStop = CHAPTER_SECONDS[0] * ASSIST_AT[2] + LONG_STOP_GRACE;
  let assisted = 0;
  /** 0 not yet shown · 1 showing · 2 cleared */
  let captionState = 0;
  let presenceRate = 0.8;

  const onGesture = () => {
    if (phase === 'active' || phase === 'exiting') memory.gesture(elapsed);
  };
  interaction.onGesture = onGesture;

  const level = (table: readonly number[], i: number) => table[Math.min(Math.max(i, 0), table.length - 1)];

  function scheduledStart(i: number): number {
    let t = 0;
    for (let k = 0; k < i && k < CHAPTER_SECONDS.length; k++) t += CHAPTER_SECONDS[k];
    return t;
  }

  function report(what: string, err: unknown): void {
    console.error(`[director] chapter ${current ? current.numeral : '?'} failed in ${what}`, err);
  }

  /** Dispose the live chapter (if any) and return every shared resource to neutral. */
  function teardown(): void {
    const ch = current;
    current = null;
    if (ch) {
      try {
        ch.dispose(ctx);
      } catch (err) {
        console.error(`[director] chapter ${ch.numeral} failed in dispose`, err);
      }
    }
    clearWaves(bridge);
    interaction.clear();
    interaction.onGesture = onGesture;
    ui.hint(null);
    ui.caption('');
  }

  /** Everything begin() promises, once the previous world (if any) is out of sight. */
  function resetWorld(): void {
    teardown();
    for (let i = 0; i < bridge.waves.length; i++) {
      bridge.waves[i].amp = 0;
      bridge.waves[i].phase = 0;
    }
    bridge.activeWaves = 0;
    bridge.attack = 0;
    bridge.stability = 0;
    bridge.presence = 0;
    bridge.spectral = 0;
    bridge.silence = 0;
    bridge.chapter = 0;
    bridge.progress = 0;
    audio.reset();
    const harmony = hooks.setHarmony(seed);
    mutable.harmony = harmony;
    bridge.fundamental = harmony.root;
    audio.setHarmony(harmony);
  }

  function enter(i: number): void {
    index = i;
    const ch = order[i];
    current = ch;
    chapterT = 0;
    exitT = 0;
    assisted = 0;
    captionState = 0;
    presenceRate = 0.8;
    // A visitor who is behind schedule gets a slightly shorter leash, never a longer one.
    const nominal = CHAPTER_SECONDS[Math.min(i, CHAPTER_SECONDS.length - 1)];
    const late = Math.max(0, elapsed - BLACK_HOLD - scheduledStart(i));
    target = clamp(nominal - late * 0.5, nominal * 0.75, nominal);
    longStop = nominal * ASSIST_AT[2] + LONG_STOP_GRACE;

    bridge.chapter = i;
    bridge.progress = 0;
    stage.grade.fade = 0;
    ui.hint(null);
    ui.caption('');
    ui.chapter(ch.numeral, ch.name);
    phase = 'active';
    try {
      ch.enter(ctx);
    } catch (err) {
      report('enter', err);
      advance();
    }
  }

  function beginExit(): void {
    const ch = current;
    if (!ch) return;
    ui.hint(null);
    if (captionState === 1) ui.caption('');
    captionState = 2;
    exitT = 0;
    phase = 'exiting';
    try {
      ch.exit(ctx);
    } catch (err) {
      report('exit', err);
      exitT = EXIT_TIMEOUT;
    }
  }

  /** The current chapter is over: retire it and move on. */
  function advance(): void {
    const next = index + 1;
    teardown();
    if (next < order.length) {
      enter(next);
      return;
    }
    phase = 'ended';
    ended = true;
    bridge.chapter = order.length;
    bridge.progress = 1;
    bridge.presence = 0;
    stage.grade.fade = 1;
    ui.chapter('', '');
    ui.progress(1);
    ui.showEnding(true);
    hooks.onEnded();
  }

  function begin(nextSeed: number): void {
    seed = nextSeed;
    ended = false;
    elapsed = 0;
    ui.showEnding(false);
    ui.chapter('', '');
    ui.hint(null);
    ui.caption('');
    ui.progress(0);
    interaction.clear();
    interaction.onGesture = onGesture;
    memory.reset();
    if (current) {
      // Never a hard cut: the live chapter sinks into black first, then the world is rebuilt.
      // Sound stops now; the chapter is frozen (not updated) while it fades.
      audio.reset();
      phase = 'closing';
      closeT = CLOSE_SECONDS;
      stage.grade.fade = 1;
      return;
    }
    resetWorld();
    phase = 'hold';
    holdT = BLACK_HOLD;
  }

  function jump(to: number): void {
    const i = Math.min(Math.max(Math.floor(to) || 0, 0), order.length - 1);
    if (phase === 'closing') resetWorld();
    else {
      // Leaving a live chapter (or the ending) sideways: its drone, fields, finale and any
      // dissolve in progress must not follow into the next one. begin() has already done this
      // when the jump comes straight after it.
      const sounding = current !== null || phase === 'ended';
      teardown();
      if (sounding) {
        audio.reset();
        audio.setHarmony(ctx.harmony);
      }
    }
    ended = false;
    ui.showEnding(false);
    elapsed = scheduledStart(i);
    bridge.presence = 0;
    bridge.spectral = level(SPECTRAL, i);
    bridge.silence = 0;
    bridge.stability = 0;
    enter(i);
    presenceRate = 1.6; // arriving from black with nothing before it: come up a little sooner
  }

  function update(dt: number): void {
    if (phase === 'idle' || phase === 'ended') return;

    elapsed += dt;
    ui.progress(clamp(elapsed / JOURNEY_SECONDS));

    if (phase === 'closing') {
      closeT -= dt;
      bridge.presence = damp(bridge.presence, 0, 7, dt);
      if (closeT <= 0) {
        resetWorld();
        phase = 'hold';
        holdT = BLACK_HOLD;
      }
      return;
    }

    if (phase === 'hold') {
      holdT -= dt;
      if (holdT <= 0) enter(0);
      return;
    }

    const ch = current;
    if (!ch) return;

    if (phase === 'active') {
      chapterT += dt;
      bridge.presence = damp(bridge.presence, level(PRESENCE, index), presenceRate, dt);
      const base = level(SPECTRAL, index);
      bridge.spectral = damp(bridge.spectral, base, bridge.spectral < base ? 0.5 : 0.35, dt);

      if (captionState === 0 && chapterT >= CAPTION_IN) {
        captionState = 1;
        ui.caption(ch.line);
      } else if (captionState === 1 && chapterT >= CAPTION_IN + CAPTION_HOLD) {
        captionState = 2;
        ui.caption('');
      }

      let complete = false;
      try {
        ch.update(dt, ctx);
        bridge.progress = clamp(ch.progress);
        complete = ch.complete;
      } catch (err) {
        report('update', err);
        advance();
        return;
      }

      if (complete || chapterT > longStop) {
        // Early or late, the visitor is never held back.
        beginExit();
        return;
      }
      if (assisted < 3 && chapterT >= target * ASSIST_AT[assisted]) {
        assisted++;
        try {
          ch.assist(assisted as 1 | 2 | 3, ctx);
        } catch (err) {
          report('assist', err);
        }
      }
      return;
    }

    // exiting
    exitT += dt;
    const final = index === order.length - 1;
    if (final) {
      bridge.presence = damp(bridge.presence, 0, 0.9, dt);
      stage.grade.fade = smoothstep(0, FINAL_FADE_SECONDS, exitT);
    } else {
      bridge.presence = damp(bridge.presence, level(PRESENCE, index + 1), 0.5, dt);
      const base = level(SPECTRAL, index);
      bridge.spectral = damp(bridge.spectral, base, bridge.spectral < base ? 0.5 : 0.35, dt);
    }
    let exited = exitT >= EXIT_TIMEOUT;
    try {
      ch.update(dt, ctx);
      bridge.progress = clamp(ch.progress);
      exited = exited || ch.exited;
    } catch (err) {
      report('update', err);
      exited = true;
    }
    if (exited && (!final || exitT >= FINAL_FADE_SECONDS)) advance();
  }

  function dispose(): void {
    teardown();
    interaction.onGesture = null;
    phase = 'idle';
  }

  return {
    begin,
    jump,
    update,
    dispose,
    get chapterIndex() {
      return index;
    },
    get elapsed() {
      return elapsed;
    },
    get ended() {
      return ended;
    },
  };
}
