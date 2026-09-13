import { describe, expect, it } from 'vitest';
import { Btn, GAMEPLAY, shotIntervalMs, weaponDef } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import { fireWeapon, applyPlayerDamage, startReload, tryFinishReload } from '../src/sim/combat.js';
import { freshWeapon, SLOT_PRIMARY, SLOT_SIDEARM } from '../src/sim/loadout.js';

describe('weapon fire rate', () => {
  it('refuses shots that arrive faster than the weapon allows', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p1', 0, 960, 300);
    p.slots[SLOT_PRIMARY] = freshWeapon('rifle');
    p.slot = SLOT_PRIMARY;
    const start = p.slots[SLOT_PRIMARY]!.ammo;

    // Twenty trigger pulls in the same instant must only produce one shot.
    for (let i = 0; i < 20; i++) fireWeapon(world, p, i > 0, Btn.Fire);
    expect(p.slots[SLOT_PRIMARY]!.ammo).toBe(start - 1);
  });

  it('allows the next shot once the interval has elapsed', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p1', 0, 960, 300);
    p.slots[SLOT_PRIMARY] = freshWeapon('rifle');
    p.slot = SLOT_PRIMARY;

    fireWeapon(world, p, false, Btn.Fire);
    world.now += shotIntervalMs('rifle') + 1;
    fireWeapon(world, p, true, Btn.Fire);
    expect(p.slots[SLOT_PRIMARY]!.ammo).toBe(weaponDef('rifle').magazine - 2);
  });

  it('requires a trigger release for semi-automatic weapons', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p1', 0, 960, 300);
    p.slots[SLOT_PRIMARY] = freshWeapon('shotgun');
    p.slot = SLOT_PRIMARY;

    fireWeapon(world, p, false, Btn.Fire);
    const afterFirst = p.slots[SLOT_PRIMARY]!.ammo;
    world.now += 10_000;
    // Still held: no shot, however long we wait.
    fireWeapon(world, p, true, Btn.Fire);
    expect(p.slots[SLOT_PRIMARY]!.ammo).toBe(afterFirst);
    // Released and pulled again: fires.
    fireWeapon(world, p, false, Btn.Fire);
    expect(p.slots[SLOT_PRIMARY]!.ammo).toBe(afterFirst - 1);
  });
});

describe('ammunition', () => {
  it('consumes one round per trigger pull regardless of pellet count', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p1', 0, 960, 300);
    p.slots[SLOT_PRIMARY] = freshWeapon('shotgun');
    p.slot = SLOT_PRIMARY;

    fireWeapon(world, p, false, Btn.Fire);
    expect(p.slots[SLOT_PRIMARY]!.ammo).toBe(weaponDef('shotgun').magazine - 1);
  });

  it('cannot fire an empty magazine', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p1', 0, 960, 300);
    const w = freshWeapon('pistol');
    w.ammo = 0;
    w.reserve = 0;
    p.slots[SLOT_SIDEARM] = w;
    p.slot = SLOT_SIDEARM;

    world.events = [];
    fireWeapon(world, p, false, Btn.Fire);
    expect(world.events.filter((e) => e.e === 'shot')).toHaveLength(0);
    expect(w.ammo).toBe(0);
  });

  it('moves rounds from reserve to magazine on reload, never creating ammo', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p1', 0, 960, 300);
    const w = freshWeapon('rifle');
    w.ammo = 4;
    w.reserve = 10;
    p.slots[SLOT_PRIMARY] = w;
    p.slot = SLOT_PRIMARY;
    const total = w.ammo + w.reserve;

    startReload(world, p);
    world.now += weaponDef('rifle').reloadMs + 1;
    tryFinishReload(world, p);

    expect(w.ammo + w.reserve).toBe(total);
    expect(w.ammo).toBe(14);
    expect(w.reserve).toBe(0);
  });

  it('does not reload a full magazine', () => {
    const { world } = makeWorld();
    const p = placePlayer(world, 'p1', 0, 960, 300);
    const w = freshWeapon('rifle');
    p.slots[SLOT_PRIMARY] = w;
    p.slot = SLOT_PRIMARY;
    startReload(world, p);
    expect(p.reloadingSlot).toBe(-1);
  });
});

