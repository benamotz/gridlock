import { describe, expect, it } from 'vitest';
import { Btn, GAMEPLAY, NO_TEAM } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import type { FreeRoam } from '../src/modes/FreeRoam.js';
import { applyPlayerDamage } from '../src/sim/combat.js';
import { tryEnterExitVehicle } from '../src/sim/vehicles.js';
import { onVehicleSwap, reportCrime, wantedStars } from '../src/sim/wanted.js';
import type { PlayerEntity } from '../src/sim/entities.js';

const CITY = GAMEPLAY.city;
const POLICE = GAMEPLAY.police;

/** A downtown intersection on Harbor Reach, in the open. */
const JUNCTION = { x: 1280, y: 1536 };

function city(seed = 3) {
  const h = makeWorld({ mode: 'freeroam', mapId: 'harbor-reach', respawnDelaySec: 4 }, seed);
  const director = (h.mode as FreeRoam).director!;
  const me = placePlayer(h.world, 'me', NO_TEAM, JUNCTION.x, JUNCTION.y);
  // A connected player who is standing still, as a real client would report.
  let seq = 0;
  const idle = (ms: number) => {
    const ticks = Math.round(ms / (h.world.dt * 1000));
    for (let i = 0; i < ticks; i++) {
      h.world.queueInput('me', [{ seq: ++seq, dtMs: h.world.dt * 1000, buttons: 0, aim: 0, slot: -1 }]);
      h.advance(h.world.dt * 1000);
    }
  };
  return { ...h, director, me, idle };
}

const residents = (h: { world: { players: Map<string, PlayerEntity> } }, kind?: 'ped' | 'cop') =>
  [...h.world.players.values()].filter((p) => p.npc && (!kind || p.npc === kind));

describe('road network', () => {
  it('connects most of Harbor Reach and leaves out blocked segments', () => {
    const { director } = city();
    const net = director.net;
    const usable = net.adj.filter((a) => a.length > 0).length;
    expect(usable).toBeGreaterThan(net.nodes.length * 0.8);
    // The canal column has no north-south roads.
    const canal = net.nodes.findIndex((n) => n.x === 2560 && n.y === 1536);
    expect(net.adj[canal].every((m) => net.nodes[m].x !== 2560)).toBe(true);
  });

  it('routes between distant intersections', () => {
    const { director } = city();
    const net = director.net;
    const a = net.nearestNode(640, 512);
    const b = net.nearestNode(4480, 3584);
    let at = a;
    for (let i = 0; i < 40 && at !== b; i++) at = net.nextHop(at, b);
    expect(at).toBe(b);
  });
});

describe('city residents', () => {
  it('fills the streets around a player, out of sight', () => {
    const h = city();
    h.idle(3000);
    const peds = residents(h, 'ped').filter((p) => p.vehicleId === null);
    const drivers = residents(h, 'ped').filter((p) => p.vehicleId !== null);
    expect(peds.length).toBeGreaterThan(4);
    expect(drivers.length).toBeGreaterThan(2);
    for (const p of residents(h)) {
      expect(h.world.grid.circleBlocked(p.x, p.y, GAMEPLAY.player.radius - 2)).toBe(false);
    }
  });

  it('keeps pedestrians and traffic moving', () => {
    const h = city();
    h.idle(3000);
    const before = new Map(residents(h).map((p) => [p.id, { x: p.x, y: p.y }]));
    h.idle(4000);
    let moved = 0;
    let total = 0;
    for (const p of residents(h)) {
      const b = before.get(p.id);
      if (!b) continue;
      total++;
      if (Math.hypot(p.x - b.x, p.y - b.y) > 40) moved++;
    }
    expect(moved / total).toBeGreaterThan(0.75);
  });

  it('empties the city once nobody is there to see it', () => {
    const h = city();
    h.idle(3000);
    expect(h.director.residentCount).toBeGreaterThan(0);
    h.world.removePlayer('me');
    h.advance(CITY.populateMs * 2);
    expect(h.director.residentCount).toBe(0);
    expect([...h.world.vehicles.values()].some((v) => v.spawnIndex === -1)).toBe(false);
  });

  it('treats killing a pedestrian as murder, with no score and no kill feed entry', () => {
    const h = city();
    h.idle(3000);
    const ped = residents(h, 'ped').find((p) => p.vehicleId === null)!;
    h.world.events = [];
    applyPlayerDamage(h.world, ped, 500, h.me, 'pistol');
    expect(ped.life).toBe('dead');
    expect(wantedStars(h.me.heat)).toBe(2);
    expect(h.me.stats.kills).toBe(0);
    expect(h.world.events.some((e) => e.e === 'kill')).toBe(false);
  });

  it('sends pedestrians running from gunfire', () => {
    const h = city();
    h.idle(3000);
    const ped = residents(h, 'ped').find((p) => p.vehicleId === null)!;
    h.world.emit({ e: 'shot', by: 'me', x: ped.x + 40, y: ped.y, a: 0, w: 'pistol', len: 0 });
    h.idle(600);
    expect(Math.hypot(ped.vx, ped.vy)).toBeGreaterThan(GAMEPLAY.player.walkSpeed * 0.7);
  });

  it('never lets residents collect pickups', () => {
    const h = city();
    h.idle(3000);
    for (const p of residents(h)) {
      expect(p.slots.filter(Boolean).every((s) => s!.id === 'fists' || s!.id === 'pistol')).toBe(true);
    }
  });
});

