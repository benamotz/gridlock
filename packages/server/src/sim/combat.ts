import {
  GAMEPLAY,
  type WeaponDef,
  type WeaponId,
  dist,
  isEvading,
  seatIndexOf,
  seatOffset,
  segmentCircle,
  segmentRect,
  shotIntervalMs,
  vehicleDef,
  weaponDef,
} from '@gridlock/shared';
import type {
  DeployableEntity, PlayerEntity, ProjectileEntity, VehicleEntity,
} from './entities.js';
import type { World } from './World.js';
import { bestSlot } from './loadout.js';
import { dropConsumableAt, dropWeaponAt } from './pickups.js';
import { detachFromVehicle, ejectOccupants } from './vehicles.js';
import { damageDeployable } from './deployables.js';

interface RayHit {
  t: number;
  player?: PlayerEntity;
  vehicle?: VehicleEntity;
  deployable?: DeployableEntity;
}

/** Bullet-vs-vehicle uses the exact rotated body, not the physics circle. */
function segmentVehicle(
  x0: number, y0: number, x1: number, y1: number, v: VehicleEntity,
): number | null {
  const def = vehicleDef(v.type);
  const c = Math.cos(-v.rot);
  const s = Math.sin(-v.rot);
  const lx0 = (x0 - v.x) * c - (y0 - v.y) * s;
  const ly0 = (x0 - v.x) * s + (y0 - v.y) * c;
  const lx1 = (x1 - v.x) * c - (y1 - v.y) * s;
  const ly1 = (x1 - v.x) * s + (y1 - v.y) * c;
  return segmentRect(lx0, ly0, lx1, ly1, {
    x: -def.length / 2, y: -def.width / 2, w: def.length, h: def.width,
  });
}

/**
 * Traces a single shot against the world and returns the nearest thing it hit.
 * Static geometry is tested first so bullets never pass through buildings.
 */
export function traceShot(
  world: World,
  x0: number, y0: number, x1: number, y1: number,
  ignoreId: string,
  /** Vehicle the shot was fired from, which its own passengers cannot hit. */
  ignoreVehicleId: number | null = null,
  /** Deployable the shot was fired from, so a turret cannot shoot itself. */
  ignoreDeployableId: number | null = null,
): RayHit {
  // Static geometry includes deployables, so resolve those first and then let
  // the specific entity tests below refine the hit.
  let best: RayHit = { t: world.grid.raycast(x0, y0, x1, y1) };

  for (const d of world.deployables.values()) {
    if (d.id === ignoreDeployableId) continue;
    for (const solid of d.solids) {
      const t = segmentRect(x0, y0, x1, y1, solid.rect);
      if (t !== null && t <= best.t) best = { t, deployable: d };
    }
  }

  for (const p of world.players.values()) {
    if (p.id === ignoreId || p.life !== 'alive') continue;
    // Mid-jump, bullets pass beneath the player.
    if (isEvading(p)) continue;
    if (p.vehicleId !== null) {
      // An enclosed body protects its occupants - shoot the vehicle instead.
      // A motorcycle does not, which is the price of riding one.
      const ride = world.vehicles.get(p.vehicleId);
      if (!ride || vehicleDef(ride.type).shieldsOccupants) continue;
      if (ride.id === ignoreVehicleId) continue;
    }
    const t = segmentCircle(x0, y0, x1, y1, p.x, p.y, GAMEPLAY.player.radius);
    if (t !== null && t < best.t) best = { t, player: p };
  }

  for (const v of world.vehicles.values()) {
    if (v.destroyed || v.id === ignoreVehicleId) continue;
    // A rider on an open vehicle takes the hit whenever the shot reaches them;
    // a motorcycle's thin frame must not soak bullets meant for its riders.
    if (best.player && best.player.vehicleId === v.id) continue;
    const t = segmentVehicle(x0, y0, x1, y1, v);
    if (t !== null && t >= 0 && t < best.t) best = { t, vehicle: v };
  }

  return best;
}

const falloff = (def: WeaponDef, distance: number): number => {
  if (distance <= def.falloffStart) return 1;
  const span = Math.max(1, def.range - def.falloffStart);
  const f = Math.min(1, (distance - def.falloffStart) / span);
  return 1 - (1 - def.falloffMin) * f;
};

/**
 * Server-authoritative trigger pull.
 *
 * Validates cadence, ammunition and state before anything is spent. A client
 * that sends fire requests faster than its weapon allows simply has the extra
 * requests ignored - it gains no shots and no ammunition is consumed.
 */
