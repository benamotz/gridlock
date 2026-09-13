import { describe, expect, it } from 'vitest';
import {
  CollisionGrid, DEFAULT_MATCH_CONFIG, getMap, mapIds, vehicleBodyWorld,
} from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { applyPlayerDamage } from '../src/sim/combat.js';
import { TeamDeathmatch } from '../src/modes/TeamDeathmatch.js';
import { selectSpawn } from '../src/sim/spawn.js';
import { buildLoadout, SLOT_MELEE, SLOT_PRIMARY, SLOT_SIDEARM } from '../src/sim/loadout.js';
import { makeRng } from '@gridlock/shared';

const config = (patch = {}) => ({ ...DEFAULT_MATCH_CONFIG, teamCount: 2, ...patch });

describe('team deathmatch rules', () => {
  it('ends when a team reaches the score target', () => {
    const mode = new TeamDeathmatch(config({ scoreTarget: 2 }));
    const { world } = makeWorld({ scoreTarget: 2 });
    const killer = placePlayer(world, 'k', 0, 960, 300);
    const victim = placePlayer(world, 'v', 1, 990, 300);

    mode.onKill(world, victim, killer);
    expect(mode.checkEnd(world, 0)).toBeNull();
    mode.onKill(world, victim, killer);

    expect(mode.checkEnd(world, 0)).toEqual({ winningTeam: 0, reason: 'score' });
  });

  it('awards the win to the leader when time expires', () => {
    const mode = new TeamDeathmatch(config({ scoreTarget: 50, matchDurationSec: 60 }));
    const { world } = makeWorld();
    const killer = placePlayer(world, 'k', 1, 960, 300);
    const victim = placePlayer(world, 'v', 0, 990, 300);
    mode.onKill(world, victim, killer);

    expect(mode.checkEnd(world, 59_000)).toBeNull();
    expect(mode.checkEnd(world, 60_001)).toEqual({ winningTeam: 1, reason: 'time' });
  });

  it('declares a draw when scores are level at full time', () => {
    const mode = new TeamDeathmatch(config({ scoreTarget: 50, matchDurationSec: 60 }));
    const { world } = makeWorld();
    const a = placePlayer(world, 'a', 0, 960, 300);
    const b = placePlayer(world, 'b', 1, 990, 300);
    mode.onKill(world, b, a);
    mode.onKill(world, a, b);

    expect(mode.checkEnd(world, 60_001)).toEqual({ winningTeam: null, reason: 'time' });
  });

  it('deducts a point for a team-kill instead of awarding one', () => {
    const mode = new TeamDeathmatch(config({ scoreTarget: 50 }));
    const { world } = makeWorld();
    const a = placePlayer(world, 'a', 0, 960, 300);
    const b = placePlayer(world, 'b', 0, 990, 300);
    const e = placePlayer(world, 'e', 1, 900, 300);

    mode.onKill(world, e, a);
    expect(mode.teamScores(world)[0]).toBe(1);
    mode.onKill(world, b, a);
    expect(mode.teamScores(world)[0]).toBe(0);
  });

  it('never lets a team score go negative', () => {
    const mode = new TeamDeathmatch(config());
    const { world } = makeWorld();
    const v = placePlayer(world, 'v', 0, 960, 300);
    mode.onKill(world, v, null);
    mode.onKill(world, v, null);
    expect(mode.teamScores(world)[0]).toBe(0);
  });

  it('runs a full match through to a valid result', () => {
    const h = makeWorld({ scoreTarget: 3, respawnDelaySec: 0 });
    const killer = placePlayer(h.world, 'k', 0, 960, 300);
    for (let i = 0; i < 3; i++) {
      const victim = placePlayer(h.world, `v${i}`, 1, 990 + i, 300);
      applyPlayerDamage(h.world, victim, 500, killer, 'rifle');
    }
    const result = h.mode.checkEnd(h.world, 0);
    expect(result).not.toBeNull();
    expect(result!.winningTeam).toBe(0);
    expect(killer.stats.kills).toBe(3);
  });
});

