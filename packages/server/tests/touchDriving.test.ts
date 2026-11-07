import { describe, expect, it } from 'vitest';
import { CollisionGrid, drivePedal, getMap, snapToRoad, stepVehicle, vehicleDef } from '@gridlock/shared';

const open = new CollisionGrid({ ...getMap('kestrel-region'), solids: [], water: [] } as never);
const CAR = vehicleDef('car');

/** Drives a car with a fixed stick direction; reports the worst reverse speed and the end pose. */
function drive(rot: number, speed: number, ax: number, ay: number, secs: number, grid = open) {
  const v = { type: 'car' as const, x: 5000, y: 5000, rot, vx: Math.cos(rot) * speed, vy: Math.sin(rot) * speed };
  let minAlong = Infinity;
  for (let t = 0; t < secs * 30; t++) {
    stepVehicle(v, 0, 1 / 30, grid, { x: ax, y: ay });
    minAlong = Math.min(minAlong, v.vx * Math.cos(v.rot) + v.vy * Math.sin(v.rot));
  }
  const along = v.vx * Math.cos(v.rot) + v.vy * Math.sin(v.rot);
  return { v, minAlong, along };
}
const headingErr = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);

describe('touch driving (point where you want to go)', () => {
  // Regression: pointing behind the car used to make it reverse. In a city -
  // after every bump, at every junction - that read as the car going the
  // opposite way to the thumb.
  it('turns round forwards when you point behind the car, instead of reversing', () => {
    const fromRest = drive(0, 0, -1, 0, 2);
    expect(fromRest.minAlong).toBeGreaterThan(-5);
    expect(headingErr(fromRest.v.rot, Math.PI)).toBeLessThan(0.15);

    const atSpeed = drive(0, 350, -1, 0, 2);
    expect(atSpeed.minAlong).toBeGreaterThan(-5);
    expect(headingErr(atSpeed.v.rot, Math.PI)).toBeLessThan(0.15);
  });

  // Regression: with reversing gone, a parked car pointed back the way it
  // faced swung round in a wide forward circle - it looked like a spin and
  // usually clipped a kerb. Nearly stopped, it now turns on the spot.
  it('turns a parked car on the spot to face where you point, then drives off', () => {
    const v = { type: 'car' as const, x: 5000, y: 5000, rot: 0, vx: 0, vy: 0 };
    let facedAt = -1;
    for (let t = 0; t < 45; t++) {
      stepVehicle(v, 0, 1 / 30, open, { x: -1, y: 0 });
      if (facedAt < 0 && headingErr(v.rot, Math.PI) < 0.6) facedAt = t / 30;
      // While turning it stays where it was parked.
      if (facedAt < 0) expect(Math.hypot(v.x - 5000, v.y - 5000)).toBeLessThan(20);
    }
    expect(facedAt).toBeGreaterThan(0);
    expect(facedAt).toBeLessThan(0.9);
    expect(headingErr(v.rot, Math.PI)).toBeLessThan(0.05);
    expect(v.x).toBeLessThan(4950);
  });

  it('backs out only when the nose is against a wall', () => {
    const wall = new CollisionGrid({ ...getMap('kestrel-region'), water: [],
      solids: [{ rect: { x: 5042, y: 4800, w: 60, h: 400 }, kind: 'wall' }] } as never);
    const out = drive(0, 0, 0, -1, 2, wall);
    expect(out.minAlong).toBeLessThan(-20);
    expect(headingErr(out.v.rot, -Math.PI / 2)).toBeLessThan(0.2);
  });

  it('reaches top speed from a half push', () => {
    expect(drivePedal(0.5)).toBe(1);
    expect(drive(0, 0, 0.5, 0, 2).along).toBeCloseTo(CAR.maxSpeed, 0);
    // A light touch still creeps rather than racing off.
    expect(drivePedal(0.05)).toBeLessThan(0.45);
  });

  it('settles along the street when the thumb is a few degrees off', () => {
    expect(snapToRoad(0.17)).toBe(0);
    expect(snapToRoad(Math.PI / 2 - 0.2)).toBeCloseTo(Math.PI / 2);
    // A deliberate diagonal is left alone.
    expect(snapToRoad(Math.PI / 4)).toBeCloseTo(Math.PI / 4);
    const r = drive(0, 0, Math.cos(0.17), Math.sin(0.17), 2);
    expect(headingErr(r.v.rot, 0)).toBeLessThan(0.02);
  });
});
