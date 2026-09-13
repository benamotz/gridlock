import { describe, expect, it } from 'vitest';
import {
  Btn, CollisionGrid, GAMEPLAY, VEHICLES, getMap, stepVehicle, vehicleBodyCircles,
  vehicleBodyWorld, vehicleDef,
} from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { applyPlayerDamage, applyVehicleDamage, destroyVehicle } from '../src/sim/combat.js';
import { tryEnterExitVehicle } from '../src/sim/vehicles.js';

const types = Object.keys(VEHICLES) as (keyof typeof VEHICLES)[];
const dt = 1 / 30;
// The west face of depot-yard's centre block.
const WALL = { x: 890, y: 500, w: 140, h: 90 };

describe('vehicle bodies', () => {
  it.each(types)('%s body reaches exactly its nose and tail', (type) => {
    const def = vehicleDef(type);
    const { radius, offsets } = vehicleBodyCircles(def);
    expect(Math.max(...offsets) + radius).toBeCloseTo(def.length / 2, 5);
    expect(Math.min(...offsets) - radius).toBeCloseTo(-def.length / 2, 5);
  });

  it.each(types)('%s never drives its nose into a building', (type) => {
    const grid = new CollisionGrid(getMap('depot-yard'));
    const def = vehicleDef(type);
    const v = { x: 600, y: WALL.y + WALL.h / 2, vx: 0, vy: 0, rot: 0, type };
    for (let i = 0; i < 120; i++) stepVehicle(v, Btn.Up, dt, grid);
    // Regression: with one circle of width/2 a truck's nose ended 38 units inside.
    expect(v.x + def.length / 2).toBeLessThanOrEqual(WALL.x + 1.5);
  });

  it.each(types)('%s cannot turn its body through a wall', (type) => {
    const grid = new CollisionGrid(getMap('depot-yard'));
    const def = vehicleDef(type);
    // Parked alongside the wall, then steered hard into it.
    const v = {
      x: WALL.x - def.width / 2 - 2, y: WALL.y + WALL.h / 2, vx: 0, vy: 0,
      rot: Math.PI / 2, type,
    };
    for (let i = 0; i < 90; i++) stepVehicle(v, Btn.Up | Btn.Left, dt, grid);
    for (const c of vehicleBodyWorld(v)) {
      expect(grid.circleBlocked(c.x, c.y, c.r - 1.5)).toBe(false);
    }
  });

  it('frees a vehicle that starts embedded in a building', () => {
    const grid = new CollisionGrid(getMap('depot-yard'));
    const v = { x: WALL.x + 10, y: WALL.y + WALL.h / 2, vx: 0, vy: 0, rot: 0, type: 'truck' as const };
    for (let i = 0; i < 10; i++) stepVehicle(v, 0, dt, grid);
    for (const c of vehicleBodyWorld(v)) {
      expect(grid.circleBlocked(c.x, c.y, c.r - 1.5)).toBe(false);
    }
  });

  it('stops a motorcycle from riding inside another vehicle', () => {
    const h = makeWorld();
    const van = [...h.world.vehicles.values()].find((v) => v.type === 'van')!;
    const bike = [...h.world.vehicles.values()].find((v) => v.type === 'motorcycle')!;
    bike.x = van.x + 20;
    bike.y = van.y + 4;
    bike.rot = van.rot;
    h.advance(200);

    let deepest = 0;
    for (const a of vehicleBodyWorld(van)) {
      for (const b of vehicleBodyWorld(bike)) {
        deepest = Math.max(deepest, a.r + b.r - Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(deepest).toBeLessThan(2);
  });

  it('boards from beside a long vehicle, not only near its centre', () => {
    const h = makeWorld();
    const truck = [...h.world.vehicles.values()].find((v) => v.type === 'truck')!;
    const def = vehicleDef('truck');
    // Standing by the tail, well past a centre-only reach.
    const tailX = truck.x - Math.cos(truck.rot) * (def.length / 2 - 8);
    const tailY = truck.y - Math.sin(truck.rot) * (def.length / 2 - 8);
    const p = placePlayer(
      h.world, 'p', 0,
      tailX - Math.sin(truck.rot) * (def.width / 2 + 20),
      tailY + Math.cos(truck.rot) * (def.width / 2 + 20),
    );
    tryEnterExitVehicle(h.world, p);
    expect(p.vehicleId).toBe(truck.id);
  });

  it('steps a player out clear of even the widest body', () => {
    const h = makeWorld();
    for (const type of ['truck', 'armored', 'van'] as const) {
      const v = [...h.world.vehicles.values()].find((x) => x.type === type)!;
      const p = placePlayer(h.world, `p-${type}`, 0, v.x, v.y);
      tryEnterExitVehicle(h.world, p);
      tryEnterExitVehicle(h.world, p);
      expect(p.vehicleId).toBeNull();
      for (const c of vehicleBodyWorld(v)) {
        expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeGreaterThanOrEqual(c.r);
      }
    }
  });
});

describe('riding and dying on a motorcycle', () => {
  const mount = (h: ReturnType<typeof makeWorld>, id = 'rider', team = 0) => {
    const bike = [...h.world.vehicles.values()].find((v) => v.type === 'motorcycle')!;
    const rider = placePlayer(h.world, id, team, bike.x, bike.y);
    tryEnterExitVehicle(h.world, rider);
    return { bike, rider };
  };

  it('survives repeated hard crashes into a wall', () => {
    const h = makeWorld();
    const { bike, rider } = mount(h);
    let seq = 1;
    for (let lap = 0; lap < 4; lap++) {
      bike.x = 600; bike.y = WALL.y + WALL.h / 2; bike.rot = 0; bike.vx = 0; bike.vy = 0;
      for (let i = 0; i < 60; i++) {
        h.world.queueInput('rider', [{ seq: seq++, dtMs: 33, buttons: Btn.Up, aim: 0, slot: -1 }]);
        h.world.step();
      }
    }
    // Regression: three crashes used to destroy the bike and nearly kill the rider.
    expect(bike.destroyed).toBe(false);
    expect(rider.hp).toBe(GAMEPLAY.player.maxHealth);
  });

  it('breaks apart rather than exploding when destroyed', () => {
    const h = makeWorld();
    const { bike } = mount(h);
    h.world.events = [];
    destroyVehicle(h.world, bike, null);
    expect(h.world.events.some((e) => e.e === 'explosion')).toBe(false);
  });

  it('leaves a rider shot dead where they fell', () => {
    const h = makeWorld();
    const { rider } = mount(h);
    const shooter = placePlayer(h.world, 'shooter', 1, rider.x, rider.y - 200);
    const where = { x: rider.x, y: rider.y };

    applyPlayerDamage(h.world, rider, 500, shooter, 'marksman');
    expect(rider.life).toBe('dead');
    // Regression: the body used to be moved 34 units to the kerb.
    expect(Math.hypot(rider.x - where.x, rider.y - where.y)).toBeLessThan(1);
    expect(rider.vehicleId).toBeNull();
  });

  it('stops quickly with nobody on it instead of rolling away', () => {
    const h = makeWorld();
    const { bike, rider } = mount(h);
    bike.rot = 0; bike.vx = 300; bike.vy = 0;
    applyPlayerDamage(h.world, rider, 500, null, 'marksman');
    const x0 = bike.x;
    h.advance(1500);
    // Regression: it used to coast a further 170 units.
    expect(Math.abs(bike.x - x0)).toBeLessThan(60);
  });

  it('hands the handlebars to the passenger when the rider is killed', () => {
    const h = makeWorld();
    const { bike, rider } = mount(h);
    const pillion = placePlayer(h.world, 'pillion', 0, bike.x, bike.y);
    tryEnterExitVehicle(h.world, pillion);
    applyPlayerDamage(h.world, rider, 500, null, 'marksman');
    expect(bike.driverId).toBe('pillion');
    expect(pillion.vehicleId).toBe(bike.id);
  });
});

describe('credit for wreck kills', () => {
  it("credits the enemy who wrecked a vehicle, not the driver's final crash", () => {
    const h = makeWorld();
    const car = [...h.world.vehicles.values()].find((v) => v.type === 'car')!;
    const driver = placePlayer(h.world, 'driver', 0, car.x, car.y);
    tryEnterExitVehicle(h.world, driver);
    const enemy = placePlayer(h.world, 'enemy', 1, car.x + 300, car.y);
    driver.hp = 10;

    applyVehicleDamage(h.world, car, car.hp - 1, enemy);
    h.world.events = [];
    // The driver's own crash deals the final point of damage.
    applyVehicleDamage(h.world, car, 5, driver);

    const kill = h.world.events.find((e) => e.e === 'kill');
    expect(kill).toMatchObject({ killer: 'enemy', victim: 'driver' });
    expect(enemy.stats.kills).toBe(1);
  });

  it("does not let the crew's own crash erase an enemy's damage credit", () => {
    const h = makeWorld();
    const car = [...h.world.vehicles.values()].find((v) => v.type === 'car')!;
    const driver = placePlayer(h.world, 'driver', 0, car.x, car.y);
    tryEnterExitVehicle(h.world, driver);
    const enemy = placePlayer(h.world, 'enemy', 1, car.x + 300, car.y);

    applyVehicleDamage(h.world, car, 20, enemy);
    applyVehicleDamage(h.world, car, 20, driver);
    expect(car.lastDamagedBy).toBe('enemy');
  });

  it('scales the wreck blast with the vehicle', () => {
    expect(vehicleDef('motorcycle').wreckBlast).toBe(0);
    expect(vehicleDef('truck').wreckBlast).toBeGreaterThan(vehicleDef('car').wreckBlast);
  });
});

describe('parked vehicles', () => {
  it('gives every Harbor Reach base a van and a motorcycle', () => {
    const map = getMap('harbor-reach');
    for (const { zone } of map.teamSpawns) {
      const zx = zone.x + zone.w / 2;
      const zy = zone.y + zone.h / 2;
      for (const type of ['van', 'motorcycle'] as const) {
        const nearby = map.vehicleSpawns.some(
          (v) => v.type === type && Math.hypot(v.x - zx, v.y - zy) < 520,
        );
        expect(nearby, `${type} near base at ${zx},${zy}`).toBe(true);
      }
    }
  });

  it('keeps base vehicles out of the spawn zone', () => {
    const map = getMap('harbor-reach');
    for (const v of map.vehicleSpawns) {
      for (const { zone } of map.teamSpawns) {
        for (const c of vehicleBodyWorld(v)) {
          const inside = c.x + c.r > zone.x && c.x - c.r < zone.x + zone.w &&
            c.y + c.r > zone.y && c.y - c.r < zone.y + zone.h;
          expect(inside, `${v.type} at ${v.x},${v.y} overlaps a spawn zone`).toBe(false);
        }
      }
    }
  });

  it('face the map centre at every Harbor Reach base', () => {
    const map = getMap('harbor-reach');
    // Each base's own van: the nearest van to its spawn zone. Rolled traffic
    // on the north-south avenues faces along the road instead.
    const baseVans = map.teamSpawns.map(({ zone }) => {
      const zx = zone.x + zone.w / 2;
      const zy = zone.y + zone.h / 2;
      const near = map.vehicleSpawns
        .filter((v) => v.type === 'van' && Math.hypot(v.x - zx, v.y - zy) < 520)
        .sort((a, b) => Math.hypot(a.x - zx, a.y - zy) - Math.hypot(b.x - zx, b.y - zy));
      return near[0];
    });
    // Regression: both northern bases had lost their vehicles to spawn pruning.
    expect(baseVans.every(Boolean)).toBe(true);
    for (const v of baseVans) {
      const towardCentre = Math.sign(map.width / 2 - v!.x);
      expect(Math.sign(Math.cos(v!.rot))).toBe(towardCentre);
    }
  });
});
