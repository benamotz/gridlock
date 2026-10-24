import { describe, expect, it } from 'vitest';
import { GAMEPLAY, NO_TEAM } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import type { FreeRoam } from '../src/modes/FreeRoam.js';
import { applyPlayerDamage, applyVehicleDamage } from '../src/sim/combat.js';
import { wantedStars } from '../src/sim/wanted.js';
import type { PlayerEntity } from '../src/sim/entities.js';

const JOBS = GAMEPLAY.jobs;
const MONEY = GAMEPLAY.money;

function city(seed = 21) {
  const h = makeWorld({ mode: 'freeroam', mapId: 'kestrel-region', respawnDelaySec: 4 }, seed);
  const mode = h.mode as FreeRoam;
  const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
  // Plenty of health: these tests watch the crew, not how fast it wins.
  me.hp = 1e6;
  let seq = 0;
  const run = (ms: number) => {
    const ticks = Math.round(ms / (h.world.dt * 1000));
    for (let i = 0; i < ticks; i++) {
      h.world.queueInput('me', [{ seq: ++seq, dtMs: h.world.dt * 1000, buttons: 0, aim: 0, slot: -1 }]);
      h.advance(h.world.dt * 1000);
    }
  };
  return { ...h, mode, me, run, jobs: mode.economy!.jobs, crews: mode.director!.crews };
}

const crew = (world: { players: Map<string, PlayerEntity> }) =>
  [...world.players.values()].filter((p) => p.npc === 'thug' && p.life === 'alive');

/** Stand somewhere open, this far from the hideout. */
function approach(h: ReturnType<typeof city>, range: number): void {
  const { x, y } = h.me.job!;
  for (const [dx, dy] of [[range, 0], [-range, 0], [0, range], [0, -range]]) {
    if (!h.world.grid.circleBlocked(x + dx, y + dy, 14)) {
      h.me.x = x + dx;
      h.me.y = y + dy;
      return;
    }
  }
  throw new Error('no open spot near the hideout');
}

describe('crew hideout', () => {
  it('holds its ground until the player comes close', () => {
    const h = city();
    expect(h.jobs.startKind(h.me, 'hideout')).toBe(true);
    expect(crew(h.world).length).toBe(JOBS.hideoutCrew);
    h.world.events = [];
    h.run(2000);
    expect(h.world.events.some((e) => e.e === 'damage' && e.to === 'me')).toBe(false);
  });

  it('opens fire once the player is spotted, after a moment to react', () => {
    const h = city();
    h.jobs.startKind(h.me, 'hideout');
    h.run(500);
    approach(h, 280);
    h.world.events = [];
    h.run(GAMEPLAY.crew.reactionMs - 200);
    expect(h.world.events.some((e) => e.e === 'damage' && e.to === 'me')).toBe(false);
    h.run(3000);
    expect(h.world.events.some((e) => e.e === 'damage' && e.to === 'me')).toBe(true);
  });

  it('never shoots itself: a crossfire leaves the whole crew standing', () => {
    const h = city();
    h.jobs.startKind(h.me, 'hideout');
    h.run(500);
    approach(h, 200);
    h.run(4000);
    expect(crew(h.world).length).toBe(JOBS.hideoutCrew);
  });

  it('is survivable for a few seconds in the open', () => {
    const h = city();
    h.jobs.startKind(h.me, 'hideout');
    h.run(500);
    approach(h, 280);
    let dealt = 0;
    for (let i = 0; i < 30; i++) {
      h.run(100);
      for (const e of h.world.events) if (e.e === 'damage' && e.to === 'me') dealt += e.amount;
      h.world.events = [];
    }
    // Three seconds facing the whole crew: hurt badly, but not a one-second wipe.
    expect(dealt).toBeGreaterThan(30);
    expect(dealt).toBeLessThan(260);
  });

  it('pays out once every gunman is down, and is never treated as murder', () => {
    const h = city();
    h.run(50);
    h.jobs.startKind(h.me, 'hideout');
    const reward = h.me.job!.reward;
    const before = h.me.cash;
    for (const p of crew(h.world)) applyPlayerDamage(h.world, p, 1000, h.me, 'smg');
    h.run(100);
    expect(h.me.job).toBeNull();
    expect(h.me.cash).toBe(before + reward);
    // Each kill is noise (an assault), not murder: five of them make two stars.
    expect(wantedStars(h.me.heat)).toBeLessThanOrEqual(2);
    // And the crew's wallets and guns are left behind.
    expect(h.world.moneyDrops.size).toBeGreaterThan(0);
  });
});

