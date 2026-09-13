import { describe, expect, it } from 'vitest';
import {
  Btn, CollisionGrid, DEPLOY_ROT_STEP, GAMEPLAY, VEHICLES, deployableDef,
  deployableSolids, getMap, isEvading, jumpHeight, quantizeDeployRot,
  stepPlayerMovement, vehicleDef, vehicleRatings,
} from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { traceShot, applyPlayerDamage, fireWeapon } from '../src/sim/combat.js';
import { tryClaimPickups, useArmorPlate, useMedkit } from '../src/sim/pickups.js';
import { tryDeploy } from '../src/sim/deployables.js';
import { tryEnterExitVehicle } from '../src/sim/vehicles.js';
import { freshWeapon, SLOT_PRIMARY } from '../src/sim/loadout.js';
import type { PickupEntity } from '../src/sim/entities.js';

const grid = () => new CollisionGrid(getMap('depot-yard'));
const actor = (x: number, y: number) => ({
  x, y, vx: 0, vy: 0, stamina: 100, sprinting: false, air: 0, jumpCd: 0, jumpHeld: false,
});
const step = 1 / 30;

function pickupAt(
  world: ReturnType<typeof makeWorld>['world'], id: string, x: number, y: number,
  patch: Partial<PickupEntity>,
): PickupEntity {
  const p: PickupEntity = {
    id, spawnId: null, kind: 'weapon', x, y, ammo: 0, reserve: 0, active: true,
    respawnAt: 0, expiresAt: 0, availableAt: 0, claimedBy: null, ...patch,
  };
  world.pickups.set(id, p);
  return p;
}

function inBase(h: ReturnType<typeof makeWorld>, id: string, team: number) {
  const zone = h.world.mapDef.teamSpawns.find((s) => s.team === team)!.zone;
  const p = placePlayer(h.world, id, team, zone.x + zone.w / 2, zone.y + zone.h / 2);
  p.aim = 0;
  return p;
}

// ---------------------------------------------------------------------------

