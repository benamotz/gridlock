import {
  type DeployableKind,
  type Rect,
  GAMEPLAY,
  angleDelta,
  deployPlacementPoint,
  deployZoneFor,
  deployableDef,
  deployableSolids,
  dist,
  dist2,
  pointInRect,
  quantizeDeployRot,
  shotIntervalMs,
  vehicleBodyWorld,
  weaponDef,
} from '@gridlock/shared';
import type { DeployableEntity, PlayerEntity } from './entities.js';
import type { World } from './World.js';
import { applyPlayerDamage, detonate, traceShot } from './combat.js';

export type DeployRefusal =
  | 'dead'
  | 'in-vehicle'
  | 'out-of-base'
  | 'blocked'
  | 'team-limit'
  | 'cooldown';

export interface DeployResult {
  ok: boolean;
  reason?: DeployRefusal;
  entity?: DeployableEntity;
}

/** The area a team may fortify: their spawn zone, grown by the deploy radius. */
export function deployZone(world: World, team: number): Rect {
  return deployZoneFor(world.mapDef, team);
}

export function teamDeployCount(world: World, team: number, kind: DeployableKind): number {
  let n = 0;
  for (const d of world.deployables.values()) {
    if (d.team === team && d.kind === kind) n++;
  }
  return n;
}

const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Squared distance from a point to the nearest point of a rect. */
const pointRectDist2 = (x: number, y: number, r: Rect): number => {
  const cx = Math.max(r.x, Math.min(x, r.x + r.w));
  const cy = Math.max(r.y, Math.min(y, r.y + r.h));
  return dist2(x, y, cx, cy);
};


/**
 * True when a footprint is clear of geometry, other defences, players and
 * vehicles. Shared by placement and by the tests, so both agree on "blocked".
 */
export function placementClear(world: World, footprint: Rect[]): boolean {
  const margin = 6;
  for (const r of footprint) {
    const probe: Rect = { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 };
    for (const solid of world.grid.query(probe)) {
      if (rectsIntersect(solid.rect, probe)) return false;
    }
    for (const p of world.players.values()) {
      if (p.life !== 'alive' || p.vehicleId !== null) continue;
      const reach = GAMEPLAY.player.radius + margin;
      if (pointRectDist2(p.x, p.y, r) < reach * reach) return false;
    }
    for (const v of world.vehicles.values()) {
      if (v.destroyed) continue;
      for (const c of vehicleBodyWorld(v)) {
        const reach = c.r + margin;
        if (pointRectDist2(c.x, c.y, r) < reach * reach) return false;
      }
    }
    // Mines have no collision, so check defences by footprint rather than grid.
    for (const d of world.deployables.values()) {
      const def = deployableDef(d.kind);
      const reach = Math.max(def.length, def.width) / 2;
      if (pointRectDist2(d.x, d.y, r) < reach * reach) return false;
    }
  }
  return true;
}

/**
 * Places a defence in front of the player.
 *
 * Every condition is checked here on the server: the player must be alive and
 * on foot, inside their own base area, the team must be under its limit, the
 * player off cooldown, and the ground clear. The requested rotation is the
 * only thing taken from the client, and it is snapped to 15 degree steps.
 */
