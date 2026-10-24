import { type CashReason, GAMEPLAY } from '@gridlock/shared';
import type { PlayerEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';

const MONEY = GAMEPLAY.money;

/** Pays a player and tells them why. */
export function giveCash(world: World, p: PlayerEntity, amount: number, reason: CashReason): void {
  const sum = Math.round(amount);
  if (sum <= 0) return;
  p.cash += sum;
  if (!p.npc) world.emit({ e: 'cash', by: p.id, amount: sum, reason });
}

/** Takes up to `amount` from a player; returns what was actually taken. */
export function takeCash(world: World, p: PlayerEntity, amount: number, reason: CashReason): number {
  const sum = Math.min(p.cash, Math.max(0, Math.round(amount)));
  if (sum <= 0) return 0;
  p.cash -= sum;
  if (!p.npc) world.emit({ e: 'cash', by: p.id, amount: -sum, reason });
  return sum;
}

/** Drops cash in the street for anyone to pick up. */
export function dropMoney(world: World, x: number, y: number, amount: number): void {
  const sum = Math.round(amount);
  if (sum < 1) return;
  // Scattered a little, so several drops in one spot stay readable.
  const a = world.rng() * Math.PI * 2;
  const r = 8 + world.rng() * 18;
  let px = x + Math.cos(a) * r;
  let py = y + Math.sin(a) * r;
  if (world.grid.circleBlocked(px, py, 8)) {
    px = x;
    py = y;
  }
  const id = world.allocId();
  world.moneyDrops.set(id, {
    id, x: px, y: py, amount: sum,
    expiresAt: world.now + MONEY.dropLifetimeSec * 1000,
    availableAt: world.now + 400,
  });
}

/**
 * Expires old drops and hands each remaining one to the first player who
 * reaches it - on foot or driving over it. Residents leave money where it lies.
 */
export function stepMoney(world: World): void {
  if (world.moneyDrops.size === 0) return;
  const r2 = MONEY.pickupRadius ** 2;
  for (const d of [...world.moneyDrops.values()]) {
    if (world.now >= d.expiresAt) {
      world.moneyDrops.delete(d.id);
      continue;
    }
    if (world.now < d.availableAt) continue;
    for (const p of world.players.values()) {
      if (p.npc || p.life !== 'alive') continue;
      if ((p.x - d.x) ** 2 + (p.y - d.y) ** 2 > r2) continue;
      world.moneyDrops.delete(d.id);
      giveCash(world, p, d.amount, 'pickup');
      break;
    }
  }
}