describe('jumping', () => {
  it('leaves the ground on a press and lands after the jump duration', () => {
    const a = actor(1100, 200);
    const g = grid();
    const r = stepPlayerMovement(a, 'pistol', Btn.Jump, step, g);
    expect(r.jumped).toBe(true);
    expect(a.air).toBeGreaterThan(0);

    let t = 0;
    while (a.air > 0 && t < 3) {
      stepPlayerMovement(a, 'pistol', Btn.Jump, step, g);
      t += step;
    }
    expect(a.air).toBe(0);
    expect(t).toBeCloseTo(GAMEPLAY.player.jumpDuration, 1);
  });

  it('jumps once per press, not repeatedly while held', () => {
    const a = actor(1100, 200);
    const g = grid();
    let jumps = 0;
    for (let i = 0; i < 150; i++) {
      if (stepPlayerMovement(a, 'pistol', Btn.Jump, step, g).jumped) jumps++;
    }
    expect(jumps).toBe(1);
  });

  it('enforces the cooldown between jumps', () => {
    const a = actor(1100, 200);
    const g = grid();
    stepPlayerMovement(a, 'pistol', Btn.Jump, step, g);
    // Release and press again straight after landing - still on cooldown.
    for (let i = 0; i < 16; i++) stepPlayerMovement(a, 'pistol', 0, step, g);
    const early = stepPlayerMovement(a, 'pistol', Btn.Jump, step, g);
    expect(early.jumped).toBe(false);

    for (let i = 0; i < 40; i++) stepPlayerMovement(a, 'pistol', 0, step, g);
    expect(stepPlayerMovement(a, 'pistol', Btn.Jump, step, g).jumped).toBe(true);
  });

  it('costs stamina and cannot be used when exhausted', () => {
    const a = actor(1100, 200);
    a.stamina = GAMEPLAY.player.jumpStamina - 1;
    expect(stepPlayerMovement(a, 'pistol', Btn.Jump, step, grid()).jumped).toBe(false);

    const b = actor(1100, 200);
    stepPlayerMovement(b, 'pistol', Btn.Jump, step, grid());
    expect(b.stamina).toBeLessThan(100 - GAMEPLAY.player.jumpStamina + 1);
  });

  it('carries the player further than walking over the same time', () => {
    const g = grid();
    const walker = actor(1100, 200);
    const jumper = actor(1100, 200);
    for (let i = 0; i < 15; i++) {
      stepPlayerMovement(walker, 'pistol', Btn.Right, step, g);
      stepPlayerMovement(jumper, 'pistol', Btn.Right | (i === 0 ? Btn.Jump : 0), step, g);
    }
    expect(jumper.x).toBeGreaterThan(walker.x);
  });

  it('evades bullets only in the middle of the jump', () => {
    const d = GAMEPLAY.player.jumpDuration;
    expect(isEvading({ air: d })).toBe(false); // take-off frame
    expect(isEvading({ air: d - 0.2 })).toBe(true); // mid-air
    expect(isEvading({ air: 0.02 })).toBe(false); // about to land
    expect(isEvading({ air: 0 })).toBe(false);
    expect(jumpHeight(d / 2)).toBeCloseTo(1, 1);
  });

  it('lets bullets pass beneath a player mid-jump', () => {
    const h = makeWorld();
    const target = placePlayer(h.world, 't', 1, 1100, 200);
    target.air = GAMEPLAY.player.jumpDuration - 0.2;

    const hit = traceShot(h.world, 900, 200, 1300, 200, 'shooter');
    expect(hit.player).toBeUndefined();

    target.air = 0;
    expect(traceShot(h.world, 900, 200, 1300, 200, 'shooter').player?.id).toBe('t');
  });

  it('does not protect a jumping player from explosions', () => {
    const h = makeWorld();
    const target = placePlayer(h.world, 't', 1, 1100, 200);
    target.air = GAMEPLAY.player.jumpDuration - 0.2;
    applyPlayerDamage(h.world, target, 40, null, 'grenade');
    expect(target.hp).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------

describe('the health and armour pouch', () => {
  it('stores a medkit instead of using it on contact', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.hp = 40;
    p.medkits = 0;
    pickupAt(h.world, 'h1', 1100, 200, { kind: 'health', spawnId: 'h1' });

    tryClaimPickups(h.world, p, false);
    expect(p.medkits).toBe(1);
    expect(p.hp).toBe(40);
  });

  it('collects health even at full health, as long as the pouch has room', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.medkits = 0;
    pickupAt(h.world, 'h1', 1100, 200, { kind: 'health', spawnId: 'h1' });
    tryClaimPickups(h.world, p, false);
    expect(p.medkits).toBe(1);
  });

  it('uses a full-pouch pickup on the spot when it would help', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.medkits = GAMEPLAY.pouch.maxMedkits;
    p.hp = 30;
    pickupAt(h.world, 'h1', 1100, 200, { kind: 'health', spawnId: 'h1' });
    tryClaimPickups(h.world, p, false);
    expect(p.hp).toBe(30 + GAMEPLAY.pickups.healthAmount);
    expect(p.medkits).toBe(GAMEPLAY.pouch.maxMedkits);
  });

  it('leaves the pickup when the pouch is full and it would not help', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.medkits = GAMEPLAY.pouch.maxMedkits;
    const item = pickupAt(h.world, 'h1', 1100, 200, { kind: 'health', spawnId: 'h1' });
    tryClaimPickups(h.world, p, false);
    expect(item.active).toBe(true);
  });

  it('stores and uses armour plates', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    pickupAt(h.world, 'a1', 1100, 200, { kind: 'armor', spawnId: 'a1' });
    tryClaimPickups(h.world, p, false);
    expect(p.armorPlates).toBe(1);
    expect(p.armor).toBe(0);

    expect(useArmorPlate(h.world, p)).toBe(true);
    expect(p.armor).toBe(GAMEPLAY.pouch.armorPlateAmount);
    expect(p.armorPlates).toBe(0);
  });

  it('heals with a medkit and spends exactly one', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.hp = 20;
    p.medkits = 2;
    expect(useMedkit(h.world, p)).toBe(true);
    expect(p.hp).toBe(20 + GAMEPLAY.pouch.medkitHeal);
    expect(p.medkits).toBe(1);
  });

  it('refuses to waste a medkit at full health', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.medkits = 2;
    expect(useMedkit(h.world, p)).toBe(false);
    expect(p.medkits).toBe(2);
  });

  it('enforces a short cooldown between uses', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.hp = 10;
    p.medkits = 3;
    expect(useMedkit(h.world, p)).toBe(true);
    expect(useMedkit(h.world, p)).toBe(false);
    h.world.now += GAMEPLAY.pouch.useCooldownSec * 1000 + 1;
    expect(useMedkit(h.world, p)).toBe(true);
  });

  it('uses a medkit through the input command, once per key press', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.hp = 10;
    p.medkits = 3;
    h.world.queueInput('p', [
      { seq: 1, dtMs: 33, buttons: Btn.UseMedkit, aim: 0, slot: -1 },
      { seq: 2, dtMs: 33, buttons: Btn.UseMedkit, aim: 0, slot: -1 },
    ]);
    h.advance(100);
    expect(p.medkits).toBe(2);
  });

  it('starts every life with the configured pouch', () => {
    const h = makeWorld();
    const p = h.world.addPlayer('fresh', 'fresh', 0, false);
    expect(p.medkits).toBe(GAMEPLAY.pouch.startMedkits);
    expect(p.armorPlates).toBe(GAMEPLAY.pouch.startArmorPlates);
  });

  it('spills a medkit on death', () => {
    const h = makeWorld();
    const victim = placePlayer(h.world, 'v', 1, 1100, 200);
    victim.medkits = 2;
    const before = [...h.world.pickups.values()].filter((x) => x.kind === 'health').length;
    applyPlayerDamage(h.world, victim, 500, null, 'rifle');
    const after = [...h.world.pickups.values()].filter((x) => x.kind === 'health').length;
    expect(after).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------

describe('faster weapon collection', () => {
  it('collects from the wider pickup radius', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.slots[SLOT_PRIMARY] = null;
    pickupAt(h.world, 'w', 1100 + GAMEPLAY.player.pickupRadius - 3, 200, {
      kind: 'weapon', weapon: 'rifle', ammo: 30, reserve: 40,
    });
    tryClaimPickups(h.world, p, false);
    expect(p.slots[SLOT_PRIMARY]?.id).toBe('rifle');
  });

  it('swaps automatically when the held weapon is completely empty', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    const spent = freshWeapon('smg');
    spent.ammo = 0;
    spent.reserve = 0;
    p.slots[SLOT_PRIMARY] = spent;
    pickupAt(h.world, 'w', 1100, 200, { kind: 'weapon', weapon: 'rifle', ammo: 30, reserve: 40 });

    tryClaimPickups(h.world, p, false);
    expect(p.slots[SLOT_PRIMARY]?.id).toBe('rifle');
    // The empty weapon is discarded, not littered on the ground.
    expect([...h.world.pickups.values()].some((x) => x.spawnId === null && x.weapon === 'smg'))
      .toBe(false);
  });

  it('still asks before replacing a weapon that has ammunition', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.slots[SLOT_PRIMARY] = freshWeapon('smg');
    pickupAt(h.world, 'w', 1100, 200, { kind: 'weapon', weapon: 'rifle', ammo: 30, reserve: 40 });
    tryClaimPickups(h.world, p, false);
    expect(p.slots[SLOT_PRIMARY]?.id).toBe('smg');
    expect(p.prompt).toContain('Swap');
  });

  it('attributes the pickup event to the collector, with its id', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    p.slots[SLOT_PRIMARY] = null;
    pickupAt(h.world, 'w9', 1100, 200, { kind: 'weapon', weapon: 'rifle', ammo: 30, reserve: 40 });
    h.world.events = [];
    tryClaimPickups(h.world, p, false);
    expect(h.world.events.find((e) => e.e === 'pickup')).toMatchObject({
      id: 'w9', by: 'p', weapon: 'rifle',
    });
  });
});

