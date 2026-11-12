import { clamp, damp } from '../state/Perception';

/**
 * Normalises pointer, touch, wheel and keyboard into a handful of continuous
 * signals. No listener allocates; per-frame deltas are consumed in update().
 */
export class Input {
  /** Smoothed pointer in NDC (-1..1, y up). */
  x = 0;
  y = 0;
  /** Raw pointer target. */
  tx = 0;
  ty = 0;
  /** Smoothed speed in NDC units per second. */
  speed = 0;
  /** Per-frame smoothed horizontal motion (signed). */
  dx = 0;
  down = false;
  /** Seconds since the last meaningful input. */
  idle = 999;
  /** True once the visitor has moved at all. */
  touched = false;
  /** Consumed by the camera each frame. */
  zoomDelta = 0;
  dragX = 0;
  dragY = 0;

  private acc = 0;
  private accX = 0;
  private lastX = 0;
  private lastY = 0;
  private hasLast = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private keyHold = false;
  private pointerHold = false;

  constructor(private el: HTMLElement) {
    const o: AddEventListenerOptions = { passive: true };
    el.addEventListener('pointermove', this.onMove, o);
    el.addEventListener('pointerdown', this.onDown, o);
    window.addEventListener('pointerup', this.onUp, o);
    window.addEventListener('pointercancel', this.onUp, o);
    window.addEventListener('blur', this.release, o);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private toNdc(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -(((e.clientY - r.top) / r.height) * 2 - 1),
    };
  }

  private onMove = (e: PointerEvent) => {
    const p = this.toNdc(e);
    if (this.pointers.has(e.pointerId)) {
      const q = this.pointers.get(e.pointerId)!;
      q.x = p.x;
      q.y = p.y;
    }
    if (this.pointers.size >= 2) {
      // Pinch moves through depth.
      const d = this.pinchDist();
      if (this.pinch > 0) this.zoomDelta += (this.pinch - d) * 900;
      this.pinch = d;
      this.idle = 0;
      return;
    }
    if (this.hasLast) {
      const ddx = p.x - this.lastX;
      const ddy = p.y - this.lastY;
      this.acc += Math.hypot(ddx, ddy);
      this.accX += ddx;
      if (this.pointerHold && e.pointerType === 'mouse') {
        this.dragX += ddx;
        this.dragY += ddy;
      }
    }
    this.lastX = this.tx = p.x;
    this.lastY = this.ty = p.y;
    this.hasLast = true;
    this.touched = true;
    this.idle = 0;
  };

  private onDown = (e: PointerEvent) => {
    const p = this.toNdc(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.lastX = this.tx = p.x;
      this.lastY = this.ty = p.y;
      this.hasLast = true;
      this.pointerHold = true;
      this.touched = true;
    } else {
      this.pinch = this.pinchDist();
    }
    this.idle = 0;
    this.sync();
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    this.pinch = 0;
    if (this.pointers.size === 0) {
      this.pointerHold = false;
      if (e.pointerType !== 'mouse') this.hasLast = false;
    }
    this.sync();
  };

  private release = () => {
    this.pointers.clear();
    this.pointerHold = this.keyHold = false;
    this.sync();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : 1;
    this.zoomDelta += clamp(e.deltaY * unit, -120, 120);
    this.idle = 0;
  };

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'BUTTON' || t.tagName === 'A')) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.keyHold = true;
        this.touched = true;
        break;
      case 'ArrowLeft':
        this.dragX += 0.05;
        break;
      case 'ArrowRight':
        this.dragX -= 0.05;
        break;
      case 'ArrowUp':
        this.zoomDelta -= 60;
        break;
      case 'ArrowDown':
        this.zoomDelta += 60;
        break;
      default:
        return;
    }
    this.idle = 0;
    this.sync();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      this.keyHold = false;
      this.sync();
    }
  };

  private sync() {
    this.down = this.pointerHold || this.keyHold;
  }

  private pinchDist() {
    const it = this.pointers.values();
    const a = it.next().value!;
    const b = it.next().value!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  update(dt: number) {
    this.idle += dt;
    if (this.down) this.idle = Math.min(this.idle, 0.5);
    const raw = this.acc / Math.max(dt, 1e-3);
    this.speed = damp(this.speed, raw, raw > this.speed ? 10 : 4, dt);
    this.dx = damp(this.dx, this.accX / Math.max(dt, 1e-3), 6, dt);
    this.acc = 0;
    this.accX = 0;
    this.x = damp(this.x, this.tx, 7, dt);
    this.y = damp(this.y, this.ty, 7, dt);
  }

  /** Called by the camera after it has read the deltas. */
  consume() {
    this.zoomDelta = 0;
    this.dragX = 0;
    this.dragY = 0;
  }
}
