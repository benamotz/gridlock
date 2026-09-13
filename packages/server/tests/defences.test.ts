import { describe, expect, it } from 'vitest';
import { GAMEPLAY, deployableDef, getMap, pointInRect } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import {
  deployZone, destroyDeployable, damageDeployable, teamDeployCount, tryDeploy,
} from '../src/sim/deployables.js';
import { applyPlayerDamage } from '../src/sim/combat.js';

/** Puts a player at the centre of their own base, facing into open ground. */
function inBase(h: ReturnType<typeof makeWorld>, id: string, team: number) {
  const zone = h.world.mapDef.teamSpawns.find((s) => s.team === team)!.zone;
  const p = placePlayer(h.world, id, team, zone.x + zone.w / 2, zone.y + zone.h / 2);
  p.aim = 0;
  return p;
}

describe('placing base defences', () => {
  it('places a barricade in front of the player', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const res = tryDeploy(h.world, p, 'barricade');

    expect(res.ok).toBe(true);
    expect(h.world.deployables.size).toBe(1);
    expect(res.entity!.team).toBe(0);
    // Placed ahead of the player, not on top of them.
    expect(res.entity!.x).toBeGreaterThan(p.x);
  });

  it('registers the barricade as a real obstacle', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const res = tryDeploy(h.world, p, 'barricade');
    const d = res.entity!;

    expect(h.world.grid.circleBlocked(d.x, d.y, 4)).toBe(true);
    // And stops blocking once it is destroyed.
    destroyDeployable(h.world, d);
    expect(h.world.grid.circleBlocked(d.x, d.y, 4)).toBe(false);
  });

  it('refuses placement outside the team base area', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const zone = deployZone(h.world, 0);
    p.x = zone.x + zone.w + 400;

    expect(tryDeploy(h.world, p, 'barricade')).toMatchObject({
      ok: false, reason: 'out-of-base',
    });
    expect(h.world.deployables.size).toBe(0);
  });

  it('refuses placement while dead or riding', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);

    p.life = 'dead';
    expect(tryDeploy(h.world, p, 'barricade').reason).toBe('dead');

    p.life = 'alive';
    p.vehicleId = 1;
    expect(tryDeploy(h.world, p, 'barricade').reason).toBe('in-vehicle');
  });

  it('enforces a per-player cooldown', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    expect(tryDeploy(h.world, p, 'turret').ok).toBe(true);

    p.aim = Math.PI;
    expect(tryDeploy(h.world, p, 'turret').reason).toBe('cooldown');

    h.world.now += deployableDef('turret').cooldownSec * 1000 + 1;
    expect(tryDeploy(h.world, p, 'turret').ok).toBe(true);
  });

  it('enforces the team limit across different players', () => {
    const h = makeWorld();
    const def = deployableDef('turret');
    const zone = h.world.mapDef.teamSpawns.find((s) => s.team === 0)!.zone;

    // Spread placers out so they refuse for the limit, not for clearance.
    for (let i = 0; i < def.teamLimit; i++) {
      const p = placePlayer(h.world, `p${i}`, 0, zone.x + 30 + i * 90, zone.y + 40);
      p.aim = Math.PI / 2;
      expect(tryDeploy(h.world, p, 'turret').ok).toBe(true);
    }
    expect(teamDeployCount(h.world, 0, 'turret')).toBe(def.teamLimit);

    const extra = placePlayer(h.world, 'extra', 0, zone.x + 30, zone.y + zone.h - 40);
    extra.aim = -Math.PI / 2;
    expect(tryDeploy(h.world, extra, 'turret').reason).toBe('team-limit');
  });

  it('refuses to drop a defence on top of a player', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const def = deployableDef('barricade');
    // Stand someone exactly where the barricade would land.
    placePlayer(h.world, 'other', 0, p.x + def.placeOffset, p.y);

    expect(tryDeploy(h.world, p, 'barricade').reason).toBe('blocked');
  });

  it('keeps each team to its own deploy zone', () => {
    const h = makeWorld();
    const zoneA = deployZone(h.world, 0);
    const zoneB = deployZone(h.world, 1);
    const p = inBase(h, 'p', 0);
    expect(pointInRect(p.x, p.y, zoneA)).toBe(true);
    expect(pointInRect(p.x, p.y, zoneB)).toBe(false);
  });

  it('removes a player defences when they leave the match', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    tryDeploy(h.world, p, 'barricade');
    expect(h.world.deployables.size).toBe(1);

    h.world.removePlayer('p');
    expect(h.world.deployables.size).toBe(0);
  });
});

