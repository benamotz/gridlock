import { Btn, GAMEPLAY } from '@gridlock/shared';
import type { PlayerEntity } from '../sim/entities.js';
import { exitVehicle, vehicleSurfaceDistance } from '../sim/vehicles.js';
import {
  clearWanted, markSeen, outOfJurisdiction, recentlySeen, sightRange, wantedStars,
} from '../sim/wanted.js';
import { takeCash } from '../economy/cash.js';
import type { CityDirector } from './CityDirector.js';
import { type Command, type CopBrain, towards } from './brains.js';
import type { Point } from './roadNet.js';

const POLICE = GAMEPLAY.police;
const CITY = GAMEPLAY.city;
const MONEY = GAMEPLAY.money;

interface Roadblock {
  suspectId: string;
  vehicleIds: number[];
}

/**
 * The police: patrols, dispatch, pursuit, search, road blocks and arrests.
 *
 * Officers only know what they have seen. A crime is reported from the scene
 * (at once if an officer witnessed it, after a delay otherwise); each sighting
 * updates the last known position and is shared by radio for a moment. Once
 * every officer has lost the suspect, units search around that position
 * instead of following them for free - which is what makes a getaway possible.
 */
export class PoliceForce {
  private nextDispatchAt = 0;
  private readonly nextRoadblockAt = new Map<string, number>();
  private roadblocks: Roadblock[] = [];

  constructor(private readonly city: CityDirector) {}

  private get world() {
    return this.city.world;
  }

  update(): void {
    if (this.world.now < this.nextDispatchAt) return;
    this.nextDispatchAt = this.world.now + POLICE.dispatchMs;
    this.dispatch();
  }

  /** Dispatched units leave once nobody is wanted and nobody is watching. */
  offDuty(b: CopBrain, p: PlayerEntity, humans: PlayerEntity[]): boolean {
    return b.dispatched && b.idleSince > 0 &&
      this.world.now - b.idleSince > POLICE.standDownSec * 1000 &&
      this.city.nearestHumanDist(p.x, p.y, humans) > CITY.spawnClearDist;
  }

  // -------------------------------------------------------------------------
  // Units
  // -------------------------------------------------------------------------

  private copCount(): number {
    let n = 0;
    for (const b of this.city.brains.values()) if (b.kind === 'cop') n++;
    return n;
  }

  private chasing(suspectId: string): number {
    let n = 0;
    for (const b of this.city.brains.values()) {
      if (b.kind === 'cop' && b.targetId === suspectId) n++;
    }
    return n;
  }

  private addOfficer(
    x: number, y: number, targetId: string | null, dispatched: boolean, post: Point | null = null,
  ): PlayerEntity {
    const p = this.city.addResident('cop', x, y, POLICE.officerHealth, 'pistol');
    this.city.brains.set(p.id, {
      kind: 'cop', id: p.id, seq: 0, lastX: x, lastY: y, stuckMs: 0,
      corner: { node: this.city.net.nearestNode(x, y), sx: 1, sy: 1 },
      prevNode: -1, panicUntil: 0, threatX: 0, threatY: 0,
      from: -1, to: -1, blockedMs: 0, pushThroughUntil: 0,
      targetId, dispatched, idleSince: 0, toggle: false, jinkUntil: 0, jinkAngle: 0,
      searchX: 0, searchY: 0, searchSet: false, searchAnchorX: 0, searchAnchorY: 0,
      post,
    });
    return p;
  }

  /** A squad car with two officers aboard. */
  private addSquadCar(
    x: number, y: number, rot: number, targetId: string | null, dispatched: boolean,
  ): boolean {
    if (!this.city.vehicleFits('car', x, y, rot)) return false;
    const v = this.world.addVehicle('car', x, y, rot);
    v.police = true;
    const driver = this.addOfficer(x, y, targetId, dispatched);
    const partner = this.addOfficer(x, y, targetId, dispatched);
    v.driverId = driver.id;
    v.passengers.push(partner.id);
    driver.vehicleId = v.id;
    partner.vehicleId = v.id;
    return true;
  }

