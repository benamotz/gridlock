import { type CrimeKind, GAMEPLAY, townAt } from '@gridlock/shared';
import type { PlayerEntity } from './entities.js';
import type { World } from './World.js';

/**
 * Free-roam law: crimes raise a per-player wanted level that cools off once the
 * offender lies low. Each player's level is theirs alone, so the police (next
 * milestone) can chase the offender without involving anyone else.
 *
 * Attacking someone who is already wanted is not a crime. That keeps
 * bystanders free to fight back, and makes a high wanted level a risk from
 * other players as well as from the police.
 */

const W = GAMEPLAY.wanted;
const POLICE = GAMEPLAY.police;

export function wantedStars(heat: number): number {
  let stars = 0;
  while (stars < W.maxStars && heat >= W.starHeat[stars]) stars++;
  return stars;
}

export function isWanted(p: PlayerEntity): boolean {
  return wantedStars(p.heat) > 0;
}

/** `heatTown` for a crime committed out in the country, between towns. */
export const COUNTRYSIDE = -2;

/**
 * Who handles a crime here: the town it happened in, or the country patrol
 * for one committed between towns. -1 on a map without towns.
 */
export function jurisdictionAt(world: World, x: number, y: number): number {
  const towns = world.mapDef.towns;
  if (!towns || towns.length === 0) return -1;
  const inside = townAt(world.mapDef, x, y);
  return inside >= 0 ? inside : COUNTRYSIDE;
}

/**
 * Wanted, and somewhere the police who want them do not patrol: another
 * town, or open country after a crime in town, or any town after a crime in
 * the country.
 */
export function outOfJurisdiction(world: World, p: PlayerEntity): boolean {
  if (p.heat <= 0 || p.heatTown === -1) return false;
  const here = jurisdictionAt(world, p.x, p.y);
  return here !== p.heatTown;
}

/** True once the offender has gone `coolDelaySec` without a new crime. */
export function isCooling(world: World, p: PlayerEntity): boolean {
  const quietSince = Math.max(p.lastCrimeAt, p.lastSeenAt);
  const rate = outOfJurisdiction(world, p) ? W.outsideCoolRate : 1;
  return p.heat > 0 && world.now - quietSince >= (W.coolDelaySec * 1000) / rate;
}

/**
 * A police officer has eyes on the suspect: the wanted level cannot start
 * cooling until they have been out of sight for the full delay.
 */
export function markSeen(world: World, p: PlayerEntity): void {
  if (p.heat <= 0) return;
  p.lastSeenAt = world.now;
  p.nextCoolAt = Math.max(p.nextCoolAt, world.now + W.coolDelaySec * 1000);
  p.lkpX = p.x;
  p.lkpY = p.y;
  p.knownVehicleId = p.vehicleId ?? -1;
  // Seen means reported: units may come straight away.
  p.reportAt = Math.min(p.reportAt, world.now);
}

/**
 * Puts a player straight onto a wanted level, as if seen in the act: used by
 * jobs that start with the police already looking (the decoy run).
 */
export function setWanted(world: World, p: PlayerEntity, stars: number): void {
  if (!world.lawEnabled) return;
  const target = W.starHeat[Math.max(0, Math.min(W.maxStars, stars) - 1)];
  p.heat = Math.max(p.heat, target);
  p.heatTown = jurisdictionAt(world, p.x, p.y);
  p.lastCrimeAt = world.now;
  p.nextCoolAt = world.now + W.coolDelaySec * 1000;
  p.lkpX = p.x;
  p.lkpY = p.y;
  p.reportAt = world.now;
  p.lastSeenAt = world.now;
}

/** How far officers can see a suspect with this many stars. */
export function sightRange(stars: number): number {
  return POLICE.sightByStars[Math.max(0, Math.min(W.maxStars, stars))];
}

/** True when the police have had eyes on this suspect within the radio window. */
export function recentlySeen(world: World, p: PlayerEntity): boolean {
  return p.heat > 0 && world.now - p.lastSeenAt <= POLICE.radioSec * 1000;
}