export function fireWeapon(
  world: World,
  p: PlayerEntity,
  wasHeld: boolean,
  _buttons: number,
): void {
  if (p.life !== 'alive') return;

  // Riding: passengers can shoot out of the windows, the driver cannot.
  const vehicle = p.vehicleId !== null ? world.vehicles.get(p.vehicleId) ?? null : null;
  if (vehicle) {
    if (vehicle.destroyed) return;
    const isDriver = vehicle.driverId === p.id;
    if (isDriver && !GAMEPLAY.vehicleCombat.driverCanFire) return;
  }

  const slotState = p.slots[p.slot];
  if (!slotState) return;
  const def = weaponDef(slotState.id);

  // Semi-automatic weapons need the trigger released between shots.
  const semiAuto = def.rpm < 200 || def.class === 'throwable';
  if (semiAuto && wasHeld) return;

  if (world.now < p.nextFireAt - GAMEPLAY.combat.fireRateGraceMs) return;
  if (p.reloadingSlot === p.slot && world.now < p.reloadEndsAt) return;

  if (slotState.ammo <= 0) {
    // Empty: try to reload instead of firing, exactly like a real trigger pull.
    startReload(world, p);
    return;
  }

  if (Number.isFinite(def.magazine)) slotState.ammo -= 1;
  p.nextFireAt = world.now + shotIntervalMs(slotState.id);
  p.spread = Math.min(def.maxSpread, p.spread + def.spreadPerShot);
  // Firing forfeits spawn protection - you cannot shoot from behind a shield.
  if (world.isProtected(p)) p.spawnProtectedUntil = world.now;

  if (def.projectileSpeed > 0) {
    spawnProjectile(world, p, def, vehicle);
  } else {
    hitscan(world, p, def, vehicle);
  }

  // Throwables and single-shot heavies auto-reload from reserve.
  if (slotState.ammo <= 0 && slotState.reserve > 0) startReload(world, p);
}

function hitscan(
  world: World,
  p: PlayerEntity,
  def: WeaponDef,
  vehicle: VehicleEntity | null,
): void {
  const baseSpread = world.effectiveSpread(p);
  // Shots leave from the shooter's seat, clear of their own bodywork.
  const origin = firingOrigin(world, p, vehicle);

  for (let i = 0; i < def.pellets; i++) {
    const jitter = def.pellets > 1
      ? (world.rng() * 2 - 1) * def.spread + (world.rng() * 2 - 1) * p.spread
      : (world.rng() * 2 - 1) * baseSpread;
    const a = p.aim + jitter;
    const x1 = origin.x + Math.cos(a) * def.range;
    const y1 = origin.y + Math.sin(a) * def.range;

    const hit = traceShot(world, origin.x, origin.y, x1, y1, p.id, vehicle?.id ?? null);
    const hx = origin.x + (x1 - origin.x) * hit.t;
    const hy = origin.y + (y1 - origin.y) * hit.t;

    world.emit({
      e: 'shot', by: p.id, x: origin.x, y: origin.y, a,
      w: def.id, len: def.range * hit.t,
    });

    if (hit.player) {
      const d = dist(origin.x, origin.y, hit.player.x, hit.player.y);
      applyPlayerDamage(world, hit.player, def.damage * falloff(def, d), p, def.id);
      world.emit({ e: 'hit', x: hx, y: hy, onPlayer: true });
    } else if (hit.deployable) {
      damageDeployable(world, hit.deployable, def.damage, p);
      world.emit({ e: 'hit', x: hx, y: hy, onPlayer: false });
    } else if (hit.vehicle) {
      applyVehicleDamage(
        world,
        hit.vehicle,
        def.damage * GAMEPLAY.combat.vehicleDamageMult *
          vehicleDef(hit.vehicle.type).bulletDamageMult,
        p,
      );
      world.emit({ e: 'hit', x: hx, y: hy, onPlayer: false });
    } else if (hit.t < 1) {
      world.emit({ e: 'hit', x: hx, y: hy, onPlayer: false });
    }
  }
}

