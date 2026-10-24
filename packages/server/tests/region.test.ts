import { describe, expect, it } from 'vitest';
import { CollisionGrid, GAMEPLAY, NO_TEAM, getMap, townAt } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import type { FreeRoam } from '../src/modes/FreeRoam.js';
import { RoadNet } from '../src/npc/roadNet.js';
import { isCooling, outOfJurisdiction, reportCrime, wantedStars } from '../src/sim/wanted.js';

const W = GAMEPLAY.wanted;
const POLICE = GAMEPLAY.police;

function region(seed = 5) {
  const h = makeWorld({ mode: 'freeroam', mapId: 'kestrel-region', respawnDelaySec: 4 }, seed);
  const director = (h.mode as FreeRoam).director!;
  return { ...h, director };
}

/** Points in the region: a Harborside intersection, the open road, Ironvale. */
const HARBORSIDE = { x: 3584, y: 3072 };
const OPEN_ROAD = { x: 8192, y: 2560 };
const IRONVALE = { x: 12544, y: 2560 };

describe('Kestrel Region map', () => {
  const map = getMap('kestrel-region');
  const net = new RoadNet(map, new CollisionGrid(map));

  it('joins all three towns into one road network', () => {
    const start = net.nearestNode(HARBORSIDE.x, HARBORSIDE.y);
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      for (const m of net.adj[queue.shift()!]) {
        if (!seen.has(m)) {
          seen.add(m);
          queue.push(m);
        }
      }
    }
    for (const t of map.towns!) {
      const inside = net.nodes.some((n, i) =>
        seen.has(i) && townAt(map, n.x, n.y) === map.towns!.indexOf(t));
      expect(inside, t.name).toBe(true);
    }
  });

  it('spaces highway points closely enough for police to find one', () => {
    for (let a = 0; a < net.nodes.length; a++) {
      for (const b of net.adj[a]) {
        const len = Math.hypot(net.nodes[b].x - net.nodes[a].x, net.nodes[b].y - net.nodes[a].y);
        expect(len).toBeLessThanOrEqual(POLICE.spawnMaxDist - POLICE.spawnMinDist + 1000);
      }
    }
    expect(net.nodes.filter((n) => n.rural).length).toBeGreaterThan(10);
  });

  it('is much bigger than Harbor Reach', () => {
    const city = getMap('harbor-reach');
    expect(map.width * map.height).toBeGreaterThan(city.width * city.height * 8);
  });

  it('is only offered for free roam', () => {
    expect(map.modes).toEqual(['freeroam']);
  });
});

describe('jurisdiction', () => {
  it('knows which town a crime belongs to, and when the suspect has left it', () => {
    const { world } = region();
    const p = placePlayer(world, 'me', NO_TEAM, HARBORSIDE.x, HARBORSIDE.y);
    reportCrime(world, p, 'murder');
    expect(outOfJurisdiction(world, p)).toBe(false);
    p.x = OPEN_ROAD.x;
    p.y = OPEN_ROAD.y;
    expect(outOfJurisdiction(world, p)).toBe(true);
    p.x = IRONVALE.x;
    p.y = IRONVALE.y;
    expect(outOfJurisdiction(world, p)).toBe(true);
  });

  it('cools off twice as fast outside it', () => {
    // No residents: an officer's sighting would (rightly) stop the cooling.
    const quiet = () => {
      const h = region();
      (h.mode as FreeRoam).director = null;
      return h;
    };
    const inTown = quiet();
    const a = placePlayer(inTown.world, 'me', NO_TEAM, HARBORSIDE.x, HARBORSIDE.y);
    reportCrime(inTown.world, a, 'murder');

    const away = quiet();
    const b = placePlayer(away.world, 'me', NO_TEAM, HARBORSIDE.x, HARBORSIDE.y);
    reportCrime(away.world, b, 'murder');
    b.x = OPEN_ROAD.x;
    b.y = OPEN_ROAD.y;

    // Halfway through the normal delay: only the suspect who left town is cooling.
    const half = (W.coolDelaySec * 1000) / 2 + 200;
    inTown.advance(half);
    away.advance(half);
    expect(isCooling(inTown.world, a)).toBe(false);
    expect(isCooling(away.world, b)).toBe(true);
    expect(wantedStars(a.heat)).toBe(2);
    away.advance(500);
    expect(wantedStars(b.heat)).toBe(1);
  });

  it('sends fewer reinforcements after a suspect who left town', () => {
    const h = region();
    h.director.police.patrol = () => {};
    // A crime at Harborside's eastern edge, then out onto the highway.
    const p = placePlayer(h.world, 'me', NO_TEAM, 6080, 2560);
    for (let i = 0; i < 4; i++) reportCrime(h.world, p, 'murder');
    const stars = wantedStars(p.heat);
    for (let i = 0; i < 12; i++) {
      p.x = 6900;
      p.y = 2560;
      h.advance(POLICE.dispatchMs / 2);
    }
    expect(outOfJurisdiction(h.world, p)).toBe(true);
    const units = [...h.director.brains.values()]
      .filter((b) => b.kind === 'cop' && b.targetId === 'me').length;
    expect(units).toBeGreaterThan(0);
    expect(units).toBeLessThanOrEqual(Math.ceil(POLICE.unitsByStars[stars] * POLICE.outsideUnits) + 1);
  });

  it('gets police to a suspect on the open highway', () => {
    const h = region();
    h.director.police.patrol = () => {};
    const p = placePlayer(h.world, 'me', NO_TEAM, OPEN_ROAD.x, OPEN_ROAD.y);
    reportCrime(h.world, p, 'assault');
    h.advance((POLICE.responseDelaySec + 1) * 1000 + POLICE.dispatchMs);
    const units = [...h.director.brains.values()]
      .filter((b) => b.kind === 'cop' && b.targetId === 'me').length;
    expect(units).toBeGreaterThan(0);
  });
});

describe('residents in the region', () => {
  it('keeps pedestrians in town', () => {
    const h = region();
    placePlayer(h.world, 'me', NO_TEAM, 6144, 2560);
    for (let i = 0; i < 20; i++) h.advance(500);
    const peds = [...h.world.players.values()].filter((p) => p.npc === 'ped' && p.vehicleId === null);
    expect(peds.length).toBeGreaterThan(0);
    for (const p of peds) {
      // Allow the kerb strip just outside a town's edge road.
      const inTown = h.world.mapDef.towns!.some((t) =>
        p.x > t.rect.x - 120 && p.x < t.rect.x + t.rect.w + 120 &&
        p.y > t.rect.y - 120 && p.y < t.rect.y + t.rect.h + 120);
      expect(inTown).toBe(true);
    }
  });
});
