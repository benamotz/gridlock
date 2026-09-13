import {
  GAMEPLAY,
  type PickupSpawnDef,
  type WeaponId,
  type WeaponState,
  type WeaponTier,
  dist2,
  pickupWeapons,
  weaponDef,
  weaponsOfTier,
} from '@gridlock/shared';
import type { PickupEntity, PlayerEntity } from './entities.js';
import type { World } from './World.js';
import { bestSlot, freshWeapon, slotForWeapon } from './loadout.js';

/** Weighted random weapon, optionally restricted to a tier. */
function rollWeapon(world: World, tier?: WeaponTier): WeaponId {
  const pool = tier !== undefined
    ? weaponsOfTier(tier).filter((w) => w.rarity > 0)
    : pickupWeapons();
  const candidates = pool.length > 0 ? pool : pickupWeapons();
  const total = candidates.reduce((s, w) => s + w.rarity, 0);
  let r = world.rng() * total;
  for (const w of candidates) {
    r -= w.rarity;
    if (r <= 0) return w.id;
  }
  return candidates[candidates.length - 1].id;
}

function instantiate(world: World, def: PickupSpawnDef): PickupEntity {
  const weapon = def.kind === 'weapon' ? (def.weapon ?? rollWeapon(world, def.tier)) : undefined;
  const wdef = weapon ? weaponDef(weapon) : null;
  return {
    id: def.id,
    spawnId: def.id,
    kind: def.kind,
    x: def.x,
    y: def.y,
    weapon,
    ammo: wdef && Number.isFinite(wdef.magazine) ? wdef.magazine : 0,
    reserve: wdef ? Math.floor(wdef.reserveMax * 0.4) : 0,
    active: true,
    respawnAt: 0,
    expiresAt: 0,
    availableAt: 0,
    claimedBy: null,
  };
}

export function initPickups(world: World): void {
  for (const def of world.mapDef.pickupSpawns) {
    const p = instantiate(world, def);
    world.pickups.set(p.id, p);
  }
}

/** Drops a weapon into the world, keeping whatever ammunition it had. */
export function dropWeaponAt(
  world: World,
  x: number,
  y: number,
  weapon: WeaponState,
  /** Direction to toss the weapon, so it does not land under the dropper. */
  angle = world.rng() * Math.PI * 2,
): PickupEntity {
  const retain = GAMEPLAY.pickups.dropRetainFraction;
  const toss = GAMEPLAY.pickups.dropDistance;
  x += Math.cos(angle) * toss;
  y += Math.sin(angle) * toss;
  const drop: PickupEntity = {
    id: `d${world.allocId()}`,
    spawnId: null,
    kind: 'weapon',
    // Nudge the drop clear of walls so it is always reachable.
    x, y,
    weapon: weapon.id,
    ammo: Math.floor((Number.isFinite(weapon.ammo) ? weapon.ammo : 0) * retain),
    reserve: Math.floor(weapon.reserve * retain),
    active: true,
    respawnAt: 0,
    expiresAt: world.now + GAMEPLAY.pickups.dropLifetimeSec * 1000,
    availableAt: world.now + GAMEPLAY.pickups.dropArmingSec * 1000,
    claimedBy: null,
  };
  if (world.grid.circleBlocked(drop.x, drop.y, 10)) {
    const free = nearestFreeSpot(world, x, y);
    drop.x = free.x;
    drop.y = free.y;
  }
  world.pickups.set(drop.id, drop);
  return drop;
}

function nearestFreeSpot(world: World, x: number, y: number): { x: number; y: number } {
  for (let r = 16; r <= 96; r += 16) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const nx = x + Math.cos(a) * r;
      const ny = y + Math.sin(a) * r;
      if (!world.grid.circleBlocked(nx, ny, 10)) return { x: nx, y: ny };
    }
  }
  return { x, y };
}

export function stepPickups(world: World): void {
  for (const p of [...world.pickups.values()]) {
    if (p.spawnId === null) {
      // World drops expire; fixed spawns respawn.
      if (p.expiresAt > 0 && world.now >= p.expiresAt) world.pickups.delete(p.id);
      continue;
    }
    if (!p.active && world.now >= p.respawnAt) {
      const def = world.mapDef.pickupSpawns.find((d) => d.id === p.spawnId);
      if (!def) continue;
      const fresh = instantiate(world, def);
      // Weapon spawns re-roll, so a contested spawn point stays interesting.
      Object.assign(p, fresh, { active: true, claimedBy: null });
    }
  }
}