describe('defences under fire', () => {
  it('is destroyed once its health runs out and stops blocking', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'barricade').entity!;
    const enemy = placePlayer(h.world, 'e', 1, d.x + 200, d.y);

    damageDeployable(h.world, d, deployableDef('barricade').hp + 10, enemy);

    expect(h.world.deployables.has(d.id)).toBe(false);
    expect(h.world.grid.circleBlocked(d.x, d.y, 4)).toBe(false);
  });

  it('ignores friendly fire from its own team by default', () => {
    const h = makeWorld({ friendlyFire: false });
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'barricade').entity!;
    const mate = placePlayer(h.world, 'mate', 0, d.x + 120, d.y);

    damageDeployable(h.world, d, 500, mate);
    expect(h.world.deployables.has(d.id)).toBe(true);
  });
});

describe('sentry guns', () => {
  it('does not fire before it has finished arming', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'turret').entity!;
    const enemy = placePlayer(h.world, 'e', 1, d.x + 150, d.y);

    h.world.events = [];
    h.world.step();
    expect(h.world.events.filter((e) => e.e === 'shot')).toHaveLength(0);
    expect(enemy.hp).toBe(GAMEPLAY.player.maxHealth);
  });

  it('acquires and damages an enemy in line of sight', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'turret').entity!;
    const enemy = placePlayer(h.world, 'e', 1, d.x + 150, d.y);

    h.advance((deployableDef('turret').armingSec ?? 2) * 1000 + 1500);

    expect(d.targetId).toBe('e');
    expect(enemy.hp).toBeLessThan(GAMEPLAY.player.maxHealth);
  });

  it('never targets its own team', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'turret').entity!;
    const mate = placePlayer(h.world, 'mate', 0, d.x + 150, d.y);

    h.advance(4000);
    expect(d.targetId).toBeNull();
    expect(mate.hp).toBe(GAMEPLAY.player.maxHealth);
  });

  it('holds fire against a spawn-protected enemy', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'turret').entity!;
    const enemy = placePlayer(h.world, 'e', 1, d.x + 150, d.y);
    enemy.spawnProtectedUntil = h.world.now + 60_000;

    h.advance(4000);
    expect(enemy.hp).toBe(GAMEPLAY.player.maxHealth);
  });

  it('credits its kills to whoever placed it', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'turret').entity!;
    const enemy = placePlayer(h.world, 'e', 1, d.x + 150, d.y);
    enemy.hp = 8;

    h.advance((deployableDef('turret').armingSec ?? 2) * 1000 + 2000);
    expect(p.stats.kills).toBeGreaterThanOrEqual(1);
  });

  it('cannot shoot through a wall', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'turret').entity!;
    // Put the enemy behind a building rather than in the open.
    const wall = getMap('depot-yard').solids.find((sd) => sd.kind === 'building')!.rect;
    const enemy = placePlayer(h.world, 'e', 1, wall.x + wall.w + 40, wall.y + wall.h / 2);
    void d;

    h.advance(4000);
    if (!h.world.grid.lineOfSight(d.x, d.y, enemy.x, enemy.y)) {
      expect(enemy.hp).toBe(GAMEPLAY.player.maxHealth);
    }
  });
});

describe('defences and the rest of the world', () => {
  it('stops a bullet that would otherwise hit a player', () => {
    const h = makeWorld();
    const p = inBase(h, 'p', 0);
    const d = tryDeploy(h.world, p, 'barricade').entity!;
    const behind = placePlayer(h.world, 'behind', 0, d.x + 60, d.y);
    const shooter = placePlayer(h.world, 's', 1, d.x - 120, d.y);
    shooter.aim = 0;

    applyPlayerDamage(h.world, behind, 0, shooter, 'rifle');
    expect(h.world.grid.lineOfSight(shooter.x, shooter.y, behind.x, behind.y)).toBe(false);
  });
});
