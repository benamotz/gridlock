import { describe, expect, it } from 'vitest';
import { Btn, CollisionGrid, GAMEPLAY, NO_TEAM, SHOP_ITEMS, getMap } from '@gridlock/shared';
import { makeWorld, placePlayer } from './helpers.js';
import type { FreeRoam } from '../src/modes/FreeRoam.js';
import { applyPlayerDamage, destroyVehicle } from '../src/sim/combat.js';
import { reportCrime, wantedStars } from '../src/sim/wanted.js';
import type { PlayerEntity } from '../src/sim/entities.js';

const MONEY = GAMEPLAY.money;

function region(seed = 9) {
  const h = makeWorld({ mode: 'freeroam', mapId: 'kestrel-region', respawnDelaySec: 4 }, seed);
  const mode = h.mode as FreeRoam;
  // Money rules only: no residents wandering into the tests.
  mode.director!.update = () => {};
  return { ...h, economy: mode.economy!, director: mode.director! };
}

const service = (kind: string, item?: string) => {
  const s = getMap('kestrel-region').services!.find((x) => x.kind === kind && (!item || x.item === item));
  if (!s) throw new Error(`no ${kind}`);
  return s;
};

/** A player standing still, consuming idle input like a connected client. */
function idler(h: ReturnType<typeof region>, p: PlayerEntity) {
  let seq = 0;
  return (ms: number, buttons = 0) => {
    const ticks = Math.round(ms / (h.world.dt * 1000));
    for (let i = 0; i < ticks; i++) {
      h.world.queueInput(p.id, [{ seq: ++seq, dtMs: h.world.dt * 1000, buttons, aim: 0, slot: -1 }]);
      h.advance(h.world.dt * 1000);
    }
  };
}

describe('cash', () => {
  it('gives every player the same starting stake', () => {
    const h = region();
    const p = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    expect(p.cash).toBe(MONEY.start);
  });

  it('drops a pedestrian’s wallet where they fall, for anyone to take', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    const ped = h.world.addNpc('ped', 'Civilian', 'ped', 3700, 3072, 60, null);
    ped.cash = 40;
    applyPlayerDamage(h.world, ped, 500, me, 'pistol');
    const drop = [...h.world.moneyDrops.values()][0];
    expect(drop.amount).toBe(40);
    me.x = drop.x;
    me.y = drop.y;
    h.advance(600);
    expect(me.cash).toBe(MONEY.start + 40);
    expect(h.world.moneyDrops.size).toBe(0);
  });

  it('lets a punch rob a pedestrian of half their wallet, once', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    const ped = h.world.addNpc('ped', 'Civilian', 'ped', 3610, 3072, 60, null);
    ped.cash = 60;
    applyPlayerDamage(h.world, ped, 5, me, 'fists');
    applyPlayerDamage(h.world, ped, 5, me, 'fists');
    const dropped = [...h.world.moneyDrops.values()].reduce((s, d) => s + d.amount, 0);
    expect(dropped).toBe(30);
    expect(ped.cash).toBe(30);
  });

  it('pays a bounty for a wanted player and leaves part of their cash behind', () => {
    const h = region();
    const hunter = placePlayer(h.world, 'hunter', NO_TEAM, 3584, 3072);
    const outlaw = placePlayer(h.world, 'outlaw', NO_TEAM, 3700, 3072);
    h.advance(50);
    for (let i = 0; i < 3; i++) reportCrime(h.world, outlaw, 'murder');
    const stars = wantedStars(outlaw.heat);
    outlaw.cash = 1000;
    applyPlayerDamage(h.world, outlaw, 500, hunter, 'pistol');
    expect(hunter.cash).toBe(MONEY.start + MONEY.bountyByStars[stars]);
    expect(outlaw.cash).toBe(1000 - 1000 * MONEY.deathDrop);
    const dropped = [...h.world.moneyDrops.values()].reduce((s, d) => s + d.amount, 0);
    expect(dropped).toBe(1000 * MONEY.deathDrop);
  });
});