function respawnSecFor(kind: PickupEntity['kind']): number {
  switch (kind) {
    case 'weapon': return GAMEPLAY.pickups.weaponRespawnSec;
    case 'ammo': return GAMEPLAY.pickups.ammoRespawnSec;
    case 'health': return GAMEPLAY.pickups.healthRespawnSec;
    case 'armor': return GAMEPLAY.pickups.armorRespawnSec;
  }
}

function consume(world: World, p: PickupEntity, by: PlayerEntity): void {
  p.claimedBy = by.id;
  if (p.spawnId === null) {
    world.pickups.delete(p.id);
  } else {
    p.active = false;
    p.respawnAt = world.now + respawnSecFor(p.kind) * 1000;
  }
}

/**
 * Grants everything the player can legally take at their current position.
 *
 * `explicitSwap` is true when the player pressed the swap key, which is the
 * only way to replace an occupied weapon slot - walking over a weapon you have
 * no room for never silently discards what you are carrying.
 *
 * Claims are decided here, on the server, and a pickup is marked consumed
 * before any state is granted. Two players arriving on the same tick therefore
 * cannot both receive it, and a duplicate request from a laggy or malicious
 * client finds the pickup already inactive.
 */
export function tryClaimPickups(
  world: World,
  player: PlayerEntity,
  explicitSwap: boolean,
): void {
  if (player.life !== 'alive') return;
  player.prompt = null;
  player.swapCandidate = null;

  const radius = GAMEPLAY.player.pickupRadius;
  // Iterate a snapshot: claiming a weapon can drop the replaced one into the
  // world, and a live Map iterator would then walk straight into the item we
  // just created - swapping with itself forever.
  const candidates = [...world.pickups.values()];
  let tookWeapon = false;

  for (const p of candidates) {
    if (!p.active || p.claimedBy) continue;
    if (world.now < p.availableAt) continue;
    if (dist2(player.x, player.y, p.x, p.y) > radius * radius) continue;

    switch (p.kind) {
      case 'health': {
        // Stored for later if there is room in the pouch; used on the spot only
        // when the pouch is full and it would actually help.
        if (player.medkits < GAMEPLAY.pouch.maxMedkits) {
          player.medkits++;
          consume(world, p, player);
          world.emit({
            e: 'pickup', id: p.id, by: player.id, x: p.x, y: p.y,
            kind: 'health', label: 'Medkit', stored: true,
          });
        } else if (player.hp < GAMEPLAY.player.maxHealth) {
          player.hp = Math.min(
            GAMEPLAY.player.maxHealth, player.hp + GAMEPLAY.pickups.healthAmount,
          );
          consume(world, p, player);
          world.emit({
            e: 'pickup', id: p.id, by: player.id, x: p.x, y: p.y,
            kind: 'health', label: `+${GAMEPLAY.pickups.healthAmount} HP`, stored: false,
          });
        } else continue;
        break;
      }
      case 'armor': {
        if (player.armorPlates < GAMEPLAY.pouch.maxArmorPlates) {
          player.armorPlates++;
          consume(world, p, player);
          world.emit({
            e: 'pickup', id: p.id, by: player.id, x: p.x, y: p.y,
            kind: 'armor', label: 'Armor plate', stored: true,
          });
        } else if (player.armor < GAMEPLAY.player.maxArmor) {
          player.armor = Math.min(
            GAMEPLAY.player.maxArmor, player.armor + GAMEPLAY.pickups.armorAmount,
          );
          consume(world, p, player);
          world.emit({
            e: 'pickup', id: p.id, by: player.id, x: p.x, y: p.y,
            kind: 'armor', label: `+${GAMEPLAY.pickups.armorAmount} armor`, stored: false,
          });
        } else continue;
        break;
      }
      case 'ammo': {
        // Ammo crates top up every carried weapon that has room in reserve.
        let took = false;
        for (const w of player.slots) {
          if (!w) continue;
          const def = weaponDef(w.id);
          if (def.pickupAmmo <= 0 || w.reserve >= def.reserveMax) continue;
          w.reserve = Math.min(def.reserveMax, w.reserve + def.pickupAmmo);
          took = true;
        }
        if (!took) continue;
        consume(world, p, player);
        world.emit({
          e: 'pickup', id: p.id, by: player.id, x: p.x, y: p.y, kind: 'ammo', label: 'Ammo',
        });
        break;
      }
      case 'weapon': {
        if (!p.weapon || tookWeapon) continue;
        const slot = slotForWeapon(p.weapon);
        const held = player.slots[slot];

        if (held && held.id === p.weapon) {
          // Same weapon: treat it as an ammo top-up rather than a swap.
          const def = weaponDef(p.weapon);
          if (held.reserve >= def.reserveMax) continue;
          held.reserve = Math.min(def.reserveMax, held.reserve + p.reserve + p.ammo);
          consume(world, p, player);
          world.emit({
            e: 'pickup', id: p.id, by: player.id, x: p.x, y: p.y,
            kind: 'ammo', label: `${def.name} ammo`, weapon: p.weapon,
          });
          break;
        }

        // A weapon with nothing left in it is not worth protecting: take the
        // new one straight away instead of making the player press swap.
        const heldSpent = !!held && held.ammo <= 0 && held.reserve <= 0;

        if (held && !explicitSwap && !heldSpent) {
          // Occupied slot: advertise the swap instead of taking it silently.
          player.prompt = `F - Swap for ${weaponDef(p.weapon).name}`;
          player.swapCandidate = p.id;
          continue;
        }

        const taken = freshWeapon(p.weapon, 0);
        taken.ammo = p.ammo;
        taken.reserve = p.reserve;
        // Throw the replaced weapon behind the player, away from the pickup.
        // An empty one is simply discarded.
        if (held && !heldSpent) {
          dropWeaponAt(world, player.x, player.y, held, player.aim + Math.PI);
        }
        tookWeapon = true;
        player.slots[slot] = taken;
        player.slot = slot;
        player.reloadingSlot = -1;
        player.reloadEndsAt = 0;
        consume(world, p, player);
        world.emit({
          e: 'pickup', id: p.id, by: player.id, x: p.x, y: p.y,
          kind: 'weapon', label: weaponDef(p.weapon).name, weapon: p.weapon,
        });
        break;
      }
    }
  }

  if (!player.slots[player.slot]) player.slot = bestSlot(player.slots);
}