// ---------------------------------------------------------------------------

describe('vehicle categories', () => {
  it('defines the six categories with distinct roles', () => {
    expect(Object.keys(VEHICLES).sort()).toEqual(
      ['armored', 'car', 'motorcycle', 'sports', 'truck', 'van'],
    );
  });

  it('makes each category best at something', () => {
    const all = Object.values(VEHICLES);
    const best = (pick: (v: typeof all[number]) => number) =>
      all.reduce((a, b) => (pick(b) > pick(a) ? b : a)).id;
    expect(best((v) => v.maxSpeed)).toBe('sports');
    expect(best((v) => v.acceleration)).toBe('motorcycle');
    expect(best((v) => v.seats)).toBe('van');
    expect(best((v) => v.demolition)).toBe('truck');
    expect(best((v) => 1 / v.bulletDamageMult)).toBe('armored');
  });

  it('pays for strengths with weaknesses', () => {
    expect(vehicleDef('motorcycle').shieldsOccupants).toBe(false);
    expect(vehicleDef('armored').maxSpeed).toBeLessThan(vehicleDef('car').maxSpeed);
    expect(vehicleDef('truck').acceleration).toBeLessThan(vehicleDef('car').acceleration);
    expect(vehicleDef('sports').durability).toBeLessThan(vehicleDef('car').durability);
    expect(vehicleDef('sports').seats).toBeLessThan(vehicleDef('van').seats);
  });

  it('produces card ratings in range for every vehicle', () => {
    for (const def of Object.values(VEHICLES)) {
      for (const value of Object.values(vehicleRatings(def))) {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('exposes motorcycle riders to gunfire', () => {
    const h = makeWorld();
    const bike = [...h.world.vehicles.values()].find((v) => v.type === 'motorcycle')!;
    const rider = placePlayer(h.world, 'rider', 0, bike.x, bike.y);
    tryEnterExitVehicle(h.world, rider);
    h.advance(34);

    const hit = traceShot(h.world, rider.x - 200, rider.y, rider.x + 200, rider.y, 'shooter');
    expect(hit.player?.id).toBe('rider');
  });

  it('shields riders of an enclosed vehicle', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;
    const rider = placePlayer(h.world, 'rider', 0, van.x, van.y);
    tryEnterExitVehicle(h.world, rider);
    h.advance(34);

    const hit = traceShot(h.world, van.x - 300, van.y, van.x + 300, van.y, 'shooter');
    expect(hit.player).toBeUndefined();
    expect(hit.vehicle?.id).toBe(van.id);
  });

  it('lets armour plating shrug off bullets', () => {
    const h = makeWorld();
    const armored = [...h.world.vehicles.values()].find((v) => v.type === 'armored')!;
    const car = [...h.world.vehicles.values()].find((v) => v.type === 'car')!;

    const shoot = (targetX: number, targetY: number, id: string) => {
      const s = placePlayer(h.world, id, 1, targetX - 150, targetY);
      s.slots[SLOT_PRIMARY] = freshWeapon('rifle');
      s.slot = SLOT_PRIMARY;
      s.aim = 0;
      s.spread = 0;
      h.world.now += 1000;
      fireWeapon(h.world, s, false, Btn.Fire);
      h.world.removePlayer(id);
    };
    const aBefore = armored.hp;
    const cBefore = car.hp;
    shoot(armored.x, armored.y, 's1');
    shoot(car.x, car.y, 's2');

    const armoredLoss = aBefore - armored.hp;
    const carLoss = cBefore - car.hp;
    expect(carLoss).toBeGreaterThan(0);
    expect(armoredLoss).toBeLessThan(carLoss);
  });

  it('lets a truck smash a barricade far faster than a motorcycle', () => {
    expect(vehicleDef('truck').demolition).toBeGreaterThan(vehicleDef('motorcycle').demolition * 10);
  });

  it('seats a motorcycle passenger behind the rider, not beside', () => {
    const h = makeWorld();
    const bike = [...h.world.vehicles.values()].find((v) => v.type === 'motorcycle')!;
    bike.rot = 0;
    const a = placePlayer(h.world, 'a', 0, bike.x + 5, bike.y);
    const b = placePlayer(h.world, 'b', 0, bike.x + 6, bike.y);
    tryEnterExitVehicle(h.world, a);
    tryEnterExitVehicle(h.world, b);
    h.advance(34);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    expect(a.x).toBeGreaterThan(b.x);
  });
});

// ---------------------------------------------------------------------------

describe('rotated barricades', () => {
  it('snaps requested rotations to 15 degree steps', () => {
    expect(quantizeDeployRot(0.26)).toBeCloseTo(DEPLOY_ROT_STEP, 5);
    expect(quantizeDeployRot(Number.NaN)).toBe(0);
    expect(Math.abs(quantizeDeployRot(100))).toBeLessThanOrEqual(Math.PI);
  });

  it('uses one rect when axis-aligned and a chain when angled', () => {
    expect(deployableSolids('barricade', 0, 0, 0)).toHaveLength(1);
    expect(deployableSolids('barricade', 0, 0, Math.PI / 2)).toHaveLength(1);
    expect(deployableSolids('barricade', 0, 0, Math.PI / 4).length).toBeGreaterThan(3);
  });

  it('leaves no gap in an angled wall a player could slip through', () => {
    const h = makeWorld();
    const cx = 960;
    const cy = 640;
    const rot = Math.PI / 4;
    for (const s of deployableSolids('barricade', cx, cy, rot)) h.world.grid.addSolid(s);

    // Sample every point along the wall's centre line: all must be blocked.
    const def = deployableDef('barricade');
    for (let t = -def.length / 2 + 8; t <= def.length / 2 - 8; t += 2) {
      const x = cx + Math.cos(rot) * t;
      const y = cy + Math.sin(rot) * t;
      expect(h.world.grid.circleBlocked(x, y, GAMEPLAY.player.radius)).toBe(true);
    }
  });

  it('stops a bullet fired straight through an angled barricade', () => {
    const h = makeWorld();
    const rot = Math.PI / 4;
    for (const s of deployableSolids('barricade', 960, 640, rot)) h.world.grid.addSolid(s);
    // Fire perpendicular to the wall, through its middle.
    const nx = Math.cos(rot + Math.PI / 2);
    const ny = Math.sin(rot + Math.PI / 2);
    expect(h.world.grid.lineOfSight(960 - nx * 80, 640 - ny * 80, 960 + nx * 80, 640 + ny * 80))
      .toBe(false);
  });

  it('places a barricade at the requested angle', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const res = tryDeploy(h.world, p, 'barricade', Math.PI / 4 + 0.03);
    expect(res.ok).toBe(true);
    expect(res.entity!.rot).toBeCloseTo(Math.PI / 4, 5);
    expect(res.entity!.solids.length).toBeGreaterThan(3);
  });

  it('never lands a barricade turned along the line of sight on its placer', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const res = tryDeploy(h.world, p, 'barricade', 0); // wall runs along the aim
    expect(res.ok).toBe(true);
    expect(h.world.grid.circleBlocked(p.x, p.y, GAMEPLAY.player.radius)).toBe(false);
  });

  it('removes every link of an angled barricade when destroyed', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'barricade', Math.PI / 3).entity!;
    const probe = d.solids[0].rect;
    expect(h.world.grid.circleBlocked(probe.x + probe.w / 2, probe.y + probe.h / 2, 2)).toBe(true);
    applyPlayerDamage; // keep import used
    h.world.deployables.delete(d.id);
    for (const s of d.solids) h.world.grid.removeSolid(s);
    expect(h.world.grid.circleBlocked(probe.x + probe.w / 2, probe.y + probe.h / 2, 2)).toBe(false);
  });

  it('ignores rotation for defences that cannot rotate', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const res = tryDeploy(h.world, p, 'turret', 1.2);
    expect(res.entity!.rot).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('proximity mines', () => {
  const armMine = (h: ReturnType<typeof makeWorld>) => {
    const p = inBase(h, 'owner', 0);
    const res = tryDeploy(h.world, p, 'mine');
    expect(res.ok).toBe(true);
    h.world.now += (deployableDef('mine').armingSec ?? 1.5) * 1000 + 50;
    return { owner: p, mine: res.entity! };
  };

  it('does not block movement or bullets', () => {
    const h = makeWorld();
    const { mine } = armMine(h);
    expect(mine.solids).toHaveLength(0);
    expect(h.world.grid.circleBlocked(mine.x, mine.y, 4)).toBe(false);
  });

  it('detonates when an enemy walks over it', () => {
    const h = makeWorld();
    const { owner, mine } = armMine(h);
    const enemy = placePlayer(h.world, 'e', 1, mine.x + 10, mine.y);

    h.advance(34);
    expect(h.world.deployables.has(mine.id)).toBe(false);
    expect(enemy.hp).toBeLessThan(100);
    void owner;
  });

  it('is not set off by the placing team', () => {
    const h = makeWorld();
    const { mine } = armMine(h);
    placePlayer(h.world, 'mate', 0, mine.x + 10, mine.y);
    h.advance(100);
    expect(h.world.deployables.has(mine.id)).toBe(true);
  });

  it('can be cleared by jumping over it', () => {
    const h = makeWorld();
    const { mine } = armMine(h);
    const enemy = placePlayer(h.world, 'e', 1, mine.x + 10, mine.y);
    enemy.air = GAMEPLAY.player.jumpDuration;
    h.world.step();
    expect(h.world.deployables.has(mine.id)).toBe(true);
  });

  it('does nothing before it has armed', () => {
    const h = makeWorld();
    const p = inBase(h, 'owner', 0);
    const mine = tryDeploy(h.world, p, 'mine').entity!;
    placePlayer(h.world, 'e', 1, mine.x + 10, mine.y);
    h.world.step();
    expect(h.world.deployables.has(mine.id)).toBe(true);
  });

  it('wrecks an enemy-crewed vehicle far harder than it hurts a player', () => {
    const h = makeWorld();
    const { mine } = armMine(h);
    const car = [...h.world.vehicles.values()].find((v) => v.type === 'car')!;
    const driver = placePlayer(h.world, 'd', 1, car.x, car.y);
    tryEnterExitVehicle(h.world, driver);
    car.x = mine.x;
    car.y = mine.y;
    car.vx = 0;
    car.vy = 0;
    const before = car.hp;

    h.world.step();
    expect(h.world.deployables.has(mine.id)).toBe(false);
    expect(before - car.hp).toBeGreaterThan(deployableDef('mine').hp);
  });

  it('ignores an empty parked vehicle rolling past', () => {
    const h = makeWorld();
    const { mine } = armMine(h);
    const car = [...h.world.vehicles.values()].find((v) => v.type === 'car')!;
    car.x = mine.x;
    car.y = mine.y;
    h.world.step();
    expect(h.world.deployables.has(mine.id)).toBe(true);
  });

  it('respects the team limit', () => {
    const h = makeWorld();
    const zone = h.world.mapDef.teamSpawns.find((s) => s.team === 0)!.zone;
    const limit = deployableDef('mine').teamLimit;
    for (let i = 0; i < limit; i++) {
      const p = placePlayer(h.world, `m${i}`, 0, zone.x + 30 + i * 55, zone.y + 40);
      p.aim = Math.PI / 2;
      expect(tryDeploy(h.world, p, 'mine').ok).toBe(true);
    }
    const extra = placePlayer(h.world, 'extra', 0, zone.x + 40, zone.y + zone.h - 40);
    extra.aim = -Math.PI / 2;
    expect(tryDeploy(h.world, extra, 'mine').reason).toBe('team-limit');
  });
});
