import { Btn, GAMEPLAY, type WeaponId, vehicleBodyWorld, weaponDef } from '@gridlock/shared';
import type { PlayerEntity, VehicleEntity } from '../sim/entities.js';
import type { CityDirector } from './CityDirector.js';
import { type Command, type CrewBrain, towards } from './brains.js';

const CREW = GAMEPLAY.crew;

interface Group {
  id: number;
  /** The one player this crew fights; nobody else is ever a target. */
  holder: string;
  members: Set<string>;
  homeX: number;
  homeY: number;
  /** How far from home members will chase; unlimited for an escort. */
  leash: number;
  alerted: boolean;
  /** For an escort: the van it guards, and the car it rides in. */
  vanId: number | null;
  carId: number | null;
}

/**
 * Armed crews: hostile residents a job sets against one player - guards
 * riding behind a cash van, or gunmen holed up in a hideout.
 *
 * Members stand guard until the group spots its target or is attacked; then
 * every member fights. They shoot by the police's rules (honest aim error,
 * bursts from automatic weapons, a standoff distance) and chase to where the
 * target was last seen, but only ever at that one player.
 */
export class Crews {
  private readonly groups = new Map<number, Group>();
  private nextGroup = 1;

  constructor(private readonly city: CityDirector) {}

  private get world() {
    return this.city.world;
  }

  /** Members still standing. */
  alive(groupId: number): number {
    const g = this.groups.get(groupId);
    if (!g) return 0;
    let n = 0;
    for (const id of g.members) {
      const p = this.world.players.get(id);
      if (p && p.life === 'alive') n++;
    }
    return n;
  }

  isAlerted(groupId: number): boolean {
    return this.groups.get(groupId)?.alerted ?? false;
  }

  /** The job is over: survivors stop fighting and drift off like anyone else. */
  disband(groupId: number): void {
    const g = this.groups.get(groupId);
    if (!g) return;
    this.groups.delete(groupId);
    for (const id of g.members) {
      const b = this.city.brains.get(id);
      if (b?.kind === 'crew') b.targetId = null;
      const p = this.world.players.get(id);
      if (p) p.markedFor = null;
    }
  }

  /** Raises the alarm on gunfire at a member, or an attack on the van. */
  update(): void {
    const world = this.world;
    for (const e of world.events) {
      if (e.e !== 'damage') continue;
      for (const g of this.groups.values()) {
        if (g.members.has(e.to)) this.alert(g, e.fromX, e.fromY);
      }
    }
    for (const g of this.groups.values()) {
      if (g.alerted || g.vanId === null) continue;
      const van = world.vehicles.get(g.vanId);
      const attacked = van && van.lastDamagedBy === g.holder && world.now - van.lastDamagedAt < 1500;
      if (!van || van.destroyed || attacked) {
        const holder = world.players.get(g.holder);
        this.alert(g, holder?.x ?? g.homeX, holder?.y ?? g.homeY);
      }
    }
  }