describe('carjacking', () => {
  it('pulls the resident driver out, takes the wheel and counts as a crime', () => {
    const h = city();
    h.idle(3000);
    const v = [...h.world.vehicles.values()].find((c) => {
      const d = c.driverId ? h.world.players.get(c.driverId) : undefined;
      return !!d?.npc && !c.destroyed;
    })!;
    const victimId = v.driverId!;
    // Stand right beside the driver's door.
    h.me.x = v.x - Math.sin(v.rot) * 40;
    h.me.y = v.y + Math.cos(v.rot) * 40;
    v.vx = 0;
    v.vy = 0;
    tryEnterExitVehicle(h.world, h.me);

    expect(v.driverId).toBe('me');
    expect(h.world.players.get(victimId)!.vehicleId).toBeNull();
    expect(wantedStars(h.me.heat)).toBe(1);
  });

  it('does not let a player ride along as a resident’s passenger', () => {
    const h = city();
    h.idle(3000);
    const v = [...h.world.vehicles.values()].find((c) =>
      !!c.driverId && !!h.world.players.get(c.driverId)?.npc)!;
    h.me.x = v.x - Math.sin(v.rot) * 40;
    h.me.y = v.y + Math.cos(v.rot) * 40;
    tryEnterExitVehicle(h.world, h.me);
    expect(v.passengers).not.toContain('me');
  });
});

/** Officers whose brain is chasing `id` (patrol crews on their rounds do not count). */
const chasing = (h: ReturnType<typeof city>, id: string) =>
  [...h.director.brains.values()].filter((b) => b.kind === 'cop' && b.targetId === id).length;

