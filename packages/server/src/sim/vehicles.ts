import {
  GAMEPLAY,
  type MoveAxes,
  dist2,
  seatOffset,
  stepVehicle,
  vehicleBodyWorld,
  vehicleDef,
} from '@gridlock/shared';
import type { PlayerEntity, VehicleEntity } from './entities.js';
import type { World } from './World.js';
import { applyPlayerDamage, applyVehicleDamage } from './combat.js';
import { damageDeployable } from './deployables.js';

/**
 * Distance from a point to the surface of a vehicle's body - negative when the
 * point is inside it - plus the outward direction at the nearest spot.
 *
 * Uses the same row of body circles as the physics, so boarding range, shoves
 * and collisions all agree with where the vehicle actually is.
 */
export function vehicleSurfaceDistance(
  v: VehicleEntity,
  x: number,
  y: number,
): { d: number; nx: number; ny: number } {
  let best = Infinity;
  let nx = 1;
  let ny = 0;
  for (const c of vehicleBodyWorld(v)) {
    const dx = x - c.x;
    const dy = y - c.y;
    const len = Math.hypot(dx, dy);
    const d = len - c.r;
    if (d < best) {
      best = d;
      if (len > 1e-6) {
        nx = dx / len;
        ny = dy / len;
      }
    }
  }
  return { d: best, nx, ny };
}

/**
 * Handles the interact key: enter the nearest free vehicle, or leave the
 * current one. The server owns the seat assignment, so two players pressing E
 * on the same driver seat in the same tick cannot both end up driving.
 */
export function tryEnterExitVehicle(world: World, p: PlayerEntity): void {
  if (p.life !== 'alive') return;

  if (p.vehicleId !== null) {
    exitVehicle(world, p);
    return;
  }
  if (!world.config.vehiclesEnabled) return;

  const best = nearestBoardable(world, p);
  if (!best) return;

  if (best.driverId === null) best.driverId = p.id;
  else best.passengers.push(p.id);
  p.vehicleId = best.id;
  p.vx = 0;
  p.vy = 0;
  // Boarding lands a jump; otherwise the rider would stay "airborne" all ride.
  p.air = 0;
  syncOccupants(world, best);
}

