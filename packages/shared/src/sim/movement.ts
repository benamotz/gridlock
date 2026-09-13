import { GAMEPLAY } from '../config/gameplay.js';
import { weaponDef } from '../config/weapons.js';
import { Btn, type WeaponId } from '../types.js';
import type { CollisionGrid } from './collision.js';

/**
 * The minimal slice of player state that movement touches. Both the
 * authoritative server entity and the client's predicted copy satisfy this,
 * which is what lets a single implementation drive both.
 */
export interface MovableActor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  stamina: number;
  sprinting: boolean;
  /** Seconds of airtime remaining; 0 while on the ground. */
  air: number;
  /** Seconds until the next jump is allowed. */
  jumpCd: number;
  /** Jump button state from the previous step, so a held key jumps once. */
  jumpHeld: boolean;
}

export interface MoveResult {
  hitWall: boolean;
  /** True on the step the actor left the ground. */
  jumped: boolean;
}

/** True while a jump carries the actor over incoming bullets. */
export function isEvading(a: Pick<MovableActor, 'air'>): boolean {
  if (a.air <= 0) return false;
  const elapsed = GAMEPLAY.player.jumpDuration - a.air;
  return elapsed >= GAMEPLAY.player.evadeStart && elapsed <= GAMEPLAY.player.evadeEnd;
}

/** 0 on the ground, rising to 1 at the top of a jump and back to 0 on landing. */
export function jumpHeight(air: number): number {
  if (air <= 0) return 0;
  const t = 1 - air / GAMEPLAY.player.jumpDuration;
  return Math.sin(Math.PI * Math.max(0, Math.min(1, t)));
}

/** An analog world-space direction, magnitude 0..1. */
export interface MoveAxes {
  x: number;
  y: number;
}

/** Below this an analog vector counts as "no input". */
const AXIS_DEADZONE = 0.02;

/**
 * The analog axes a command carries, clamped to length 1, or null when it has
 * none. Clamping here as well as in the parser keeps the simulation safe for
 * commands that never crossed the wire (bots, tests, prediction).
 */
export function commandAxes(cmd: { ax?: number; ay?: number }): MoveAxes | null {
  if (typeof cmd.ax !== 'number' || typeof cmd.ay !== 'number') return null;
  if (!Number.isFinite(cmd.ax) || !Number.isFinite(cmd.ay)) return null;
  const len = Math.hypot(cmd.ax, cmd.ay);
  if (len > 1) return { x: cmd.ax / len, y: cmd.ay / len };
  return { x: cmd.ax, y: cmd.ay };
}

/**
 * One fixed movement step. Deterministic given the same inputs, so replaying
 * unacknowledged commands on the client reproduces the server exactly -
 * including jumps, whose timers advance by `dt` rather than by wall clock.
 *
 * `axes`, when present, replaces the direction bits: its direction is where to
 * go and its length (at most 1) scales the speed, so a half-pushed stick walks
 * at half pace and a full push matches a keyboard exactly.
 */
export function stepPlayerMovement(
  a: MovableActor,
  weapon: WeaponId,
  buttons: number,
  dt: number,
  grid: CollisionGrid,
  axes: MoveAxes | null = null,
): MoveResult {
  const P = GAMEPLAY.player;

  let ix = 0;
  let iy = 0;
  let throttle = 1;
  if (axes) {
    const mag = Math.min(1, Math.hypot(axes.x, axes.y));
    if (mag > AXIS_DEADZONE) {
      ix = axes.x;
      iy = axes.y;
      throttle = mag;
    }
  } else {
    if (buttons & Btn.Left) ix -= 1;
    if (buttons & Btn.Right) ix += 1;
    if (buttons & Btn.Up) iy -= 1;
    if (buttons & Btn.Down) iy += 1;
  }
  const len = Math.hypot(ix, iy);
  if (len > 0) {
    ix /= len;
    iy /= len;
  }

  const wantsSprint = (buttons & Btn.Sprint) !== 0 && len > 0;
  if (wantsSprint && a.stamina > 0 && (a.sprinting || a.stamina > P.staminaRestartAt)) {
    a.sprinting = true;
    a.stamina = Math.max(0, a.stamina - P.staminaDrainPerSec * dt);
    if (a.stamina <= 0) a.sprinting = false;
  } else {
    a.sprinting = false;
    a.stamina = Math.min(P.staminaMax, a.stamina + P.staminaRegenPerSec * dt);
  }

  // --- jump --------------------------------------------------------------
  if (a.jumpCd > 0) a.jumpCd = Math.max(0, a.jumpCd - dt);
  if (a.air > 0) a.air = Math.max(0, a.air - dt);

  const jumpDown = (buttons & Btn.Jump) !== 0;
  let jumped = false;
  if (
    jumpDown && !a.jumpHeld &&
    a.air <= 0 && a.jumpCd <= 0 &&
    a.stamina >= P.jumpStamina
  ) {
    a.air = P.jumpDuration;
    a.jumpCd = P.jumpCooldown;
    a.stamina -= P.jumpStamina;
    jumped = true;

    // Launch along the held direction, or the current heading if none is held.
    const speed = Math.hypot(a.vx, a.vy);
    const dirX = len > 0 ? ix : speed > 1 ? a.vx / speed : 0;
    const dirY = len > 0 ? iy : speed > 1 ? a.vy / speed : 0;
    a.vx += dirX * P.jumpBoost;
    a.vy += dirY * P.jumpBoost;
  }
  a.jumpHeld = jumpDown;
  const airborne = a.air > 0;

  const weaponMult = weaponDef(weapon).moveMultiplier;
  const groundTarget = (a.sprinting ? P.sprintSpeed : P.walkSpeed) * weaponMult * throttle;
  // In the air the take-off boost is allowed to carry, so a jump covers ground.
  const target = airborne ? groundTarget + P.jumpBoost : groundTarget;

  // Accelerate toward the desired velocity; steering is weak mid-air.
  const control = airborne ? P.airControl : 1;
  a.vx += ix * P.acceleration * control * dt;
  a.vy += iy * P.acceleration * control * dt;

  const speed = Math.hypot(a.vx, a.vy);
  if (speed > target) {
    const s = target / speed;
    a.vx *= s;
    a.vy *= s;
  }
  // No friction while airborne: momentum is what makes a jump a dodge.
  if (len === 0 && !airborne) {
    const damp = Math.max(0, 1 - P.friction * dt);
    a.vx *= damp;
    a.vy *= damp;
    if (Math.abs(a.vx) < 1) a.vx = 0;
    if (Math.abs(a.vy) < 1) a.vy = 0;
  }

  const res = grid.moveCircle(a.x, a.y, P.radius, a.vx * dt, a.vy * dt);
  a.x = res.x;
  a.y = res.y;
  if (res.hitX) a.vx = 0;
  if (res.hitY) a.vy = 0;

  return { hitWall: res.hitX || res.hitY, jumped };
}
