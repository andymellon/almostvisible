/**
 * Interaction — pointer / touch / pen / keyboard → hover, press, sprung drag, soft release.
 *
 * Event listeners only record state; every callback into an Interactive is issued from
 * update(), so chapters are always called inside the frame, with a current camera.
 *
 * Spaces. `constrain`, `magnet` and `onMove` all see vectors in the space of
 * `object.position` (the object's parent space — world space when the chapter root is
 * untransformed, which is the normal case). `onPress` receives a world-space point.
 *
 * Drag. The target is the pointer ray ∩ the camera-facing plane through the object at
 * grab, plus the grab offset, plus a depth offset (wheel / pinch / W,S). It is then
 * constrained, attracted by the magnet, and followed through a Spring3:
 *   while held   k = 620, ζ ≈ 0.72  → steady-state lag c/k ≈ 58 ms, a trace of overshoot
 *   after release k = 150, ζ ≈ 0.80 → soft settle toward magnet(desired, false)
 * onMove keeps firing until the object is at rest.
 *
 * Callback order for one pointer gesture:
 *   onHover(true) → onPress(point) [+ onGesture] → onMove(…, true)* → onRelease() [+ onGesture
 *   if it was a drag] → onMove(…, false)* → onHover(false)
 * onRelease is issued for every press, dragged or not.
 */
import { Vector2, Vector3, type Camera, type Object3D, type PerspectiveCamera } from 'three';
import type { Bridge, Interaction, Interactive } from './contracts';
import { clamp, damp, Spring3 } from './math';

/** Interaction plus keyboard-focus reporting (optional extras; the contract is unchanged). */
export interface StageInteraction extends Interaction {
  /** The Interactive holding keyboard focus (Tab), or null. */
  readonly focused: Interactive | null;
  /** Called with an Interactive's label when keyboard focus lands on it. Wire to ui.announce. */
  onFocus: ((label: string) => void) | null;
}

interface Entry {
  item: Interactive;
  spring: Spring3;
  /** Constrained drag target, before the magnet, in the object's parent space. */
  desired: Vector3;
  /** The spring is integrating (drag, key move or settle). */
  active: boolean;
}

const DRAG_STIFFNESS = 620;
const DRAG_DAMPING = 2 * 0.72 * Math.sqrt(DRAG_STIFFNESS);
const SETTLE_STIFFNESS = 150;
const SETTLE_DAMPING = 2 * 0.8 * Math.sqrt(SETTLE_STIFFNESS);
/** Spring sub-step ceiling: keeps the stiff drag spring exact at any frame time. */
const MAX_SUBSTEP = 1 / 120;

const DRAG_THRESHOLD_MOUSE = 4; // px
const DRAG_THRESHOLD_TOUCH = 9;
const TOUCH_RADIUS_SCALE = 1.6;
const MIN_RADIUS_PX_MOUSE = 10;
const MIN_RADIUS_PX_TOUCH = 26;
/** The hovered target keeps a slightly larger sphere and a head start, so hover never flickers. */
const HYSTERESIS_RADIUS = 1.18;
const HYSTERESIS_BIAS = 0.18;

const WHEEL_ROTATE = 0.004; // rad per wheel px
const WHEEL_DEPTH = 0.004; // world units per wheel px
const PINCH_DEPTH = 0.012; // world units per px of spread
const KEY_MOVE = 0.3; // fraction of camera distance per second
const KEY_ROTATE = 1.2; // rad per second
const MAX_DEPTH = 8;
/** A press older than this when update() next runs (tab was hidden, piece was paused) is dropped. */
const STALE_MS = 600;

const REST_DISTANCE = 1e-3;
const REST_SPEED = 1e-2;