describe('damage, elimination and scoring', () => {
  it('kills a player at zero health and credits the killer', () => {
    const { world, mode } = makeWorld();
    const attacker = placePlayer(world, 'a', 0, 960, 300);
    const victim = placePlayer(world, 'v', 1, 990, 300);

    applyPlayerDamage(world, victim, 500, attacker, 'rifle');

    // The body stays on the ground first; 'respawning' comes later.
    expect(victim.life).toBe('dead');
    expect(attacker.stats.kills).toBe(1);
    expect(victim.stats.deaths).toBe(1);
    expect(mode.teamScores(world)[0]).toBe(1);
  });

  it('absorbs part of the damage with armor before health', () => {
    const { world } = makeWorld();
    const victim = placePlayer(world, 'v', 1, 990, 300);
    victim.armor = 100;
    applyPlayerDamage(world, victim, 40, null, 'rifle');

    // Half of the 40 is soaked, so 20 reaches health.
    expect(victim.hp).toBe(GAMEPLAY.player.maxHealth - 20);
    expect(victim.armor).toBe(80);
  });

  it('ignores damage to a spawn-protected player', () => {
    const { world } = makeWorld();
    const victim = placePlayer(world, 'v', 1, 990, 300);
    victim.spawnProtectedUntil = world.now + 3000;
    applyPlayerDamage(world, victim, 90, null, 'rifle');
    expect(victim.hp).toBe(GAMEPLAY.player.maxHealth);
  });

  it('blocks friendly fire by default and allows it when configured', () => {
    const off = makeWorld({ friendlyFire: false });
    const a1 = placePlayer(off.world, 'a', 0, 960, 300);
    const a2 = placePlayer(off.world, 'b', 0, 990, 300);
    applyPlayerDamage(off.world, a2, 50, a1, 'rifle');
    expect(a2.hp).toBe(GAMEPLAY.player.maxHealth);

    const on = makeWorld({ friendlyFire: true });
    const b1 = placePlayer(on.world, 'a', 0, 960, 300);
    const b2 = placePlayer(on.world, 'b', 0, 990, 300);
    applyPlayerDamage(on.world, b2, 50, b1, 'rifle');
    expect(b2.hp).toBe(GAMEPLAY.player.maxHealth - 50);
  });

  it('awards an assist for recent, meaningful damage', () => {
    const { world } = makeWorld();
    const finisher = placePlayer(world, 'f', 0, 960, 300);
    const helper = placePlayer(world, 'h', 0, 940, 300);
    const victim = placePlayer(world, 'v', 1, 990, 300);

    applyPlayerDamage(world, victim, 60, helper, 'rifle');
    applyPlayerDamage(world, victim, 60, finisher, 'rifle');

    expect(finisher.stats.kills).toBe(1);
    expect(helper.stats.assists).toBe(1);
    expect(helper.stats.kills).toBe(0);
  });

  it('does not award an assist for trivial or stale damage', () => {
    const { world } = makeWorld();
    const finisher = placePlayer(world, 'f', 0, 960, 300);
    const grazer = placePlayer(world, 'g', 0, 940, 300);
    const victim = placePlayer(world, 'v', 1, 990, 300);

    applyPlayerDamage(world, victim, 5, grazer, 'pistol');
    applyPlayerDamage(world, victim, 200, finisher, 'rifle');
    expect(grazer.stats.assists).toBe(0);
  });

  it('costs the team a point for a self-inflicted death', () => {
    const { world, mode } = makeWorld();
    const victim = placePlayer(world, 'v', 0, 990, 300);
    // Give team 0 something to lose.
    const enemy = placePlayer(world, 'e', 1, 900, 300);
    applyPlayerDamage(world, enemy, 500, victim, 'rifle');
    expect(mode.teamScores(world)[0]).toBe(1);

    applyPlayerDamage(world, victim, 500, null, 'rifle');
    expect(mode.teamScores(world)[0]).toBe(0);
  });

  it('respawns a dead player after the configured delay', () => {
    const h = makeWorld({ respawnDelaySec: 2 });
    const victim = placePlayer(h.world, 'v', 1, 990, 300);
    applyPlayerDamage(h.world, victim, 500, null, 'rifle');
    expect(victim.life).toBe('dead');

    h.advance(1000);
    expect(victim.life).toBe('dead');
    h.advance(1500);
    expect(victim.life).toBe('alive');
    expect(victim.hp).toBe(GAMEPLAY.player.maxHealth);
  });

  it('leaves a body on the ground before queueing the respawn', () => {
    const h = makeWorld({ respawnDelaySec: 20 });
    const victim = placePlayer(h.world, 'v', 1, 990, 300);
    const where = { x: victim.x, y: victim.y };
    applyPlayerDamage(h.world, victim, 500, null, 'rifle');

    // Still a body, still where it fell.
    h.advance(GAMEPLAY.combat.corpseSec * 1000 - 500);
    expect(victim.life).toBe('dead');
    expect(victim.x).toBe(where.x);
    expect(victim.y).toBe(where.y);

    // Once the body times out the player joins the respawn queue.
    h.advance(1000);
    expect(victim.life).toBe('respawning');
  });

  it('sends a private hit confirmation to the shooter', () => {
    const { world } = makeWorld();
    const attacker = placePlayer(world, 'a', 0, 960, 300);
    const victim = placePlayer(world, 'v', 1, 990, 300);

    world.events = [];
    applyPlayerDamage(world, victim, 30, attacker, 'rifle');

    const marks = world.events.filter((e) => e.e === 'hitmark');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ by: 'a', lethal: false });
  });

  it('flags the confirmation as lethal on a killing blow', () => {
    const { world } = makeWorld();
    const attacker = placePlayer(world, 'a', 0, 960, 300);
    const victim = placePlayer(world, 'v', 1, 990, 300);

    world.events = [];
    applyPlayerDamage(world, victim, 500, attacker, 'rifle');

    const mark = world.events.find((e) => e.e === 'hitmark');
    expect(mark).toMatchObject({ by: 'a', lethal: true });
  });

  it('does not confirm a hit that armor and protection absorbed entirely', () => {
    const { world } = makeWorld();
    const attacker = placePlayer(world, 'a', 0, 960, 300);
    const victim = placePlayer(world, 'v', 1, 990, 300);
    victim.spawnProtectedUntil = world.now + 3000;

    world.events = [];
    applyPlayerDamage(world, victim, 50, attacker, 'rifle');
    expect(world.events.filter((e) => e.e === 'hitmark')).toHaveLength(0);
  });
});

describe('corpses cannot be interacted with', () => {
  it('does not let a body be shot again or score twice', () => {
    const { world } = makeWorld();
    const attacker = placePlayer(world, 'a', 0, 960, 300);
    const victim = placePlayer(world, 'v', 1, 990, 300);

    applyPlayerDamage(world, victim, 500, attacker, 'rifle');
    expect(attacker.stats.kills).toBe(1);

    applyPlayerDamage(world, victim, 500, attacker, 'rifle');
    expect(attacker.stats.kills).toBe(1);
    expect(victim.stats.deaths).toBe(1);
  });
});
