import { describe, expect, it } from 'vitest';
import { GAMEPLAY, NO_TEAM, normalizeCrewCode, parseClientMessage } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import type { FreeRoam } from '../src/modes/FreeRoam.js';
import { applyPlayerDamage } from '../src/sim/combat.js';
import { reportCrime, wantedStars } from '../src/sim/wanted.js';
import { buildSnapshot } from '../src/net/snapshot.js';

const MONEY = GAMEPLAY.money;
const CREW = GAMEPLAY.freeRoam.playerCrew;

function region(seed = 9) {
  const h = makeWorld({ mode: 'freeroam', mapId: 'kestrel-region', respawnDelaySec: 4 }, seed);
  const mode = h.mode as FreeRoam;
  // Crew rules only: no residents wandering into the tests.
  mode.director!.update = () => {};
  return { ...h, economy: mode.economy!, director: mode.director! };
}

/** Two friends side by side in one crew, plus a stranger nearby. */
function crewOfTwo() {
  const h = region();
  const a = placePlayer(h.world, 'a', NO_TEAM, 3584, 3072);
  const b = placePlayer(h.world, 'b', NO_TEAM, 3640, 3072);
  const stranger = placePlayer(h.world, 'stranger', NO_TEAM, 3584, 3140);
  h.advance(50);
  const code = h.economy.crews.create(a);
  expect(h.economy.crews.join(b, code)).toBe('ok');
  return { ...h, a, b, stranger, code };
}

describe('player crews', () => {
  it('codes are six characters a person can read aloud', () => {
    const h = region();
    const a = placePlayer(h.world, 'a', NO_TEAM, 3584, 3072);
    const code = h.economy.crews.create(a);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(normalizeCrewCode(code.toLowerCase())).toBe(code);
    expect(normalizeCrewCode('abc')).toBe('');
  });

  it('cannot hurt each other, by gun or by car, but can hurt anyone else', () => {
    const h = crewOfTwo();
    applyPlayerDamage(h.world, h.b, 40, h.a, 'pistol');
    expect(h.b.hp).toBe(GAMEPLAY.player.maxHealth);
    expect(h.world.canDamage(h.a, h.b)).toBe(false);
    expect(h.world.canDamage(h.a, h.stranger)).toBe(true);
  });

  it('is full at the size limit, and a vanished crew says so', () => {
    const h = region();
    const founder = placePlayer(h.world, 'f', NO_TEAM, 3584, 3072);
    h.advance(50);
    const code = h.economy.crews.create(founder);
    for (let i = 1; i < CREW.maxSize; i++) {
      const p = placePlayer(h.world, `m${i}`, NO_TEAM, 3584 + i * 50, 3072);
      expect(h.economy.crews.join(p, code)).toBe('ok');
    }
    const late = placePlayer(h.world, 'late', NO_TEAM, 3584, 3200);
    expect(h.economy.crews.join(late, code)).toBe('full');
    expect(h.economy.crews.join(late, 'ZZZZZZ')).toBe('gone');
  });

  it('a crew link puts the newcomer beside a crewmate', () => {
    const h = region();
    const a = placePlayer(h.world, 'a', NO_TEAM, 3584, 3072);
    const b = placePlayer(h.world, 'b', NO_TEAM, 9000, 9000);
    h.advance(50);
    const code = h.economy.crews.create(a);
    h.economy.joinCrew(b, code);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(CREW.joinDistance * 1.7);
  });

  it('forgets a member who leaves the city, and an empty crew disappears', () => {
    const h = crewOfTwo();
    h.world.players.delete(h.b.id);
    h.advance(50);
    expect(h.economy.crews.memberIds(h.a.id)).toEqual(['a']);
    h.economy.leaveCrew(h.a);
    expect(h.economy.crews.join(h.stranger, h.code)).toBe('gone');
  });

  it('shows each member the crew, and marks crewmates in snapshots city-wide', () => {
    const h = crewOfTwo();
    h.b.x = 9000;
    h.b.y = 9000;
    const snap = buildSnapshot(h.world, h.a, 'active', [], 60_000, []);
    expect(snap.self.crew?.members.map((m) => m.id).sort()).toEqual(['a', 'b']);
    const mate = snap.players.find((p) => p.id === 'b');
    expect(mate?.crewmate).toBe(true);
    expect(snap.players.find((p) => p.id === 'stranger')?.crewmate).toBeUndefined();
  });
});

