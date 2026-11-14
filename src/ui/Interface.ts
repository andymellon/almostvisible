/**
 * Interface — the typographic layer. Markup lives in index.html, appearance in style.css;
 * this module only moves text in and out and reports the visitor's three decisions.
 *
 * States (data-state on #ui): title → journey → ending → journey …
 * The title card is the audio-unlock gesture: a click anywhere on it, or Enter / Space,
 * calls handlers.onBegin() synchronously inside the event.
 *
 * Nothing here reads layout per frame. update() writes two custom properties at ~10 Hz
 * (--amp, --stab) and they only drive opacity / transform.
 */
import type { Bridge, UI, UIHandlers } from '../core/contracts';

type State = 'title' | 'journey' | 'ending';

/** UI plus teardown (optional extra; the contract is unchanged). */
export interface StageUI extends UI {
  dispose(): void;
}

const IDLE_SECONDS = 3.5;
const ANNOUNCE_SECONDS = 4.2;
const BREATHE_INTERVAL = 0.1;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Interface: #${id} is missing from index.html`);
  return node as T;
}

/**
 * Show the static composition instead of the live piece (no WebGL, ?static, context lost).
 * Safe to call at any time, with or without an Interface.
 */
export function showFallback(reason?: string): void {
  const app = document.getElementById('app');
  const fallback = document.getElementById('fallback');
  if (!fallback) return;
  if (reason) {
    const text = document.getElementById('fallback-reason');
    if (text) text.textContent = reason;
  }
  app?.classList.add('is-fallback');
  fallback.hidden = false;
}

