import { describe, expect, it } from 'vitest';
import { GAMEPLAY, NO_TEAM } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { applyPlayerDamage, destroyVehicle } from '../src/sim/combat.js';
import { reportCrime, wantedStars } from '../src/sim/wanted.js';
import { buildSnapshot } from '../src/net/snapshot.js';

const W = GAMEPLAY.wanted;

function city() {
  const h = makeWorld({ mode: 'freeroam', respawnDelaySec: 4 });
  const a = placePlayer(h.world, 'a', NO_TEAM, 1100, 200);
  const b = placePlayer(h.world, 'b', NO_TEAM, 1160, 200);
  return { ...h, a, b };
}

describe('wanted level', () => {
  it('gives an attacker one star for an assault', () => {
    const { world, a, b } = city();
    applyPlayerDamage(world, b, 10, a, 'pistol');
    expect(wantedStars(a.heat)).toBe(1);
    expect(wantedStars(b.heat)).toBe(0);
  });

  it('counts a burst on one victim as a single assault', () => {
    const { world, a, b } = city();
    for (let i = 0; i < 6; i++) applyPlayerDamage(world, b, 3, a, 'shotgun');
    expect(a.heat).toBe(W.crimeHeat.assault);
  });

  it('escalates with murder', () => {
    const { world, a, b } = city();
    applyPlayerDamage(world, b, 500, a, 'pistol');
    expect(b.life).toBe('dead');
    expect(wantedStars(a.heat)).toBe(2);
  });

  it('does not make it a crime to attack someone who is already wanted', () => {
    const { world, a, b } = city();
    applyPlayerDamage(world, b, 10, a, 'pistol');
    expect(wantedStars(a.heat)).toBe(1);

    applyPlayerDamage(world, a, 500, b, 'pistol');
    expect(b.heat).toBe(0);
  });

  it('clears the victim’s own level when they die', () => {
    const { world, a, b } = city();
    applyPlayerDamage(world, b, 10, a, 'pistol');
    applyPlayerDamage(world, a, 500, b, 'pistol');
    expect(a.heat).toBe(0);
  });

  it('treats wrecking a vehicle as vandalism, but not crashing your own', () => {
    const { world, a } = city();
    const [v1, v2] = [...world.vehicles.values()];
    destroyVehicle(world, v1, a);
    expect(a.heat).toBe(W.crimeHeat.vandalism);

    const before = a.heat;
    a.vehicleId = v2.id;
    v2.driverId = a.id;
    destroyVehicle(world, v2, a);
    expect(a.heat).toBe(before);
  });

  it('cools off one star at a time once the offender lies low', () => {
    const { world, a, advance } = city();
    for (let i = 0; i < 4; i++) reportCrime(world, a, 'murder');
    const start = wantedStars(a.heat);
    expect(start).toBe(3);

    advance(W.coolDelaySec * 1000 - 500);
    expect(wantedStars(a.heat)).toBe(start);

    advance(1000);
    expect(wantedStars(a.heat)).toBe(start - 1);
    advance(W.coolStepSec * 1000);
    expect(wantedStars(a.heat)).toBe(start - 2);
    advance(W.coolStepSec * 1000);
    expect(a.heat).toBe(0);
  });

  it('restarts the cool-off when a new crime happens', () => {
    const { world, a, advance } = city();
    reportCrime(world, a, 'murder');
    advance(W.coolDelaySec * 1000 - 1000);
    reportCrime(world, a, 'vandalism');
    advance(2000);
    expect(wantedStars(a.heat)).toBe(2);
  });

  it('caps at five stars', () => {
    const { world, a } = city();
    for (let i = 0; i < 40; i++) reportCrime(world, a, 'murder');
    expect(wantedStars(a.heat)).toBe(W.maxStars);
  });

  it('does not exist outside free roam', () => {
    const h = makeWorld({ mode: 'tdm' });
    const a = placePlayer(h.world, 'a', 0, 1100, 200);
    const b = placePlayer(h.world, 'b', 1, 1160, 200);
    applyPlayerDamage(h.world, b, 500, a, 'pistol');
    expect(a.heat).toBe(0);
  });

  it('shows everyone the stars but only the offender the crime callout', () => {
    const { world, a, b } = city();
    applyPlayerDamage(world, b, 10, a, 'pistol');
    const events = world.events;

    const mine = buildSnapshot(world, a, 'active', [], 0, events);
    expect(mine.self.wanted).toBe(1);
    expect(mine.events.some((e) => e.e === 'crime')).toBe(true);

    const theirs = buildSnapshot(world, b, 'active', [], 0, events);
    expect(theirs.players.find((p) => p.id === 'a')?.wanted).toBe(1);
    expect(theirs.events.some((e) => e.e === 'crime')).toBe(false);
  });
});
