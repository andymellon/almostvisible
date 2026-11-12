import './style.css';
import { Sound } from './audio/Sound';
import { Input } from './interaction/Input';
import { World } from './scene/World';
import { shared } from './scene/uniforms';
import { Perception } from './state/Perception';
import { Interface } from './ui/Interface';

const canvas = document.getElementById('stage') as HTMLCanvasElement;

function fallback(reason?: string) {
  const el = document.getElementById('fallback')!;
  el.hidden = false;
  if (reason) document.getElementById('fallback-reason')!.textContent = reason;
  document.getElementById('ui')!.style.display = 'none';
  document.getElementById('veil')!.classList.add('clear');
  canvas.style.display = 'none';
}

function start() {
  const params = new URLSearchParams(location.search);
  if (params.has('static')) return fallback();

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lite = params.has('lite') || window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 560;

  let world: World;
  try {
    world = new World(canvas, { lite, reduced });
  } catch {
    return fallback();
  }

  const perception = new Perception();
  const input = new Input(canvas);
  const sound = new Sound();
  const ui = new Interface(sound, () => {
    perception.reset();
    world.reset();
  });

  const resize = () => world.resize(Math.max(2, window.innerWidth), Math.max(2, window.innerHeight));
  window.addEventListener('resize', resize);
  resize();

  let raf = 0;
  let last = performance.now();
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    input.update(dt);
    perception.update(dt, input, world.closeness, reduced);
    world.update(dt, perception, input);
    sound.update(dt, perception, input, shared.uMorph.value, world.closeness);
    ui.update(dt, perception, input, world);
  };
  raf = requestAnimationFrame(frame);

  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    fallback('The graphics context was lost. Reload to begin the encounter again. Not everything that disappears is gone.');
  });

  if (import.meta.env.DEV) {
    // deterministic stepping for inspection when no display is driving rAF
    const step = (n: number, dt = 1 / 60) => {
      cancelAnimationFrame(raf);
      for (let i = 0; i < n; i++) {
        input.update(dt);
        perception.update(dt, input, world.closeness, reduced);
        world.update(dt, perception, input);
        ui.update(dt, perception, input, world);
      }
    };
    Object.assign(window, { __av: { perception, input, world, sound, step } });
  }
}

start();
