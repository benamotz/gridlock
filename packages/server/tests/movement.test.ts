import { describe, expect, it } from 'vitest';
import {
  Btn, CollisionGrid, GAMEPLAY, getMap, stepPlayerMovement, stepVehicle,
} from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { tryEnterExitVehicle, exitVehicle } from '../src/sim/vehicles.js';

const grid = () => new CollisionGrid(getMap('depot-yard'));

const actor = (x: number, y: number) => ({
  x, y, vx: 0, vy: 0, stamina: 100, sprinting: false,
});

describe('player movement', () => {
  it('moves in the pressed direction', () => {
    const g = grid();
    const a = actor(960, 300);
    for (let i = 0; i < 10; i++) stepPlayerMovement(a, 'pistol', Btn.Right, 1 / 30, g);
    expect(a.x).toBeGreaterThan(960);
  });

  it('cannot walk through a building', () => {
    const g = grid();
    const map = getMap('depot-yard');
    const wall = map.solids.find((s) => s.kind === 'building')!;
    // Start just left of the wall and push right for a full second.
    const a = actor(wall.rect.x - GAMEPLAY.player.radius - 4, wall.rect.y + wall.rect.h / 2);
    for (let i = 0; i < 60; i++) stepPlayerMovement(a, 'pistol', Btn.Right, 1 / 30, g);
    expect(g.circleBlocked(a.x, a.y, GAMEPLAY.player.radius)).toBe(false);
    expect(a.x).toBeLessThan(wall.rect.x);
  });

  it('slides along a wall instead of sticking to it', () => {
    const g = grid();
    const map = getMap('depot-yard');
    const wall = map.solids.find((s) => s.kind === 'building')!;
    const a = actor(wall.rect.x - GAMEPLAY.player.radius - 2, wall.rect.y + 10);
    const y0 = a.y;
    for (let i = 0; i < 30; i++) {
      stepPlayerMovement(a, 'pistol', Btn.Right | Btn.Down, 1 / 30, g);
    }
    expect(a.y).toBeGreaterThan(y0 + 20);
  });

  it('drains stamina while sprinting and refills it at rest', () => {
    const g = grid();
    const a = actor(960, 300);
    for (let i = 0; i < 60; i++) {
      stepPlayerMovement(a, 'pistol', Btn.Right | Btn.Sprint, 1 / 30, g);
    }
    expect(a.stamina).toBeLessThan(GAMEPLAY.player.staminaMax);

    const drained = a.stamina;
    for (let i = 0; i < 60; i++) stepPlayerMovement(a, 'pistol', 0, 1 / 30, g);
    expect(a.stamina).toBeGreaterThan(drained);
  });

  it('never exceeds the sprint speed in one step', () => {
    const g = grid();
    const a = actor(960, 300);
    for (let i = 0; i < 120; i++) {
      stepPlayerMovement(a, 'pistol', Btn.Right | Btn.Down | Btn.Sprint, 1 / 30, g);
    }
    expect(Math.hypot(a.vx, a.vy)).toBeLessThanOrEqual(GAMEPLAY.player.sprintSpeed + 1);
  });
});

describe('collision recovery', () => {
  it('pushes an actor that starts inside a solid back out', () => {
    const g = grid();
    const map = getMap('depot-yard');
    const b = map.solids.find((s) => s.kind === 'building')!.rect;
    const inside = { x: b.x + b.w / 2, y: b.y + b.h / 2 };

    const freed = g.resolvePenetration(inside.x, inside.y, GAMEPLAY.player.radius);
    expect(g.circleBlocked(freed.x, freed.y, GAMEPLAY.player.radius)).toBe(false);
  });

  it('frees a player who is stuck, so they can move again', () => {
    // Regression: an actor shoved inside geometry found every candidate
    // position blocked and could never move again.
    const g = grid();
    const map = getMap('depot-yard');
    const b = map.solids.find((s) => s.kind === 'building')!.rect;
    const a = actor(b.x + b.w / 2, b.y + b.h / 2);
    const start = { x: a.x, y: a.y };

    for (let i = 0; i < 20; i++) stepPlayerMovement(a, 'pistol', Btn.Right, 1 / 30, g);

    expect(g.circleBlocked(a.x, a.y, GAMEPLAY.player.radius)).toBe(false);
    expect(Math.hypot(a.x - start.x, a.y - start.y)).toBeGreaterThan(1);
  });

  it('keeps actors inside the world bounds', () => {
    const g = grid();
    const freed = g.resolvePenetration(-500, -500, GAMEPLAY.player.radius);
    expect(freed.x).toBeGreaterThanOrEqual(GAMEPLAY.player.radius);
    expect(freed.y).toBeGreaterThanOrEqual(GAMEPLAY.player.radius);
  });
});

describe('vehicles', () => {
  it('accelerates forward and can be steered', () => {
    const g = grid();
    const v = { x: 960, y: 300, vx: 0, vy: 0, rot: 0, type: 'car' as const };
    for (let i = 0; i < 45; i++) stepVehicle(v, Btn.Up, 1 / 30, g);
    expect(v.x).toBeGreaterThan(960);

    const rot0 = v.rot;
    for (let i = 0; i < 20; i++) stepVehicle(v, Btn.Up | Btn.Right, 1 / 30, g);
    expect(v.rot).not.toBe(rot0);
  });

  it('coasts to a stop with no throttle', () => {
    const g = grid();
    const v = { x: 960, y: 300, vx: 0, vy: 0, rot: 0, type: 'car' as const };
    for (let i = 0; i < 30; i++) stepVehicle(v, Btn.Up, 1 / 30, g);
    const moving = Math.hypot(v.vx, v.vy);
    for (let i = 0; i < 180; i++) stepVehicle(v, 0, 1 / 30, g);
    expect(Math.hypot(v.vx, v.vy)).toBeLessThan(moving);
  });

  it('lets a player enter and leave a nearby vehicle', () => {
    const { world } = makeWorld();
    const veh = [...world.vehicles.values()][0];
    const p = placePlayer(world, 'p', 0, veh.x + 20, veh.y);

    tryEnterExitVehicle(world, p);
    expect(p.vehicleId).toBe(veh.id);
    expect(veh.driverId).toBe('p');

    tryEnterExitVehicle(world, p);
    expect(p.vehicleId).toBeNull();
    expect(veh.driverId).toBeNull();
    expect(world.grid.circleBlocked(p.x, p.y, GAMEPLAY.player.radius)).toBe(false);
  });

  it('gives the driver seat to only one of two players', () => {
    const { world } = makeWorld();
    const veh = [...world.vehicles.values()][0];
    const a = placePlayer(world, 'a', 0, veh.x + 15, veh.y);
    const b = placePlayer(world, 'b', 0, veh.x - 15, veh.y);

    tryEnterExitVehicle(world, a);
    tryEnterExitVehicle(world, b);

    expect(veh.driverId).toBe('a');
    expect(veh.passengers).toContain('b');
  });

  it('places an exiting player somewhere legal even if the car is wedged', () => {
    const { world } = makeWorld();
    const veh = [...world.vehicles.values()][0];
    const p = placePlayer(world, 'p', 0, veh.x, veh.y);
    tryEnterExitVehicle(world, p);

    // Pretend the car came to rest inside geometry.
    const wall = world.mapDef.solids.find((s) => s.kind === 'building')!.rect;
    veh.x = wall.x + wall.w / 2;
    veh.y = wall.y + wall.h / 2;

    exitVehicle(world, p);
    expect(world.grid.circleBlocked(p.x, p.y, GAMEPLAY.player.radius)).toBe(false);
  });
});
