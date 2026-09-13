import { GAMEPLAY } from '../config/gameplay.js';
import { vehicleBodyCircles, vehicleDef } from '../config/vehicles.js';
import { angleDelta, clamp } from '../math.js';
import { Btn, type VehicleDef, type VehicleTypeId } from '../types.js';
import type { CollisionGrid } from './collision.js';
import type { MoveAxes } from './movement.js';

export interface DrivableActor {
  x: number;
  y: number;
  /** World-space velocity. */
  vx: number;
  vy: number;
  /** Facing angle in radians. */
  rot: number;
  type: VehicleTypeId;
}

export interface DriveResult {
  /** Impact speed in world units/sec, 0 when nothing was struck. */
  impact: number;
}

/** Controls for one driving step: both in -1..1, throttle positive forward. */
export interface DriveControls {
  steer: number;
  throttle: number;
}

/** Past this angle off the nose a destination counts as behind the vehicle. */
const BEHIND_ANGLE = 1.95;
/** A reversing vehicle keeps backing up until its nose is this close to on course. */
const REVERSE_UNTIL_ANGLE = 1.2;
/** Heading error that earns full steering lock. */
const FULL_LOCK_ANGLE = 0.35;
/** Below this length a direction counts as no input. */
const DRIVE_DEADZONE = 0.02;

/**
 * Screen-relative driving: turns "I want to go that way" into steering and
 * throttle for the vehicle's current pose.
 *
 * Ahead, it steers toward the direction and eases off the throttle for sharp
 * turns. Behind, it brakes if moving fast, then makes a three-point turn -
 * reversing while swinging the nose round - until the nose is roughly on
 * course. Whether it is reversing is read from the velocity rather than stored,
 * so the choice replays identically during client prediction.
 */
export function steerTowards(
  rot: number,
  along: number,
  def: Pick<VehicleDef, 'maxSpeed'>,
  dirX: number,
  dirY: number,
): DriveControls {
  const mag = Math.min(1, Math.hypot(dirX, dirY));
  if (mag <= DRIVE_DEADZONE) return { steer: 0, throttle: 0 };

  const delta = angleDelta(rot, Math.atan2(dirY, dirX));
  const off = Math.abs(delta);
  // Steering flips while reversing, so the wheel direction that turns the nose
  // toward the target depends on which way the vehicle is rolling.
  const wheel = along < 0 ? -1 : 1;
  const turn = clamp(delta / FULL_LOCK_ANGLE, -1, 1);

  const reversing = along < -20;
  const backUp = reversing
    ? off > REVERSE_UNTIL_ANGLE
    : off > BEHIND_ANGLE && along < def.maxSpeed * 0.25;
  if (backUp) return { steer: Math.sign(delta) * wheel, throttle: -mag };
  // Target behind while still moving forward quickly: brake into the turn.
  if (off > BEHIND_ANGLE) return { steer: Math.sign(delta) * wheel, throttle: -mag };

  const ease = off < Math.PI / 2 ? 0.45 + 0.55 * Math.cos(off) : 0.45;
  return { steer: turn * wheel, throttle: mag * ease };
}

/**
 * Arcade car handling: forward thrust along the body axis, steering scaled by
 * speed, and lateral velocity bled off to fake tyre grip. Shared with the
 * client so a driven car predicts as smoothly as a walking player.
 *
 * With `axes` the driver gives a world direction instead of pedals and
 * steering (see `steerTowards`); without them the direction bits drive it
 * exactly as before.
 */