  private alert(g: Group, x: number, y: number): void {
    const fresh = !g.alerted;
    g.alerted = true;
    for (const id of g.members) {
      const b = this.city.brains.get(id);
      if (b?.kind !== 'crew') continue;
      // Everyone gets the same beat to react to the alarm; without it, members
      // who heard the shout fired the instant they saw the target.
      if (fresh) b.reactAt = Math.max(b.reactAt, this.world.now + GAMEPLAY.crew.reactionMs);
      b.seenX = x;
      b.seenY = y;
      b.seenAt = this.world.now;
    }
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private newGroup(holder: string, x: number, y: number, leash: number): Group {
    const g: Group = {
      id: this.nextGroup++, holder, members: new Set(),
      homeX: x, homeY: y, leash, alerted: false, vanId: null, carId: null,
    };
    this.groups.set(g.id, g);
    return g;
  }

  private addMember(g: Group, x: number, y: number): PlayerEntity {
    const rng = this.world.rng;
    const weapon = CREW.weapons[Math.floor(rng() * CREW.weapons.length)] as WeaponId;
    const p = this.city.addResident('thug', x, y, CREW.health, weapon);
    p.armor = CREW.armor;
    // Kept in the world for the job, and ringed on the target's screen.
    p.markedFor = g.holder;
    this.city.brains.set(p.id, {
      kind: 'crew', id: p.id, seq: 0, lastX: x, lastY: y, stuckMs: 0,
      corner: { node: this.city.net.nearestNode(x, y), sx: 1, sy: 1 },
      prevNode: -1, panicUntil: 0, threatX: 0, threatY: 0,
      groupId: g.id, targetId: g.holder, postX: x, postY: y,
      seenX: x, seenY: y, seenAt: -Infinity, reactAt: 0,
      burstUntil: 0, restUntil: 0, toggle: false,
    });
    g.members.add(p.id);
    return p;
  }

  /**
   * Gunmen holed up around an intersection in town, away from the player.
   * Returns the group and where it is, or null if no spot fits.
   */
  spawnHideout(holder: PlayerEntity, count: number): { groupId: number; x: number; y: number } | null {
    const world = this.world;
    const net = this.city.net;
    const nodes = this.city.spawnNodes(holder, this.city.humans(), 900, 1700, 500)
      .filter((i) => !net.nodes[i].rural);
    for (let tries = 0; tries < 8 && nodes.length > 0; tries++) {
      const node = nodes.splice(Math.floor(world.rng() * nodes.length), 1)[0];
      const n = net.nodes[node];
      const posts = [
        { x: n.x, y: n.y },
        { x: n.x - 60, y: n.y - 60 }, { x: n.x + 60, y: n.y - 60 },
        { x: n.x - 60, y: n.y + 60 }, { x: n.x + 60, y: n.y + 60 },
        { x: n.x - 140, y: n.y }, { x: n.x + 140, y: n.y },
        { x: n.x, y: n.y - 140 }, { x: n.x, y: n.y + 140 },
      ].filter((s) => !world.grid.circleBlocked(s.x, s.y, GAMEPLAY.player.radius + 2));
      if (posts.length < Math.min(count, 3)) continue;
      const g = this.newGroup(holder.id, n.x, n.y, CREW.leash);
      for (const s of posts.slice(0, count)) this.addMember(g, s.x, s.y);
      return { groupId: g.id, x: n.x, y: n.y };
    }
    return null;
  }

  /** A car of armed guards tailing the cash van. Null if there is no room behind it. */
  spawnEscort(van: VehicleEntity, holder: PlayerEntity, count: number): number | null {
    const world = this.world;
    const fx = Math.cos(van.rot);
    const fy = Math.sin(van.rot);
    for (const back of [100, 150, 210]) {
      const x = van.x - fx * back;
      const y = van.y - fy * back;
      if (!this.city.vehicleFits('car', x, y, van.rot)) continue;
      const car = world.addVehicle('car', x, y, van.rot);
      car.protectedFor = holder.id;
      const g = this.newGroup(holder.id, van.x, van.y, Infinity);
      g.vanId = van.id;
      g.carId = car.id;
      for (let i = 0; i < Math.min(count, 4); i++) {
        const p = this.addMember(g, x, y);
        if (car.driverId === null) car.driverId = p.id;
        else car.passengers.push(p.id);
        p.vehicleId = car.id;
      }
      return g.id;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  think(b: CrewBrain, p: PlayerEntity): Command {
    const world = this.world;
    b.toggle = !b.toggle;
    const g = this.groups.get(b.groupId);
    const target = b.targetId ? world.players.get(b.targetId) : undefined;
    if (!g || !target || target.life !== 'alive') return this.idle(b, p);

    const dist = Math.hypot(target.x - p.x, target.y - p.y);
    const sees = dist < CREW.aggroRange && world.grid.lineOfSight(p.x, p.y, target.x, target.y);
    if (sees) {
      // A fresh sighting (not a moment's break in line of sight) takes a beat
      // to react to.
      if (world.now - b.seenAt > 1500) b.reactAt = world.now + CREW.reactionMs;
      b.seenX = target.x;
      b.seenY = target.y;
      b.seenAt = world.now;
      if (!g.alerted) this.alert(g, target.x, target.y);
    }

    if (p.vehicleId !== null) return this.riding(b, p, g);
    if (!g.alerted) return this.guard(b, p);

    // Keep a weapon fed: a crew fights until it is finished.
    const gun = p.slots[p.slot];
    if (gun && gun.id !== 'fists' && gun.reserve < 20) gun.reserve = 60;

    const fromHome = Math.hypot(p.x - g.homeX, p.y - g.homeY);
    if (!sees && fromHome > g.leash) {
      return towards(p, this.city.route(b, p, { x: g.homeX, y: g.homeY }), 1, Btn.Sprint);
    }
    if (sees && dist < CREW.shootRange) return this.shoot(b, p, target, dist);
    if (world.now - b.seenAt < 6000) {
      return towards(p, this.city.route(b, p, { x: b.seenX, y: b.seenY }), 1, Btn.Sprint);
    }
    return this.guard(b, p);
  }

  /**
   * A vehicle body between the shooter and the target. Line of sight only
   * knows the map, so an escort standing behind its own van was emptying
   * magazines into the van.
   */
  private vehicleInTheWay(p: PlayerEntity, target: PlayerEntity): boolean {
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const len2 = dx * dx + dy * dy || 1;
    for (const v of this.world.vehicles.values()) {
      if (v.destroyed || v.id === target.vehicleId || v.id === p.vehicleId) continue;
      for (const c of vehicleBodyWorld(v)) {
        const t = Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.y - p.y) * dy) / len2));
        if (t <= 0.02 || t >= 0.98) continue;
        const ex = p.x + dx * t - c.x;
        const ey = p.y + dy * t - c.y;
        if (ex * ex + ey * ey < (c.r + 3) ** 2) return true;
      }
    }
    return false;
  }

  /** Fire at the target from a standoff distance, in bursts for automatics. */
  private shoot(b: CrewBrain, p: PlayerEntity, target: PlayerEntity, dist: number): Command {
    const world = this.world;
    const gun = p.slots[p.slot];
    const aim = Math.atan2(target.y - p.y, target.x - p.x) + (world.rng() * 2 - 1) * CREW.aimError;
    if (this.vehicleInTheWay(p, target)) {
      // Hold fire and work round the obstruction.
      const side = (p.id.charCodeAt(p.id.length - 1) % 2) ? 1 : -1;
      const flank = { x: p.x - Math.sin(aim) * side * 120, y: p.y + Math.cos(aim) * side * 120 };
      return { ...towards(p, flank, 0.9, Btn.Sprint), aim };
    }
    let fire: boolean;
    if (world.now < b.reactAt) {
      fire = false;
    } else if (gun && weaponDef(gun.id).rpm >= 200) {
      if (world.now >= b.restUntil) {
        b.burstUntil = world.now + CREW.burstMs;
        b.restUntil = b.burstUntil + CREW.restMs;
      }
      fire = world.now < b.burstUntil;
    } else {
      // Semi-automatic: the trigger has to be released between shots.
      fire = b.toggle;
    }
    const buttons = gun && gun.ammo === 0 ? Btn.Reload : fire ? Btn.Fire : 0;
    if (dist > CREW.standoff + 70) return { ...towards(p, target, 0.75, buttons), aim };
    if (dist < CREW.standoff - 70) {
      return { ...towards(p, { x: 2 * p.x - target.x, y: 2 * p.y - target.y }, 0.5, buttons), aim };
    }
    // In range: sidestep a little, so a crew is not a row of statues.
    const side = Math.sin(world.now / 700 + p.x) > 0 ? 1 : -1;
    const strafe = { x: p.x - Math.sin(aim) * side * 60, y: p.y + Math.cos(aim) * side * 60 };
    return { ...towards(p, strafe, 0.35, buttons), aim };
  }

  /** Hold the post, facing out; walk back to it if pushed off. */
  private guard(b: CrewBrain, p: PlayerEntity): Command {
    if (Math.hypot(b.postX - p.x, b.postY - p.y) > 24) {
      return towards(p, this.city.route(b, p, { x: b.postX, y: b.postY }), 0.5, 0);
    }
    return { buttons: 0, aim: p.aim + Math.sin(this.world.now / 1500 + p.y) * 0.01 };
  }

  /** Escort duty: the driver tails the van; everyone bails out once alerted. */
  private riding(b: CrewBrain, p: PlayerEntity, g: Group): Command {
    const world = this.world;
    const car = world.vehicles.get(p.vehicleId!);
    if (!car) return { buttons: 0, aim: p.aim };
    const speed = Math.hypot(car.vx, car.vy);
    const along = car.vx * Math.cos(car.rot) + car.vy * Math.sin(car.rot);
    const driver = car.driverId === p.id;
    if (g.alerted) {
      if (speed < 45) return { buttons: b.toggle ? Btn.Interact : 0, aim: car.rot };
      return { buttons: driver && along > 15 ? Btn.Down : 0, aim: car.rot };
    }
    if (!driver) return { buttons: 0, aim: car.rot };
    const van = g.vanId !== null ? world.vehicles.get(g.vanId) : undefined;
    if (!van) return { buttons: along > 15 ? Btn.Down : 0, aim: car.rot };
    g.homeX = van.x;
    g.homeY = van.y;
    // A car length behind the van: close the gap, ease off, or wait.
    const spot = { x: van.x - Math.cos(van.rot) * 95, y: van.y - Math.sin(van.rot) * 95 };
    const gap = Math.hypot(spot.x - car.x, spot.y - car.y);
    if (gap < 45) return { buttons: along > 15 ? Btn.Down : 0, aim: car.rot };
    const pace = gap > 220 ? 1 : gap > 110 ? 0.7 : 0.45;
    return towards(car, this.city.route(b, car, spot, car.rot), pace, 0, car.rot);
  }

  /** No fight to have: stand down and wander off like anyone else. */
  private idle(b: CrewBrain, p: PlayerEntity): Command {
    if (p.vehicleId !== null) {
      const car = this.world.vehicles.get(p.vehicleId);
      const along = car ? car.vx * Math.cos(car.rot) + car.vy * Math.sin(car.rot) : 0;
      return { buttons: along > 15 ? Btn.Down : 0, aim: p.aim };
    }
    return this.city.walk(b, p, 0.8);
  }
}
