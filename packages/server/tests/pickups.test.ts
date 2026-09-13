import { describe, expect, it } from 'vitest';
import { GAMEPLAY, weaponDef } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { dropWeaponAt, tryClaimPickups } from '../src/sim/pickups.js';
import { freshWeapon, SLOT_PRIMARY, SLOT_SIDEARM } from '../src/sim/loadout.js';
import type { PickupEntity } from '../src/sim/entities.js';

/** Places a pickup exactly under a player, already armed. */
function pickupAt(
  world: ReturnType<typeof makeWorld>['world'],
  id: string,
  x: number,
  y: number,
  patch: Partial<PickupEntity>,
): PickupEntity {
  const p: PickupEntity = {
    id, spawnId: null, kind: 'weapon', x, y,
    ammo: 0, reserve: 0, active: true, respawnAt: 0,
    expiresAt: 0, availableAt: 0, claimedBy: null,
    ...patch,
  };
  world.pickups.set(id, p);
  return p;
}

describe('pickup claiming', () => {
  it('gives a weapon to a player whose slot is empty', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p', 0, 1100, 200);
    p.slots[SLOT_PRIMARY] = null;
    pickupAt(world, 'w1', 1100, 200, { kind: 'weapon', weapon: 'rifle', ammo: 30, reserve: 60 });

    tryClaimPickups(world, p, false);

    expect(p.slots[SLOT_PRIMARY]?.id).toBe('rifle');
    expect(p.slots[SLOT_PRIMARY]?.ammo).toBe(30);
    expect(world.pickups.has('w1')).toBe(false);
  });

  it('only prompts, and takes nothing, when the slot is occupied', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p', 0, 1100, 200);
    p.slots[SLOT_PRIMARY] = freshWeapon('smg');
    pickupAt(world, 'w1', 1100, 200, { kind: 'weapon', weapon: 'rifle', ammo: 30, reserve: 60 });

    tryClaimPickups(world, p, false);

    expect(p.slots[SLOT_PRIMARY]?.id).toBe('smg');
    expect(world.pickups.get('w1')?.active).toBe(true);
    expect(p.prompt).toContain('Swap');
  });

  it('swaps on an explicit request and drops the replaced weapon', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p', 0, 1100, 200);
    p.slots[SLOT_PRIMARY] = freshWeapon('smg');
    pickupAt(world, 'w1', 1100, 200, { kind: 'weapon', weapon: 'rifle', ammo: 30, reserve: 60 });

    tryClaimPickups(world, p, true);

    expect(p.slots[SLOT_PRIMARY]?.id).toBe('rifle');
    // Only world drops (no spawnId) count - the map itself has smg spawns.
    const dropped = [...world.pickups.values()]
      .filter((x) => x.spawnId === null && x.weapon === 'smg');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reserve).toBeGreaterThan(0);
  });

  it('terminates instead of looping when a swap drops a weapon underfoot', () => {
    // Regression: dropping into the live pickup map while iterating it made the
    // player swap with their own dropped weapon forever, exhausting memory.
    const { world } = makeWorld();
    const p = placePlayer(world, 'p', 0, 1100, 200);
    p.slots[SLOT_PRIMARY] = freshWeapon('smg');
    const before = world.pickups.size;
    pickupAt(world, 'w1', 1100, 200, { kind: 'weapon', weapon: 'rifle', ammo: 30, reserve: 60 });

    tryClaimPickups(world, p, true);

    // One weapon taken, one dropped - never an unbounded cascade.
    expect(world.pickups.size).toBe(before + 1);
  });

  it('cannot immediately re-collect a weapon it just dropped', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p', 0, 1100, 200);
    const dropped = dropWeaponAt(world, p.x, p.y, freshWeapon('rifle'), 0);
    p.slots[SLOT_PRIMARY] = null;

    tryClaimPickups(world, p, false);
    expect(p.slots[SLOT_PRIMARY]).toBeNull();

    world.now += GAMEPLAY.pickups.dropArmingSec * 1000 + 1;
    // Stand on it now that it has settled.
    p.x = dropped.x;
    p.y = dropped.y;
    tryClaimPickups(world, p, false);
    expect(p.slots[SLOT_PRIMARY]?.id).toBe('rifle');
  });

  it('gives a contested pickup to exactly one of two players', () => {
    const { world } = makeWorld();
    const a = placePlayer(world, 'a', 0, 1100, 200);
    const b = placePlayer(world, 'b', 1, 1102, 202);
    a.slots[SLOT_PRIMARY] = null;
    b.slots[SLOT_PRIMARY] = null;
    pickupAt(world, 'w1', 1101, 201, { kind: 'weapon', weapon: 'rifle', ammo: 30, reserve: 60 });

    // Same tick, both in range.
    tryClaimPickups(world, a, false);
    tryClaimPickups(world, b, false);

    const holders = [a, b].filter((p) => p.slots[SLOT_PRIMARY]?.id === 'rifle');
    expect(holders).toHaveLength(1);
  });

  it('refuses a second claim of an already-consumed spawn', () => {
    const { world } = makeWorld();
    const a = placePlayer(world, 'a', 0, 1100, 200);
    a.medkits = 0;
    pickupAt(world, 'h1', 1100, 200, { kind: 'health', spawnId: 'h1' });

    tryClaimPickups(world, a, false);
    expect(a.medkits).toBe(1);

    // The spawn is now inactive: claiming again must grant nothing.
    tryClaimPickups(world, a, false);
    expect(a.medkits).toBe(1);
  });

  it('tops up ammunition without exceeding the weapon reserve cap', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p', 0, 1100, 200);
    const w = freshWeapon('rifle');
    w.reserve = weaponDef('rifle').reserveMax - 5;
    p.slots[SLOT_PRIMARY] = w;
    pickupAt(world, 'a1', 1100, 200, { kind: 'ammo', spawnId: 'a1' });

    tryClaimPickups(world, p, false);
    expect(w.reserve).toBe(weaponDef('rifle').reserveMax);
  });

  it('leaves a health pack when the pouch is full and health is too', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p', 0, 1100, 200);
    p.hp = GAMEPLAY.player.maxHealth;
    p.medkits = GAMEPLAY.pouch.maxMedkits;
    pickupAt(world, 'h1', 1100, 200, { kind: 'health', spawnId: 'h1' });

    tryClaimPickups(world, p, false);
    expect(world.pickups.get('h1')?.active).toBe(true);
  });

  it('respawns a consumed map pickup after its timer', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.hp = 10;
    const spawnDef = h.world.mapDef.pickupSpawns.find((d) => d.kind === 'health')!;
    const entity = h.world.pickups.get(spawnDef.id)!;
    p.x = entity.x;
    p.y = entity.y;

    tryClaimPickups(h.world, p, false);
    expect(entity.active).toBe(false);

    // Step away, or the player simply collects it again the moment it returns.
    p.x = entity.x + 400;
    h.advance(GAMEPLAY.pickups.healthRespawnSec * 1000 + 200);
    expect(h.world.pickups.get(spawnDef.id)?.active).toBe(true);
  });

  it('picks a weapon up within the documented collection radius', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p', 0, 1100, 200);
    p.slots[SLOT_SIDEARM] = null;
    pickupAt(world, 'w1', 1100 + GAMEPLAY.player.pickupRadius - 2, 200, {
      kind: 'weapon', weapon: 'pistol', ammo: 14, reserve: 20,
    });
    tryClaimPickups(world, p, false);
    expect(p.slots[SLOT_SIDEARM]?.id).toBe('pistol');
  });
});
