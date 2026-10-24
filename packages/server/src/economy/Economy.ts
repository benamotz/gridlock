import { GAMEPLAY, type WeaponId } from '@gridlock/shared';
import type { CityHooks, PlayerEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';
import type { CityDirector } from '../npc/CityDirector.js';
import { wantedStars } from '../sim/wanted.js';
import { dropMoney, giveCash, stepMoney, takeCash } from './cash.js';
import { Jobs } from './jobs.js';
import { Services } from './services.js';

const MONEY = GAMEPLAY.money;

/**
 * Free-roam money. Nothing is saved: a player starts each visit with the same
 * stake and earns it from the city - wallets, bounties, chop shops, store
 * hold-ups and jobs - and loses it to bail, death and spending.
 */
export class Economy implements CityHooks {
  readonly jobs: Jobs;
  readonly services: Services;
  /** Players who have already been handed their starting stake this visit. */
  private readonly staked = new Set<string>();

  constructor(private readonly world: World, city: CityDirector) {
    this.jobs = new Jobs(world, city);
    this.services = new Services(world, this.jobs);
  }

  update(): void {
    const world = this.world;
    for (const p of world.players.values()) {
      if (p.npc || this.staked.has(p.id)) continue;
      this.staked.add(p.id);
      p.cash = MONEY.start;
    }
    // Forget players who have left, so a later visit starts fresh.
    for (const id of [...this.staked]) if (!world.players.has(id)) this.staked.delete(id);

    stepMoney(world);
    this.services.step();
    this.jobs.step();
  }

  /** A pedestrian punched or knocked down hands over half their wallet, once. */
  onHurt(target: PlayerEntity, attacker: PlayerEntity | null, weapon: WeaponId): void {
    if (target.npc !== 'ped' || target.mugged || !attacker || attacker.npc) return;
    if (weapon !== 'fists') return;
    target.mugged = true;
    const take = Math.floor(target.cash / 2);
    target.cash -= take;
    dropMoney(this.world, target.x, target.y, take);
  }

  onKill(victim: PlayerEntity, killer: PlayerEntity | null): void {
    const world = this.world;
    if (victim.npc) {
      // Whatever they carried falls with them.
      dropMoney(world, victim.x, victim.y, victim.cash);
      victim.cash = 0;
    } else {
      // A wanted player is worth a bounty to whoever takes them down.
      const stars = wantedStars(victim.heat);
      if (stars > 0 && killer && !killer.npc && killer.id !== victim.id) {
        giveCash(world, killer, MONEY.bountyByStars[stars], 'bounty');
      }
      // And part of what they carried is left in the street.
      const dropped = takeCash(world, victim, victim.cash * MONEY.deathDrop, 'death');
      dropMoney(world, victim.x, victim.y, dropped);
    }
    this.jobs.onKill(victim, killer);
  }

  interact(p: PlayerEntity): boolean {
    return this.services.interact(p);
  }

  prompt(p: PlayerEntity): string | null {
    return this.services.prompt(p);
  }

  answerPhone(p: PlayerEntity, accept: boolean): void {
    this.jobs.answer(p, accept);
  }
}
