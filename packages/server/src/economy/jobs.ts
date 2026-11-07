import {
  GAMEPLAY,
  type JobKind,
  type ServiceDef,
  type VehicleTypeId,
  townAt,
  vehicleDef,
} from '@gridlock/shared';
import type { PlayerEntity, VehicleEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';
import type { CityDirector } from '../npc/CityDirector.js';
import { pickWeighted, randomBetween } from '../npc/brains.js';
import { setWanted, wantedStars } from '../sim/wanted.js';
import { dropMoney, giveCash } from './cash.js';
import { CONTACTS, type Contact, Story } from './story.js';
import type { PlayerCrews } from './playerCrews.js';

const JOBS = GAMEPLAY.jobs;
const PLAYER_CREW = GAMEPLAY.freeRoam.playerCrew;

/** What a steal-to-order job wants: a vehicle type, or a squad car. */
type BoostTarget = 'sports' | 'truck' | 'van' | 'motorcycle' | 'policeCar';
const BOOST_TARGETS: [BoostTarget, number][] = [
  ['sports', 3], ['truck', 2], ['van', 2], ['motorcycle', 2], ['policeCar', 1],
];

/** A job worked out in advance, so a call can quote it before it starts. */
interface Plan {
  kind: JobKind;
  title: string;
  reward: number;
  contact: Contact;
  brief: string;
  finale: boolean;
  dest?: { x: number; y: number };
  boost?: { target: BoostTarget; chop: ServiceDef; label: string };
  decoyStars?: number;
  bountyTargetId?: string | null;
  crewSize?: number;
}

interface Job extends Plan {
  holder: string;
  x: number;
  y: number;
  endsAt: number;
  targetId: string | null;
  truckId: number | null;
  /** The armed crew this job set against the player (escort or hideout). */
  crewId: number | null;
  /** The holder's player crew, remembered so the job outlives them leaving. */
  crewCode: string | null;
  /**
   * A courier run that will be ambushed once the courier gets this close to
   * the drop-off (null: no ambush, or it has already happened).
   */
  ambushWithin: number | null;
}

/** Jobs where the pay is for a gunfight, and grows with the crew taking it on. */
const COMBAT_KINDS: ReadonlySet<JobKind> = new Set(['hit', 'bounty', 'armored', 'hideout']);

interface Offer {
  plan: Plan;
  expiresAt: number;
}

/**
 * Jobs, handed out by three contacts (see `story.ts`), one at a time per
 * player and paid on completion. Each is built on something the city already
 * does:
 *
 * - courier: get to a drop-off in another town before the clock runs out;
 * - hit: kill a marked resident, who runs when they see you coming;
 * - boost (steal to order): bring a particular vehicle - perhaps a squad car -
 *   to a particular chop shop; the pay follows its condition;
 * - armored: wreck a security van on its rounds and grab the cash it spills;
 * - decoy: start with the police on you and lose them in time;
 * - bounty: bring down the most wanted player, or an armed fugitive.
 *
 * A phone booth puts you through to its town's contact on the spot. A
 * cellphone rings with offers from any of them wherever you are.
 */
export class Jobs {
  readonly story = new Story();
  private readonly jobs = new Map<string, Job>();
  private readonly offers = new Map<string, Offer>();

  constructor(
    private readonly world: World,
    private readonly city: CityDirector,
    private readonly crews: PlayerCrews,
  ) {}

  /** True while `p` or anyone in their crew is on a job: a crew shares one. */
  has(p: PlayerEntity): boolean {
    return this.jobFor(p) !== undefined;
  }

  /** The job `p` is on: their own, or the one their crew is on. */
  private jobFor(p: PlayerEntity): Job | undefined {
    const own = this.jobs.get(p.id);
    if (own) return own;
    for (const id of this.crews.memberIds(p.id)) {
      const job = this.jobs.get(id);
      if (job) return job;
    }
    return undefined;
  }

  /** Everyone on a job: its holder and the holder's crew, as in the world. */
  private crewOn(job: Job): PlayerEntity[] {
    const holder = this.world.players.get(job.holder);
    if (!holder) return [];
    return [holder, ...this.crews.mates(holder)];
  }

  /** A phone booth in `town` was used: hang up on a job, or take one. */
  phone(p: PlayerEntity, town = -1): void {
    const job = this.jobFor(p);
    if (job) {
      // Only whoever took the job can drop it for the whole crew.
      if (job.holder === p.id) this.fail(job, 'Job dropped');
      else this.notice(p, 'Your crew is already on a job');
      return;
    }
    this.clearOffer(p);
    const contact = this.story.contactFor(town, this.world.rng);
    const plan = this.plan(p, contact);
    if (!plan || !this.start(p, plan)) this.notice(p, 'Nobody is hiring right now');
  }

  /**
   * Starts a particular kind of job for a contact who offers it, bypassing the
   * random pick - for tests and any scripted moment that needs a known job.
   */
  startKind(p: PlayerEntity, kind: JobKind): boolean {
    const contact = CONTACTS.find((c) => c.kinds.some(([k]) => k === kind));
    if (!contact || this.has(p)) return false;
    const plan = this.plan(p, contact, kind);
    return plan !== null && this.start(p, plan);
  }

  /** The cellphone was answered. */
  answer(p: PlayerEntity, accept: boolean): void {
    const offer = this.offers.get(p.id);
    if (!offer) return;
    this.clearOffer(p);
    if (!accept || this.has(p) || p.life !== 'alive') {
      this.scheduleCall(p);
      return;
    }
    if (!this.start(p, offer.plan)) {
      this.notice(p, 'The job fell through');
      this.scheduleCall(p);
    }
  }

  step(): void {
    const world = this.world;
    this.story.forget((id) => world.players.has(id));
    this.ringPhones();
    for (const job of [...this.jobs.values()]) {
      let holder = world.players.get(job.holder);
      if (holder) job.crewCode = this.crews.codeOf(holder.id);
      // In a crew the job survives its holder going down or leaving: a
      // crewmate still standing carries it on.
      if (!holder || holder.life !== 'alive') {
        const heir = this.heir(job, holder);
        if (heir) holder = this.handOver(job, heir);
      }
      if (!holder) {
        this.finish(job);
        continue;
      }
      if (holder.life !== 'alive') {
        this.fail(job, job.kind === 'decoy' ? 'Job failed - they got you' : 'Job failed - you went down');
        continue;
      }
      if (world.now > job.endsAt) {
        this.fail(job, 'Job failed - out of time');
        continue;
      }
      this.advance(job, holder);
      if (this.jobs.get(job.holder) === job) this.publish(job, holder);
    }
    this.clearStaleJobWires();
  }

  /** A living crewmate who can take over a job whose holder is down or gone. */
  private heir(job: Job, holder: PlayerEntity | undefined): PlayerEntity | null {
    // A departed holder is already out of the crew registry; the code the job
    // remembered still finds the friends they left behind.
    const ids = holder ? this.crews.memberIds(holder.id) : this.crews.membersOf(job.crewCode);
    for (const id of ids) {
      if (id === job.holder) continue;
      const p = this.world.players.get(id);
      if (p && !p.npc && p.life === 'alive' && !this.jobs.has(p.id)) return p;
    }
    return null;
  }

  private handOver(job: Job, heir: PlayerEntity): PlayerEntity {
    const world = this.world;
    this.jobs.delete(job.holder);
    job.holder = heir.id;
    this.jobs.set(heir.id, job);
    const target = job.targetId ? world.players.get(job.targetId) : undefined;
    if (target?.npc) target.markedFor = heir.id;
    const truck = job.truckId !== null ? world.vehicles.get(job.truckId) : undefined;
    if (truck) {
      truck.protectedFor = heir.id;
      const driver = truck.driverId ? world.players.get(truck.driverId) : undefined;
      if (driver?.npc) driver.markedFor = heir.id;
    }
    if (job.crewId !== null) this.city.crews.setHolder(job.crewId, heir.id);
    this.notice(heir, 'You are carrying the job now');
    return heir;
  }

  /** Someone who left a crew (or whose crew finished) stops seeing its job. */
  private clearStaleJobWires(): void {
    const onJob = new Set<string>();
    for (const job of this.jobs.values()) for (const p of this.crewOn(job)) onJob.add(p.id);
    for (const p of this.world.players.values()) {
      if (!p.npc && p.job && !onJob.has(p.id)) p.job = null;
    }
  }

  /** Called for every death: a target only counts for the crew hunting it. */
  onKill(victim: PlayerEntity, killer: PlayerEntity | null): void {
    for (const job of [...this.jobs.values()]) {
      if (job.targetId !== victim.id) continue;
      const crew = this.crewOn(job);
      const ours = killer ? crew.find((p) => p.id === killer.id) : undefined;
      if (ours) this.complete(job, ours);
      else this.fail(job, 'Job failed - someone else got to the target');
    }
  }

  /**
   * A car pulled into a chop shop. If it is what this player's steal-to-order
   * job asked for, at the right shop, returns the job's pay (and completes it);
   * otherwise null and the shop buys it as usual.
   */
  chop(p: PlayerEntity, v: VehicleEntity, shop: ServiceDef): number | null {
    const job = this.jobFor(p);
    if (!job || job.kind !== 'boost' || !job.boost) return null;
    if (shop.id !== job.boost.chop.id || !matches(v, job.boost.target)) return null;
    const condition = Math.max(0, v.hp / Math.max(1, v.maxHp));
    const pay = Math.round((job.reward * (0.4 + 0.6 * condition)) / 10) * 10;
    this.complete(job, p, pay);
    return pay;
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  private plan(p: PlayerEntity, contact: Contact, only?: JobKind): Plan | null {
    const world = this.world;
    const rng = world.rng;
    const finale = this.story.isFinale(p.id, contact);
    const mult = finale ? JOBS.finaleMultiplier : 1;
    const chops = (world.mapDef.services ?? []).filter((s) => s.kind === 'chopshop');
    const kind = only ??
      (finale ? contact.finaleKind : this.story.pickKind(contact, rng, (k) => k !== 'boost' || chops.length > 0));
    if (!kind) return null;
    const base = { kind, contact, finale };
    const brief = (vars: Record<string, string>) => this.story.brief(p.id, contact, kind, vars, rng);

    switch (kind) {
      case 'courier': {
        const dest = this.pickDropOff(p);
        if (!dest) return null;
        const reward = Math.round(((JOBS.courierBase + Math.hypot(dest.x - p.x, dest.y - p.y) *
          JOBS.courierPerUnit) * mult) / 10) * 10;
        return {
          ...base, reward, dest: { x: dest.x, y: dest.y },
          title: `Courier: get the package to ${dest.where}`,
          brief: brief({ where: dest.where }),
        };
      }
      case 'hit': {
        const reward = Math.round((randomBetween(JOBS.hitReward, rng) * mult) / 10) * 10;
        return { ...base, reward, title: 'Hit: take out the marked target', brief: brief({}) };
      }
      case 'boost': {
        const target: BoostTarget = finale ? 'policeCar' : pickWeighted(BOOST_TARGETS, rng);
        const here = townAt(world.mapDef, p.x, p.y);
        const away = chops.filter((c) => c.town !== here);
        const chop = (away.length > 0 ? away : chops)[Math.floor(rng() * (away.length > 0 ? away.length : chops.length))];
        const where = world.mapDef.towns?.[chop.town]?.name ?? 'town';
        const label = target === 'policeCar' ? 'squad car' : vehicleDef(target).category.toLowerCase();
        return {
          ...base,
          reward: JOBS.boostReward[target] * mult,
          boost: { target, chop, label },
          title: `Steal to order: a ${label} for the ${where} chop shop`,
          brief: brief({ car: label, where }),
        };
      }
      case 'armored': {
        const reward = JOBS.truckCash * mult;
        return { ...base, reward, title: `Armored truck: wreck the cash van (up to $${reward})`, brief: brief({}) };
      }
      case 'decoy': {
        const stars = JOBS.decoyStars + (finale ? 1 : 0);
        return {
          ...base, decoyStars: stars, reward: JOBS.decoyReward * mult,
          title: `Decoy: take ${stars} stars of heat and lose it`,
          brief: brief({}),
        };
      }
      case 'hideout': {
        const reward = JOBS.hideoutReward * mult;
        const crew = JOBS.hideoutCrew + (finale ? 2 : 0);
        return {
          ...base, reward, crewSize: crew,
          title: `Crew hideout: clear out ${crew} gunmen`,
          brief: brief({}),
        };
      }
      case 'bounty': {
        const wanted = this.mostWanted(p);
        const name = wanted ? wanted.name : 'an armed fugitive';
        return {
          ...base,
          bountyTargetId: wanted?.id ?? null,
          reward: (wanted ? JOBS.bountyBonus : JOBS.fugitiveReward) * mult,
          title: `Bounty: bring down ${name}`,
          brief: brief({ target: name }),
        };
      }
    }
  }

  /** The most wanted other player, if anyone is worth a bounty job. */
  private mostWanted(p: PlayerEntity): PlayerEntity | null {
    let best: PlayerEntity | null = null;
    for (const o of this.world.players.values()) {
      if (o.npc || o.id === p.id || o.life !== 'alive') continue;
      // Never a bounty on your own crew.
      if (this.crews.same(p, o)) continue;
      const stars = wantedStars(o.heat);
      if (stars >= 2 && (!best || o.heat > best.heat)) best = o;
    }
    return best;
  }

  private pickDropOff(p: PlayerEntity): { x: number; y: number; where: string } | null {
    const world = this.world;
    const net = this.city.net;
    const here = townAt(world.mapDef, p.x, p.y);
    const towns = world.mapDef.towns ?? [];
    const options = net.nodes.filter((n, i) => {
      if (n.rural || net.adj[i].length === 0) return false;
      // Another town if the map has towns; otherwise just somewhere far.
      if (towns.length > 1) return townAt(world.mapDef, n.x, n.y) !== here;
      return Math.hypot(n.x - p.x, n.y - p.y) > 1500;
    });
    if (options.length === 0) return null;
    const n = options[Math.floor(world.rng() * options.length)];
    const town = townAt(world.mapDef, n.x, n.y);
    return { x: n.x, y: n.y, where: town >= 0 ? towns[town].name : 'the drop-off' };
  }

  // -------------------------------------------------------------------------
  // Running jobs
  // -------------------------------------------------------------------------

  private start(p: PlayerEntity, plan: Plan): boolean {
    const world = this.world;
    const job: Job = {
      ...plan, holder: p.id, x: p.x, y: p.y, endsAt: 0, targetId: null, truckId: null, crewId: null,
      crewCode: this.crews.codeOf(p.id), ambushWithin: null,
    };
    // A bigger crew faces more guns, and is paid for it.
    const extra = this.crews.mates(p).length;
    if (extra > 0 && COMBAT_KINDS.has(plan.kind)) {
      job.reward = Math.round((job.reward * (1 + JOBS.crewPayBonus * extra)) / 10) * 10;
    }
    const gang = (base: number): number => Math.min(JOBS.maxGang, base + extra);
    switch (plan.kind) {
      case 'courier': {
        // The clock starts from where the player is when they take the job.
        const d = plan.dest!;
        job.x = d.x;
        job.y = d.y;
        const route = Math.hypot(d.x - p.x, d.y - p.y);
        job.endsAt = world.now + (route / JOBS.courierSpeed + JOBS.courierSlackSec) * 1000;
        // Someone has heard about the package.
        if (world.rng() < JOBS.ambushChance + JOBS.ambushChancePerMate * extra) {
          job.ambushWithin = route * (1 - JOBS.ambushAtProgress);
        }
        break;
      }
      case 'hit':
      case 'bounty': {
        const human = plan.bountyTargetId ? world.players.get(plan.bountyTargetId) : undefined;
        if (human && human.life === 'alive' && wantedStars(human.heat) > 0) {
          job.targetId = human.id;
        } else {
          const target = this.spawnTarget(p, plan.kind === 'bounty');
          if (!target) return false;
          target.markedFor = p.id;
          job.targetId = target.id;
          // A hit target pays for protection; an armed fugitive brings friends
          // only when a whole crew is coming for them. Best effort either way.
          const guards = plan.kind === 'hit' ? gang(JOBS.bodyguards) : extra;
          if (guards > 0) {
            job.crewId = this.city.crews.spawnBodyguards(target, p, Math.min(guards, 4));
            if (job.crewId !== null) job.title = `${job.title} (${Math.min(guards, 4)} bodyguards)`;
          }
        }
        job.endsAt = world.now + (plan.kind === 'hit' ? JOBS.hitTimeSec : JOBS.bountyTimeSec) * 1000;
        break;
      }
      case 'boost':
        job.endsAt = world.now + JOBS.boostTimeSec * 1000;
        break;
      case 'armored': {
        const truck = this.spawnTruck(p);
        if (!truck) return false;
        job.truckId = truck.id;
        // The guards behind it are best effort: no room, no escort.
        job.crewId = this.city.crews.spawnEscort(truck, p, gang(JOBS.escortCrew));
        job.endsAt = world.now + JOBS.truckTimeSec * 1000;
        break;
      }
      case 'decoy':
        setWanted(world, p, plan.decoyStars ?? JOBS.decoyStars);
        job.endsAt = world.now + JOBS.decoyTimeSec * 1000;
        break;
      case 'hideout': {
        const hideout = this.city.crews.spawnHideout(p, gang(plan.crewSize ?? JOBS.hideoutCrew));
        if (!hideout) return false;
        job.crewId = hideout.groupId;
        job.x = hideout.x;
        job.y = hideout.y;
        job.endsAt = world.now + JOBS.hideoutTimeSec * 1000;
        break;
      }
    }
    this.jobs.set(p.id, job);
    this.advance(job, p);
    this.publish(job, p);
    this.notice(p, `${job.title} - $${job.reward}`);
    return true;
  }

  private spawnTarget(p: PlayerEntity, armed: boolean): PlayerEntity | null {
    const nodes = this.city.spawnNodes(p, this.city.humans(), JOBS.hitMinDist, JOBS.hitMaxDist, 400);
    for (let tries = 0; tries < 6 && nodes.length > 0; tries++) {
      const node = nodes.splice(Math.floor(this.world.rng() * nodes.length), 1)[0];
      const target = this.city.spawnPedAt(node, armed);
      if (target) return target;
    }
    return null;
  }

  private spawnTruck(p: PlayerEntity): VehicleEntity | null {
    const nodes = this.city.spawnNodes(p, this.city.humans(), JOBS.hitMinDist, JOBS.hitMaxDist, 500);
    for (let tries = 0; tries < 6 && nodes.length > 0; tries++) {
      const node = nodes.splice(Math.floor(this.world.rng() * nodes.length), 1)[0];
      const spawned = this.city.spawnTrafficAt(node, 'van');
      if (!spawned) continue;
      spawned.vehicle.security = true;
      spawned.vehicle.protectedFor = p.id;
      // The driver is kept around with the van.
      spawned.driver.markedFor = p.id;
      return spawned.vehicle;
    }
    return null;
  }

  /** Per-tick progress for each kind; completes or fails the job as it goes. */
  private advance(job: Job, holder: PlayerEntity): void {
    const world = this.world;
    switch (job.kind) {
      case 'courier': {
        // Any of the crew can make the drop.
        const crew = this.crewOn(job);
        const there = crew.find((p) =>
          p.life === 'alive' && Math.hypot(p.x - job.x, p.y - job.y) < JOBS.courierRadius);
        if (there) {
          this.complete(job, there);
          return;
        }
        if (job.ambushWithin !== null && job.crewId === null &&
          Math.hypot(holder.x - job.x, holder.y - job.y) < job.ambushWithin) {
          // Best effort: no road with room nearby, try again in a moment.
          const size = Math.min(4, JOBS.ambushCrew + crew.length - 1);
          job.crewId = this.city.crews.spawnAmbush(holder, size);
          if (job.crewId !== null) {
            job.ambushWithin = null;
            for (const p of crew) this.notice(p, 'Ambush! Someone knew about the package');
          }
        }
        return;
      }
      case 'hit':
      case 'bounty': {
        const target = job.targetId ? world.players.get(job.targetId) : undefined;
        if (!target || target.life !== 'alive') {
          if (!target) this.fail(job, 'Job failed - the target got away');
          return;
        }
        if (!target.npc && wantedStars(target.heat) === 0) {
          this.fail(job, 'They went quiet - the bounty is off');
          return;
        }
        job.x = target.x;
        job.y = target.y;
        return;
      }
      case 'boost': {
        const b = job.boost!;
        const v = holder.vehicleId !== null ? world.vehicles.get(holder.vehicleId) : undefined;
        if (v && v.driverId === holder.id && matches(v, b.target)) {
          job.x = b.chop.x;
          job.y = b.chop.y;
          job.title = `Deliver the ${b.label} to the chop shop`;
        } else {
          const car = this.nearestMatch(holder, b.target);
          job.x = car ? car.x : b.chop.x;
          job.y = car ? car.y : b.chop.y;
          job.title = car ? `Find a ${b.label}` : `Find a ${b.label} (none nearby yet)`;
        }
        return;
      }
      case 'armored': {
        const v = job.truckId !== null ? world.vehicles.get(job.truckId) : undefined;
        if (!v) {
          this.fail(job, 'Job failed - the van got away');
          return;
        }
        if (v.destroyed) {
          // The van bursts: the cash is in the street for whoever gets there.
          const bag = Math.round(job.reward / JOBS.truckBags);
          for (let i = 0; i < JOBS.truckBags; i++) {
            const a = (i / JOBS.truckBags) * Math.PI * 2;
            dropMoney(world, v.x + Math.cos(a) * 46, v.y + Math.sin(a) * 46, bag);
          }
          this.complete(job, holder, 0, 'The van is open - grab the cash!');
          return;
        }
        job.x = v.x;
        job.y = v.y;
        return;
      }
      case 'decoy':
        if (holder.heat <= 0) this.complete(job, holder);
        return;
      case 'hideout': {
        const left = job.crewId !== null ? this.city.crews.alive(job.crewId) : 0;
        if (left === 0) {
          this.complete(job, holder);
          return;
        }
        job.title = `Crew hideout: ${left} gunm${left === 1 ? 'an' : 'en'} left`;
        return;
      }
    }
  }

  private nearestMatch(p: PlayerEntity, target: BoostTarget): VehicleEntity | null {
    let best: VehicleEntity | null = null;
    let bestD = 3000;
    for (const v of this.world.vehicles.values()) {
      if (v.destroyed || !matches(v, target)) continue;
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best;
  }

  /** Shows the job to its holder and their whole crew. */
  private publish(job: Job, holder: PlayerEntity): void {
    const wire = {
      kind: job.kind, text: job.title,
      contact: job.contact.name, brief: job.brief,
      x: Math.round(job.x), y: Math.round(job.y),
      reward: job.reward, endsAt: job.endsAt,
    };
    holder.job = wire;
    for (const mate of this.crews.mates(holder)) mate.job = wire;
  }

  /**
   * Pays a finished job. A crew splits it between the members who were in on
   * it - near the job or near whoever finished it - so a friend idling across
   * town gets nothing.
   */
  private complete(job: Job, by: PlayerEntity, pay = job.reward, message = 'Job done'): void {
    const crew = this.crewOn(job);
    const near = (p: PlayerEntity): boolean =>
      Math.hypot(p.x - by.x, p.y - by.y) <= PLAYER_CREW.shareRadius ||
      Math.hypot(p.x - job.x, p.y - job.y) <= PLAYER_CREW.shareRadius;
    const paid = crew.filter((p) => p.id === by.id || near(p));
    if (paid.length === 0) paid.push(by);
    const share = paid.length > 1 ? Math.round(pay / paid.length / 10) * 10 : pay;
    for (const p of crew) {
      const inOnIt = paid.includes(p);
      if (pay > 0 && inOnIt) giveCash(this.world, p, share, 'job');
      const note = pay > 0 && paid.length > 1
        ? inOnIt ? `${message} - $${share} each` : `${message} - you were too far away for a cut`
        : message;
      this.notice(p, note);
    }
    const holder = this.world.players.get(job.holder) ?? by;
    this.say(holder, job.contact, this.story.close(holder.id, job.contact, true, job.finale, this.world.rng));
    this.finish(job);
  }

  private fail(job: Job, message: string): void {
    const holder = this.world.players.get(job.holder);
    for (const p of this.crewOn(job)) this.notice(p, message);
    if (holder) {
      this.say(holder, job.contact, this.story.close(holder.id, job.contact, false, job.finale, this.world.rng));
    }
    this.finish(job);
  }

  private finish(job: Job): void {
    const world = this.world;
    const crew = this.crewOn(job);
    if (this.jobs.get(job.holder) === job) this.jobs.delete(job.holder);
    for (const p of crew) {
      p.job = null;
      // The phone stays quiet for a while after a job, whatever the outcome.
      this.scheduleCall(p);
    }
    const target = job.targetId ? world.players.get(job.targetId) : undefined;
    if (target?.npc) target.markedFor = null;
    if (job.crewId !== null) this.city.crews.disband(job.crewId);
    const truck = job.truckId !== null ? world.vehicles.get(job.truckId) : undefined;
    if (truck) {
      truck.protectedFor = undefined;
      const driver = truck.driverId ? world.players.get(truck.driverId) : undefined;
      if (driver?.npc) driver.markedFor = null;
    }
  }

  // -------------------------------------------------------------------------
  // Cellphone
  // -------------------------------------------------------------------------

  /** Rings free phone owners with a new offer, and rings off unanswered calls. */
  private ringPhones(): void {
    const world = this.world;
    for (const [id, offer] of [...this.offers]) {
      const p = world.players.get(id);
      if (!p) {
        this.offers.delete(id);
        continue;
      }
      if (world.now >= offer.expiresAt) {
        this.clearOffer(p);
        this.notice(p, 'Missed call');
        this.scheduleCall(p);
      }
    }
    for (const p of world.players.values()) {
      if (p.npc || !p.hasPhone || p.life !== 'alive') continue;
      if (this.has(p) || this.offers.has(p.id) || world.now < p.nextOfferAt) continue;
      const contact = this.story.contactFor(-1, world.rng);
      const plan = this.plan(p, contact);
      if (!plan) {
        this.scheduleCall(p);
        continue;
      }
      const expiresAt = world.now + JOBS.cellRingSec * 1000;
      this.offers.set(p.id, { plan, expiresAt });
      p.phoneOffer = {
        kind: plan.kind, text: plan.title, reward: plan.reward, expiresAt,
        contact: plan.contact.name, brief: plan.brief,
      };
    }
  }

  private clearOffer(p: PlayerEntity): void {
    this.offers.delete(p.id);
    p.phoneOffer = null;
  }

  private scheduleCall(p: PlayerEntity): void {
    if (!p.hasPhone) return;
    p.nextOfferAt = this.world.now + randomBetween(JOBS.cellOfferEverySec, this.world.rng) * 1000;
  }

  private notice(p: PlayerEntity, text: string): void {
    this.world.emit({ e: 'notice', by: p.id, text });
  }

  /** A contact's line, shown with their name (and hidden if story text is off). */
  private say(p: PlayerEntity, c: Contact, text: string): void {
    this.world.emit({ e: 'notice', by: p.id, text, from: c.name });
  }
}

function matches(v: VehicleEntity, target: BoostTarget): boolean {
  if (v.destroyed) return false;
  if (target === 'policeCar') return !!v.police;
  return !v.police && !v.security && v.type === (target as VehicleTypeId);
}