function spawnProjectile(
  world: World,
  p: PlayerEntity,
  def: WeaponDef,
  vehicle: VehicleEntity | null,
): void {
  const a = p.aim + (world.rng() * 2 - 1) * world.effectiveSpread(p);
  const origin = firingOrigin(world, p, vehicle);
  const proj: ProjectileEntity = {
    id: world.allocId(),
    weapon: def.id,
    ownerId: p.id,
    ownerTeam: p.team,
    fromVehicleId: vehicle?.id ?? null,
    x: origin.x + Math.cos(a) * (GAMEPLAY.player.radius + 4),
    y: origin.y + Math.sin(a) * (GAMEPLAY.player.radius + 4),
    vx: Math.cos(a) * def.projectileSpeed,
    vy: Math.sin(a) * def.projectileSpeed,
    expiresAt: world.now + (def.range / def.projectileSpeed) * 1000,
  };
  world.projectiles.set(proj.id, proj);
  world.emit({ e: 'shot', by: p.id, x: origin.x, y: origin.y, a, w: def.id, len: 0 });
}

export function stepProjectiles(world: World): void {
  const dt = world.dt;
  for (const proj of [...world.projectiles.values()]) {
    const nx = proj.x + proj.vx * dt;
    const ny = proj.y + proj.vy * dt;
    const owner = world.players.get(proj.ownerId) ?? null;
    const hit = traceShot(world, proj.x, proj.y, nx, ny, proj.ownerId, proj.fromVehicleId);

    if (hit.t < 1 || world.now >= proj.expiresAt) {
      const ix = proj.x + (nx - proj.x) * hit.t;
      const iy = proj.y + (ny - proj.y) * hit.t;
      detonate(world, ix, iy, weaponDef(proj.weapon), owner);
      world.projectiles.delete(proj.id);
      continue;
    }
    proj.x = nx;
    proj.y = ny;
  }
}

/** Radial damage with line-of-sight checking so walls provide real cover. */
export function detonate(
  world: World,
  x: number,
  y: number,
  def: WeaponDef,
  attacker: PlayerEntity | null,
): void {
  const r = def.explosionRadius;
  if (r <= 0) {
    world.emit({ e: 'hit', x, y, onPlayer: false });
    return;
  }
  world.emit({ e: 'explosion', x, y, r });

  for (const p of world.players.values()) {
    if (p.life !== 'alive') continue;
    // Enclosed vehicles shield occupants from the blast; the vehicle takes it.
    if (p.vehicleId !== null) {
      const ride = world.vehicles.get(p.vehicleId);
      if (!ride || vehicleDef(ride.type).shieldsOccupants) continue;
    }
    const d = dist(x, y, p.x, p.y);
    if (d > r) continue;
    if (!world.grid.lineOfSight(x, y, p.x, p.y)) continue;
    applyPlayerDamage(world, p, def.damage * (1 - d / r), attacker, def.id);
  }
  for (const v of world.vehicles.values()) {
    if (v.destroyed) continue;
    const d = dist(x, y, v.x, v.y);
    if (d > r * 1.2) continue;
    const resist = vehicleDef(v.type).explosiveDamageMult * (def.vehicleDamageMult ?? 1);
    applyVehicleDamage(world, v, def.damage * (1 - d / (r * 1.2)) * resist, attacker);
  }
  for (const dep of [...world.deployables.values()]) {
    const d = dist(x, y, dep.x, dep.y);
    if (d > r * 1.2) continue;
    damageDeployable(world, dep, def.damage * (1 - d / (r * 1.2)), attacker);
  }
}

/**
 * Where a shot leaves from: the muzzle in front of a player on foot, or the
 * shooter's seat pushed clear of their own vehicle's bodywork.
 */
export function firingOrigin(
  world: World,
  p: PlayerEntity,
  vehicle: VehicleEntity | null,
): { x: number; y: number } {
  if (!vehicle) return { x: p.x, y: p.y };
  const def = vehicleDef(vehicle.type);
  const seat = seatIndexOf(vehicle.driverId, vehicle.passengers, p.id);
  const local = seatOffset(def, Math.max(0, seat));
  const c = Math.cos(vehicle.rot);
  const sn = Math.sin(vehicle.rot);
  // Seat position in world space, then pushed outward along the aim so the
  // bullet starts outside the car rather than inside its own hitbox.
  const sx = vehicle.x + local.x * c - local.y * sn;
  const sy = vehicle.y + local.x * sn + local.y * c;
  const clear = Math.max(def.width, def.length) * 0.5 + 6;
  return { x: sx + Math.cos(p.aim) * clear, y: sy + Math.sin(p.aim) * clear };
}

// ---------------------------------------------------------------------------
// Damage and death
// ---------------------------------------------------------------------------

