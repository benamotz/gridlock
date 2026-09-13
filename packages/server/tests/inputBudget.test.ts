import { describe, expect, it } from 'vitest';
import { Btn, GAMEPLAY, type InputCommand } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { tryEnterExitVehicle } from '../src/sim/vehicles.js';

const cmd = (seq: number, dtMs: number, buttons = 0): InputCommand => ({
  seq, dtMs, buttons, aim: 0, slot: -1,
});

describe('server input consumption', () => {
  it('keeps up with a 120 Hz display instead of queueing its input', () => {
    // Regression: a fixed three-commands-per-tick cap let a 120 Hz client, which
    // sends four short commands a tick, fall about 800 ms behind; predicted
    // vehicles then snapped by up to 140 units.
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    let seq = 1;
    for (let tick = 0; tick < 300; tick++) {
      h.world.queueInput('p', Array.from({ length: 4 }, () => cmd(seq++, 1000 / 120)));
      h.advance(h.world.dt * 1000);
    }
    expect(p.pending.length).toBeLessThanOrEqual(4);
  });

  it('never lets a flood of commands move a player faster than real time', () => {
    const h = makeWorld();
    const p = placePlayer(h.world, 'p', 0, 1100, 200);
    // Far more than a second of commands, delivered all at once.
    h.world.queueInput(
      'p', Array.from({ length: 90 }, (_, i) => cmd(i + 1, 60, Btn.Right)),
    );
    h.advance(1000);
    const simulatedMs = p.lastProcessedSeq * 60;
    expect(simulatedMs).toBeLessThanOrEqual(1000 + GAMEPLAY.inputBankMs);
  });

  it('does not move a driver during a brief gap in their input, only after a stall', () => {
    // A late packet is jitter: the client has already predicted those frames,
    // so moving the vehicle without them made the driver's view snap back.
    const h = makeWorld();
    const car = [...h.world.vehicles.values()].find((v) => v.type === 'car')!;
    for (const v of [...h.world.vehicles.values()]) if (v !== car) h.world.vehicles.delete(v.id);
    const driver = placePlayer(h.world, 'd', 0, car.x, car.y + 30);
    tryEnterExitVehicle(h.world, driver);
    expect(car.driverId).toBe('d');

    const tickMs = h.world.dt * 1000;
    for (let seq = 1; seq <= 8; seq++) {
      h.world.queueInput('d', [cmd(seq, tickMs, Btn.Up)]);
      h.advance(tickMs);
    }
    const speed = Math.hypot(car.vx, car.vy);
    expect(speed).toBeGreaterThan(0);

    const held = { x: car.x, y: car.y };
    h.advance(GAMEPLAY.inputStallMs * 0.6);
    expect(car.x).toBeCloseTo(held.x, 6);
    expect(car.y).toBeCloseTo(held.y, 6);

    h.advance(GAMEPLAY.inputStallMs * 2);
    expect(Math.hypot(car.x - held.x, car.y - held.y)).toBeGreaterThan(0);
    expect(Math.hypot(car.vx, car.vy)).toBeLessThan(speed);
  });
});
