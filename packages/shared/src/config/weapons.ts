import type { WeaponDef, WeaponId, WeaponTier } from '../types.js';

const D = (w: WeaponDef): WeaponDef => w;

/**
 * All weapon behaviour is data. Adding a weapon means adding a record here -
 * no simulation code changes required.
 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: D({
    id: 'fists', name: 'Fists', class: 'melee', tier: 0,
    damage: 18, rpm: 130, range: 42, falloffStart: 42, falloffMin: 1,
    pellets: 1, spread: 0, spreadPerShot: 0, maxSpread: 0,
    magazine: Infinity, reserveMax: 0, reloadMs: 0,
    projectileSpeed: 0, explosionRadius: 0, moveMultiplier: 1.05,
    pickupAmmo: 0, rarity: 0, color: '#cfd6e4', sfx: 'melee',
  }),
  sentry: D({
    // Not obtainable: the profile a deployed sentry gun fires with.
    id: 'sentry', name: 'Sentry Gun', class: 'primary', tier: 0,
    damage: 11, rpm: 200, range: 620, falloffStart: 400, falloffMin: 0.7,
    pellets: 1, spread: 0.035, spreadPerShot: 0, maxSpread: 0.035,
    magazine: Infinity, reserveMax: 0, reloadMs: 0,
    projectileSpeed: 0, explosionRadius: 0, moveMultiplier: 1,
    pickupAmmo: 0, rarity: 0, color: '#9fc0ff', sfx: 'smg',
  }),
  mine: D({
    // Not obtainable: the charge a deployed proximity mine detonates with.
    // Tuned against vehicles - the counter to a truck ramming the base.
    id: 'mine', name: 'Proximity Mine', class: 'heavy', tier: 0,
    damage: 125, rpm: 1, range: 1, falloffStart: 1, falloffMin: 1,
    pellets: 1, spread: 0, spreadPerShot: 0, maxSpread: 0,
    magazine: Infinity, reserveMax: 0, reloadMs: 0,
    projectileSpeed: 0, explosionRadius: 130, moveMultiplier: 1,
    pickupAmmo: 0, rarity: 0, color: '#c7d36b', sfx: 'launcher',
    vehicleDamageMult: 2.4,
  }),
  pipe: D({
    id: 'pipe', name: 'Steel Pipe', class: 'melee', tier: 1,
    damage: 42, rpm: 105, range: 58, falloffStart: 58, falloffMin: 1,
    pellets: 1, spread: 0, spreadPerShot: 0, maxSpread: 0,
    magazine: Infinity, reserveMax: 0, reloadMs: 0,
    projectileSpeed: 0, explosionRadius: 0, moveMultiplier: 1.02,
    pickupAmmo: 0, rarity: 1.0, color: '#9aa6bb', sfx: 'melee',
  }),
  pistol: D({
    id: 'pistol', name: 'M9 Sidearm', class: 'sidearm', tier: 1,
    damage: 24, rpm: 300, range: 620, falloffStart: 300, falloffMin: 0.6,
    pellets: 1, spread: 0.014, spreadPerShot: 0.012, maxSpread: 0.10,
    magazine: 14, reserveMax: 84, reloadMs: 1100,
    projectileSpeed: 0, explosionRadius: 0, moveMultiplier: 1.0,
    pickupAmmo: 28, rarity: 1.4, color: '#e8d8a0', sfx: 'pistol',
  }),
  smg: D({
    id: 'smg', name: 'Vector-9 SMG', class: 'primary', tier: 2,
    damage: 16, rpm: 820, range: 520, falloffStart: 220, falloffMin: 0.5,
    pellets: 1, spread: 0.030, spreadPerShot: 0.016, maxSpread: 0.20,
    magazine: 32, reserveMax: 192, reloadMs: 1500,
    projectileSpeed: 0, explosionRadius: 0, moveMultiplier: 0.97,
    pickupAmmo: 64, rarity: 1.2, color: '#a8c4ff', sfx: 'smg',
  }),
  shotgun: D({
    id: 'shotgun', name: 'Breaker 12', class: 'primary', tier: 2,
    damage: 13, rpm: 78, range: 380, falloffStart: 130, falloffMin: 0.28,
    pellets: 8, spread: 0.115, spreadPerShot: 0.02, maxSpread: 0.16,
    magazine: 6, reserveMax: 36, reloadMs: 2100,
    projectileSpeed: 0, explosionRadius: 0, moveMultiplier: 0.93,
    pickupAmmo: 12, rarity: 1.0, color: '#ffab6b', sfx: 'shotgun',
  }),
  rifle: D({
    id: 'rifle', name: 'AR-14 Rifle', class: 'primary', tier: 2,
    damage: 25, rpm: 560, range: 780, falloffStart: 420, falloffMin: 0.62,
    pellets: 1, spread: 0.020, spreadPerShot: 0.014, maxSpread: 0.16,
    magazine: 30, reserveMax: 180, reloadMs: 1900,
    projectileSpeed: 0, explosionRadius: 0, moveMultiplier: 0.94,
    pickupAmmo: 60, rarity: 1.0, color: '#8ce0a8', sfx: 'rifle',
  }),
  marksman: D({
    id: 'marksman', name: 'Longshot .308', class: 'primary', tier: 3,
    damage: 82, rpm: 48, range: 1500, falloffStart: 1200, falloffMin: 0.85,
    pellets: 1, spread: 0.004, spreadPerShot: 0.05, maxSpread: 0.14,
    magazine: 5, reserveMax: 25, reloadMs: 2600,
    projectileSpeed: 0, explosionRadius: 0, moveMultiplier: 0.86,
    pickupAmmo: 10, rarity: 0.5, color: '#d59bff', sfx: 'marksman',
  }),
  grenade: D({
    id: 'grenade', name: 'Frag Charge', class: 'throwable', tier: 2,
    damage: 96, rpm: 50, range: 460, falloffStart: 460, falloffMin: 1,
    pellets: 1, spread: 0, spreadPerShot: 0, maxSpread: 0,
    magazine: 1, reserveMax: 3, reloadMs: 900,
    projectileSpeed: 460, explosionRadius: 110, moveMultiplier: 1.0,
    pickupAmmo: 2, rarity: 0.6, color: '#c2d24a', sfx: 'throw',
  }),
  launcher: D({
    id: 'launcher', name: 'Sledge Launcher', class: 'heavy', tier: 3,
    damage: 130, rpm: 40, range: 900, falloffStart: 900, falloffMin: 1,
    pellets: 1, spread: 0.01, spreadPerShot: 0, maxSpread: 0.01,
    magazine: 1, reserveMax: 4, reloadMs: 2800,
    projectileSpeed: 620, explosionRadius: 150, moveMultiplier: 0.8,
    pickupAmmo: 2, rarity: 0.22, color: '#ff7a4d', sfx: 'launcher',
  }),
};

export const weaponDef = (id: WeaponId): WeaponDef => WEAPONS[id];

/** Milliseconds between shots, derived from RPM. */
export const shotIntervalMs = (id: WeaponId): number => 60000 / WEAPONS[id].rpm;