export function applyPlayerDamage(
  world: World,
  target: PlayerEntity,
  rawAmount: number,
  attacker: PlayerEntity | null,
  weapon: WeaponId,
): void {
  if (target.life !== 'alive') return;
  if (world.isProtected(target)) return;
  if (!world.canDamage(attacker, target)) return;

  let amount = Math.max(0, rawAmount);
  if (amount <= 0) return;

  // Armor soaks a fraction of each hit until it runs out.
  if (target.armor > 0) {
    const absorbed = Math.min(target.armor, amount * GAMEPLAY.player.armorAbsorb);
    target.armor -= absorbed;
    amount -= absorbed;
  }

  target.hp -= amount;
  const lethal = target.hp <= 0;

  if (attacker && attacker.id !== target.id) {
    // Private confirmation to the shooter: this is what drives the hit marker
    // and the floating damage number, and it is the only way the client can
    // know a shot connected without being told everyone else's health.
    world.emit({
      e: 'hitmark', by: attacker.id, x: target.x, y: target.y,
      amount, lethal,
    });
    const rec = target.damageTakenFrom.get(attacker.id) ?? { amount: 0, at: 0 };
    rec.amount += amount;
    rec.at = world.now;
    target.damageTakenFrom.set(attacker.id, rec);
    attacker.stats.damageDealt += amount;
    world.emit({ e: 'damage', to: target.id, amount, fromX: attacker.x, fromY: attacker.y });
  } else {
    world.emit({ e: 'damage', to: target.id, amount, fromX: target.x, fromY: target.y });
  }

  if (target.hp <= 0) killPlayer(world, target, attacker, weapon);
}

export function applyVehicleDamage(
  world: World,
  v: VehicleEntity,
  amount: number,
  attacker: PlayerEntity | null,
): void {
  if (v.destroyed) return;
  v.hp -= amount;
  // Remember who last hurt it - unless it was one of its own occupants, such
  // as the driver hitting a wall, which must not overwrite an enemy's credit.
  if (attacker && attacker.vehicleId !== v.id) {
    v.lastDamagedBy = attacker.id;
    v.lastDamagedAt = world.now;
  }
  if (v.hp <= 0) destroyVehicle(world, v, attacker);
}

/** Seconds an enemy keeps the credit for damaging a vehicle that later wrecks. */
const WRECK_CREDIT_MS = 8000;

/**
 * Who gets the kill when a vehicle's destruction kills someone: the attacker
 * who finished it, if they were not aboard; otherwise the enemy who last
 * damaged it recently; and only failing both, the crew's own crash.
 */
function wreckCredit(
  world: World,
  v: VehicleEntity,
  attacker: PlayerEntity | null,
): PlayerEntity | null {
  if (attacker && attacker.vehicleId !== v.id) return attacker;
  if (v.lastDamagedBy && world.now - v.lastDamagedAt < WRECK_CREDIT_MS) {
    return world.players.get(v.lastDamagedBy) ?? attacker;
  }
  return attacker;
}

export function destroyVehicle(
  world: World,
  v: VehicleEntity,
  attacker: PlayerEntity | null,
): void {
  if (v.destroyed) return;
  v.hp = 0;
  v.destroyed = true;
  v.vx = 0;
  v.vy = 0;
  v.despawnAt = world.now + GAMEPLAY.vehicle.wreckSec * 1000;

  const def = vehicleDef(v.type);
  const credit = wreckCredit(world, v, attacker);
  // Riders are thrown clear; less violently from something that does not explode.
  ejectOccupants(world, v, true, undefined, credit, def.wreckBlast > 0 ? 25 : 15);

  if (def.wreckBlast > 0) {
    // Bigger vehicles make bigger fireballs; the blast can finish off whoever
    // was just thrown clear.
    const g = weaponDef('grenade');
    detonate(world, v.x, v.y, {
      ...g,
      damage: g.damage * def.wreckBlast,
      explosionRadius: g.explosionRadius * Math.sqrt(def.wreckBlast),
    }, credit);
  } else {
    // A motorcycle breaks apart rather than exploding.
    world.emit({ e: 'vehicleHit', x: v.x, y: v.y, force: 420 });
  }
}