describe('vehicle services', () => {
  it('buys a car at the chop shop, worth less when damaged', () => {
    const h = region();
    const chop = service('chopshop');
    const me = placePlayer(h.world, 'me', NO_TEAM, chop.x, chop.y);
    h.advance(50);
    const v = h.world.addVehicle('sports', chop.x, chop.y, 0);
    v.hp = v.maxHp / 2;
    v.driverId = me.id;
    me.vehicleId = v.id;
    h.advance(100);
    expect(h.world.vehicles.has(v.id)).toBe(false);
    expect(me.vehicleId).toBeNull();
    const expected = Math.round((MONEY.chopValue.sports * (0.4 + 0.6 * 0.5)) / 10) * 10;
    expect(me.cash).toBe(MONEY.start + expected);
  });

  it('resprays a wanted driver for a fee, and refuses one who cannot pay', () => {
    const h = region();
    const garage = service('respray');
    const me = placePlayer(h.world, 'me', NO_TEAM, garage.x, garage.y);
    h.advance(50);
    for (let i = 0; i < 2; i++) reportCrime(h.world, me, 'murder');
    const stars = wantedStars(me.heat);
    const v = h.world.addVehicle('car', garage.x, garage.y, 0);
    v.driverId = me.id;
    me.vehicleId = v.id;

    me.cash = 10;
    h.advance(100);
    expect(wantedStars(me.heat)).toBe(stars);

    me.cash = 1000;
    h.advance(100);
    expect(me.heat).toBe(0);
    expect(me.cash).toBe(1000 - MONEY.resprayPerStar * stars);
  });
});

describe('stores and shops', () => {
  it('pays out a hold-up after holding a gun on the till, and makes it a crime', () => {
    const h = region();
    const store = service('store');
    const me = placePlayer(h.world, 'me', NO_TEAM, store.x, store.y);
    me.slot = me.slots.findIndex((w) => w && w.id !== 'fists');
    const idle = idler(h, me);
    idle(100);
    const before = me.cash;
    idle(MONEY.holdupSec * 1000 + 300);
    expect(me.cash).toBeGreaterThanOrEqual(before + MONEY.holdupTake[0]);
    expect(wantedStars(me.heat)).toBe(2);
    // The till stays empty for a while.
    const after = me.cash;
    idle(MONEY.holdupSec * 1000 + 300);
    expect(me.cash).toBe(after);
  });

  it('does nothing for an unarmed robber', () => {
    const h = region();
    const store = service('store');
    const me = placePlayer(h.world, 'me', NO_TEAM, store.x, store.y);
    me.slot = 0;
    const idle = idler(h, me);
    idle(MONEY.holdupSec * 1000 + 300);
    expect(me.cash).toBe(MONEY.start);
    expect(me.heat).toBe(0);
  });

  it('sells from a counter with the interact key', () => {
    const h = region();
    const counter = service('shop', 'smg');
    const me = placePlayer(h.world, 'me', NO_TEAM, counter.x, counter.y);
    const idle = idler(h, me);
    idle(100);
    me.cash = 1000;
    idle(100, Btn.Interact);
    expect(me.slots.some((w) => w?.id === 'smg')).toBe(true);
    expect(me.cash).toBe(1000 - SHOP_ITEMS.smg.price);
  });

  it('refuses a sale the player cannot afford, with a reason', () => {
    const h = region();
    const counter = service('shop', 'smg');
    const me = placePlayer(h.world, 'me', NO_TEAM, counter.x, counter.y);
    const idle = idler(h, me);
    idle(100);
    me.cash = 10;
    h.world.events = [];
    idle(100, Btn.Interact);
    expect(me.slots.some((w) => w?.id === 'smg')).toBe(false);
    expect(h.world.events.some((e) => e.e === 'notice' && e.by === 'me')).toBe(true);
  });

  it('puts every business on open ground', () => {
    const map = getMap('kestrel-region');
    const grid = new CollisionGrid(map);
    expect(map.services!.length).toBeGreaterThan(20);
    for (const s of map.services!) expect(grid.circleBlocked(s.x, s.y, 13), s.id).toBe(false);
  });
});