export const allWeaponIds = Object.keys(WEAPONS) as WeaponId[];

export const weaponsOfTier = (tier: WeaponTier): WeaponDef[] =>
  allWeaponIds.map(weaponDef).filter((w) => w.tier === tier);

/** Weapons eligible to appear as world pickups (excludes the default fists). */
export const pickupWeapons = (): WeaponDef[] =>
  allWeaponIds.map(weaponDef).filter((w) => w.rarity > 0);

/** Weapon that never runs out and is always in the melee slot. */
export const DEFAULT_MELEE: WeaponId = 'fists';

/**
 * Starting pool for `random-tier` loadouts. Every entry is tier 2, so no player
 * begins a match meaningfully out-gunned.
 */
export const FAIR_START_POOL: WeaponId[] = ['smg', 'shotgun', 'rifle'];

/** Pool for the `chaos` loadout rule, which deliberately ignores tier fairness. */
export const CHAOS_POOL: WeaponId[] = [
  'pistol', 'smg', 'shotgun', 'rifle', 'marksman', 'launcher', 'pipe',
];

export const DEFAULT_START_WEAPON: WeaponId = 'pistol';

/**
 * Ammo families - picking up "rifle ammo" also feeds anything sharing the family.
 * Kept simple for the MVP: each weapon has its own family.
 */
export const ammoFamily = (id: WeaponId): WeaponId => id;
