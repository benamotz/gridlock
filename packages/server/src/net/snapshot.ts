import {
  GAMEPLAY,
  type DeployStatusWire,
  type DeployableKind,
  type DeployableWire,
  type GameEvent,
  type MatchPhase,
  type PickupWire,
  type PlayerWire,
  type ProjectileWire,
  type SelfState,
  type SnapshotMsg,
  type VehicleWire,
  deployableDef,
  dist2,
  pointInRect,
  seatIndexOf,
} from '@gridlock/shared';
import type { PlayerEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';
import { deployZone, teamDeployCount } from '../sim/deployables.js';

const round = (v: number): number => Math.round(v * 100) / 100;

/**
 * Builds one player's view of the world.
 *
 * Interest management: entities beyond `interestRadius` are omitted entirely.
 * That keeps bandwidth flat as maps grow, and has the useful side effect that a
 * modified client cannot read positions the server never sent it.
 */
export function buildSnapshot(
  world: World,
  viewer: PlayerEntity,
  phase: MatchPhase,
  teamScores: number[],
  timeLeftMs: number,
  events: GameEvent[],
): SnapshotMsg {
  const R = GAMEPLAY.net.interestRadius;
  const R2 = R * R;
  const near = (x: number, y: number): boolean =>
    dist2(viewer.x, viewer.y, x, y) <= R2;

  const players: PlayerWire[] = [];
  for (const p of world.players.values()) {
    if (p.id === viewer.id) continue;
    const teammate = p.team === viewer.team && viewer.team >= 0;
    if (!teammate && !near(p.x, p.y)) continue;
    // Bodies are still sent; only players waiting to respawn are omitted.
    if (p.life === 'respawning' || p.life === 'spectating') continue;
    players.push({
      id: p.id,
      name: p.name,
      x: round(p.x),
      y: round(p.y),
      aim: round(p.life === 'dead' ? p.corpseAim : p.aim),
      team: p.team,
      life: p.life,
      weapon: world.currentWeaponId(p),
      // Exact health is teammate-only information.
      hp: teammate ? Math.round(p.hp) : -1,
      vehicleId: p.vehicleId,
      sprinting: p.sprinting,
      protected: world.isProtected(p),
      carryingFlag: -1,
      air: round(p.air),
    });
  }

  const vehicles: VehicleWire[] = [];
  for (const v of world.vehicles.values()) {
    if (!near(v.x, v.y)) continue;
    vehicles.push({
      id: v.id,
      x: round(v.x), y: round(v.y), rot: round(v.rot),
      vx: round(v.vx), vy: round(v.vy),
      type: v.type,
      hp: Math.round(v.hp), maxHp: v.maxHp,
      driver: v.driverId,
      passengers: [...v.passengers],
      seats: v.passengers.length + (v.driverId ? 1 : 0),
      destroyed: v.destroyed,
    });
  }

  const deployables: DeployableWire[] = [];
  for (const d of world.deployables.values()) {
    if (!near(d.x, d.y)) continue;
    // Hidden defences (mines) only show to an enemy who is close enough to
    // spot them. The server never sends the position otherwise, so a modified
    // client cannot map a minefield from across the base.
    const reveal = deployableDef(d.kind).revealRadius;
    if (
      reveal !== undefined && d.team !== viewer.team &&
      dist2(viewer.x, viewer.y, d.x, d.y) > reveal * reveal
    ) continue;
    deployables.push({
      id: d.id,
      kind: d.kind,
      team: d.team,
      x: round(d.x), y: round(d.y), rot: round(d.rot),
      hp: Math.round(d.hp), maxHp: d.maxHp,
      aim: round(d.aim),
      active: world.now >= d.activeAt,
    });
  }

  const projectiles: ProjectileWire[] = [];
  for (const pr of world.projectiles.values()) {
    if (!near(pr.x, pr.y)) continue;
    projectiles.push({
      id: pr.id,
      x: round(pr.x), y: round(pr.y),
      rot: round(Math.atan2(pr.vy, pr.vx)),
      weapon: pr.weapon,
    });
  }

  const pickups: PickupWire[] = [];
  for (const pk of world.pickups.values()) {
    if (!pk.active || !near(pk.x, pk.y)) continue;
    pickups.push({
      id: pk.id,
      x: round(pk.x), y: round(pk.y),
      kind: pk.kind,
      weapon: pk.weapon,
      ammo: pk.ammo,
    });
  }

  // Kill and flag events are global (they drive the kill feed); positional
  // events are filtered to what this player could plausibly perceive.
  const visibleEvents = events.filter((e) => {
    switch (e.e) {
      case 'kill':
      case 'flag':
        return true;
      case 'damage':
        // The directional damage indicator is private to whoever was hit.
        return e.to === viewer.id;
      case 'hitmark':
        // The hit marker belongs to the shooter alone.
        return e.by === viewer.id;
      case 'deploy':
        // Placing a mine would give its position away to anyone watching.
        return near(e.x, e.y) && (e.kind !== 'mine' || e.team === viewer.team);
      case 'shot':
      case 'hit':
      case 'explosion':
      case 'pickup':
      case 'reload':
      case 'vehicleHit':
      case 'deployDown':
      case 'useItem':
      case 'jump':
        return near(e.x, e.y);
      default:
        return false;
    }
  });

  const self: SelfState = {
    x: round(viewer.x), y: round(viewer.y),
    vx: round(viewer.vx), vy: round(viewer.vy),
    hp: Math.round(viewer.hp),
    armor: Math.round(viewer.armor),
    stamina: Math.round(viewer.stamina),
    life: viewer.life,
    ack: viewer.lastProcessedSeq,
    slot: viewer.slot,
    weapons: viewer.slots.map((w) =>
      w
        ? { id: w.id, ammo: Number.isFinite(w.ammo) ? w.ammo : -1, reserve: w.reserve }
        : { id: 'fists' as const, ammo: -1, reserve: 0 },
    ),
    reloadEndsAt: viewer.reloadEndsAt,
    spawnProtectedUntil: viewer.spawnProtectedUntil,
    respawnAt: viewer.respawnAt,
    vehicleId: viewer.vehicleId,
    spread: round(world.effectiveSpread(viewer)),
    team: viewer.team,
    seat: seatFor(world, viewer),
    deployables: deployStatus(world, viewer),
    air: round(viewer.air),
    jumpCd: round(viewer.jumpCd),
    medkits: viewer.medkits,
    armorPlates: viewer.armorPlates,
    pouchCooldownMs: Math.max(0, Math.round(viewer.pouchReadyAt - world.now)),
  };

  return {
    t: 'snap',
    tick: world.tick,
    serverTime: world.now,
    self,
    players,
    vehicles,
    deployables,
    projectiles,
    pickups,
    events: visibleEvents,
    teamScores,
    timeLeftMs,
    phase,
    prompt: viewer.prompt,
  };
}

/** -1 on foot, 0 driving, 1+ riding. */
function seatFor(world: World, p: PlayerEntity): number {
  if (p.vehicleId === null) return -1;
  const v = world.vehicles.get(p.vehicleId);
  if (!v) return -1;
  return seatIndexOf(v.driverId, v.passengers, p.id);
}

/**
 * What the deploy panel shows: remaining team budget, personal cooldown, and
 * whether this player is currently in a position to place anything.
 */
function deployStatus(world: World, p: PlayerEntity): DeployStatusWire[] {
  const kinds: DeployableKind[] = ['barricade', 'turret', 'mine'];
  const inZone =
    p.team >= 0 && pointInRect(p.x, p.y, deployZone(world, p.team));
  const eligible = p.life === 'alive' && p.vehicleId === null && inZone;

  return kinds.map((kind) => {
    const def = deployableDef(kind);
    const used = teamDeployCount(world, p.team, kind);
    const cooldownMs = Math.max(0, (p.deployCooldowns[kind] ?? 0) - world.now);
    return {
      kind,
      remaining: Math.max(0, def.teamLimit - used),
      cooldownMs: Math.round(cooldownMs),
      canDeploy: eligible && cooldownMs === 0 && used < def.teamLimit,
    };
  });
}