describe('jobs', () => {
  const JOBS = GAMEPLAY.jobs;

  it('pays a courier who reaches the drop-off in time', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    expect(h.economy.jobs.startKind(me, 'courier')).toBe(true);
    const reward = me.job!.reward;
    me.x = me.job!.x;
    me.y = me.job!.y;
    h.advance(100);
    expect(me.job).toBeNull();
    expect(me.cash).toBe(MONEY.start + reward);
  });

  it('pays for a hit only when the hit man makes it', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    const rival = placePlayer(h.world, 'rival', NO_TEAM, 5000, 5000);
    h.advance(50);
    h.economy.jobs.startKind(me, 'hit');
    const target = [...h.world.players.values()].find((p) => p.markedFor === me.id)!;
    const reward = me.job!.reward;
    applyPlayerDamage(h.world, target, 500, me, 'pistol');
    expect(me.job).toBeNull();
    expect(me.cash).toBe(MONEY.start + reward);

    h.economy.jobs.startKind(me, 'hit');
    const second = [...h.world.players.values()].find((p) => p.markedFor === me.id && p.life === 'alive')!;
    const cash = me.cash;
    applyPlayerDamage(h.world, second, 500, rival, 'pistol');
    expect(me.job).toBeNull();
    expect(me.cash).toBe(cash);
  });

  it('hangs up a job when a booth is used again', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    h.economy.jobs.phone(me, 0);
    expect(me.job).not.toBeNull();
    h.economy.jobs.phone(me, 0);
    expect(me.job).toBeNull();
  });

  it('pays steal-to-order at the named chop shop, scaled by condition', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    expect(h.economy.jobs.startKind(me, 'boost')).toBe(true);
    const job = me.job!;
    // Bring exactly what was asked for to the shop the job names.
    const shop = getMap('kestrel-region').services!.find((s) =>
      s.kind === 'chopshop' && Math.hypot(s.x - job.x, s.y - job.y) < 1)
      ?? getMap('kestrel-region').services!.find((s) => s.kind === 'chopshop')!;
    const wantsSquad = job.text.includes('squad car');
    const type = wantsSquad ? 'car'
      : job.text.includes('sports') ? 'sports'
        : job.text.includes('truck') ? 'truck'
          : job.text.includes('van') ? 'van' : 'motorcycle';
    const v = h.world.addVehicle(type, me.x + 60, me.y, 0);
    v.police = wantsSquad;
    v.driverId = me.id;
    me.vehicleId = v.id;
    h.advance(100);
    expect(me.job!.text).toMatch(/Deliver/);
    const target = { x: me.job!.x, y: me.job!.y };
    const chop = getMap('kestrel-region').services!.find((s) =>
      s.kind === 'chopshop' && Math.hypot(s.x - target.x, s.y - target.y) < 1)!;
    expect(chop).toBeDefined();
    expect(shop).toBeDefined();
    v.x = chop.x;
    v.y = chop.y;
    const reward = me.job!.reward;
    h.advance(100);
    expect(me.job).toBeNull();
    expect(me.cash).toBe(MONEY.start + reward);
  });

  it('spills the cash van’s money when it is wrecked', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    expect(h.economy.jobs.startKind(me, 'armored')).toBe(true);
    const van = [...h.world.vehicles.values()].find((v) => v.security)!;
    expect(van).toBeDefined();
    expect(van.protectedFor).toBe(me.id);
    destroyVehicle(h.world, van, me);
    h.advance(100);
    expect(me.job).toBeNull();
    const spilled = [...h.world.moneyDrops.values()].reduce((s, d) => s + d.amount, 0);
    expect(spilled).toBeGreaterThanOrEqual(JOBS.truckCash - JOBS.truckBags);
  });

  it('starts a decoy run with the police on you and pays once they are lost', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    expect(h.economy.jobs.startKind(me, 'decoy')).toBe(true);
    expect(wantedStars(me.heat)).toBe(JOBS.decoyStars);
    const reward = me.job!.reward;
    me.heat = 0;
    h.advance(100);
    expect(me.job).toBeNull();
    expect(me.cash).toBe(MONEY.start + reward);
  });

  it('sets a bounty job on the most wanted player when there is one', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    const outlaw = placePlayer(h.world, 'outlaw', NO_TEAM, 4200, 3072);
    h.advance(50);
    for (let i = 0; i < 3; i++) reportCrime(h.world, outlaw, 'murder');
    expect(h.economy.jobs.startKind(me, 'bounty')).toBe(true);
    expect(me.job!.text).toContain('outlaw');
    const stars = wantedStars(outlaw.heat);
    const reward = me.job!.reward;
    applyPlayerDamage(h.world, outlaw, 500, me, 'pistol');
    expect(me.job).toBeNull();
    expect(me.cash).toBe(MONEY.start + reward + MONEY.bountyByStars[stars]);
  });

  it('sends an armed fugitive when nobody is wanted', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    expect(h.economy.jobs.startKind(me, 'bounty')).toBe(true);
    const fugitive = [...h.world.players.values()].find((p) => p.markedFor === me.id)!;
    expect(fugitive.slots.some((w) => w?.id === 'pistol')).toBe(true);
  });
});

