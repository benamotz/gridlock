import {
  GAMEPLAY,
  SHOP_ITEMS,
  type ServiceDef,
  type VehicleTypeId,
  vehicleDef,
} from '@gridlock/shared';
import type { PlayerEntity, VehicleEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';
import { exitVehicle } from '../sim/vehicles.js';
import { freshWeapon, slotForWeapon } from '../sim/loadout.js';
import { clearWanted, reportCrime, wantedStars } from '../sim/wanted.js';
import { randomBetween } from '../npc/brains.js';
import { giveCash, takeCash } from './cash.js';
import type { Jobs } from './jobs.js';

const MONEY = GAMEPLAY.money;

/**
 * The businesses on a free-roam map: chop shops and respray garages you drive
 * into, stores you hold up, gun counters you buy from and phone booths that
 * hand out jobs. All money and outcomes are decided here, on the server.
 */
export class Services {
  private readonly defs: ServiceDef[];
  private readonly storeReadyAt = new Map<string, number>();
  /** Last notice per player and text, so a message is not repeated every tick. */
  private readonly lastNotice = new Map<string, number>();

  constructor(private readonly world: World, private readonly jobs: Jobs) {
    this.defs = world.mapDef.services ?? [];
  }

  /** The service whose trigger the player is standing (or parked) in. */
  at(p: PlayerEntity): ServiceDef | null {
    let best: ServiceDef | null = null;
    let bestD = Infinity;
    for (const s of this.defs) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d <= s.r && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  step(): void {
    const world = this.world;
    for (const p of world.players.values()) {
      if (p.npc || p.life !== 'alive') continue;
      const s = this.at(p);
      if (!s || s.kind !== 'store' || p.vehicleId !== null) {
        p.holdupStore = null;
        p.holdupMs = 0;
      }
      if (!s) continue;
      const v = p.vehicleId !== null ? world.vehicles.get(p.vehicleId) : undefined;
      if (v && v.driverId === p.id && Math.hypot(v.vx, v.vy) < MONEY.serviceMaxSpeed) {
        if (s.kind === 'chopshop') this.chop(p, v);
        else if (s.kind === 'respray') this.respray(p);
      } else if (!v && s.kind === 'store') {
        this.holdup(p, s);
      }
    }
  }

  /** Interact pressed: buy at a counter, or use a phone. */
  interact(p: PlayerEntity): boolean {
    const s = this.at(p);
    if (!s) return false;
    if (s.kind === 'shop' && s.item) {
      this.buy(p, s);
      return true;
    }
    if (s.kind === 'phone') {
      this.jobs.phone(p, s.town);
      return true;
    }
    return false;
  }

  prompt(p: PlayerEntity): string | null {
    const s = this.at(p);
    if (!s) return null;
    switch (s.kind) {
      case 'shop': {
        const item = SHOP_ITEMS[s.item!];
        return `E - Buy ${item.name} ($${item.price})`;
      }
      case 'phone':
        return this.jobs.has(p) ? 'E - Hang up (drop the job)' : 'E - Take a job';
      case 'store':
        if ((this.storeReadyAt.get(s.id) ?? 0) > this.world.now) return 'The till is empty - robbed recently';
        return p.slots[p.slot] && p.slots[p.slot]!.id !== 'fists'
          ? 'Hold your ground to rob the store'
          : 'Draw a gun to rob the store';
      case 'chopshop':
        return 'Chop shop - drive a car in to sell it';
      case 'respray': {
        const stars = wantedStars(p.heat);
        return stars > 0
          ? `Respray - drive in to lose the police ($${MONEY.resprayPerStar * stars})`
          : 'Respray - drive in when the police want you';
      }
    }
  }

  private notice(p: PlayerEntity, text: string): void {
    const key = `${p.id}|${text}`;
    const last = this.lastNotice.get(key) ?? -Infinity;
    if (this.world.now - last < 4000) return;
    this.lastNotice.set(key, this.world.now);
    if (this.lastNotice.size > 500) this.lastNotice.clear();
    this.world.emit({ e: 'notice', by: p.id, text });
  }

  private chop(p: PlayerEntity, v: VehicleEntity): void {
    const world = this.world;
    if (world.now < p.chopReadyAt) {
      this.notice(p, `The chop shop is busy - back in ${Math.ceil((p.chopReadyAt - world.now) / 1000)}s`);
      return;
    }
    // A steal-to-order job pays its own price (and finishes the job) here.
    const ordered = this.jobs.chop(p, v, this.at(p)!);
    const base = v.police
      ? MONEY.policeCarValue
      : MONEY.chopValue[v.type as VehicleTypeId] ?? MONEY.chopValue.car;
    // A wreck-in-waiting fetches less than a clean car.
    const health = Math.max(0, v.hp / Math.max(1, v.maxHp));
    const price = Math.round((base * (0.4 + 0.6 * health)) / 10) * 10;

    for (const id of [v.driverId, ...v.passengers]) {
      const rider = id ? world.players.get(id) : undefined;
      if (rider) exitVehicle(world, rider);
    }
    world.vehicles.delete(v.id);
    // A map vehicle comes back at its spawn point as if it had been wrecked.
    const spawn = world.mapDef.vehicleSpawns[v.spawnIndex];
    if (spawn) {
      world.pendingVehicleSpawns.push({ spawnIndex: v.spawnIndex, at: world.now + spawn.respawnSec * 1000 });
    }
    p.chopReadyAt = world.now + MONEY.chopCooldownSec * 1000;
    if (ordered !== null) return;
    giveCash(world, p, price, 'chop');
    this.notice(p, `Sold the ${vehicleDef(v.type).category.toLowerCase()} for $${price}`);
  }

  private respray(p: PlayerEntity): void {
    const stars = wantedStars(p.heat);
    if (stars === 0) return;
    const cost = MONEY.resprayPerStar * stars;
    if (p.cash < cost) {
      this.notice(p, `A respray costs $${cost} - you have $${p.cash}`);
      return;
    }
    takeCash(this.world, p, cost, 'respray');
    clearWanted(p);
    this.notice(p, 'Fresh paint - the police have lost you');
  }

  private holdup(p: PlayerEntity, s: ServiceDef): void {
    const world = this.world;
    const weapon = p.slots[p.slot];
    if (!weapon || weapon.id === 'fists') {
      p.holdupStore = null;
      p.holdupMs = 0;
      return;
    }
    if ((this.storeReadyAt.get(s.id) ?? 0) > world.now) return;
    if (p.holdupStore !== s.id) {
      p.holdupStore = s.id;
      p.holdupMs = 0;
    }
    p.holdupMs += world.dt * 1000;
    if (p.holdupMs < MONEY.holdupSec * 1000) return;

    p.holdupStore = null;
    p.holdupMs = 0;
    this.storeReadyAt.set(s.id, world.now + MONEY.storeCooldownSec * 1000);
    giveCash(world, p, randomBetween(MONEY.holdupTake, world.rng), 'robbery');
    reportCrime(world, p, 'robbery');
  }

  private buy(p: PlayerEntity, s: ServiceDef): void {
    const item = SHOP_ITEMS[s.item!];
    if (p.cash < item.price) {
      this.notice(p, `${item.name} costs $${item.price} - you have $${p.cash}`);
      return;
    }
    if (s.item === 'armor' && p.armorPlates >= GAMEPLAY.pouch.maxArmorPlates) {
      this.notice(p, 'No room for another armor plate');
      return;
    }
    if (s.item === 'medkit' && p.medkits >= GAMEPLAY.pouch.maxMedkits) {
      this.notice(p, 'No room for another medkit');
      return;
    }
    if (s.item === 'phone' && p.hasPhone) {
      this.notice(p, 'You already have a cellphone');
      return;
    }
    takeCash(this.world, p, item.price, 'purchase');
    if (item.weapon) {
      const slot = slotForWeapon(item.weapon);
      p.slots[slot] = freshWeapon(item.weapon, 1);
      p.slot = slot;
      p.reloadingSlot = -1;
      p.reloadEndsAt = 0;
    } else if (s.item === 'armor') {
      p.armorPlates++;
    } else if (s.item === 'medkit') {
      p.medkits++;
    } else if (s.item === 'phone') {
      p.hasPhone = true;
      p.nextOfferAt = this.world.now + GAMEPLAY.jobs.cellFirstOfferSec * 1000;
      this.notice(p, 'Cellphone bought - job offers will ring in (Y answer, N decline)');
    }
  }
}
