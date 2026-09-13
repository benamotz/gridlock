import {
  CHAOS_POOL,
  DEFAULT_MELEE,
  DEFAULT_START_WEAPON,
  FAIR_START_POOL,
  type LoadoutRule,
  type WeaponId,
  type WeaponState,
  pick,
  weaponDef,
} from '@gridlock/shared';

/** Inventory slot for a weapon, derived from its class so pickups are predictable. */
export const SLOT_MELEE = 0;
export const SLOT_SIDEARM = 1;
export const SLOT_PRIMARY = 2;
export const SLOT_THROWABLE = 3;
export const SLOT_COUNT = 4;

export function slotForWeapon(id: WeaponId): number {
  switch (weaponDef(id).class) {
    case 'melee': return SLOT_MELEE;
    case 'sidearm': return SLOT_SIDEARM;
    case 'throwable': return SLOT_THROWABLE;
    // Heavy weapons compete for the primary slot - you cannot hold a rifle
    // and a rocket launcher at once.
    default: return SLOT_PRIMARY;
  }
}

/** A fresh weapon with a full magazine and a starting reserve. */
export function freshWeapon(id: WeaponId, reserveFraction = 0.5): WeaponState {
  const def = weaponDef(id);
  return {
    id,
    ammo: Number.isFinite(def.magazine) ? def.magazine : Infinity,
    reserve: Math.floor(def.reserveMax * reserveFraction),
  };
}

/**
 * Builds a starting inventory.
 *
 * Randomised rules draw from a single tier so nobody starts the match
 * out-gunned; `chaos` is the one rule that deliberately ignores that, and it
 * has to be opted into per room.
 */
export function buildLoadout(
  rule: LoadoutRule,
  team: number,
  rng: () => number,
): (WeaponState | null)[] {
  const slots: (WeaponState | null)[] = new Array(SLOT_COUNT).fill(null);
  slots[SLOT_MELEE] = freshWeapon(DEFAULT_MELEE);

  const give = (id: WeaponId, reserveFraction = 0.5) => {
    slots[slotForWeapon(id)] = freshWeapon(id, reserveFraction);
  };

  switch (rule) {
    case 'none':
      break;
    case 'fixed':
      give(DEFAULT_START_WEAPON);
      break;
    case 'random-tier':
      give(DEFAULT_START_WEAPON, 0.35);
      give(pick(FAIR_START_POOL, rng), 0.4);
      break;
    case 'team-pool': {
      // Each team draws from a rotated view of the same fair pool, so team
      // identity shows in the loadout without changing its power level.
      const pool = FAIR_START_POOL.map(
        (_, i) => FAIR_START_POOL[(i + team) % FAIR_START_POOL.length],
      );
      give(DEFAULT_START_WEAPON, 0.35);
      give(pick(pool, rng), 0.4);
      break;
    }
    case 'chaos':
      give(pick(CHAOS_POOL, rng), 0.5);
      break;
  }
  return slots;
}

/** First slot holding a usable weapon, preferring the strongest. */
export function bestSlot(slots: (WeaponState | null)[]): number {
  for (const s of [SLOT_PRIMARY, SLOT_SIDEARM, SLOT_THROWABLE, SLOT_MELEE]) {
    const w = slots[s];
    if (w && (w.ammo > 0 || w.reserve > 0)) return s;
  }
  return SLOT_MELEE;
}