describe('spawn selection', () => {
  it('places a player inside their own team zone and clear of geometry', () => {
    const map = getMap('depot-yard');
    const grid = new CollisionGrid(map);
    const rng = makeRng(9);

    for (let team = 0; team < 2; team++) {
      const zone = map.teamSpawns.find((s) => s.team === team)!.zone;
      for (let i = 0; i < 30; i++) {
        const p = selectSpawn(map, grid, team, [], rng);
        expect(p.x).toBeGreaterThanOrEqual(zone.x - 1);
        expect(p.x).toBeLessThanOrEqual(zone.x + zone.w + 1);
        expect(grid.circleBlocked(p.x, p.y, 13)).toBe(false);
      }
    }
  });

  it('avoids spawning next to a visible enemy', () => {
    const map = getMap('depot-yard');
    const grid = new CollisionGrid(map);
    const rng = makeRng(11);
    const zone = map.teamSpawns.find((s) => s.team === 0)!.zone;
    const camper = {
      x: zone.x + 10, y: zone.y + 10, team: 1, alive: true,
    };

    let total = 0;
    for (let i = 0; i < 40; i++) {
      const p = selectSpawn(map, grid, 0, [camper], rng);
      total += Math.hypot(p.x - camper.x, p.y - camper.y);
    }
    // Averaged over many rolls, spawns clearly favour the far side of the zone.
    expect(total / 40).toBeGreaterThan(150);
  });
});

describe('starting loadouts', () => {
  it('always includes a melee fallback', () => {
    const rng = makeRng(3);
    for (const rule of ['fixed', 'random-tier', 'team-pool', 'none', 'chaos'] as const) {
      const slots = buildLoadout(rule, 0, rng);
      expect(slots[SLOT_MELEE]).not.toBeNull();
    }
  });

  it('keeps randomised starts inside one balanced tier', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 50; i++) {
      const slots = buildLoadout('random-tier', i % 2, rng);
      const primary = slots[SLOT_PRIMARY];
      expect(primary).not.toBeNull();
      expect(['smg', 'shotgun', 'rifle']).toContain(primary!.id);
    }
  });

  it('gives the fixed rule the same sidearm every time', () => {
    const rng = makeRng(5);
    const a = buildLoadout('fixed', 0, rng);
    const b = buildLoadout('fixed', 1, rng);
    expect(a[SLOT_SIDEARM]?.id).toBe(b[SLOT_SIDEARM]?.id);
  });

  it('leaves the player unarmed beyond melee under the "none" rule', () => {
    const slots = buildLoadout('none', 0, makeRng(1));
    expect(slots[SLOT_SIDEARM]).toBeNull();
    expect(slots[SLOT_PRIMARY]).toBeNull();
  });
});

describe('map definitions', () => {
  it.each(mapIds())('%s spawns nothing inside geometry', (id) => {
    const map = getMap(id);
    const grid = new CollisionGrid(map);

    for (const p of map.pickupSpawns) {
      expect(grid.circleBlocked(p.x, p.y, 14)).toBe(false);
    }
    for (const v of map.vehicleSpawns) {
      // The whole body at its parked heading, not just the centre.
      for (const c of vehicleBodyWorld({ ...v, rot: v.rot })) {
        expect(grid.circleBlocked(c.x, c.y, c.r)).toBe(false);
      }
    }
    for (const s of map.teamSpawns) {
      const point = selectSpawn(map, grid, s.team, [], makeRng(2));
      expect(grid.circleBlocked(point.x, point.y, 13)).toBe(false);
    }
  });

  it.each(mapIds())('%s declares a spawn zone for every supported team', (id) => {
    const map = getMap(id);
    for (let t = 0; t < map.maxTeams; t++) {
      expect(map.teamSpawns.some((s) => s.team === t)).toBe(true);
    }
  });
});
