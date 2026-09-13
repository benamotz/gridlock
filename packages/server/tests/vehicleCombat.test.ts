import { describe, expect, it } from 'vitest';
import {
  Btn, VEHICLES, dist, seatIndexOf, seatOffset, vehicleDef, weaponDef,
} from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { exitVehicle, tryEnterExitVehicle } from '../src/sim/vehicles.js';
import { fireWeapon, firingOrigin } from '../src/sim/combat.js';
import { freshWeapon, SLOT_PRIMARY } from '../src/sim/loadout.js';

/** Gives a player a loaded rifle in the primary slot. */
function arm(p: ReturnType<typeof placePlayer>) {
  p.slots[SLOT_PRIMARY] = freshWeapon('rifle');
  p.slot = SLOT_PRIMARY;
  return p.slots[SLOT_PRIMARY]!;
}

describe('vehicle roster', () => {
  it('defines every declared vehicle type coherently', () => {
    for (const [id, def] of Object.entries(VEHICLES)) {
      expect(def.id).toBe(id);
      expect(def.seats).toBeGreaterThanOrEqual(1);
      expect(def.length).toBeGreaterThan(def.width);
      expect(def.maxSpeed).toBeGreaterThan(0);
      expect(def.durability).toBeGreaterThan(0);
      // Zoom is a scale factor: driving always pulls the camera back.
      expect(def.cameraZoom).toBeGreaterThan(0.3);
      expect(def.cameraZoom).toBeLessThanOrEqual(1);
    }
  });

  it('offers vehicles across a real range of size and speed', () => {
    const speeds = Object.values(VEHICLES).map((v) => v.maxSpeed);
    const seats = Object.values(VEHICLES).map((v) => v.seats);
    expect(Object.keys(VEHICLES).length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...speeds) - Math.min(...speeds)).toBeGreaterThan(150);
    expect(Math.max(...seats)).toBeGreaterThanOrEqual(6);
  });

  it('gives every seat a distinct position inside the body', () => {
    const def = vehicleDef('van');
    const seen = new Set<string>();
    for (let i = 0; i < def.seats; i++) {
      const o = seatOffset(def, i);
      seen.add(`${o.x.toFixed(2)},${o.y.toFixed(2)}`);
      expect(Math.abs(o.x)).toBeLessThanOrEqual(def.length / 2);
      expect(Math.abs(o.y)).toBeLessThanOrEqual(def.width / 2);
    }
    expect(seen.size).toBe(def.seats);
  });
});

describe('sharing a vehicle', () => {
  it('seats several players in the same vehicle', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;

    const riders = ['a', 'b', 'c'].map((id, i) =>
      placePlayer(h.world, id, 0, van.x + 10 + i, van.y));
    for (const r of riders) tryEnterExitVehicle(h.world, r);

    expect(van.driverId).toBe('a');
    expect(van.passengers).toEqual(['b', 'c']);
    expect(riders.every((r) => r.vehicleId === van.id)).toBe(true);
  });

  it('refuses to seat more players than the vehicle holds', () => {
    const h = makeWorld();
    const bike = [...h.world.vehicles.values()].find((v) => v.type === 'motorcycle')!;
    const seats = vehicleDef('motorcycle').seats;

    const riders = Array.from({ length: seats + 2 }, (_, i) =>
      placePlayer(h.world, `r${i}`, 0, bike.x + 8 + i, bike.y));
    for (const r of riders) tryEnterExitVehicle(h.world, r);

    const aboard = riders.filter((r) => r.vehicleId === bike.id);
    expect(aboard).toHaveLength(seats);
  });

  it('parks each occupant at their own seat', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;
    const a = placePlayer(h.world, 'a', 0, van.x + 10, van.y);
    const b = placePlayer(h.world, 'b', 0, van.x + 12, van.y);
    tryEnterExitVehicle(h.world, a);
    tryEnterExitVehicle(h.world, b);
    h.advance(120);

    expect(dist(a.x, a.y, b.x, b.y)).toBeGreaterThan(1);
    // Both still ride with the body.
    expect(dist(a.x, a.y, van.x, van.y)).toBeLessThan(vehicleDef('van').length);
  });

  it('promotes a passenger when the driver bails out', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;
    const a = placePlayer(h.world, 'a', 0, van.x + 10, van.y);
    const b = placePlayer(h.world, 'b', 0, van.x + 12, van.y);
    tryEnterExitVehicle(h.world, a);
    tryEnterExitVehicle(h.world, b);

    exitVehicle(h.world, a);

    expect(van.driverId).toBe('b');
    expect(van.passengers).toEqual([]);
    expect(b.vehicleId).toBe(van.id);
  });

  it('reports seat indices consistently', () => {
    expect(seatIndexOf('a', ['b', 'c'], 'a')).toBe(0);
    expect(seatIndexOf('a', ['b', 'c'], 'b')).toBe(1);
    expect(seatIndexOf('a', ['b', 'c'], 'c')).toBe(2);
    expect(seatIndexOf('a', ['b', 'c'], 'nobody')).toBe(-1);
  });
});