describe('story', () => {
  const JOBS = GAMEPLAY.jobs;

  it('opens with the contact introducing themselves, by name', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    h.economy.jobs.phone(me, 0);
    expect(me.job!.contact).toBe('Vera Lowe');
    expect(me.job!.brief).toMatch(/Vera/);
  });

  it('closes each job with a line from the contact', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    h.economy.jobs.startKind(me, 'decoy');
    h.world.events = [];
    me.heat = 0;
    h.advance(100);
    expect(h.world.events.some((e) => e.e === 'notice' && e.from === 'Nell Price')).toBe(true);
  });

  it('offers a better-paid finale after enough jobs for one contact', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    const rewards: number[] = [];
    for (let i = 0; i <= JOBS.trustForFinale; i++) {
      h.economy.jobs.startKind(me, 'decoy');
      rewards.push(me.job!.reward);
      me.heat = 0;
      h.advance(100);
    }
    expect(rewards[JOBS.trustForFinale]).toBe(JOBS.decoyReward * JOBS.finaleMultiplier);
    expect(rewards.slice(0, JOBS.trustForFinale).every((r) => r === JOBS.decoyReward)).toBe(true);
  });
});

describe('cellphone', () => {
  const JOBS = GAMEPLAY.jobs;

  function withPhone() {
    const h = region();
    const counter = service('shop', 'phone');
    const me = placePlayer(h.world, 'me', NO_TEAM, counter.x, counter.y);
    const idle = idler(h, me);
    idle(100);
    me.cash = 1000;
    idle(100, Btn.Interact);
    return { h, me, idle };
  }

  it('is sold at gun counters, once', () => {
    const { h, me, idle } = withPhone();
    expect(me.hasPhone).toBe(true);
    expect(me.cash).toBe(1000 - SHOP_ITEMS.phone.price);
    h.world.events = [];
    idle(100);
    idle(100, Btn.Interact);
    expect(me.cash).toBe(1000 - SHOP_ITEMS.phone.price);
  });

  it('rings with a job offer anywhere, which can be taken', () => {
    const { h, me, idle } = withPhone();
    me.x = 3584;
    me.y = 3072;
    idle((JOBS.cellFirstOfferSec + 0.5) * 1000);
    expect(me.phoneOffer).not.toBeNull();
    const reward = me.phoneOffer!.reward;
    h.economy.answerPhone(me, true);
    expect(me.phoneOffer).toBeNull();
    expect(me.job).not.toBeNull();
    expect(me.job!.reward).toBe(reward);
  });

  it('can be turned down, and rings again later', () => {
    const { h, me, idle } = withPhone();
    idle((JOBS.cellFirstOfferSec + 0.5) * 1000);
    h.economy.answerPhone(me, false);
    expect(me.job).toBeNull();
    expect(me.phoneOffer).toBeNull();
    idle((JOBS.cellOfferEverySec[1] + 1) * 1000);
    expect(me.phoneOffer).not.toBeNull();
  });

  it('rings off when nobody answers', () => {
    const { h, me, idle } = withPhone();
    idle((JOBS.cellFirstOfferSec + 0.5) * 1000);
    expect(me.phoneOffer).not.toBeNull();
    h.world.events = [];
    idle((JOBS.cellRingSec + 0.5) * 1000);
    expect(me.phoneOffer).toBeNull();
    expect(h.world.events.some((e) => e.e === 'notice' && e.text === 'Missed call')).toBe(true);
  });

  it('stays quiet without a phone, and while on a job', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    const idle = idler(h, me);
    idle((JOBS.cellOfferEverySec[1] + 5) * 1000);
    expect(me.phoneOffer).toBeNull();

    me.hasPhone = true;
    h.economy.jobs.phone(me);
    expect(me.job).not.toBeNull();
    idle((JOBS.cellOfferEverySec[1] + 5) * 1000);
    expect(me.phoneOffer).toBeNull();
  });
});

describe('dying costs money', () => {
  const lost = (cash: number) => cash * MONEY.deathDrop;

  it('to a police officer', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    me.cash = 800;
    const cop = h.world.addNpc('cop', 'Police', 'cop', 3650, 3072, 100, 'pistol');
    applyPlayerDamage(h.world, me, 500, cop, 'pistol');
    expect(me.life).toBe('dead');
    expect(me.cash).toBe(800 - lost(800));
  });

  it('in a crash nobody caused', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    me.cash = 400;
    applyPlayerDamage(h.world, me, 500, null, 'grenade');
    expect(me.cash).toBe(400 - lost(400));
    const dropped = [...h.world.moneyDrops.values()].reduce((s, d) => s + d.amount, 0);
    expect(dropped).toBe(lost(400));
  });

  it('and the dying player is told how much', () => {
    const h = region();
    const me = placePlayer(h.world, 'me', NO_TEAM, 3584, 3072);
    h.advance(50);
    me.cash = 400;
    h.world.events = [];
    applyPlayerDamage(h.world, me, 500, null, 'grenade');
    const event = h.world.events.find((e) => e.e === 'cash' && e.by === 'me');
    expect(event).toMatchObject({ amount: -lost(400), reason: 'death' });
  });
});