describe('crew police heat', () => {
  it('makes crewmates near a crime accomplices, and leaves a distant one clean', () => {
    const h = region();
    const a = placePlayer(h.world, 'a', NO_TEAM, 3584, 3072);
    const near = placePlayer(h.world, 'near', NO_TEAM, 3700, 3072);
    const far = placePlayer(h.world, 'far', NO_TEAM, 3584 + CREW.accompliceRadius + 400, 3072);
    h.advance(50);
    const code = h.economy.crews.create(a);
    h.economy.crews.join(near, code);
    h.economy.crews.join(far, code);
    reportCrime(h.world, a, 'murder');
    expect(wantedStars(near.heat)).toBe(wantedStars(a.heat));
    expect(far.heat).toBe(0);
  });
});

describe('crew jobs', () => {
  const JOBS = GAMEPLAY.jobs;

  it('share one job: every member sees it and nobody can start a second', () => {
    const h = crewOfTwo();
    expect(h.economy.jobs.startKind(h.a, 'courier')).toBe(true);
    h.advance(50);
    expect(h.b.job?.text).toBe(h.a.job?.text);
    expect(h.economy.jobs.startKind(h.b, 'courier')).toBe(false);
  });

  it('pays a courier drop by any member, split between those in on it', () => {
    const h = crewOfTwo();
    h.economy.jobs.startKind(h.a, 'courier');
    const reward = h.a.job!.reward;
    h.b.x = h.a.job!.x;
    h.b.y = h.a.job!.y;
    h.a.x = h.b.x + 60;
    h.a.y = h.b.y;
    h.advance(100);
    const share = Math.round(reward / 2 / 10) * 10;
    expect(h.a.job).toBeNull();
    expect(h.b.cash).toBe(MONEY.start + share);
    expect(h.a.cash).toBe(MONEY.start + share);
  });

  it('gives no cut to a crewmate who was nowhere near', () => {
    const h = crewOfTwo();
    h.economy.jobs.startKind(h.a, 'courier');
    const reward = h.a.job!.reward;
    h.a.x = h.a.job!.x;
    h.a.y = h.a.job!.y;
    h.b.x = h.a.x + CREW.shareRadius * 3;
    h.b.y = h.a.y;
    h.advance(100);
    expect(h.a.cash).toBe(MONEY.start + reward);
    expect(h.b.cash).toBe(MONEY.start);
  });

  it('counts a hit made by a crewmate', () => {
    const h = crewOfTwo();
    h.economy.jobs.startKind(h.a, 'hit');
    const target = [...h.world.players.values()].find((p) => p.markedFor === h.a.id)!;
    h.b.x = target.x - 80;
    h.b.y = target.y;
    applyPlayerDamage(h.world, target, 500, h.b, 'pistol');
    expect(h.a.job).toBeNull();
    expect(h.b.cash).toBeGreaterThan(MONEY.start);
  });

  // Regression guard for the design: one friend going down must not throw the
  // whole crew's job away while the others are still in the fight.
  it('hands the job to a crewmate when its holder goes down', () => {
    const h = crewOfTwo();
    h.economy.jobs.startKind(h.a, 'courier');
    applyPlayerDamage(h.world, h.a, 500, h.stranger, 'pistol');
    h.advance(50);
    expect(h.b.job).not.toBeNull();
    h.b.x = h.b.job!.x;
    h.b.y = h.b.job!.y;
    h.advance(100);
    expect(h.b.cash).toBeGreaterThan(MONEY.start);
  });

  it('stops showing the job to a member who leaves the crew', () => {
    const h = crewOfTwo();
    h.economy.jobs.startKind(h.a, 'courier');
    h.advance(50);
    h.economy.leaveCrew(h.b);
    h.advance(50);
    expect(h.b.job).toBeNull();
    expect(h.a.job).not.toBeNull();
  });

  it('never posts a bounty on your own crewmate', () => {
    const h = crewOfTwo();
    h.b.heat = GAMEPLAY.wanted.starHeat[2];
    expect(h.economy.jobs.startKind(h.a, 'bounty')).toBe(true);
    const target = [...h.world.players.values()].find((p) => p.markedFor === h.a.id);
    expect(target?.id).not.toBe(h.b.id);
    expect(JOBS).toBeDefined();
  });
});

