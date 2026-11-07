/**
 * Pure touch-gesture logic, kept free of the DOM so it can be unit tested.
 */

export interface StickVector {
  /** Direction scaled by push, each axis -1..1, length 0..1. */
  x: number;
  y: number;
  /** How far the stick is pushed, 0..1, after the dead zone. */
  mag: number;
}

/** A small dead zone so a resting thumb does not creep. */
export const STICK_DEADZONE = 0.14;
/** Pushed this far (or more) on foot, the player sprints. */
export const SPRINT_PUSH = 0.92;

/**
 * Converts a thumb position relative to where it landed into a stick vector.
 * The dead zone is rescaled away, so just outside it the push starts near 0
 * rather than jumping to 0.14.
 */
export function stickVector(
  originX: number, originY: number, x: number, y: number, radius: number,
  deadzone = STICK_DEADZONE,
): StickVector {
  const dx = x - originX;
  const dy = y - originY;
  const len = Math.hypot(dx, dy);
  const raw = Math.min(1, len / Math.max(1, radius));
  if (raw <= deadzone || len < 1e-6) return { x: 0, y: 0, mag: 0 };
  const mag = (raw - deadzone) / (1 - deadzone);
  return { x: (dx / len) * mag, y: (dy / len) * mag, mag };
}

/** Car-style driving from a stick: forward/back is throttle, sideways steers. */
export function stickToDriveBits(
  v: StickVector, bits: { up: number; down: number; left: number; right: number },
): number {
  let b = 0;
  if (v.y < -0.3) b |= bits.up;
  if (v.y > 0.3) b |= bits.down;
  if (v.x < -0.3) b |= bits.left;
  if (v.x > 0.3) b |= bits.right;
  return b;
}

/** A quick touch that barely moved is a tap; anything longer becomes a hold. */
export const TAP_MAX_MS = 220;
/** Moving the thumb further than this switches to manual aim. */
export const DRAG_MIN_PX = 22;
/** How long a tap keeps the trigger down, so it always registers a shot. */
export const TAP_FIRE_MS = 140;

export type FirePhase = 'idle' | 'pending' | 'hold' | 'drag';

/**
 * The right thumb's fire stick.
 *
 * - tap: a short touch that barely moved; fires briefly at the auto target.
 * - hold: a touch that stays put; fires continuously, tracking the target.
 * - drag: the thumb moved; fires continuously, aimed by hand.
 */
export class FireStick {
  phase: FirePhase = 'idle';
  originX = 0;
  originY = 0;
  x = 0;
  y = 0;
  private downAt = 0;
  /** A tap's shot keeps firing until this time. */
  tapUntil = 0;

  down(x: number, y: number, now: number): void {
    this.phase = 'pending';
    this.originX = this.x = x;
    this.originY = this.y = y;
    this.downAt = now;
  }

  move(x: number, y: number): void {
    if (this.phase === 'idle') return;
    this.x = x;
    this.y = y;
    if (Math.hypot(x - this.originX, y - this.originY) > DRAG_MIN_PX) this.phase = 'drag';
  }

  /** Lifted: a short, still touch fires a tap. */
  up(now: number): void {
    if (this.phase === 'pending' && now - this.downAt <= TAP_MAX_MS) {
      this.tapUntil = now + TAP_FIRE_MS;
    }
    this.phase = 'idle';
  }

  /** Called every frame: a touch held still long enough becomes a hold. */
  update(now: number): void {
    if (this.phase === 'pending' && now - this.downAt > TAP_MAX_MS) this.phase = 'hold';
  }

  /** True while the trigger should be down. */
  firing(now: number): boolean {
    return this.phase === 'hold' || this.phase === 'drag' || now < this.tapUntil;
  }

  /** Manual aim angle while dragging, else null. */
  dragAngle(): number | null {
    if (this.phase !== 'drag') return null;
    return Math.atan2(this.y - this.originY, this.x - this.originX);
  }
}

/**
 * The context button's label and action from the server's interaction prompt,
 * e.g. "E - Buy SMG ($400)" or "F - Swap for Rifle". Prompts without a key
 * (a store's "Hold your ground to rob the store") are information only.
 */
export function contextFromPrompt(
  prompt: string | null, inVehicle: boolean,
): { label: string; action: 'interact' | 'swap' } | null {
  if (inVehicle) return { label: 'Exit', action: 'interact' };
  if (!prompt) return null;
  const m = /^([EF]) - (.+)$/.exec(prompt);
  if (!m) return null;
  return { label: m[2], action: m[1] === 'F' ? 'swap' : 'interact' };
}