function nearestBoardable(world: World, p: PlayerEntity): VehicleEntity | null {
  const range = GAMEPLAY.player.interactRange;
  let best: VehicleEntity | null = null;
  let bestD = Infinity;
  for (const v of world.vehicles.values()) {
    if (v.destroyed) continue;
    const occupied = (v.driverId ? 1 : 0) + v.passengers.length;
    if (occupied >= vehicleDef(v.type).seats) continue;
    const d = vehicleSurfaceDistance(v, p.x, p.y).d;
    if (d < range && d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

/**
 * The interaction hint for the nearest vehicle a player on foot could board,
 * naming its category and seats so the choice is informed before pressing E.
 */
export function vehiclePrompt(world: World, p: PlayerEntity): string | null {
  if (!world.config.vehiclesEnabled || p.life !== 'alive' || p.vehicleId !== null) {
    return null;
  }
  const best = nearestBoardable(world, p);
  if (!best) return null;

  const def = vehicleDef(best.type);
  const free = def.seats - ((best.driverId ? 1 : 0) + best.passengers.length);
  return best.driverId === null
    ? `E - Drive ${def.category}`
    : `E - Ride ${def.category} (${free} seat${free === 1 ? '' : 's'} free)`;
}

/**
 * Unlinks a player from their vehicle without moving them.
 *
 * Used on death: a rider shot off a motorcycle falls where they were, instead
 * of being teleported to the kerb the way a player stepping out would be. If
 * the driver leaves, the first passenger takes the wheel.
 */
export function detachFromVehicle(world: World, p: PlayerEntity): VehicleEntity | null {
  if (p.vehicleId === null) return null;
  const v = world.vehicles.get(p.vehicleId) ?? null;
  p.vehicleId = null;
  if (!v) return null;
  if (v.driverId === p.id) v.driverId = v.passengers.shift() ?? null;
  else v.passengers = v.passengers.filter((id) => id !== p.id);
  return v;
}

export function exitVehicle(world: World, p: PlayerEntity): void {
  const v = detachFromVehicle(world, p);
  if (!v) return;

  // Step out beside the seat, clear of the body; then behind or in front of
  // the vehicle; and only as a last resort, push out from where they sat.
  const def = vehicleDef(v.type);
  const r = GAMEPLAY.player.radius;
  const fx = Math.cos(v.rot);
  const fy = Math.sin(v.rot);
  const along = (p.x - v.x) * fx + (p.y - v.y) * fy;
  const side = def.width / 2 + r + 6;
  const end = def.length / 2 + r + 6;
  const ax = v.x + fx * along;
  const ay = v.y + fy * along;
  const candidates = [
    { x: ax - fy * side, y: ay + fx * side },
    { x: ax + fy * side, y: ay - fx * side },
    { x: v.x - fx * end, y: v.y - fy * end },
    { x: v.x + fx * end, y: v.y + fy * end },
  ];
  let placed = false;
  for (const c of candidates) {
    if (world.grid.circleBlocked(c.x, c.y, r)) continue;
    p.x = c.x;
    p.y = c.y;
    placed = true;
    break;
  }
  if (!placed) {
    const freed = world.grid.resolvePenetration(p.x, p.y, r);
    p.x = freed.x;
    p.y = freed.y;
  }
  // Carry a little of the vehicle's momentum out with them.
  p.vx = v.vx * 0.25;
  p.vy = v.vy * 0.25;
}

/**
 * Throws everyone out, optionally damaging them (used when a vehicle is
 * destroyed). The damage is credited to whoever destroyed the vehicle.
 */
export function ejectOccupants(
  world: World,
  v: VehicleEntity,
  damage: boolean,
  onlyId?: string,
  attacker: PlayerEntity | null = null,
  amount = 25,
): void {
  const ids = [v.driverId, ...v.passengers].filter((id): id is string => id !== null);
  for (const id of ids) {
    if (onlyId && id !== onlyId) continue;
    const p = world.players.get(id);
    if (!p) continue;
    exitVehicle(world, p);
    if (damage) applyPlayerDamage(world, p, amount, attacker, 'grenade');
  }
}

/**
 * Per-tick vehicle upkeep.
 *
 * A vehicle with a live driver is stepped from that driver's input commands in
 * `World.applyCommand`, exactly as on-foot movement is, so the client can
 * predict driving with the same code. This pass only coasts driverless
 * vehicles, syncs occupants to the body, and resolves collisions.
 */
export function stepVehicles(world: World): void {
  const dt = world.dt;

  for (const v of [...world.vehicles.values()]) {
    if (v.destroyed) {
      if (world.now >= v.despawnAt) {
        world.vehicles.delete(v.id);
        const def = world.mapDef.vehicleSpawns[v.spawnIndex];
        if (def && world.config.vehiclesEnabled) {
          world.pendingVehicleSpawns.push({
            spawnIndex: v.spawnIndex,
            at: world.now + def.respawnSec * 1000,
          });
        }
      }
      continue;
    }

    const def = vehicleDef(v.type);
    const driver = v.driverId ? world.players.get(v.driverId) : null;
    const driverActive =
      !!driver && driver.life === 'alive' && driver.connection === 'connected';
    if (!driverActive) {
      const res = stepVehicle(v, 0, dt, world.grid);
      // A motorcycle with nobody holding it up falls over and stops; a car
      // coasts on its own momentum.
      if (def.topplesWhenRiderless) {
        const k = Math.max(0, 1 - 7 * dt);
        v.vx *= k;
        v.vy *= k;
      }
      if (res.impact > 0) {
        applyVehicleDamage(
          world, v, res.impact * GAMEPLAY.vehicle.selfDamage * def.crashDamageMult, null,
        );
      }
    }

    syncOccupants(world, v);
    collideWithPlayers(world, v, driver ?? null);
    collideWithVehicles(world, v);
    collideWithDeployables(world, v, driver ?? null);
  }

  stepVehicleRespawns(world);
}

/** Drives one vehicle from a single consumed input command. */
export function driveVehicle(
  world: World,
  v: VehicleEntity,
  driver: PlayerEntity,
  buttons: number,
  dt: number,
  axes: MoveAxes | null = null,
): void {
  if (v.destroyed) return;
  const res = stepVehicle(v, buttons, dt, world.grid, axes);
  if (res.impact > 0) {
    const def = vehicleDef(v.type);
    applyVehicleDamage(
      world, v, res.impact * GAMEPLAY.vehicle.selfDamage * def.crashDamageMult, driver,
    );
    world.emit({ e: 'vehicleHit', x: v.x, y: v.y, force: res.impact });
  }
  syncOccupants(world, v);
}

/**
 * Occupants ride along with the body, each parked at their own seat.
 *
 * Placing riders at their seat rather than the body centre is what lets a
 * passenger's shots leave from where they are actually sitting, and keeps the
 * seat markers the client draws honest.
 */
function syncOccupants(world: World, v: VehicleEntity): void {
  const def = vehicleDef(v.type);
  const c = Math.cos(v.rot);
  const sn = Math.sin(v.rot);
  const ids = [v.driverId, ...v.passengers];

  ids.forEach((id, seat) => {
    if (!id) return;
    const p = world.players.get(id);
    if (!p) return;
    const local = seatOffset(def, seat);
    p.x = v.x + local.x * c - local.y * sn;
    p.y = v.y + local.x * sn + local.y * c;
    p.vx = v.vx;
    p.vy = v.vy;
  });
}

function collideWithPlayers(
  world: World,
  v: VehicleEntity,
  driver: PlayerEntity | null,
): void {
  const speed = Math.hypot(v.vx, v.vy);
  const def = vehicleDef(v.type);
  const r = GAMEPLAY.player.radius;
  const outer = def.length / 2 + r + 4;

  for (const p of world.players.values()) {
    if (p.life !== 'alive' || p.vehicleId !== null) continue;
    if (dist2(v.x, v.y, p.x, p.y) > outer * outer) continue;
    const surface = vehicleSurfaceDistance(v, p.x, p.y);
    if (surface.d >= r) continue;

    // Push the pedestrian out of the body along its surface normal, through
    // the collision grid so they cannot be shoved into a wall.
    const push = Math.min(16, r - surface.d + 0.5);
    const moved = world.grid.moveCircle(p.x, p.y, r, surface.nx * push, surface.ny * push);
    p.x = moved.x;
    p.y = moved.y;

    if (speed < GAMEPLAY.vehicle.minImpactSpeed) continue;
    if (!world.canDamage(driver, p)) continue;

    p.vx += surface.nx * speed * GAMEPLAY.vehicle.knockback;
    p.vy += surface.ny * speed * GAMEPLAY.vehicle.knockback;
    applyPlayerDamage(world, p, speed * def.ramDamage * 0.1, driver, 'fists');
    world.emit({ e: 'vehicleHit', x: p.x, y: p.y, force: speed });
    // Ramming costs the vehicle some health too.
    applyVehicleDamage(world, v, speed * 0.04 * def.crashDamageMult, null);
  }
}

/** Driving into a barricade damages it - and slows you down. */
function collideWithDeployables(
  world: World,
  v: VehicleEntity,
  driver: PlayerEntity | null,
): void {
  const speed = Math.hypot(v.vx, v.vy);
  if (speed < GAMEPLAY.vehicle.minImpactSpeed) return;
  const def = vehicleDef(v.type);
  const reach = def.length / 2 + 70;
  const body = vehicleBodyWorld(v);

  for (const d of [...world.deployables.values()]) {
    // Mines have no body; they deal with vehicles in their own trigger.
    if (d.solids.length === 0) continue;
    if (dist2(v.x, v.y, d.x, d.y) > reach * reach) continue;
    const touching = d.solids.some((sd) => body.some((c) => {
      const cx = Math.max(sd.rect.x, Math.min(c.x, sd.rect.x + sd.rect.w));
      const cy = Math.max(sd.rect.y, Math.min(c.y, sd.rect.y + sd.rect.h));
      return dist2(c.x, c.y, cx, cy) <= (c.r + 2) ** 2;
    }));
    if (!touching) continue;

    // Demolition is what separates a truck from a car against a fortified base.
    damageDeployable(world, d, speed * GAMEPLAY.defences.ramDamage * def.demolition, driver);
    applyVehicleDamage(world, v, speed * 0.06 * def.crashDamageMult, null);
    world.emit({ e: 'vehicleHit', x: d.x, y: d.y, force: speed });
  }
}

/**
 * Vehicle-vs-vehicle contact, resolved once per pair (the lower id handles it)
 * using the deepest overlap between any two body circles, so a motorcycle can
 * no longer ride inside a van's silhouette.
 */
function collideWithVehicles(world: World, v: VehicleEntity): void {
  const defA = vehicleDef(v.type);
  for (const other of world.vehicles.values()) {
    if (other.id <= v.id || other.destroyed) continue;
    const defB = vehicleDef(other.type);
    const reach = (defA.length + defB.length) / 2;
    if (dist2(v.x, v.y, other.x, other.y) > reach * reach) continue;

    let overlap = 0;
    let nx = 0;
    let ny = 0;
    const bodyB = vehicleBodyWorld(other);
    for (const a of vehicleBodyWorld(v)) {
      for (const b of bodyB) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1e-6;
        const depth = a.r + b.r - len;
        if (depth > overlap) {
          overlap = depth;
          nx = dx / len;
          ny = dy / len;
        }
      }
    }
    if (overlap <= 0) continue;

    const massA = defA.mass;
    const massB = defB.mass;
    const total = massA + massB;
    // Separate along the contact normal, the lighter vehicle moving further.
    v.x -= nx * overlap * (massB / total);
    v.y -= ny * overlap * (massB / total);
    other.x += nx * overlap * (massA / total);
    other.y += ny * overlap * (massA / total);

    const relative = Math.hypot(v.vx - other.vx, v.vy - other.vy);
    if (relative < GAMEPLAY.vehicle.minImpactSpeed) continue;
    const impulse = relative * 0.4;
    v.vx -= nx * impulse * (massB / total);
    v.vy -= ny * impulse * (massB / total);
    other.vx += nx * impulse * (massA / total);
    other.vy += ny * impulse * (massA / total);

    const dmg = relative * GAMEPLAY.vehicle.selfDamage * 2;
    applyVehicleDamage(world, v, dmg * (massB / total) * defA.crashDamageMult, null);
    applyVehicleDamage(world, other, dmg * (massA / total) * defB.crashDamageMult, null);
    world.emit({
      e: 'vehicleHit', x: (v.x + other.x) / 2, y: (v.y + other.y) / 2, force: relative,
    });
  }
}

export function stepVehicleRespawns(world: World): void {
  for (let i = world.pendingVehicleSpawns.length - 1; i >= 0; i--) {
    const q = world.pendingVehicleSpawns[i];
    if (world.now >= q.at) {
      world.pendingVehicleSpawns.splice(i, 1);
      world.spawnVehicle(q.spawnIndex);
    }
  }
}