  /** Squad cars on their rounds, one or so around each player. */
  patrol(): void {
    const world = this.world;
    const humans = this.city.humans().filter((h) => h.life === 'alive');
    const crews: PlayerEntity[] = [];
    for (const b of this.city.brains.values()) {
      if (b.kind !== 'cop' || b.dispatched) continue;
      const p = world.players.get(b.id);
      const v = p?.vehicleId != null ? world.vehicles.get(p.vehicleId) : undefined;
      if (p && v?.driverId === p.id) crews.push(p);
    }
    let total = crews.length;
    for (const h of humans) {
      if (total >= POLICE.maxPatrols || this.copCount() + 2 > POLICE.maxCops) return;
      const near = crews.filter((c) => Math.hypot(c.x - h.x, c.y - h.y) < CITY.spawnMaxDist).length;
      if (near >= POLICE.patrolsPerPlayer) continue;
      const nodes = this.city.spawnNodes(h, humans, CITY.spawnMinDist, CITY.spawnMaxDist);
      if (nodes.length === 0) continue;
      const from = nodes[Math.floor(world.rng() * nodes.length)];
      const pose = this.city.lanePose(from);
      if (!pose || !this.addSquadCar(pose.x, pose.y, pose.rot, null, false)) continue;
      total++;
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private dispatch(): void {
    const world = this.world;
    const humans = this.city.humans();
    let cops = this.copCount();

    for (const suspect of humans) {
      const stars = wantedStars(suspect.heat);
      if (stars === 0 || suspect.life !== 'alive') continue;
      // An unwitnessed crime takes a moment to be phoned in.
      if (world.now < suspect.reportAt) continue;

      // A suspect who has left town gets a thinner pursuit: the officers already
      // on their tail keep going, but fewer new ones are sent.
      const base = POLICE.unitsByStars[stars];
      const want = outOfJurisdiction(world, suspect) ? Math.ceil(base * POLICE.outsideUnits) : base;
      let have = this.chasing(suspect.id);

      // Officers already nearby (patrols included) answer the call first.
      for (const b of this.city.brains.values()) {
        if (have >= want) break;
        if (b.kind !== 'cop' || b.targetId !== null || b.post) continue;
        const cop = world.players.get(b.id);
        if (!cop || cop.life !== 'alive') continue;
        if (Math.hypot(cop.x - suspect.lkpX, cop.y - suspect.lkpY) > POLICE.spawnMaxDist) continue;
        b.targetId = suspect.id;
        b.idleSince = 0;
        b.searchSet = false;
        have++;
      }
      // Units sent to a scene nobody is near would vanish again at once (the
      // city only keeps residents around players): the suspect has got away
      // from there, so nobody new is sent.
      const sceneWatched = this.city.nearestHumanDist(suspect.lkpX, suspect.lkpY, humans) <
        CITY.despawnDist - 200;
      while (sceneWatched && have < want && cops < POLICE.maxCops) {
        // Two to a car whenever two or more are needed.
        const sent = want - have >= 2 ? this.sendSquadCar(suspect, humans) : this.sendOfficer(suspect, humans);
        if (sent === 0) break;
        have += sent;
        cops += sent;
      }
      if (stars >= POLICE.roadblockFromStars) this.maybeRoadblock(suspect, humans, stars);
    }
  }

  /**
   * Where new units come from: around the last known position, never inside
   * the suspect's view, and (when the city allows) out of other players' view.
   */
  private unitNode(suspect: PlayerEntity, humans: PlayerEntity[]): number {
    const stars = wantedStars(suspect.heat);
    const unseen = sightRange(stars) + 150;
    const others = humans.filter((h) => h.id !== suspect.id);
    const anchor = { x: suspect.lkpX, y: suspect.lkpY };
    const net = this.city.net;
    // A crowded city may have no intersection out of everyone's sight; other
    // players' clearance gives way before the suspect's does.
    for (const clear of [CITY.spawnClearDist, 300, 0]) {
      const nodes = this.city.spawnNodes(anchor, others, POLICE.spawnMinDist, POLICE.spawnMaxDist, clear)
        .filter((i) => Math.hypot(net.nodes[i].x - suspect.x, net.nodes[i].y - suspect.y) >= unseen);
      if (nodes.length > 0) return nodes[Math.floor(this.world.rng() * nodes.length)];
    }
    return -1;
  }

  private sendOfficer(suspect: PlayerEntity, humans: PlayerEntity[]): number {
    const node = this.unitNode(suspect, humans);
    if (node < 0) return 0;
    const n = this.city.net.nodes[node];
    if (this.world.grid.circleBlocked(n.x, n.y, GAMEPLAY.player.radius)) return 0;
    this.addOfficer(n.x, n.y, suspect.id, true);
    return 1;
  }

  private sendSquadCar(suspect: PlayerEntity, humans: PlayerEntity[]): number {
    const node = this.unitNode(suspect, humans);
    if (node < 0) return 0;
    const n = this.city.net.nodes[node];
    const rot = Math.atan2(suspect.lkpY - n.y, suspect.lkpX - n.x);
    return this.addSquadCar(n.x, n.y, rot, suspect.id, true) ? 2 : 0;
  }

  /**
   * Two squad cars parked across a straight stretch of road ahead of a
   * high-level suspect, with two officers covering it.
   */
  private maybeRoadblock(suspect: PlayerEntity, humans: PlayerEntity[], stars: number): void {
    const world = this.world;
    if (world.now < (this.nextRoadblockAt.get(suspect.id) ?? 0)) return;
    this.nextRoadblockAt.set(suspect.id, world.now + POLICE.roadblockEverySec * 1000);
    this.roadblocks = this.roadblocks.filter((r) => r.vehicleIds.some((id) => world.vehicles.has(id)));
    if (this.roadblocks.filter((r) => r.suspectId === suspect.id).length >= POLICE.roadblocksPerSuspect) return;
    if (this.copCount() + 2 > POLICE.maxCops) return;

    const net = this.city.net;
    const unseen = sightRange(stars) + 150;
    const others = humans.filter((h) => h.id !== suspect.id);
    const candidates: number[] = [];
    net.nodes.forEach((n, i) => {
      const adj = net.adj[i];
      if (adj.length !== 2) return;
      const [a, b] = [net.nodes[adj[0]], net.nodes[adj[1]]];
      // Straight through: both neighbours on one axis.
      if (!(a.x === n.x && b.x === n.x) && !(a.y === n.y && b.y === n.y)) return;
      const d = Math.hypot(n.x - suspect.x, n.y - suspect.y);
      if (d < Math.max(POLICE.roadblockMinDist, unseen) || d > POLICE.roadblockMaxDist) return;
      if (this.city.nearestHumanDist(n.x, n.y, others) < 300) return;
      candidates.push(i);
    });
    if (candidates.length === 0) return;
    const node = candidates[Math.floor(world.rng() * candidates.length)];
    const n = net.nodes[node];
    const horizontal = net.nodes[net.adj[node][0]].y === n.y;
    const rot = horizontal ? Math.PI / 2 : 0;
    const spots = horizontal
      ? [{ x: n.x, y: n.y - 36 }, { x: n.x, y: n.y + 36 }]
      : [{ x: n.x - 36, y: n.y }, { x: n.x + 36, y: n.y }];
    // Check both before placing either: each would otherwise block the other.
    if (!spots.every((s) => this.city.vehicleFits('car', s.x, s.y, rot))) return;

    const ids: number[] = [];
    for (const s of spots) {
      const v = world.addVehicle('car', s.x, s.y, rot);
      v.police = true;
      ids.push(v.id);
    }
    // Officers stand on the suspect's side of the cars.
    const side = horizontal ? Math.sign(suspect.x - n.x) || 1 : Math.sign(suspect.y - n.y) || 1;
    for (const off of [-22, 22]) {
      const post = horizontal
        ? { x: n.x + side * 70, y: n.y + off }
        : { x: n.x + off, y: n.y + side * 70 };
      if (world.grid.circleBlocked(post.x, post.y, GAMEPLAY.player.radius)) continue;
      this.addOfficer(post.x, post.y, suspect.id, true, post);
    }
    this.roadblocks.push({ suspectId: suspect.id, vehicleIds: ids });
  }

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  think(b: CopBrain, cop: PlayerEntity): Command {
    const world = this.world;
    b.toggle = !b.toggle;
    const suspect = b.targetId ? world.players.get(b.targetId) : undefined;
    const stars = suspect ? wantedStars(suspect.heat) : 0;
    if (!suspect || suspect.life !== 'alive' || stars === 0) {
      if (b.idleSince === 0) {
        b.idleSince = world.now;
        b.targetId = null;
        b.post = null;
        // Forget the old route; a patrol picks its lanes up afresh.
        b.from = -1;
        b.to = -1;
      }
      return this.idle(b, cop);
    }
    b.idleSince = 0;

    // Keep a sidearm fed: officers never run dry mid-chase.
    const gun = cop.slots[cop.slot];
    if (gun && gun.id !== 'fists' && gun.reserve < 12) gun.reserve = 24;

    const dist = Math.hypot(suspect.x - cop.x, suspect.y - cop.y);
    const sees = dist < sightRange(stars) &&
      world.grid.lineOfSight(cop.x, cop.y, suspect.x, suspect.y);
    if (sees) markSeen(world, suspect);
    if (sees && this.canArrest(cop, suspect)) {
      this.bust(suspect);
      return { buttons: 0, aim: cop.aim };
    }

    if (cop.vehicleId !== null) return this.driving(b, cop, suspect, dist, sees, stars);

    const known = recentlySeen(world, suspect);
    if (b.post && !known) {
      return { buttons: 0, aim: Math.atan2(suspect.lkpY - cop.y, suspect.lkpX - cop.x) };
    }
    if (!known) return this.search(b, cop, suspect, 0.9, 0);

    b.post = null;
    b.searchSet = false;
    if (sees && stars >= POLICE.shootFromStars && dist < POLICE.shootRange) {
      // Hold a standoff distance and fire, with honest inaccuracy.
      const aim = Math.atan2(suspect.y - cop.y, suspect.x - cop.x) +
        (world.rng() * 2 - 1) * POLICE.aimError;
      let buttons = b.toggle ? Btn.Fire : 0;
      if (gun && gun.ammo === 0) buttons = Btn.Reload;
      if (dist > POLICE.standoff + 60) return { ...towards(cop, suspect, 0.8, buttons), aim };
      if (dist < POLICE.standoff - 60) {
        return { ...towards(cop, { x: 2 * cop.x - suspect.x, y: 2 * cop.y - suspect.y }, 0.5, buttons), aim };
      }
      return { buttons, aim };
    }
    // Close enough to run the suspect down and make the arrest.
    if (sees && dist < 520) return towards(cop, suspect, 1, Btn.Sprint);
    return this.pursue(b, cop, suspect);
  }

  /** Off the direct line: through the road grid toward the radioed position. */
  private pursue(b: CopBrain, cop: PlayerEntity, suspect: PlayerEntity): Command {
    const world = this.world;
    if (b.stuckMs > 900) {
      b.jinkUntil = world.now + 700;
      b.jinkAngle = world.rng() * Math.PI * 2;
      b.stuckMs = 0;
    }
    if (world.now < b.jinkUntil) {
      return towards(cop, {
        x: cop.x + Math.cos(b.jinkAngle) * 100, y: cop.y + Math.sin(b.jinkAngle) * 100,
      }, 1, 0);
    }
    return towards(cop, this.city.route(b, cop, suspect), 1, Btn.Sprint);
  }

  /**
   * The suspect has been lost: go to where they were last seen, then check
   * intersections around it until someone spots them again.
   */
  private search(
    b: CopBrain, from: Point, suspect: PlayerEntity, pace: number, buttons: number, aim?: number,
  ): Command {
    const world = this.world;
    const net = this.city.net;
    const moved = Math.hypot(b.searchAnchorX - suspect.lkpX, b.searchAnchorY - suspect.lkpY) > 50;
    const arrived = Math.hypot(b.searchX - from.x, b.searchY - from.y) < 90;
    if (!b.searchSet || moved) {
      b.searchSet = true;
      b.searchAnchorX = suspect.lkpX;
      b.searchAnchorY = suspect.lkpY;
      b.searchX = suspect.lkpX;
      b.searchY = suspect.lkpY;
    } else if (arrived || b.stuckMs > 1500) {
      b.stuckMs = 0;
      const nearby = net.nodes
        .map((n, i) => ({ n, i }))
        .filter(({ n, i }) => net.adj[i].length > 0 &&
          Math.hypot(n.x - suspect.lkpX, n.y - suspect.lkpY) < POLICE.searchRadius);
      const pick = nearby.length > 0 ? nearby[Math.floor(world.rng() * nearby.length)].n : null;
      b.searchX = pick ? pick.x : suspect.lkpX + (world.rng() * 2 - 1) * 200;
      b.searchY = pick ? pick.y : suspect.lkpY + (world.rng() * 2 - 1) * 200;
    }
    const goal = { x: b.searchX, y: b.searchY };
    return towards(from, this.city.route(b, from, goal, aim), pace, buttons, aim);
  }

  private driving(
    b: CopBrain, cop: PlayerEntity, suspect: PlayerEntity, dist: number, sees: boolean, stars: number,
  ): Command {
    const world = this.world;
    const v = world.vehicles.get(cop.vehicleId!);
    if (!v) return { buttons: 0, aim: cop.aim };
    const speed = Math.hypot(v.vx, v.vy);
    const along = v.vx * Math.cos(v.rot) + v.vy * Math.sin(v.rot);
    const driver = v.driverId === cop.id;
    const known = recentlySeen(world, suspect);
    const onFoot = suspect.vehicleId === null;
    const driverGone = !driver && !this.isOfficer(v.driverId);

    // A suspect on foot is chased on foot; a crew whose driver is gone, or
    // whose car is stuck, gets out too.
    if ((known && onFoot && dist < 320) || driverGone) {
      if (speed < 45) return { buttons: b.toggle ? Btn.Interact : 0, aim: v.rot };
      return { buttons: driver && along > 15 ? Btn.Down : 0, aim: v.rot };
    }
    if (!driver) {
      // The partner leans out of the window at high levels.
      if (sees && stars >= POLICE.passengerShootFromStars && dist < POLICE.shootRange) {
        const aim = Math.atan2(suspect.y - cop.y, suspect.x - cop.x) +
          (world.rng() * 2 - 1) * POLICE.aimError * 1.5;
        return { buttons: b.toggle ? Btn.Fire : 0, aim };
      }
      return { buttons: 0, aim: v.rot };
    }
    if (known) {
      const dest = sees && dist < 650 ? suspect : this.city.route(b, v, suspect, v.rot);
      // Flat out at a suspect who is driving: ramming is fair game.
      return towards(v, dest, onFoot ? 0.85 : 1, 0, v.rot);
    }
    return this.search(b, v, suspect, 0.75, 0, v.rot);
  }

  /** Nobody to chase: patrol crews resume their rounds, others drift off. */
  private idle(b: CopBrain, cop: PlayerEntity): Command {
    if (cop.vehicleId !== null) {
      const v = this.world.vehicles.get(cop.vehicleId);
      if (v && v.driverId === cop.id) return this.city.followLanes(b, v, 0.5);
      return { buttons: 0, aim: cop.aim };
    }
    if (b.post) return { buttons: 0, aim: cop.aim };
    // An officer on foot with nothing to do is done for the day.
    b.dispatched = true;
    return this.city.walk(b, cop, 1);
  }

  private isOfficer(id: string | null): boolean {
    if (!id) return false;
    const p = this.world.players.get(id);
    return !!p && p.npc === 'cop' && p.life === 'alive';
  }

  private canArrest(cop: PlayerEntity, suspect: PlayerEntity): boolean {
    if (cop.vehicleId !== null) return false;
    if (suspect.vehicleId === null) {
      const d = Math.hypot(suspect.x - cop.x, suspect.y - cop.y);
      return d < POLICE.bustRange && Math.hypot(suspect.vx, suspect.vy) < POLICE.bustMaxSpeed;
    }
    // A suspect who stops their car next to an officer is pulled out.
    const v = this.world.vehicles.get(suspect.vehicleId);
    if (!v) return false;
    return Math.hypot(v.vx, v.vy) < 30 &&
      vehicleSurfaceDistance(v, cop.x, cop.y).d < POLICE.bustRange - 12;
  }

  /** Arrested: out of any vehicle, bail paid, wanted level cleared, back later. */
  private bust(suspect: PlayerEntity): void {
    const world = this.world;
    if (suspect.vehicleId !== null) exitVehicle(world, suspect);
    const bail = takeCash(world, suspect, suspect.cash * MONEY.bail, 'bail');
    world.emit({ e: 'busted', by: suspect.id, bail });
    clearWanted(suspect);
    world.respawnPlayer(suspect, world.config.respawnDelaySec * 1000);
  }
}