export function createInteraction(canvas: HTMLCanvasElement): StageInteraction {
  canvas.style.touchAction = 'none';
  if (canvas.tabIndex < 0) canvas.tabIndex = 0;

  const entries: Entry[] = [];
  const pointer = { ndc: new Vector2(), world: new Vector3(), energy: 0, down: false, seen: false };

  let hovered: Entry | null = null;
  let pressed: Entry | null = null;
  let dragEntry: Entry | null = null;
  let keyEntry: Entry | null = null; // being moved by keys
  let kbFocus: Entry | null = null;
  let kbPressed: Entry | null = null;
  let keyboardMode = false;
  let idle = 0;
  let cursor = '';

  // ── raw pointer state (written by listeners) ───────────────────────────
  let rectLeft = 0;
  let rectTop = 0;
  let rectWidth = 1;
  let rectHeight = 1;
  let primaryId = -1;
  let secondId = -1;
  let touch = false;
  let inside = false;
  let clientX = 0;
  let clientY = 0;
  let secondX = 0;
  let secondY = 0;
  let pressX = 0;
  let pressY = 0;
  let pressNdcX = 0;
  let pressNdcY = 0;
  let pressStamp = 0;
  let pressQueued = false;
  let releaseQueued = false;
  /** A release that happened before the queued press (both since the last frame). */
  let preReleaseQueued = false;
  let resync = true;
  let pinchDist = 0;
  let pinchAngle = 0;
  let pinchAccum = 0;
  let twistAccum = 0;
  let wheelAccum = 0;
  let lastUpdateMs = performance.now();
  let wheelShiftAccum = 0;

  // ── raw key state ──────────────────────────────────────────────────────
  let keyLeft = 0;
  let keyRight = 0;
  let keyUp = 0;
  let keyDown = 0;
  let keyNear = 0; // S
  let keyFar = 0; // W
  let keyCcw = 0; // Q
  let keyCw = 0; // E
  let keyFine = false; // Shift
  let kbPressQueued = false;
  let kbReleaseQueued = false;
  let tabDir = 1;
  let tabStamp = -1e9;

  // ── scratch (never allocated per frame) ────────────────────────────────
  const camPos = new Vector3();
  const camRight = new Vector3();
  const camUp = new Vector3();
  const camFwd = new Vector3();
  const rayO = new Vector3();
  const rayD = new Vector3();
  const pressO = new Vector3();
  const pressD = new Vector3();
  const centre = new Vector3();
  const tmp = new Vector3();
  const planePoint = new Vector3();
  const grabPoint = new Vector3();
  const grabNormal = new Vector3();
  const grabOffset = new Vector3();
  const ORIGIN = new Vector3();
  let dragDepth = 0;
  let lastNdcX = 0;
  let lastNdcY = 0;
  let perspective = true;
  let tanHalfFov = 0.3;

  const api: StageInteraction = {
    pointer,
    onGesture: null,
    onFocus: null,
    get hovered() {
      return hovered ? hovered.item : null;
    },
    get dragging() {
      return dragEntry ? dragEntry.item : null;
    },
    get focused() {
      return kbFocus ? kbFocus.item : null;
    },
    get idle() {
      return idle;
    },
    add,
    remove,
    clear,
    update,
    dispose,
  };

  // ── registry ───────────────────────────────────────────────────────────

  function find(item: Interactive): number {
    for (let i = 0; i < entries.length; i++) if (entries[i].item === item) return i;
    return -1;
  }

  function add(item: Interactive): void {
    if (find(item) >= 0) return;
    entries.push({ item, spring: new Spring3(SETTLE_STIFFNESS, SETTLE_DAMPING), desired: new Vector3(), active: false });
  }

  function forget(e: Entry): void {
    if (hovered === e) hovered = null;
    if (pressed === e) pressed = null;
    if (dragEntry === e) dragEntry = null;
    if (keyEntry === e) keyEntry = null;
    if (kbPressed === e) kbPressed = null;
    if (kbFocus === e) {
      kbFocus = null;
      keyboardMode = false;
    }
    e.active = false;
  }

  /** Removal is silent: the owner is taking the object away, no callbacks are issued. */
  function remove(item: Interactive): void {
    const i = find(item);
    if (i < 0) return;
    forget(entries[i]);
    entries.splice(i, 1);
  }

  function clear(): void {
    entries.length = 0;
    hovered = pressed = dragEntry = keyEntry = kbFocus = kbPressed = null;
    keyboardMode = false;
    pointer.down = false;
    pressQueued = releaseQueued = preReleaseQueued = kbPressQueued = kbReleaseQueued = false;
    setCursor('');
  }

  const enabled = (e: Entry) => e.item.enabled !== false;

  // ── geometry helpers ───────────────────────────────────────────────────

  function measure(): void {
    const r = canvas.getBoundingClientRect();
    rectLeft = r.left;
    rectTop = r.top;
    rectWidth = Math.max(1, r.width);
    rectHeight = Math.max(1, r.height);
  }

  function writeNdc(x: number, y: number): void {
    pointer.ndc.set(((x - rectLeft) / rectWidth) * 2 - 1, -(((y - rectTop) / rectHeight) * 2 - 1));
  }

  function setRay(camera: Camera, nx: number, ny: number, o: Vector3, d: Vector3): void {
    if (perspective) {
      o.copy(camPos);
      d.set(nx, ny, 0.5).unproject(camera).sub(o).normalize();
    } else {
      o.set(nx, ny, -1).unproject(camera);
      d.copy(camFwd);
    }
  }

  /** Ray ∩ plane (point p, normal n). Returns false when parallel or behind the origin. */
  function hitPlane(o: Vector3, d: Vector3, p: Vector3, n: Vector3, out: Vector3): boolean {
    const denom = d.x * n.x + d.y * n.y + d.z * n.z;
    if (Math.abs(denom) < 1e-5) return false;
    const t = ((p.x - o.x) * n.x + (p.y - o.y) * n.y + (p.z - o.z) * n.z) / denom;
    if (t <= 0) return false;
    out.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
    return true;
  }

  function toLocal(object: Object3D, v: Vector3): void {
    if (object.parent) object.parent.worldToLocal(v);
  }

  function toWorld(object: Object3D, v: Vector3): void {
    if (object.parent) object.parent.localToWorld(v);
  }

  /** Nearest enabled interactive whose forgiving sphere the current ray enters. */
  function pick(): Entry | null {
    let best: Entry | null = null;
    let bestScore = Infinity;
    const minPx = touch ? MIN_RADIUS_PX_TOUCH : MIN_RADIUS_PX_MOUSE;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!enabled(e)) continue;
      e.item.object.getWorldPosition(centre);
      const vx = centre.x - rayO.x;
      const vy = centre.y - rayO.y;
      const vz = centre.z - rayO.z;
      const t = vx * rayD.x + vy * rayD.y + vz * rayD.z;
      if (t <= 0) continue;
      const d2 = Math.max(0, vx * vx + vy * vy + vz * vz - t * t);
      let r = e.item.radius * (touch ? TOUCH_RADIUS_SCALE : 1);
      // Never smaller than a comfortable target on screen, however far away the object is.
      const depth = perspective ? vx * camFwd.x + vy * camFwd.y + vz * camFwd.z : 1;
      const worldPerPx = (2 * Math.max(depth, 0) * tanHalfFov) / rectHeight;
      r = Math.max(r, minPx * worldPerPx);
      let bias = 0;
      if (e === hovered) {
        r *= HYSTERESIS_RADIUS;
        bias = HYSTERESIS_BIAS * r;
      }
      if (d2 > r * r) continue;
      const score = t - Math.sqrt(r * r - d2) - bias; // distance to where the ray enters the sphere
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  // ── state transitions ──────────────────────────────────────────────────

  function setCursor(c: string): void {
    if (c === cursor) return;
    cursor = c;
    canvas.style.cursor = c;
  }

  function setHovered(e: Entry | null): void {
    if (e === hovered) return;
    const prev = hovered;
    hovered = e;
    if (prev) prev.item.onHover?.(false);
    if (e) e.item.onHover?.(true);
  }

  function setKeyboardFocus(e: Entry | null): void {
    kbFocus = e;
    keyboardMode = e !== null;
    setHovered(e);
    if (e) api.onFocus?.(e.item.label);
  }

  function leaveKeyboardMode(): void {
    if (!keyboardMode) return;
    keyboardMode = false;
    kbFocus = null;
  }

  function activate(e: Entry): void {
    if (e.active) return;
    e.active = true;
    e.desired.copy(e.item.object.position);
    e.spring.velocity.set(0, 0, 0);
    e.spring.target.copy(e.item.object.position);
  }

  /** Shift an entry's desired position by a world-space delta (keys, wheel on a hovered object). */
  function nudge(e: Entry, wx: number, wy: number, wz: number): void {
    activate(e);
    const object = e.item.object;
    tmp.copy(e.desired);
    toWorld(object, tmp);
    tmp.x += wx;
    tmp.y += wy;
    tmp.z += wz;
    toLocal(object, tmp);
    e.item.constrain?.(tmp);
    e.desired.copy(tmp);
  }

  function endKeyMove(): void {
    const e = keyEntry;
    if (!e) return;
    keyEntry = null;
    e.item.onRelease?.();
    api.onGesture?.();
  }

  function doPress(): void {
    pointer.down = true;
    const e = hovered;
    pressed = e;
    if (e) {
      e.item.object.getWorldPosition(centre);
      if (!hitPlane(rayO, rayD, centre, camFwd, tmp)) tmp.copy(centre);
      e.item.onPress?.(tmp);
    }
    api.onGesture?.();
  }

  function beginDrag(e: Entry, camera: Camera): void {
    if (keyEntry === e) keyEntry = null;
    const object = e.item.object;
    object.getWorldPosition(grabPoint);
    grabNormal.copy(camFwd);
    dragDepth = 0;
    // Offset measured along the press ray, so nothing jumps when the threshold is crossed.
    setRay(camera, pressNdcX, pressNdcY, pressO, pressD);
    if (hitPlane(pressO, pressD, grabPoint, grabNormal, tmp)) grabOffset.copy(grabPoint).sub(tmp);
    else grabOffset.set(0, 0, 0);
    activate(e);
    dragEntry = e;
    pinchAccum = 0;
    twistAccum = 0;
  }

  function updateDrag(e: Entry): void {
    planePoint.copy(grabNormal).multiplyScalar(dragDepth).add(grabPoint);
    if (!hitPlane(rayO, rayD, planePoint, grabNormal, tmp)) return;
    tmp.add(grabOffset);
    toLocal(e.item.object, tmp);
    e.item.constrain?.(tmp);
    e.desired.copy(tmp);
  }

  function doRelease(): void {
    pointer.down = false;
    const d = dragEntry;
    const p = pressed;
    dragEntry = null;
    pressed = null;
    if (d) {
      d.item.onRelease?.();
      api.onGesture?.();
    } else if (p) {
      p.item.onRelease?.();
    }
  }

  // ── frame ──────────────────────────────────────────────────────────────

  function update(dt: number, camera: Camera, bridge: Bridge): void {
    // Input that queued up while update() was not running (paused, hidden tab) is stale: drop it.
    const nowMs = performance.now();
    if (nowMs - lastUpdateMs > STALE_MS) {
      wheelAccum = wheelShiftAccum = pinchAccum = twistAccum = 0;
      kbPressQueued = kbReleaseQueued = false;
    }
    lastUpdateMs = nowMs;
    idle += dt;

    camera.updateMatrixWorld();
    const m = camera.matrixWorld;
    camPos.setFromMatrixPosition(m);
    camRight.setFromMatrixColumn(m, 0).normalize();
    camUp.setFromMatrixColumn(m, 1).normalize();
    camFwd.setFromMatrixColumn(m, 2).normalize().negate();
    perspective = (camera as PerspectiveCamera).isPerspectiveCamera === true;
    const p11 = camera.projectionMatrix.elements[5];
    tanHalfFov = p11 > 1e-6 ? 1 / p11 : 0.3;

    setRay(camera, pointer.ndc.x, pointer.ndc.y, rayO, rayD);
    if (hitPlane(rayO, rayD, ORIGIN, camFwd, tmp)) pointer.world.copy(tmp);

    // Smoothed pointer speed: quick to rise, slow to fall.
    if (resync) {
      resync = false;
      lastNdcX = pointer.ndc.x;
      lastNdcY = pointer.ndc.y;
    }
    if (dt > 1e-5) {
      const speed = Math.hypot(pointer.ndc.x - lastNdcX, pointer.ndc.y - lastNdcY) / dt;
      const target = clamp(speed / 2.5);
      pointer.energy = damp(pointer.energy, target, target > pointer.energy ? 10 : 2.2, dt);
      lastNdcX = pointer.ndc.x;
      lastNdcY = pointer.ndc.y;
    }
    bridge.pointer.copy(pointer.world);
    bridge.pointerEnergy = pointer.energy;

    // A release left over from before the queued press ends the previous gesture first.
    if (preReleaseQueued) {
      preReleaseQueued = false;
      doRelease();
    }
    // A press that queued up while update() was not running is not a gesture any more.
    if (pressQueued && performance.now() - pressStamp > STALE_MS) {
      pressQueued = false;
      releaseQueued = false;
    }

    // Objects the owner disabled drop out of every role (hover is told; nothing else is).
    if (hovered && !enabled(hovered)) setHovered(null);
    if (pressed && !enabled(pressed)) pressed = null;
    if (dragEntry && (!enabled(dragEntry) || !dragEntry.item.draggable)) dragEntry = null;
    if (keyEntry && !enabled(keyEntry)) keyEntry = null;
    if (kbFocus && !enabled(kbFocus)) {
      kbFocus = null;
      keyboardMode = false;
    }

    // Hover.
    if (!dragEntry && !pressed) {
      if (keyboardMode) setHovered(kbFocus);
      else setHovered(inside || pressQueued ? pick() : null);
    }

    // Press → drag → release, in order, even when all three happened since the last frame.
    if (pressQueued) {
      pressQueued = false;
      doPress();
    }
    if (pressed && !dragEntry && pressed.item.draggable) {
      const threshold = touch ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE;
      if (Math.hypot(clientX - pressX, clientY - pressY) > threshold) beginDrag(pressed, camera);
    }
    if (dragEntry) {
      const item = dragEntry.item;
      // Depth: Shift+wheel always; plain wheel unless the object rotates; pinch; W / S.
      let depth = -wheelShiftAccum * WHEEL_DEPTH - pinchAccum * PINCH_DEPTH + (keyFar - keyNear) * KEY_MOVE * 6 * dt;
      if (item.onRotate) {
        const turn = wheelAccum * WHEEL_ROTATE + twistAccum + (keyCw - keyCcw) * KEY_ROTATE * dt;
        if (turn !== 0) item.onRotate(turn);
      } else {
        depth -= wheelAccum * WHEEL_DEPTH;
      }
      dragDepth = clamp(dragDepth + depth, -MAX_DEPTH, MAX_DEPTH);
      updateDrag(dragEntry);
    } else {
      updateFreeInput(dt);
    }
    wheelAccum = wheelShiftAccum = pinchAccum = twistAccum = 0;

    if (releaseQueued) {
      releaseQueued = false;
      doRelease();
    }

    // Keyboard press / release (Enter, Space).
    if (kbPressQueued) {
      kbPressQueued = false;
      const e = kbFocus ?? hovered;
      if (e) {
        kbPressed = e;
        e.item.object.getWorldPosition(centre);
        e.item.onPress?.(centre);
        api.onGesture?.();
      }
    }
    if (kbReleaseQueued) {
      kbReleaseQueued = false;
      if (kbPressed) kbPressed.item.onRelease?.();
      kbPressed = null;
    }

    // Springs.
    const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
    const h = dt / steps;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.active) continue;
      if (!enabled(e)) {
        e.active = false;
        continue;
      }
      const item = e.item;
      const live = e === dragEntry || e === keyEntry;
      const spring = e.spring;
      const position = item.object.position;
      tmp.copy(e.desired);
      item.magnet?.(tmp, live);
      spring.target.copy(tmp);
      spring.stiffness = live ? DRAG_STIFFNESS : SETTLE_STIFFNESS;
      spring.damping = live ? DRAG_DAMPING : SETTLE_DAMPING;
      for (let s = 0; s < steps; s++) spring.step(position, h);
      if (!live && position.distanceToSquared(spring.target) < REST_DISTANCE * REST_DISTANCE && spring.velocity.lengthSq() < REST_SPEED * REST_SPEED) {
        position.copy(spring.target);
        spring.velocity.set(0, 0, 0);
        e.active = false;
      }
      item.onMove?.(position, live);
    }

    // Affordance.
    if (dragEntry) setCursor('grabbing');
    else if (hovered && !keyboardMode) setCursor(hovered.item.draggable ? 'grab' : hovered.item.onPress ? 'pointer' : '');
    else setCursor('');
  }

  /** Wheel and keys when nothing is being dragged by the pointer. */
  function updateFreeInput(dt: number): void {
    const e = kbFocus ?? hovered;
    if (!e) {
      endKeyMove();
      return;
    }
    const item = e.item;

    const turn = (item.onRotate ? wheelAccum * WHEEL_ROTATE : 0) + (keyCw - keyCcw) * KEY_ROTATE * (keyFine ? 0.25 : 1) * dt;
    if (turn !== 0 && item.onRotate) item.onRotate(turn);

    if (!item.draggable) {
      endKeyMove();
      return;
    }

    // Wheel depth on a hovered object: a nudge that settles on its own.
    const wheelDepth = -(wheelShiftAccum + (item.onRotate ? 0 : wheelAccum)) * WHEEL_DEPTH;
    if (wheelDepth !== 0) nudge(e, camFwd.x * wheelDepth, camFwd.y * wheelDepth, camFwd.z * wheelDepth);

    // Keys: arrows only for the keyboard-focused object, W / S for focused or hovered.
    const arrows = e === kbFocus;
    const dx = arrows ? keyRight - keyLeft : 0;
    const dy = arrows ? keyUp - keyDown : 0;
    const dz = keyFar - keyNear;
    if (dx === 0 && dy === 0 && dz === 0) {
      endKeyMove();
      return;
    }
    if (keyEntry !== e) {
      endKeyMove();
      keyEntry = e;
    }
    item.object.getWorldPosition(centre);
    const rate = Math.max(0.5, centre.distanceTo(camPos)) * KEY_MOVE * (keyFine ? 0.25 : 1) * dt;
    const norm = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
    const rx = dx * norm * rate;
    const uy = dy * norm * rate;
    const fz = dz * rate;
    nudge(e, camRight.x * rx + camUp.x * uy + camFwd.x * fz, camRight.y * rx + camUp.y * uy + camFwd.y * fz, camRight.z * rx + camUp.z * uy + camFwd.z * fz);
  }

  // ── pointer listeners ──────────────────────────────────────────────────

  function updatePinch(): void {
    const dx = secondX - clientX;
    const dy = secondY - clientY;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    let turn = angle - pinchAngle;
    if (turn > Math.PI) turn -= Math.PI * 2;
    else if (turn < -Math.PI) turn += Math.PI * 2;
    pinchAccum += dist - pinchDist;
    twistAccum -= turn; // screen y points down: negate so a clockwise twist is a positive turn
    pinchDist = dist;
    pinchAngle = angle;
  }

  function onPointerDown(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    idle = 0;
    if (primaryId === -1) {
      measure();
      primaryId = ev.pointerId;
      touch = ev.pointerType === 'touch';
      clientX = pressX = ev.clientX;
      clientY = pressY = ev.clientY;
      writeNdc(clientX, clientY);
      pressNdcX = pointer.ndc.x;
      pressNdcY = pointer.ndc.y;
      if (touch || !pointer.seen) resync = true;
      pointer.seen = true;
      inside = true;
      if (releaseQueued) {
        releaseQueued = false;
        preReleaseQueued = true;
      }
      pressQueued = true;
      pressStamp = performance.now();
      leaveKeyboardMode();
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* capture is a convenience, not a requirement */
      }
    } else if (secondId === -1 && ev.pointerType === 'touch') {
      secondId = ev.pointerId;
      secondX = ev.clientX;
      secondY = ev.clientY;
      pinchDist = Math.hypot(secondX - clientX, secondY - clientY);
      pinchAngle = Math.atan2(secondY - clientY, secondX - clientX);
    }
  }

  function onPointerMove(ev: PointerEvent): void {
    if (ev.pointerId === secondId) {
      secondX = ev.clientX;
      secondY = ev.clientY;
      updatePinch();
      idle = 0;
      return;
    }
    if (primaryId !== -1 && ev.pointerId !== primaryId) return;
    // A leftover finger of a finished two-finger gesture must not become the hover pointer.
    if (primaryId === -1 && ev.pointerType === 'touch') return;
    const moved = Math.abs(ev.clientX - clientX) + Math.abs(ev.clientY - clientY);
    clientX = ev.clientX;
    clientY = ev.clientY;
    writeNdc(clientX, clientY);
    if (!pointer.seen) {
      pointer.seen = true;
      resync = true;
    }
    if (primaryId === -1) touch = ev.pointerType === 'touch';
    inside = true;
    if (moved > 0) idle = 0;
    if (moved > 2) leaveKeyboardMode();
    if (secondId !== -1) updatePinch();
  }

  function onPointerUp(ev: PointerEvent): void {
    if (ev.pointerId === secondId) {
      secondId = -1;
      return;
    }
    if (ev.pointerId !== primaryId) return;
    primaryId = -1;
    secondId = -1;
    releaseQueued = true;
    idle = 0;
    if (touch) inside = false; // a lifted finger hovers nothing
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
  }

  function onPointerEnter(): void {
    measure();
  }

  function onPointerLeave(): void {
    if (primaryId === -1) inside = false;
  }

  function onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
    // With Shift held most platforms report the wheel on the x axis.
    const raw = (ev.deltaY !== 0 ? ev.deltaY : ev.deltaX) * unit;
    const delta = clamp(raw, -240, 240);
    if (ev.shiftKey) wheelShiftAccum += delta;
    else wheelAccum += delta;
    idle = 0;
  }

  function onContextMenu(ev: Event): void {
    ev.preventDefault();
  }

  // ── keyboard listeners ─────────────────────────────────────────────────

  function onStage(target: EventTarget | null): boolean {
    return target === canvas || target === document.body || target === document.documentElement || target === null;
  }

  /** Next enabled entry in `dir`, or null when the cycle runs off either end. */
  function cycle(dir: number): Entry | null {
    let i = kbFocus ? entries.indexOf(kbFocus) : dir > 0 ? -1 : entries.length;
    for (i += dir; i >= 0 && i < entries.length; i += dir) if (enabled(entries[i])) return entries[i];
    return null;
  }

  function clearKeys(): void {
    keyLeft = keyRight = keyUp = keyDown = keyNear = keyFar = keyCcw = keyCw = 0;
    keyFine = false;
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Tab') {
      tabDir = ev.shiftKey ? -1 : 1;
      tabStamp = performance.now();
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (!onStage(ev.target)) return;
    keyFine = ev.shiftKey;
    switch (ev.key) {
      case 'Tab': {
        const next = cycle(tabDir);
        if (!next) {
          // Past the last (or first) object: let focus continue to the page's own controls.
          if (kbFocus) setKeyboardFocus(null);
          return;
        }
        ev.preventDefault();
        setKeyboardFocus(next);
        if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
        break;
      }
      case 'ArrowLeft':
        if (!kbFocus) return;
        ev.preventDefault();
        keyLeft = 1;
        break;
      case 'ArrowRight':
        if (!kbFocus) return;
        ev.preventDefault();
        keyRight = 1;
        break;
      case 'ArrowUp':
        if (!kbFocus) return;
        ev.preventDefault();
        keyUp = 1;
        break;
      case 'ArrowDown':
        if (!kbFocus) return;
        ev.preventDefault();
        keyDown = 1;
        break;
      case 'w':
      case 'W':
        keyFar = 1;
        break;
      case 's':
      case 'S':
        keyNear = 1;
        break;
      case 'q':
      case 'Q':
        keyCcw = 1;
        break;
      case 'e':
      case 'E':
        keyCw = 1;
        break;
      case 'Enter':
      case ' ':
        if (!(kbFocus ?? hovered)) return;
        ev.preventDefault();
        if (!ev.repeat) kbPressQueued = true;
        break;
      default:
        return;
    }
    idle = 0;
  }

  function onKeyUp(ev: KeyboardEvent): void {
    keyFine = ev.shiftKey;
    switch (ev.key) {
      case 'ArrowLeft':
        keyLeft = 0;
        break;
      case 'ArrowRight':
        keyRight = 0;
        break;
      case 'ArrowUp':
        keyUp = 0;
        break;
      case 'ArrowDown':
        keyDown = 0;
        break;
      case 'w':
      case 'W':
        keyFar = 0;
        break;
      case 's':
      case 'S':
        keyNear = 0;
        break;
      case 'q':
      case 'Q':
        keyCcw = 0;
        break;
      case 'e':
      case 'E':
        keyCw = 0;
        break;
      case 'Enter':
      case ' ':
        if (kbPressed || kbPressQueued) kbReleaseQueued = true;
        break;
      default:
        break;
    }
  }

  /** Focus arriving on the canvas by Tab from elsewhere lands on the first (or last) object. */
  function onCanvasFocus(): void {
    if (kbFocus || performance.now() - tabStamp > 300) return;
    const e = cycle(tabDir);
    if (e) setKeyboardFocus(e);
  }

  function onCanvasBlur(): void {
    clearKeys();
    if (kbFocus) {
      kbFocus = null;
      keyboardMode = false;
    }
  }

  function onWindowBlur(): void {
    clearKeys();
    if (kbPressed) kbReleaseQueued = true;
    if (primaryId !== -1) {
      primaryId = -1;
      secondId = -1;
      releaseQueued = true;
      if (touch) inside = false;
    }
  }

  measure();
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerenter', onPointerEnter);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('focus', onCanvasFocus);
  canvas.addEventListener('blur', onCanvasBlur);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', measure);

  function dispose(): void {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('pointerenter', onPointerEnter);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('focus', onCanvasFocus);
    canvas.removeEventListener('blur', onCanvasBlur);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('resize', measure);
    clear();
    api.onGesture = null;
    api.onFocus = null;
  }

  return api;
}