export function tryDeploy(
  world: World,
  player: PlayerEntity,
  kind: DeployableKind,
  requestedRot = 0,
  /** Aim at the moment of the request; falls back to the last input's aim. */
  requestedAim?: number,
): DeployResult {
  const def = deployableDef(kind);

  if (player.life !== 'alive') return { ok: false, reason: 'dead' };
  if (player.vehicleId !== null) return { ok: false, reason: 'in-vehicle' };

  const cooldownUntil = player.deployCooldowns[kind] ?? 0;
  if (world.now < cooldownUntil) return { ok: false, reason: 'cooldown' };

  if (teamDeployCount(world, player.team, kind) >= def.teamLimit) {
    return { ok: false, reason: 'team-limit' };
  }

  const zone = deployZone(world, player.team);
  if (!pointInRect(player.x, player.y, zone)) return { ok: false, reason: 'out-of-base' };

  const rot = def.rotatable ? quantizeDeployRot(requestedRot) : 0;
  const aim = requestedAim !== undefined && Number.isFinite(requestedAim)
    ? requestedAim
    : player.aim;
  const at = deployPlacementPoint(kind, player.x, player.y, aim, rot);
  if (!pointInRect(at.x, at.y, zone)) return { ok: false, reason: 'out-of-base' };

  const solids = deployableSolids(kind, at.x, at.y, rot);
  const footprint = solids.length > 0
    ? solids.map((sd) => sd.rect)
    : [{ x: at.x - def.length / 2, y: at.y - def.width / 2, w: def.length, h: def.width }];
  if (!placementClear(world, footprint)) return { ok: false, reason: 'blocked' };

  const entity: DeployableEntity = {
    id: world.allocId(),
    kind,
    team: player.team,
    ownerId: player.id,
    x: at.x,
    y: at.y,
    rot,
    aim: rot,
    hp: def.hp,
    maxHp: def.hp,
    activeAt: world.now + (def.armingSec ?? 0) * 1000,
    expiresAt: GAMEPLAY.defences.lifetimeSec > 0
      ? world.now + GAMEPLAY.defences.lifetimeSec * 1000
      : 0,
    nextFireAt: 0,
    targetId: null,
    solids,
  };

  world.deployables.set(entity.id, entity);
  for (const sd of solids) world.grid.addSolid(sd);
  player.deployCooldowns[kind] = world.now + def.cooldownSec * 1000;

  world.emit({ e: 'deploy', x: at.x, y: at.y, kind, team: player.team });
  return { ok: true, entity };
}

export function damageDeployable(
  world: World,
  d: DeployableEntity,
  amount: number,
  attacker: PlayerEntity | null,
): void {
  // Friendly fire never damages your own team's defences.
  if (attacker && attacker.team === d.team && !world.config.friendlyFire) return;
  d.hp -= amount;
  if (d.hp <= 0) destroyDeployable(world, d);
}

export function destroyDeployable(world: World, d: DeployableEntity): void {
  if (!world.deployables.has(d.id)) return;
  for (const sd of d.solids) world.grid.removeSolid(sd);
  world.deployables.delete(d.id);
  world.emit({ e: 'deployDown', x: d.x, y: d.y, kind: d.kind, team: d.team });
}

/** Per-tick upkeep: expiry, turrets, and mine triggers. */
export function stepDeployables(world: World): void {
  for (const d of [...world.deployables.values()]) {
    if (d.expiresAt > 0 && world.now >= d.expiresAt) {
      destroyDeployable(world, d);
      continue;
    }
    if (world.now < d.activeAt) continue;
    if (d.kind === 'turret') stepTurret(world, d);
    else if (d.kind === 'mine') stepMine(world, d);
  }
}

// ---------------------------------------------------------------------------
// Mines
// ---------------------------------------------------------------------------

/**
 * A mine goes off when an enemy on foot steps close, or when an enemy-crewed
 * vehicle drives over it. Players mid-jump pass safely over the top - the
 * counter a sharp-eyed player has once the mine is revealed.
 */
function stepMine(world: World, d: DeployableEntity): void {
  const trigger = deployableDef('mine').triggerRadius ?? 30;

  for (const p of world.players.values()) {
    if (p.life !== 'alive' || p.vehicleId !== null) continue;
    if (p.team === d.team || p.air > 0) continue;
    const reach = trigger + GAMEPLAY.player.radius;
    if (dist2(p.x, p.y, d.x, d.y) <= reach * reach) {
      explodeMine(world, d);
      return;
    }
  }

  for (const v of world.vehicles.values()) {
    if (v.destroyed) continue;
    const crew = [v.driverId, ...v.passengers]
      .map((id) => (id ? world.players.get(id) : undefined))
      .filter((p): p is PlayerEntity => !!p);
    // Parked cars and friendly vehicles roll over it harmlessly.
    if (!crew.some((p) => p.team !== d.team)) continue;
    if (vehicleBodyWorld(v).some((c) => dist2(c.x, c.y, d.x, d.y) <= (trigger + c.r) ** 2)) {
      explodeMine(world, d);
      return;
    }
  }
}

