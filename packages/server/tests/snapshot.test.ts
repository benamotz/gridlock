import { describe, expect, it } from 'vitest';
import { GAMEPLAY } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { buildSnapshot } from '../src/net/snapshot.js';
import { applyPlayerDamage } from '../src/sim/combat.js';

const snap = (
  h: ReturnType<typeof makeWorld>,
  viewer: Parameters<typeof buildSnapshot>[1],
) => buildSnapshot(h.world, viewer, 'active', h.mode.teamScores(h.world), 60_000, h.world.events);

describe('snapshot contents', () => {
  it('includes a body so the kill stays visible', () => {
    const h = makeWorld();
    const viewer = placePlayer(h.world, 'me', 0, 960, 300);
    const victim = placePlayer(h.world, 'v', 1, 1000, 300);
    applyPlayerDamage(h.world, victim, 500, viewer, 'rifle');

    const body = snap(h, viewer).players.find((p) => p.id === 'v');
    expect(body?.life).toBe('dead');
    expect(body?.x).toBeCloseTo(1000, 0);
  });

  it('drops the player once they are only waiting to respawn', () => {
    const h = makeWorld({ respawnDelaySec: 20 });
    const viewer = placePlayer(h.world, 'me', 0, 960, 300);
    const victim = placePlayer(h.world, 'v', 1, 1000, 300);
    applyPlayerDamage(h.world, victim, 500, viewer, 'rifle');

    h.advance(GAMEPLAY.combat.corpseSec * 1000 + 200);
    expect(snap(h, viewer).players.find((p) => p.id === 'v')).toBeUndefined();
  });

  it('shows teammate health but hides enemy health', () => {
    const h = makeWorld();
    const viewer = placePlayer(h.world, 'me', 0, 960, 300);
    const mate = placePlayer(h.world, 'mate', 0, 980, 300);
    const foe = placePlayer(h.world, 'foe', 1, 1000, 300);
    mate.hp = 55;
    foe.hp = 55;

    const out = snap(h, viewer);
    expect(out.players.find((p) => p.id === 'mate')?.hp).toBe(55);
    expect(out.players.find((p) => p.id === 'foe')?.hp).toBe(-1);
  });

  it('omits enemies beyond the interest radius but keeps teammates', () => {
    const h = makeWorld({ mapId: 'harbor-reach' });
    const viewer = placePlayer(h.world, 'me', 0, 400, 400);
    const farFoe = placePlayer(h.world, 'foe', 1, 4600, 3600);
    const farMate = placePlayer(h.world, 'mate', 0, 4600, 3600);
    void farFoe;
    void farMate;

    const out = snap(h, viewer);
    expect(out.players.find((p) => p.id === 'foe')).toBeUndefined();
    expect(out.players.find((p) => p.id === 'mate')).toBeDefined();
  });

  it('sends the hit confirmation only to the shooter', () => {
    const h = makeWorld();
    const shooter = placePlayer(h.world, 'shooter', 0, 960, 300);
    const bystander = placePlayer(h.world, 'bystander', 0, 970, 300);
    const victim = placePlayer(h.world, 'v', 1, 1000, 300);

    h.world.events = [];
    applyPlayerDamage(h.world, victim, 25, shooter, 'rifle');

    const mine = snap(h, shooter).events.filter((e) => e.e === 'hitmark');
    const theirs = snap(h, bystander).events.filter((e) => e.e === 'hitmark');
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it('sends the damage indicator only to whoever was hit', () => {
    const h = makeWorld();
    const shooter = placePlayer(h.world, 'shooter', 0, 960, 300);
    const victim = placePlayer(h.world, 'v', 1, 1000, 300);

    h.world.events = [];
    applyPlayerDamage(h.world, victim, 25, shooter, 'rifle');

    expect(snap(h, victim).events.filter((e) => e.e === 'damage')).toHaveLength(1);
    expect(snap(h, shooter).events.filter((e) => e.e === 'damage')).toHaveLength(0);
  });

  it('never reveals another player ammunition or inventory', () => {
    const h = makeWorld();
    const viewer = placePlayer(h.world, 'me', 0, 960, 300);
    placePlayer(h.world, 'other', 0, 980, 300);

    const other = snap(h, viewer).players.find((p) => p.id === 'other')!;
    expect(other).not.toHaveProperty('weapons');
    expect(other).not.toHaveProperty('ammo');
  });

  it('reports the acknowledged input sequence for reconciliation', () => {
    const h = makeWorld();
    const viewer = placePlayer(h.world, 'me', 0, 960, 300);
    h.world.queueInput('me', [
      { seq: 1, dtMs: 33, buttons: 0, aim: 0, slot: -1 },
      { seq: 2, dtMs: 33, buttons: 0, aim: 0, slot: -1 },
    ]);
    h.advance(100);
    expect(snap(h, viewer).self.ack).toBeGreaterThanOrEqual(2);
  });
});