describe('escorted cash van', () => {
  it('sends armed guards behind the van', () => {
    const h = city();
    expect(h.jobs.startKind(h.me, 'armored')).toBe(true);
    const guards = crew(h.world);
    expect(guards.length).toBe(JOBS.escortCrew);
    expect(guards.every((g) => g.vehicleId !== null)).toBe(true);
    const van = [...h.world.vehicles.values()].find((v) => v.security)!;
    h.run(3000);
    const car = h.world.vehicles.get(guards[0].vehicleId!)!;
    expect(Math.hypot(car.x - van.x, car.y - van.y)).toBeLessThan(400);
  });

  it('jumps out and fights when the van is attacked', () => {
    const h = city();
    h.jobs.startKind(h.me, 'armored');
    h.run(1000);
    const van = [...h.world.vehicles.values()].find((v) => v.security)!;
    h.me.x = van.x + 220;
    h.me.y = van.y;
    if (h.world.grid.circleBlocked(h.me.x, h.me.y, 14)) h.me.x = van.x - 220;
    applyVehicleDamage(h.world, van, 20, h.me);
    h.run(1500);
    expect(crew(h.world).every((g) => g.vehicleId === null)).toBe(true);
    // Step out where a guard has a clear view (and no vehicle in the way).
    const guard = crew(h.world)[0];
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const x = guard.x + Math.cos(a) * 250;
      const y = guard.y + Math.sin(a) * 250;
      const clearOfCars = [...h.world.vehicles.values()].every((v) => Math.hypot(v.x - (guard.x + x) / 2, v.y - (guard.y + y) / 2) > 80);
      if (!h.world.grid.circleBlocked(x, y, 14) && h.world.grid.lineOfSight(guard.x, guard.y, x, y) && clearOfCars) {
        h.me.x = x;
        h.me.y = y;
        break;
      }
    }
    h.world.events = [];
    h.run(3000);
    expect(h.world.events.some((e) => e.e === 'damage' && e.to === 'me')).toBe(true);
  });

  it('only ever fights the player the job set it against', () => {
    const h = city();
    const bystander = placePlayer(h.world, 'bystander', NO_TEAM, 3584, 3072);
    bystander.hp = 1e6;
    h.jobs.startKind(h.me, 'hideout');
    h.run(500);
    bystander.x = h.me.job!.x + 150;
    bystander.y = h.me.job!.y;
    if (h.world.grid.circleBlocked(bystander.x, bystander.y, 14)) bystander.x = h.me.job!.x - 150;
    h.world.events = [];
    h.run(3000);
    expect(h.world.events.some((e) => e.e === 'damage' && e.to === 'bystander' &&
      crew(h.world).some((c) => Math.hypot(c.x - e.fromX, c.y - e.fromY) < 1))).toBe(false);
  });
});

describe('job money with crews', () => {
  it('the hideout is Vera’s finale, at finale pay', () => {
    const h = city();
    h.run(50);
    // Three jobs for Vera, then the finale.
    for (let i = 0; i < JOBS.trustForFinale; i++) {
      h.jobs.startKind(h.me, 'courier');
      expect(h.me.job!.contact).toBe('Vera Lowe');
      h.me.x = h.me.job!.x;
      h.me.y = h.me.job!.y;
      h.run(100);
    }
    h.jobs.phone(h.me, 0);
    expect(h.me.job!.kind).toBe('hideout');
    expect(h.me.job!.reward).toBe(JOBS.hideoutReward * JOBS.finaleMultiplier);
    expect(MONEY.start).toBeGreaterThan(0);
  });
});