function explodeMine(world: World, d: DeployableEntity): void {
  const owner = world.players.get(d.ownerId) ?? null;
  // Remove first, so the blast cannot re-enter this mine.
  destroyDeployable(world, d);
  detonate(world, d.x, d.y, weaponDef('mine'), owner);
}

// ---------------------------------------------------------------------------
// Turrets
// ---------------------------------------------------------------------------

function stepTurret(world: World, d: DeployableEntity): void {
  const def = deployableDef('turret');
  const range = def.range ?? 600;

  // Re-acquire when the current target dies, leaves range or breaks LOS.
  let target = d.targetId ? world.players.get(d.targetId) ?? null : null;
  if (
    !target ||
    target.life !== 'alive' ||
    target.vehicleId !== null ||
    dist(d.x, d.y, target.x, target.y) > range ||
    !canSee(world, d, target.x, target.y)
  ) {
    target = acquireTarget(world, d, range);
    d.targetId = target?.id ?? null;
  }
  if (!target) return;

  // Traverse toward the target at a finite rate, so a turret can be flanked.
  const desired = Math.atan2(target.y - d.y, target.x - d.x);
  const delta = angleDelta(d.aim, desired);
  const maxTurn = (def.turnRate ?? 2.5) * world.dt;
  d.aim += Math.max(-maxTurn, Math.min(maxTurn, delta));
  if (Math.abs(delta) > 0.12) return;

  if (world.now < d.nextFireAt) return;
  d.nextFireAt = world.now + shotIntervalMs('sentry');
  fireTurret(world, d);
}

/**
 * A turret is itself a solid in the collision grid, so a line of sight cast
 * from its centre hits its own body first. Sighting and firing both start from
 * just outside the housing, in the direction being looked at.
 */
function sightOrigin(d: DeployableEntity, tx: number, ty: number): { x: number; y: number } {
  const reach = deployableDef(d.kind).length / 2 + 4;
  const a = Math.atan2(ty - d.y, tx - d.x);
  return { x: d.x + Math.cos(a) * reach, y: d.y + Math.sin(a) * reach };
}

/** Line of sight from a deployable, excluding its own body. */
function canSee(world: World, d: DeployableEntity, tx: number, ty: number): boolean {
  const o = sightOrigin(d, tx, ty);
  return world.grid.lineOfSight(o.x, o.y, tx, ty);
}

function acquireTarget(
  world: World,
  d: DeployableEntity,
  range: number,
): PlayerEntity | null {
  let best: PlayerEntity | null = null;
  let bestD = range;
  for (const p of world.players.values()) {
    if (p.life !== 'alive' || p.vehicleId !== null) continue;
    if (p.team === d.team) continue;
    if (world.isProtected(p)) continue;
    const distance = dist(d.x, d.y, p.x, p.y);
    if (distance > bestD) continue;
    if (!canSee(world, d, p.x, p.y)) continue;
    best = p;
    bestD = distance;
  }
  return best;
}

function fireTurret(world: World, d: DeployableEntity): void {
  const wdef = weaponDef('sentry');
  const spread = (world.rng() * 2 - 1) * wdef.spread;
  const angle = d.aim + spread;
  const muzzle = deployableDef('turret').length / 2 + 4;
  const ox = d.x + Math.cos(angle) * muzzle;
  const oy = d.y + Math.sin(angle) * muzzle;
  const x1 = d.x + Math.cos(angle) * wdef.range;
  const y1 = d.y + Math.sin(angle) * wdef.range;

  const hit = traceShot(world, ox, oy, x1, y1, d.ownerId, null, d.id);
  const hx = ox + (x1 - ox) * hit.t;
  const hy = oy + (y1 - oy) * hit.t;

  world.emit({
    e: 'shot', by: `turret-${d.id}`, x: ox, y: oy, a: angle,
    w: 'sentry', len: wdef.range * hit.t,
  });

  if (hit.player) {
    // Kills are credited to whoever placed the turret.
    const owner = world.players.get(d.ownerId) ?? null;
    applyPlayerDamage(world, hit.player, wdef.damage, owner, 'sentry');
    world.emit({ e: 'hit', x: hx, y: hy, onPlayer: true });
  } else if (hit.t < 1) {
    world.emit({ e: 'hit', x: hx, y: hy, onPlayer: false });
  }
}