export function killPlayer(
  world: World,
  victim: PlayerEntity,
  killer: PlayerEntity | null,
  weapon: WeaponId,
): void {
  if (victim.life !== 'alive') return;

  victim.hp = 0;
  victim.life = 'dead';
  // The body lingers before the player switches to the respawn queue, so a
  // kill reads as a kill instead of the target blinking out of existence.
  victim.corpseUntil = world.now + GAMEPLAY.combat.corpseSec * 1000;
  victim.corpseAim = victim.aim;
  victim.stats.deaths++;
  victim.stats.streak = 0;
  victim.vx = 0;
  victim.vy = 0;

  // A rider killed aboard falls where they were rather than being moved to the
  // kerb as if they had stepped out.
  if (victim.vehicleId !== null) detachFromVehicle(world, victim);

  // Drop the primary weapon so a kill leaves something worth taking.
  const primary = victim.slots.find(
    (s) => s && s.id !== 'fists' && (s.ammo > 0 || s.reserve > 0),
  );
  if (primary) dropWeaponAt(world, victim.x, victim.y, primary);
  // Carried medkits spill on death, so a kill can restock whoever made it.
  if (victim.medkits > 0) dropConsumableAt(world, victim.x, victim.y, 'health');
  victim.medkits = 0;
  victim.armorPlates = 0;

  const isSuicide = !killer || killer.id === victim.id;
  if (!isSuicide && killer) {
    killer.stats.kills++;
    killer.stats.streak++;
    killer.stats.bestStreak = Math.max(killer.stats.bestStreak, killer.stats.streak);
    killer.stats.score += GAMEPLAY.combat.killScore;
  } else {
    // Self-inflicted deaths cost a point rather than rewarding anyone.
    victim.stats.score = Math.max(0, victim.stats.score - GAMEPLAY.combat.killScore / 2);
  }

  // Assists: recent, meaningful damage from anyone who was not the killer.
  const cutoff = world.now - GAMEPLAY.combat.assistWindowSec * 1000;
  for (const [attackerId, rec] of victim.damageTakenFrom) {
    if (attackerId === killer?.id || attackerId === victim.id) continue;
    if (rec.at < cutoff || rec.amount < GAMEPLAY.combat.assistMinDamage) continue;
    const assister = world.players.get(attackerId);
    if (!assister || !world.canDamage(assister, victim)) continue;
    assister.stats.assists++;
    assister.stats.score += GAMEPLAY.combat.assistScore;
  }
  victim.damageTakenFrom.clear();

  world.emit({
    e: 'kill',
    killer: isSuicide ? victim.name : killer!.name,
    victim: victim.name,
    weapon,
    killerTeam: isSuicide ? victim.team : killer!.team,
    victimTeam: victim.team,
  });

  // The mode decides the respawn policy: a delay, or null to stay eliminated
  // (which is how last-man-standing modes will work).
  const delay = world.onKill
    ? world.onKill(victim, isSuicide ? null : killer)
    : world.config.respawnDelaySec * 1000;
  if (delay === null) {
    victim.life = 'spectating';
    return;
  }
  // Schedule the respawn, but leave the body on the ground until its timer
  // expires (`World.stepPlayer` flips it to 'respawning').
  victim.respawnAt = world.now + delay;
}

// ---------------------------------------------------------------------------
// Reloading
// ---------------------------------------------------------------------------

export function startReload(world: World, p: PlayerEntity): void {
  const w = p.slots[p.slot];
  if (!w) return;
  const def = weaponDef(w.id);
  if (!Number.isFinite(def.magazine)) return;
  if (w.ammo >= def.magazine || w.reserve <= 0) return;
  if (p.reloadingSlot === p.slot && world.now < p.reloadEndsAt) return;

  p.reloadingSlot = p.slot;
  p.reloadEndsAt = world.now + def.reloadMs;
  world.emit({ e: 'reload', x: p.x, y: p.y });
}

export function tryFinishReload(world: World, p: PlayerEntity): void {
  if (p.reloadingSlot < 0 || world.now < p.reloadEndsAt) return;
  const w = p.slots[p.reloadingSlot];
  p.reloadingSlot = -1;
  p.reloadEndsAt = 0;
  if (!w) return;
  const def = weaponDef(w.id);
  const need = def.magazine - w.ammo;
  const take = Math.min(need, w.reserve);
  w.ammo += take;
  w.reserve -= take;
  // A weapon with nothing left is dropped so the player falls back to melee.
  if (w.ammo <= 0 && w.reserve <= 0 && w.id !== 'fists') {
    p.slots[p.slots.indexOf(w)] = null;
    p.slot = bestSlot(p.slots);
  }
}