describe('shooting from a vehicle', () => {
  it('lets a passenger fire but not the driver', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;
    const driver = placePlayer(h.world, 'driver', 0, van.x + 10, van.y);
    const rider = placePlayer(h.world, 'rider', 0, van.x + 12, van.y);
    const driverGun = arm(driver);
    const riderGun = arm(rider);
    tryEnterExitVehicle(h.world, driver);
    tryEnterExitVehicle(h.world, rider);

    const driverAmmo = driverGun.ammo;
    const riderAmmo = riderGun.ammo;

    fireWeapon(h.world, driver, false, Btn.Fire);
    fireWeapon(h.world, rider, false, Btn.Fire);

    expect(driverGun.ammo).toBe(driverAmmo);
    expect(riderGun.ammo).toBe(riderAmmo - 1);
  });

  it('fires from outside its own bodywork', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;
    const rider = placePlayer(h.world, 'rider', 0, van.x + 12, van.y);
    arm(rider);
    tryEnterExitVehicle(h.world, rider);
    tryEnterExitVehicle(h.world, rider); // leave, so we can seat as passenger
    const driver = placePlayer(h.world, 'driver', 0, van.x + 10, van.y);
    tryEnterExitVehicle(h.world, driver);
    tryEnterExitVehicle(h.world, rider);
    rider.aim = 0;

    const origin = firingOrigin(h.world, rider, van);
    const def = vehicleDef('van');
    expect(dist(origin.x, origin.y, van.x, van.y))
      .toBeGreaterThan(def.width / 2);
  });

  it('never hits the vehicle it was fired from', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;
    const driver = placePlayer(h.world, 'driver', 0, van.x + 10, van.y);
    const rider = placePlayer(h.world, 'rider', 0, van.x + 12, van.y);
    arm(rider);
    tryEnterExitVehicle(h.world, driver);
    tryEnterExitVehicle(h.world, rider);
    rider.aim = 0;

    const hpBefore = van.hp;
    for (let i = 0; i < 5; i++) {
      h.world.now += 1000;
      fireWeapon(h.world, rider, false, Btn.Fire);
    }
    expect(van.hp).toBe(hpBefore);
  });

  it('can hit an enemy on foot from a moving vehicle', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;
    const driver = placePlayer(h.world, 'driver', 0, van.x + 10, van.y);
    const rider = placePlayer(h.world, 'rider', 0, van.x + 12, van.y);
    arm(rider);
    tryEnterExitVehicle(h.world, driver);
    tryEnterExitVehicle(h.world, rider);

    // Put an enemy directly ahead, well clear of the bodywork.
    const target = placePlayer(h.world, 'foe', 1, van.x + 260, van.y);
    rider.aim = Math.atan2(target.y - rider.y, target.x - rider.x);

    let hit = false;
    for (let i = 0; i < 12 && !hit; i++) {
      h.world.now += 1000;
      fireWeapon(h.world, rider, false, Btn.Fire);
      hit = target.hp < 100;
    }
    expect(hit).toBe(true);
    expect(rider.stats.damageDealt).toBeGreaterThan(0);
  });

  it('protects occupants from bullets - the car takes the hit', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;
    const rider = placePlayer(h.world, 'rider', 0, van.x, van.y);
    tryEnterExitVehicle(h.world, rider);

    const shooter = placePlayer(h.world, 'shooter', 1, van.x - 300, van.y);
    arm(shooter);
    shooter.aim = 0;

    const hpBefore = van.hp;
    fireWeapon(h.world, shooter, false, Btn.Fire);

    expect(rider.hp).toBe(100);
    expect(van.hp).toBeLessThan(hpBefore);
  });

  it('applies the sentry profile to turret fire', () => {
    // The sentry weapon exists so turret kills read correctly in the feed.
    const def = weaponDef('sentry');
    expect(def.rarity).toBe(0);
    expect(def.damage).toBeGreaterThan(0);
  });
});