export function createInterface(handlers: UIHandlers): StageUI {
  const root = el('ui');
  const chapterEl = el('chapter');
  const numeralEl = el('chapter-numeral');
  const nameEl = el('chapter-name');
  const lineEl = el('line');
  const hintEl = el('hint');
  const soundCaption = el('sound-caption');
  const soundButton = el<HTMLButtonElement>('control-sound');
  const pauseButton = el<HTMLButtonElement>('control-pause');
  const restartButton = el<HTMLButtonElement>('control-restart');
  const timeline = el('timeline');
  const titleCard = el('title');
  const endingCard = el('ending');
  const reenterButton = el<HTMLButtonElement>('reenter');
  const live = el('live');

  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Must not be shorter than --fade-out in style.css. */
  const outMs = reduced ? 320 : 920;

  let state: State = 'title';
  let muted = false;
  let paused = false;
  let idleT = 0;
  let idle = false;
  let announceT = 0;
  let breatheT = 0;
  let lastAmp = -1;
  let lastStab = -1;
  let lastProgress = -1;
  let lastPercent = -1;
  let titleTimer = 0;
  let endingTimer = 0;
  let liveTimer = 0;
  let disposed = false;

  const setState = (next: State) => {
    state = next;
    root.dataset.state = next;
  };

  /**
   * Text that is never swapped abruptly: the old line leaves, then the new one arrives.
   * `write` puts the content in the DOM while the element is invisible.
   */
  function fader(target: HTMLElement, write: (text: string) => void): (text: string) => void {
    target.classList.add('fade');
    let shown = '';
    let visible = false;
    let pending: string | null = null;
    let timer = 0;
    const apply = () => {
      timer = 0;
      target.classList.remove('out');
      const text = pending;
      pending = null;
      if (!text) return;
      write(text);
      void target.offsetWidth; // one reflow per text change: arms the transition from the hidden state
      target.classList.add('in');
      shown = text;
      visible = true;
    };
    return (text: string) => {
      if (pending === null ? text === shown : text === pending) return;
      pending = text;
      if (visible) {
        visible = false;
        shown = '';
        target.classList.remove('in');
        target.classList.add('out');
        timer = window.setTimeout(apply, outMs);
      } else if (!timer) {
        apply();
      }
    };
  }

  let chapterNumeral = '';
  let chapterName = '';
  const setChapter = fader(chapterEl, () => {
    numeralEl.textContent = chapterNumeral;
    nameEl.textContent = chapterName;
  });
  const setLine = fader(lineEl, (text) => {
    lineEl.textContent = text;
  });
  const setHint = fader(hintEl, (text) => {
    hintEl.textContent = text;
  });

  /** Polite screen-reader message; cleared first so a repeated text is spoken again. */
  function speak(text: string): void {
    window.clearTimeout(liveTimer);
    live.textContent = '';
    liveTimer = window.setTimeout(() => {
      live.textContent = text;
    }, 60);
  }

  function wake(): void {
    idleT = 0;
    if (idle) {
      idle = false;
      root.classList.remove('idle');
    }
  }

  function begin(): void {
    if (state !== 'title' || disposed) return;
    ui.showTitle(false);
    handlers.onBegin();
  }

  function toggleMute(): void {
    const next = !muted;
    ui.setMuted(next);
    handlers.onMute(next);
    speak(next ? 'Sound muted' : 'Sound on');
  }

  function togglePause(): void {
    const next = !paused;
    ui.setPaused(next);
    handlers.onPause(next);
    speak(next ? 'Paused' : 'Resumed');
  }

  function restart(): void {
    handlers.onRestart();
    speak('Restarting from the beginning');
  }

  function reenter(): void {
    if (state !== 'ending') return;
    ui.showEnding(false);
    handlers.onReenter();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    wake();
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
    const target = ev.target as HTMLElement | null;
    const onButton = !!target && (target.tagName === 'BUTTON' || target.tagName === 'A');
    if (state === 'title') {
      // A focused button turns Enter / Space into its own click, which reaches the card.
      if ((ev.key === 'Enter' || ev.key === ' ') && !onButton) {
        ev.preventDefault();
        begin();
      }
      return;
    }
    if (state !== 'journey') return;
    switch (ev.key) {
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'p':
      case 'P':
        togglePause();
        break;
      case 'r':
      case 'R':
        restart();
        break;
      default:
        break;
    }
  }

  const onTitleClick = () => begin();
  const onSoundClick = () => toggleMute();
  const onPauseClick = () => togglePause();
  const onRestartClick = () => restart();
  const onReenterClick = () => reenter();

  titleCard.addEventListener('click', onTitleClick);
  soundButton.addEventListener('click', onSoundClick);
  pauseButton.addEventListener('click', onPauseClick);
  restartButton.addEventListener('click', onRestartClick);
  reenterButton.addEventListener('click', onReenterClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('focusin', wake);

  const ui: StageUI = {
    chapter(numeral: string, name: string) {
      if (!numeral && !name) {
        setChapter('');
        return;
      }
      chapterNumeral = numeral;
      chapterName = name;
      setChapter(`${numeral} ${name}`);
      speak(`Chapter ${numeral}. ${name}.`);
    },

    caption(text: string) {
      setLine(text);
    },

    hint(text: string | null) {
      setHint(text ?? '');
    },

    announce(text: string) {
      const plain = text
        .trim()
        .replace(/^\[\s*/, '')
        .replace(/\s*\]$/, '');
      if (!plain) return;
      speak(plain);
      soundCaption.textContent = `[ ${plain} ]`;
      soundCaption.classList.add('in');
      announceT = ANNOUNCE_SECONDS;
    },

    progress(t: number) {
      const p = t > 0 ? (t < 1 ? t : 1) : 0;
      if (p === lastProgress) return;
      // 0.1 % steps are plenty for a hairline; the two ends are always written exactly.
      if (Math.abs(p - lastProgress) < 0.001 && p > 0 && p < 1) return;
      lastProgress = p;
      timeline.style.setProperty('--p', p.toFixed(4));
      const percent = Math.round(p * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        timeline.setAttribute('aria-valuenow', String(percent));
      }
    },

    showTitle(visible: boolean) {
      window.clearTimeout(titleTimer);
      if (visible) {
        titleCard.hidden = false;
        void titleCard.offsetWidth;
        titleCard.classList.remove('out');
        setState('title');
        return;
      }
      if (titleCard.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      titleCard.classList.add('out');
      titleTimer = window.setTimeout(
        () => {
          titleCard.hidden = true;
        },
        reduced ? 400 : 1900,
      );
      if (state === 'title') setState('journey');
      wake();
    },

    showEnding(visible: boolean) {
      if (visible === (state === 'ending')) return;
      window.clearTimeout(endingTimer);
      if (visible) {
        setState('ending');
        endingCard.hidden = false;
        void endingCard.offsetWidth;
        endingCard.classList.add('in');
        reenterButton.focus({ preventScroll: true });
        speak('The piece has ended. Reenter to begin again with a new harmony.');
        return;
      }
      if (endingCard.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      endingCard.classList.remove('in');
      endingTimer = window.setTimeout(
        () => {
          endingCard.hidden = true;
        },
        reduced ? 400 : 2700,
      );
      setState(titleCard.hidden || titleCard.classList.contains('out') ? 'journey' : 'title');
      wake();
    },

    setMuted(m: boolean) {
      if (m === muted) return;
      muted = m;
      soundButton.textContent = m ? 'Muted' : 'Sound';
      soundButton.setAttribute('aria-label', m ? 'Unmute sound' : 'Mute sound');
    },

    setPaused(p: boolean) {
      if (p === paused) return;
      paused = p;
      pauseButton.textContent = p ? 'Resume' : 'Pause';
      pauseButton.setAttribute('aria-label', p ? 'Resume' : 'Pause');
      // update() is not called while paused: keep the controls plainly visible.
      root.classList.toggle('paused', p);
      wake();
    },

    update(dt: number, bridge: Bridge) {
      idleT += dt;
      if (!idle && idleT > IDLE_SECONDS) {
        idle = true;
        root.classList.add('idle');
      }

      if (announceT > 0) {
        announceT -= dt;
        if (announceT <= 0) soundCaption.classList.remove('in');
      }

      breatheT += dt;
      if (breatheT >= BREATHE_INTERVAL) {
        breatheT = 0;
        const amp = Math.round(Math.min(1, Math.max(0, bridge.amplitude)) * 50) / 50;
        const stab = Math.round(Math.min(1, Math.max(0, bridge.stability)) * 50) / 50;
        if (amp !== lastAmp) {
          lastAmp = amp;
          root.style.setProperty('--amp', String(amp));
        }
        if (stab !== lastStab) {
          lastStab = stab;
          root.style.setProperty('--stab', String(stab));
        }
      }
    },

    dispose() {
      disposed = true;
      window.clearTimeout(titleTimer);
      window.clearTimeout(endingTimer);
      window.clearTimeout(liveTimer);
      titleCard.removeEventListener('click', onTitleClick);
      soundButton.removeEventListener('click', onSoundClick);
      pauseButton.removeEventListener('click', onPauseClick);
      restartButton.removeEventListener('click', onRestartClick);
      reenterButton.removeEventListener('click', onReenterClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('focusin', wake);
    },
  };

  return ui;
}