describe('police', () => {
  it('answers an unwitnessed crime after a delay, two officers to a squad car', () => {
    const h = city();
    // Only dispatched units here: a passing patrol would take the call itself.
    h.director.police.patrol = () => {};
    h.idle(1000);
    reportCrime(h.world, h.me, 'assault');
    h.idle(1000);
    expect(chasing(h, 'me')).toBe(0);
    h.idle(POLICE.responseDelaySec * 1000 + POLICE.dispatchMs);
    expect(chasing(h, 'me')).toBe(POLICE.unitsByStars[1]);
    // Both officers came in one car.
    const cops = [...h.director.brains.values()]
      .filter((b) => b.kind === 'cop' && b.targetId === 'me')
      .map((b) => h.world.players.get(b.id)!);
    expect(new Set(cops.map((c) => c.vehicleId)).size).toBe(1);
    expect(cops[0].vehicleId).not.toBeNull();

    for (let i = 0; i < 4; i++) reportCrime(h.world, h.me, 'murder');
    const stars = wantedStars(h.me.heat);
    h.idle(POLICE.dispatchMs * 2);
    expect(chasing(h, 'me')).toBeGreaterThanOrEqual(POLICE.unitsByStars[stars] - 1);
  });

  it('responds at once to a crime an officer sees', () => {
    const h = city();
    h.world.addNpc('witness', 'Police', 'cop', h.me.x + 120, h.me.y, 100, 'pistol');
    reportCrime(h.world, h.me, 'assault');
    expect(h.me.reportAt).toBeLessThanOrEqual(h.world.now);
    expect(h.me.lastSeenAt).toBe(h.world.now);
  });

  it('searches where the suspect was last seen rather than following them', () => {
    const h = city();
    h.director.police.patrol = () => {};
    h.idle(1000);
    for (let i = 0; i < 2; i++) reportCrime(h.world, h.me, 'murder');
    h.idle((POLICE.responseDelaySec + 1) * 1000 + POLICE.dispatchMs);
    const scene = { x: h.me.lkpX, y: h.me.lkpY };
    const officers = () => [...h.director.brains.values()]
      .filter((b) => b.kind === 'cop' && b.targetId === 'me')
      .map((b) => h.world.players.get(b.id)!)
      .filter((c) => c.life === 'alive');
    // Slip away a few blocks, to whichever side is furthest from the police.
    const spots = [[0, 1024], [0, -1024], [1280, 0], [-1280, 0]]
      .map(([dx, dy]) => ({ x: JUNCTION.x + dx, y: JUNCTION.y + dy }))
      .filter((s) => !h.world.grid.circleBlocked(s.x, s.y, 14));
    const away = (s: { x: number; y: number }) =>
      Math.min(...officers().map((c) => Math.hypot(c.x - s.x, c.y - s.y)));
    const spot = spots.sort((a, b) => away(b) - away(a))[0];
    h.me.x = spot.x;
    h.me.y = spot.y;
    h.idle(4000);
    const units = officers();
    expect(units.length).toBeGreaterThan(0);
    for (const c of units) {
      expect(Math.hypot(c.x - scene.x, c.y - scene.y))
        .toBeLessThan(Math.hypot(c.x - h.me.x, c.y - h.me.y));
    }
  });

  it('lets a suspect lose the police by staying out of sight', () => {
    const h = city();
    h.idle(1000);
    for (let i = 0; i < 2; i++) reportCrime(h.world, h.me, 'murder');
    h.me.x = 4480;
    h.me.y = 512;
    h.idle((GAMEPLAY.wanted.coolDelaySec + GAMEPLAY.wanted.coolStepSec * 3) * 1000);
    expect(h.me.heat).toBe(0);
  });

  it('arrests a suspect who stands still', () => {
    const h = city();
    h.idle(1000);
    const startCash = h.me.cash;
    let busted = false;
    for (let t = 0; t < 40 && !busted; t++) {
      // Keep the level alive while the police make their way over.
      if (t % 10 === 0 && wantedStars(h.me.heat) === 0) reportCrime(h.world, h.me, 'assault');
      h.idle(500);
      busted = h.world.events.some((e) => e.e === 'busted' && e.by === 'me');
      h.world.events = [];
    }
    expect(busted).toBe(true);
    expect(h.me.heat).toBe(0);
    expect(h.me.life).toBe('respawning');
    expect(h.me.cash).toBe(startCash - Math.round(startCash * GAMEPLAY.money.bail));
  });

  it('only chases the wanted player, never a bystander', () => {
    const h = city();
    placePlayer(h.world, 'bystander', NO_TEAM, JUNCTION.x + 60, JUNCTION.y);
    h.idle(500);
    reportCrime(h.world, h.me, 'assault');
    let bystanderBusted = false;
    for (let t = 0; t < 20; t++) {
      h.world.queueInput('bystander', [{
        seq: t + 1, dtMs: 33, buttons: Btn.Up, aim: 0, slot: -1,
      }]);
      h.idle(500);
      if (h.world.events.some((e) => e.e === 'busted' && e.by === 'bystander')) bystanderBusted = true;
      h.world.events = [];
    }
    expect(bystanderBusted).toBe(false);
  });

  it('sends dispatched units home when the suspect is no longer wanted', () => {
    const h = city();
    h.idle(500);
    reportCrime(h.world, h.me, 'assault');
    h.idle((POLICE.responseDelaySec + 1) * 1000 + POLICE.dispatchMs);
    expect(chasing(h, 'me')).toBeGreaterThan(0);
    h.me.heat = 0;
    h.me.x = 4480;
    h.me.y = 3584;
    h.idle((POLICE.standDownSec + 1) * 1000);
    const dispatched = [...h.director.brains.values()].filter((b) => b.kind === 'cop' && b.dispatched);
    expect(dispatched.length).toBe(0);
  });

  it('keeps squad cars on patrol around players', () => {
    const h = city();
    h.idle(3000);
    const patrols = [...h.world.vehicles.values()].filter((v) => v.police && v.driverId);
    expect(patrols.length).toBeGreaterThan(0);
  });
});

describe('changing cars', () => {
  it('costs the police a star when nobody sees the swap', () => {
    const h = city();
    h.director.police.update = () => {};
    for (let i = 0; i < 2; i++) reportCrime(h.world, h.me, 'murder');
    h.me.x = 4480;
    h.me.y = 512;
    h.idle((GAMEPLAY.wanted.carSwapUnseenSec + 0.5) * 1000);
    const before = wantedStars(h.me.heat);
    const v = h.world.addVehicle('car', h.me.x + 40, h.me.y, 0);
    onVehicleSwap(h.world, h.me, v.id);
    expect(wantedStars(h.me.heat)).toBe(before - 1);
    // Not again straight away.
    const w = h.world.addVehicle('car', h.me.x - 60, h.me.y, 0);
    onVehicleSwap(h.world, h.me, w.id);
    expect(wantedStars(h.me.heat)).toBe(before - 1);
  });
});