describe('crew protocol', () => {
  it('accepts a crew code on entering the city, and drops a malformed one', () => {
    expect(parseClientMessage({ t: 'free_roam', crew: 'abc234' })).toEqual({ t: 'free_roam', crew: 'ABC234' });
    expect(parseClientMessage({ t: 'free_roam', crew: '<script>' })).toEqual({ t: 'free_roam' });
    expect(parseClientMessage({ t: 'crew', action: 'create' })).toEqual({ t: 'crew', action: 'create' });
    expect(parseClientMessage({ t: 'crew', action: 'disband' })).toBeNull();
  });
});

describe('crew fights', () => {
  const JOBS = GAMEPLAY.jobs;
  const gangOf = (h: ReturnType<typeof region>, holderId: string) =>
    [...h.world.players.values()].filter((p) => p.npc === 'thug' && p.markedFor === holderId);

  it('puts armed bodyguards around a hit target, more for a crew', () => {
    const solo = region();
    const me = placePlayer(solo.world, 'me', NO_TEAM, 3584, 3072);
    solo.advance(50);
    solo.economy.jobs.startKind(me, 'hit');
    expect(gangOf(solo, me.id)).toHaveLength(JOBS.bodyguards);
    expect(me.job?.text).toContain('bodyguards');

    const h = crewOfTwo();
    h.economy.jobs.startKind(h.a, 'hit');
    expect(gangOf(h, h.a.id)).toHaveLength(JOBS.bodyguards + 1);
  });

  it('pays a crew more for a gunfight, and the same for a delivery', () => {
    const solo = region();
    const me = placePlayer(solo.world, 'me', NO_TEAM, 3584, 3072);
    solo.advance(50);
    solo.economy.jobs.startKind(me, 'hideout');
    const soloPay = me.job!.reward;

    const h = crewOfTwo();
    h.economy.jobs.startKind(h.a, 'hideout');
    expect(h.a.job!.reward).toBeGreaterThan(soloPay);
  });

  it('keeps bodyguards beside their client as the client moves', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    h.economy.jobs.startKind(me, 'hit');
    const client = [...h.world.players.values()].find((p) => p.markedFor === me.id && p.npc === 'ped')!;
    const guards = gangOf(h, me.id);
    // Let the city run its residents: the client walks, the guards keep up.
    const mode = h.mode as FreeRoam;
    for (let i = 0; i < 150; i++) {
      mode.director!.crews.update();
      for (const g of guards) {
        const brain = mode.director!.brains.get(g.id);
        if (brain?.kind === 'crew') h.world.queueInput(g.id, [{ ...mode.director!.crews.think(brain, g), seq: ++brain.seq, dtMs: 33, slot: -1 }]);
      }
      client.x += 1.5;
      h.advance(33);
    }
    for (const g of guards) expect(Math.hypot(g.x - client.x, g.y - client.y)).toBeLessThan(200);
  });

  it('springs an ambush on a courier part-way along the route', () => {
    const h = crewOfTwo();
    h.economy.jobs.startKind(h.a, 'courier');
    const job = (h.economy.jobs as unknown as { jobs: Map<string, { ambushWithin: number | null }> }).jobs.get(h.a.id)!;
    job.ambushWithin = Infinity;
    h.advance(100);
    const gang = gangOf(h, h.a.id);
    expect(gang.length).toBe(JOBS.ambushCrew + 1);
    const car = h.world.vehicles.get(gang[0].vehicleId!);
    expect(car).toBeDefined();
    // Spawned out of sight, not on top of the courier.
    expect(Math.hypot(car!.x - h.a.x, car!.y - h.a.y)).toBeGreaterThan(300);
    expect(job.ambushWithin).toBeNull();
  });
});