/** Any officer who can see `p` right now, within the sight range for their level. */
export function officerCanSee(world: World, p: PlayerEntity, stars = wantedStars(p.heat)): boolean {
  const range = sightRange(Math.max(1, stars));
  for (const cop of world.players.values()) {
    if (cop.npc !== 'cop' || cop.life !== 'alive') continue;
    if (Math.hypot(cop.x - p.x, cop.y - p.y) > range) continue;
    if (world.grid.lineOfSight(cop.x, cop.y, p.x, p.y)) return true;
  }
  return false;
}

/**
 * A suspect who changes vehicle while nobody is watching loses a star: the
 * police are looking for the wrong car. Limited so swapping cars on a loop
 * cannot wipe a level out.
 */
export function onVehicleSwap(world: World, p: PlayerEntity, vehicleId: number): void {
  if (!world.lawEnabled || p.heat <= 0 || vehicleId === p.knownVehicleId) return;
  // Quiet means no sighting and no fresh crime, which rules out a carjack
  // paying for itself.
  const quietSince = Math.max(p.lastSeenAt, p.lastCrimeAt);
  if (world.now - quietSince < W.carSwapUnseenSec * 1000) return;
  if (world.now - p.lastSwapAt < W.carSwapCooldownSec * 1000) return;
  p.lastSwapAt = world.now;
  p.knownVehicleId = vehicleId;
  dropStar(world, p);
}

function dropStar(world: World, p: PlayerEntity): void {
  const stars = wantedStars(p.heat);
  p.heat = stars <= 1 ? 0 : W.starHeat[stars - 2];
  p.nextCoolAt = world.now + W.coolStepSec * 1000;
  if (p.heat === 0) clearWanted(p);
}

export function clearWanted(p: PlayerEntity): void {
  p.heat = 0;
  p.heatTown = -1;
  p.reportAt = 0;
  p.knownVehicleId = -1;
  p.nextCoolAt = 0;
  p.assaultedAt.clear();
}

export function reportCrime(
  world: World,
  offender: PlayerEntity,
  kind: CrimeKind,
  victim: PlayerEntity | null = null,
): void {
  if (!world.lawEnabled || offender.npc) return;
  // A crew that came looking for a fight is not a victim of assault. Killing
  // one still makes noise, so it counts as an assault (and draws the police
  // over a long fight), but never as murder.
  if (victim?.npc === 'thug') {
    if (kind !== 'murder') return;
    kind = 'assault';
    victim = null;
  }
  if (victim) {
    if (victim.id === offender.id || isWanted(victim)) return;
    if (kind === 'assault') {
      const last = offender.assaultedAt.get(victim.id);
      if (last !== undefined && world.now - last < W.assaultRepeatSec * 1000) return;
      offender.assaultedAt.set(victim.id, world.now);
    }
  }
  const wasWanted = offender.heat > 0;
  offender.heat = Math.min(W.maxHeat, offender.heat + W.crimeHeat[kind]);
  // The latest crime decides which town's police are looking.
  offender.heatTown = jurisdictionAt(world, offender.x, offender.y);
  offender.lastCrimeAt = world.now;
  offender.nextCoolAt = world.now + W.coolDelaySec * 1000;
  const stars = wantedStars(offender.heat);
  // The police start from the scene. An officer who saw it brings them at once;
  // otherwise it takes a witness's phone call.
  offender.lkpX = offender.x;
  offender.lkpY = offender.y;
  if (officerCanSee(world, offender, stars)) markSeen(world, offender);
  else if (!wasWanted) offender.reportAt = world.now + POLICE.responseDelaySec * 1000;
  world.emit({ e: 'crime', by: offender.id, kind, stars });
}

/** Drops a star at a time from anyone who has stayed out of trouble. */
export function stepWanted(world: World): void {
  const tickMs = world.dt * 1000;
  for (const p of world.players.values()) {
    if (p.heat <= 0) continue;
    // Out of jurisdiction the countdown simply runs faster; a sighting still
    // pushes it back, because `markSeen` resets it from the current time.
    if (outOfJurisdiction(world, p)) p.nextCoolAt -= tickMs * (W.outsideCoolRate - 1);
    if (world.now < p.nextCoolAt) continue;
    dropStar(world, p);
  }
}