/** Drops a health or armour item into the world, e.g. from a player's pouch on death. */
export function dropConsumableAt(
  world: World,
  x: number,
  y: number,
  kind: 'health' | 'armor',
): PickupEntity {
  const angle = world.rng() * Math.PI * 2;
  const toss = GAMEPLAY.pickups.dropDistance;
  let px = x + Math.cos(angle) * toss;
  let py = y + Math.sin(angle) * toss;
  if (world.grid.circleBlocked(px, py, 10)) {
    const free = nearestFreeSpot(world, px, py);
    px = free.x;
    py = free.y;
  }
  const drop: PickupEntity = {
    id: `d${world.allocId()}`,
    spawnId: null,
    kind,
    x: px,
    y: py,
    ammo: 0,
    reserve: 0,
    active: true,
    respawnAt: 0,
    expiresAt: world.now + GAMEPLAY.pickups.dropLifetimeSec * 1000,
    availableAt: world.now + GAMEPLAY.pickups.dropArmingSec * 1000,
    claimedBy: null,
  };
  world.pickups.set(drop.id, drop);
  return drop;
}

/** Uses a carried medkit. Returns true when one was actually spent. */
export function useMedkit(world: World, p: PlayerEntity): boolean {
  if (p.life !== 'alive' || p.medkits <= 0) return false;
  if (world.now < p.pouchReadyAt) return false;
  // Never waste one at full health.
  if (p.hp >= GAMEPLAY.player.maxHealth) return false;

  const before = p.hp;
  p.hp = Math.min(GAMEPLAY.player.maxHealth, p.hp + GAMEPLAY.pouch.medkitHeal);
  p.medkits--;
  p.pouchReadyAt = world.now + GAMEPLAY.pouch.useCooldownSec * 1000;
  world.emit({
    e: 'useItem', by: p.id, x: p.x, y: p.y, kind: 'health', amount: p.hp - before,
  });
  return true;
}

/** Uses a carried armour plate. Returns true when one was actually spent. */
export function useArmorPlate(world: World, p: PlayerEntity): boolean {
  if (p.life !== 'alive' || p.armorPlates <= 0) return false;
  if (world.now < p.pouchReadyAt) return false;
  if (p.armor >= GAMEPLAY.player.maxArmor) return false;

  const before = p.armor;
  p.armor = Math.min(GAMEPLAY.player.maxArmor, p.armor + GAMEPLAY.pouch.armorPlateAmount);
  p.armorPlates--;
  p.pouchReadyAt = world.now + GAMEPLAY.pouch.useCooldownSec * 1000;
  world.emit({
    e: 'useItem', by: p.id, x: p.x, y: p.y, kind: 'armor', amount: p.armor - before,
  });
  return true;
}
