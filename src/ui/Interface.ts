import type { Sound } from '../audio/Sound';
import type { Input } from '../interaction/Input';
import { STATES, type Perception } from '../state/Perception';
import type { World } from '../scene/World';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sign = (v: number) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2);

/**
 * The almost-invisible interface. Typography reads the same perceptual model
 * as the shaders (via CSS custom properties), so it belongs to the organism.
 */
export class Interface {
  private ui = $('ui');
  private caption = $('caption');
  private index = document.querySelector<HTMLElement>('.index')!;
  private reticle = $('reticle');
  private reticleLabel = $('reticle-label');
  private hint = $('hint');
  private about = $('about');
  private veil = $('veil');
  private wave = $<HTMLCanvasElement>('wave');
  private wctx = this.wave.getContext('2d');
  private buf = new Float32Array(1024);
  private rE = $('r-e');
  private rC = $('r-c');
  private rM = $('r-m');
  private rZ = $('r-z');
  private shown = 0;
  private slow = 0;
  private swapTimer = 0;
  private lastFocus: HTMLElement | null = null;

  constructor(private sound: Sound, private onReset: () => void) {
    const bSound = $<HTMLButtonElement>('c-sound');
    const bFull = $<HTMLButtonElement>('c-full');

    if (!sound.supported) bSound.hidden = true;
    bSound.addEventListener('click', async () => {
      const on = await sound.toggle();
      bSound.setAttribute('aria-pressed', String(on));
      bSound.querySelector('i')!.textContent = on ? 'On' : 'Off';
    });

    $('c-reset').addEventListener('click', () => {
      this.veil.classList.add('quick');
      this.veil.classList.remove('clear');
      window.setTimeout(() => {
        this.onReset();
        this.veil.classList.remove('quick');
        this.veil.classList.add('clear');
      }, 750);
    });

    $('c-about').addEventListener('click', () => this.toggleAbout(true));
    $('about-close').addEventListener('click', () => this.toggleAbout(false));
    this.about.addEventListener('click', (e) => e.target === this.about && this.toggleAbout(false));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.about.hidden) this.toggleAbout(false);
    });

    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (!root.requestFullscreen && !root.webkitRequestFullscreen) bFull.hidden = true;
    bFull.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
      else root.webkitRequestFullscreen?.();
    });
    document.addEventListener('fullscreenchange', () => {
      bFull.textContent = document.fullscreenElement ? 'Exit' : 'Fullscreen';
    });

    requestAnimationFrame(() => {
      this.ui.classList.add('ready');
      this.veil.classList.add('clear');
      this.hint.classList.add('show');
    });
  }

  get aboutOpen() {
    return !this.about.hidden;
  }

  private toggleAbout(open: boolean) {
    if (open) {
      this.lastFocus = document.activeElement as HTMLElement;
      this.about.hidden = false;
      requestAnimationFrame(() => this.about.classList.add('open'));
      $('about-close').focus();
    } else {
      this.about.classList.remove('open');
      window.setTimeout(() => (this.about.hidden = true), 700);
      this.lastFocus?.focus();
    }
  }

  private setState(i: number) {
    this.shown = i;
    const s = STATES[i];
    this.caption.classList.add('out');
    this.index.classList.add('out');
    window.clearTimeout(this.swapTimer);
    this.swapTimer = window.setTimeout(() => {
      $('state-num').textContent = s.num;
      $('state-name').textContent = s.name;
      $('kicker').textContent = s.kicker;
      $('line').textContent = s.line;
      this.caption.classList.remove('out');
      this.index.classList.remove('out');
    }, 950);
  }

  update(dt: number, p: Perception, inp: Input, world: World) {
    if (p.state !== this.shown) this.setState(p.state);

    // the reticle follows the point of attention every frame (transform only)
    const w = window.innerWidth;
    const h = window.innerHeight;
    const rx = world.focusU * w;
    const ry = (1 - world.focusV) * h;
    this.reticle.style.transform = `translate3d(${rx.toFixed(1)}px,${ry.toFixed(1)}px,0)`;
    this.reticle.style.opacity = inp.touched ? Math.min(0.75, p.energy * 1.4 + p.hold * 0.5).toFixed(3) : '0';

    this.slow += dt;
    if (this.slow < 0.1) return;
    this.slow = 0;

    const st = this.ui.style;
    st.setProperty('--e', p.energy.toFixed(3));
    st.setProperty('--c', p.coherence.toFixed(3));
    st.setProperty('--k', p.hold.toFixed(3));
    st.setProperty('--px', inp.x.toFixed(3));
    st.setProperty('--py', inp.y.toFixed(3));
    this.ui.classList.toggle('idle', inp.idle > 4);
    this.hint.classList.toggle('show', p.state === 0 && p.attention < 0.03);

    this.rE.textContent = p.energy.toFixed(3);
    this.rC.textContent = p.coherence.toFixed(3);
    this.rM.textContent = p.memory.toFixed(3);
    this.rZ.textContent = world.dist.toFixed(2);
    const f = world.focus;
    this.reticleLabel.textContent = `x ${sign(f.x)}  y ${sign(f.y)}  z ${sign(f.z)}\nψ ${p.attention.toFixed(3)}`;

    this.drawWave(p);
  }

  /** A barely audible vibration becomes a visible waveform. */
  private drawWave(p: Perception) {
    const c = this.wctx;
    if (!c) return;
    const W = this.wave.width;
    const H = this.wave.height;
    c.clearRect(0, 0, W, H);
    c.strokeStyle = '#AEB6BC';
    c.lineWidth = 1.5;
    c.beginPath();
    const live = this.sound.enabled && this.sound.analyser;
    if (live) this.sound.analyser!.getFloatTimeDomainData(this.buf);
    const n = 96;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      let v: number;
      if (live) v = this.buf[i * 8] * 5;
      else {
        // silent: the same signal, only drawn
        const env = Math.sin(u * Math.PI);
        v = env * (Math.sin(u * 14 + p.time * 1.3) * (0.05 + 0.3 * p.energy) + Math.sin(u * 47 - p.time * 2.1) * 0.22 * p.coherence + Math.sin(u * 5 + p.time * 0.4) * 0.3 * p.hold);
      }
      const y = H / 2 - Math.max(-1, Math.min(1, v)) * (H / 2 - 2);
      if (i === 0) c.moveTo(0, y);
      else c.lineTo(u * W, y);
    }
    c.stroke();
  }
}