export function stepVehicle(
  v: DrivableActor,
  buttons: number,
  dt: number,
  grid: CollisionGrid,
  axes: MoveAxes | null = null,
): DriveResult {
  const def = vehicleDef(v.type);

  const fx = Math.cos(v.rot);
  const fy = Math.sin(v.rot);
  // Signed speed along the facing axis: negative means reversing.
  let along = v.vx * fx + v.vy * fy;
  let lateral = -v.vx * fy + v.vy * fx;

  let controls: DriveControls;
  if (axes && Math.hypot(axes.x, axes.y) > DRIVE_DEADZONE) {
    controls = steerTowards(v.rot, along, def, axes.x, axes.y);
  } else {
    const forward = (buttons & Btn.Up) !== 0;
    const back = (buttons & Btn.Down) !== 0;
    controls = {
      throttle: forward ? 1 : back ? -1 : 0,
      steer: ((buttons & Btn.Right) !== 0 ? 1 : 0) - ((buttons & Btn.Left) !== 0 ? 1 : 0),
    };
  }
  const throttle = clamp(controls.throttle, -1, 1);

  if (throttle > 0) {
    // A part-pressed pedal settles at a part of top speed.
    const cap = def.maxSpeed * throttle;
    if (along < cap) {
      along = Math.min(cap, along + def.acceleration * throttle * dt);
    } else {
      along = Math.max(cap, along * Math.max(0, 1 - def.drag * dt));
    }
  } else if (throttle < 0) {
    along -= (along > 0 ? def.braking : def.acceleration) * -throttle * dt;
  } else {
    const drag = Math.max(0, 1 - def.drag * dt);
    along *= drag;
    if (Math.abs(along) < 4) along = 0;
  }
  along = Math.max(-def.reverseSpeed, Math.min(def.maxSpeed, along));

  // Steering authority tapers off with speed so top-speed driving stays stable,
  // and reverses sign when reversing so the car handles like a real one.
  const speedFrac = Math.min(1, Math.abs(along) / def.maxSpeed);
  const authority = 1 - (1 - def.steeringAtSpeed) * speedFrac;
  // Some steering authority even at a crawl, so a parked car can be lined up
  // without first driving off in the wrong direction.
  const responsiveness = 0.35 + 0.65 * Math.min(1, Math.abs(along) / 45);
  const steerDir = clamp(controls.steer, -1, 1);
  const body = vehicleBodyCircles(def);
  const nextRot =
    v.rot + steerDir * def.steering * authority * responsiveness * dt * Math.sign(along || 1);
  // Turning swings the nose and tail sideways. Refuse a turn that would swing
  // them into a wall, so a long vehicle cannot rotate its body through a building.
  if (nextRot !== v.rot && !(bodyBlocked(grid, body, v.x, v.y, nextRot) &&
      !bodyBlocked(grid, body, v.x, v.y, v.rot))) {
    v.rot = nextRot;
  }

  // Bleed lateral velocity - the fraction retained per second is `grip`, so a
  // lower value means the tyres bite harder and the car slides less.
  lateral *= Math.pow(def.grip, dt);
  if (Math.abs(lateral) < 3) lateral = 0;

  const nfx = Math.cos(v.rot);
  const nfy = Math.sin(v.rot);
  v.vx = nfx * along - nfy * lateral;
  v.vy = nfy * along + nfx * lateral;

  // Something (a collision with another vehicle, a respawn) may have left the
  // body overlapping geometry; push it clear before moving.
  unstick(v, body, grid);

  const before = Math.hypot(v.vx, v.vy);
  const moveX = v.vx * dt;
  const moveY = v.vy * dt;
  let hitX = false;
  let hitY = false;
  if (moveX !== 0 || moveY !== 0) {
    // Sub-step so a fast vehicle cannot tunnel through a thin wall, testing
    // the whole body - not just its centre - on each axis.
    const steps = Math.max(1, Math.ceil(Math.hypot(moveX, moveY) / (body.radius * 0.8)));
    const sx = moveX / steps;
    const sy = moveY / steps;
    for (let i = 0; i < steps; i++) {
      if (!hitX) {
        if (!bodyBlocked(grid, body, v.x + sx, v.y, v.rot)) v.x += sx;
        else hitX = true;
      }
      if (!hitY) {
        if (!bodyBlocked(grid, body, v.x, v.y + sy, v.rot)) v.y += sy;
        else hitY = true;
      }
    }
  }
  const res = { hitX, hitY };

  let impact = 0;
  if (res.hitX || res.hitY) {
    impact = before;
    // Bounce back a little rather than sticking to the wall.
    if (res.hitX) v.vx *= -0.18;
    if (res.hitY) v.vy *= -0.18;
    const bled = Math.max(0, 1 - 6 * dt);
    v.vx *= bled;
    v.vy *= bled;
    if (impact < GAMEPLAY.vehicle.minImpactSpeed) impact = 0;
  }

  return { impact };
}

type Body = { radius: number; offsets: number[] };

/** True when any circle of the body overlaps geometry at this pose. */
function bodyBlocked(grid: CollisionGrid, body: Body, x: number, y: number, rot: number): boolean {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (const o of body.offsets) {
    if (grid.circleBlocked(x + c * o, y + s * o, body.radius)) return true;
  }
  return false;
}

/**
 * Pushes an embedded body out of geometry. Each pass applies the single
 * largest correction any circle needs, rather than the sum (which overshoots
 * when several circles are in the same wall) or the average (which dilutes
 * one deeply embedded circle).
 */
function unstick(v: DrivableActor, body: Body, grid: CollisionGrid): void {
  for (let pass = 0; pass < 4; pass++) {
    const c = Math.cos(v.rot);
    const s = Math.sin(v.rot);
    let bestX = 0;
    let bestY = 0;
    let bestLen = 0;
    for (const o of body.offsets) {
      const cx = v.x + c * o;
      const cy = v.y + s * o;
      if (!grid.circleBlocked(cx, cy, body.radius)) continue;
      const freed = grid.resolvePenetration(cx, cy, body.radius);
      const dx = freed.x - cx;
      const dy = freed.y - cy;
      const len = Math.hypot(dx, dy);
      if (len > bestLen) {
        bestLen = len;
        bestX = dx;
        bestY = dy;
      }
    }
    if (bestLen === 0) return;
    v.x += bestX;
    v.y += bestY;
  }
}
