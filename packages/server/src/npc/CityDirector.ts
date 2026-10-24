import {
  Btn,
  GAMEPLAY,
  type NpcKind,
  type VehicleTypeId,
  type WeaponId,
  vehicleDef,
} from '@gridlock/shared';
import type { PlayerEntity, VehicleEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';
import {
  type Brain, type BrainBase, type Command, type DriverBrain, type LaneState,
  type PedBrain, type WalkState, pickWeighted, randomBetween, shuffle, towards,
} from './brains.js';
import { PoliceForce } from './police.js';
import { Crews } from './crews.js';
import { type Corner, type Point, RoadNet } from './roadNet.js';

const CITY = GAMEPLAY.city;
const MONEY = GAMEPLAY.money;

/** Clothing variants the client knows how to draw. */
export const RESIDENT_LOOKS = 8;

/** Weighted traffic mix: mostly ordinary cars, the occasional prize. */
const TRAFFIC_MIX: [VehicleTypeId, number][] = [
  ['car', 60], ['van', 18], ['sports', 9], ['truck', 8], ['motorcycle', 5],
];

/**
 * Everyone in the city who is not a player: pedestrians, traffic and (through
 * `PoliceForce`) the police.
 *
 * Residents are ordinary world players flagged `npc`, steered by sending the
 * same input commands a human would. Movement, collisions, damage, vehicles and
 * crimes therefore all go through the one simulation, and a resident can be
 * shot, run over, carjacked or arrested exactly like anyone else.
 *
 * Populations live in a ring around each player: topped up just off screen
 * and recycled once nobody is near, so an empty city costs nothing.
 */
export class CityDirector {
  readonly net: RoadNet;
  readonly brains = new Map<string, Brain>();
  readonly police: PoliceForce;
  readonly crews: Crews;
  private nextId = 1;
  private nextPopulateAt = 0;

  constructor(readonly world: World) {
    this.net = new RoadNet(world.mapDef, world.grid);
    this.police = new PoliceForce(this);
    this.crews = new Crews(this);
  }

  get residentCount(): number {
    return this.brains.size;
  }

  update(): void {
    if (!this.net.usable) return;
    const world = this.world;
    this.reactToTrouble();
    this.crews.update();
    for (const b of [...this.brains.values()]) this.think(b);

    if (world.now >= this.nextPopulateAt) {
      this.nextPopulateAt = world.now + CITY.populateMs;
      this.recycle();
      this.populate();
      this.police.patrol();
    }
    this.police.update();
  }

  // -------------------------------------------------------------------------
  // Shared helpers (also used by the police and jobs)
  // -------------------------------------------------------------------------

  humans(): PlayerEntity[] {
    return [...this.world.players.values()].filter((p) => !p.npc);
  }

  nearestHumanDist(x: number, y: number, humans: PlayerEntity[]): number {
    let best = Infinity;
    for (const h of humans) best = Math.min(best, Math.hypot(h.x - x, h.y - y));
    return best;
  }

  /** Intersections in a ring around `anchor` and at least `clear` from every player. */
  spawnNodes(
    anchor: Point, humans: PlayerEntity[], min: number, max: number,
    clear: number = CITY.spawnClearDist,
  ): number[] {
    const out: number[] = [];
    this.net.nodes.forEach((n, i) => {
      if (this.net.adj[i].length === 0) return;
      const d = Math.hypot(n.x - anchor.x, n.y - anchor.y);
      if (d < min || d > max) return;
      if (this.nearestHumanDist(n.x, n.y, humans) < clear) return;
      out.push(i);
    });
    return out;
  }

  newId(): string {
    return `npc-${this.nextId++}`;
  }

  vehicleFits(type: VehicleTypeId, x: number, y: number, rot = 0): boolean {
    const def = vehicleDef(type);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    for (const o of [-def.length / 3, 0, def.length / 3]) {
      if (this.world.grid.circleBlocked(x + c * o, y + s * o, def.width / 2 + 2)) return false;
    }
    const clear = def.length + 40;
    for (const v of this.world.vehicles.values()) {
      if ((v.x - x) ** 2 + (v.y - y) ** 2 < clear * clear) return false;
    }
    for (const p of this.world.players.values()) {
      if (p.vehicleId === null && (p.x - x) ** 2 + (p.y - y) ** 2 < clear * clear) return false;
    }
    return true;
  }

  remove(id: string): void {
    this.world.removePlayer(id);
    this.brains.delete(id);
  }

  addResident(
    kind: NpcKind, x: number, y: number, hp: number, weapon: WeaponId | null,
  ): PlayerEntity {
    const rng = this.world.rng;
    const name = kind === 'cop' ? 'Police' : kind === 'thug' ? 'Crew' : 'Civilian';
    const p = this.world.addNpc(
      this.newId(), name, kind, x, y, hp, weapon, Math.floor(rng() * RESIDENT_LOOKS),
    );
    const wallet = kind === 'cop' ? MONEY.copWallet : kind === 'thug' ? GAMEPLAY.crew.wallet : MONEY.pedWallet;
    p.cash = randomBetween(wallet, rng);
    return p;
  }

  send(p: PlayerEntity, b: Brain, cmd: Command): void {
    this.world.queueInput(p.id, [{
      seq: ++b.seq,
      dtMs: this.world.dt * 1000,
      buttons: cmd.buttons,
      aim: cmd.aim,
      slot: -1,
      ax: cmd.ax,
      ay: cmd.ay,
    }]);
  }

  /**
   * Where to head next on the way from `from` to `to`, for a brain that
   * remembers its answer briefly. Candidates are road points reachable in a
   * straight line; the best is the one with the shortest remaining route, and
   * a vehicle avoids points behind it (a U-turn mid-block jams on the kerb).
   */
  route(b: BrainBase, from: Point, to: Point, heading?: number): Point {
    const now = this.world.now;
    const cached = b.routeX !== undefined && b.routeY !== undefined && now < (b.routeAt ?? 0) &&
      Math.hypot(b.routeX - from.x, b.routeY - from.y) > 60;
    if (cached) return { x: b.routeX!, y: b.routeY! };
    const p = this.computeRoute(from, to, heading);
    b.routeX = p.x;
    b.routeY = p.y;
    b.routeAt = now + 250;
    return p;
  }

  private computeRoute(from: Point, to: Point, heading?: number): Point {
    const net = this.net;
    if (Math.hypot(to.x - from.x, to.y - from.y) < 400 && net.segmentClear(from, to, 16)) return to;
    const goal = net.nearestNode(to.x, to.y);
    if (goal < 0) return to;
    const hops = net.hopsTo(goal);
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < net.nodes.length; i++) {
      if (hops[i] < 0) continue;
      const n = net.nodes[i];
      const d = Math.hypot(n.x - from.x, n.y - from.y);
      if (d > 900) continue;
      let score = d + hops[i] * 560;
      if (heading !== undefined && d > 60) {
        const dot = ((n.x - from.x) * Math.cos(heading) + (n.y - from.y) * Math.sin(heading)) / d;
        if (dot < -0.2) score += 450;
      }
      if (score >= bestScore || !net.segmentClear(from, n, 16)) continue;
      best = i;
      bestScore = score;
    }
    if (best < 0) return this.routePoint(from, to);
    const n = net.nodes[best];
    // Already at it: on to the next one.
    if (Math.hypot(n.x - from.x, n.y - from.y) < 60 && best !== goal) {
      return net.nodes[net.nextHop(best, goal)];
    }
    return best === goal && net.segmentClear(n, to, 16) && Math.hypot(n.x - from.x, n.y - from.y) < 60 ? to : n;
  }

  /** The next point on the road route from `from` toward `to`. */
  routePoint(from: Point, to: Point): Point {
    const here = this.net.nearestNode(from.x, from.y);
    const goal = this.net.nearestNode(to.x, to.y);
    if (here < 0 || here === goal) return to;
    const hop = this.net.nextHop(here, goal);
    // Mid-block, the next intersection usually lies round a corner: the
    // straight line cuts through the corner building. Reach the nearest
    // intersection first unless the way to the next one is open.
    const next = this.net.nodes[hop];
    if (this.net.segmentClear(from, next, 18)) return next;
    return this.net.nodes[here];
  }

  // -------------------------------------------------------------------------
  // Population
  // -------------------------------------------------------------------------

  private recycle(): void {
    const world = this.world;
    const humans = this.humans();
    for (const b of [...this.brains.values()]) {
      const p = world.players.get(b.id);
      if (!p) {
        this.brains.delete(b.id);
        continue;
      }
      const gone = p.life !== 'alive' && world.now >= p.corpseUntil;
      // A hit target stays put for the player hunting it, however far away.
      const far = !p.markedFor && this.nearestHumanDist(p.x, p.y, humans) > CITY.despawnDist;
      const offDuty = b.kind === 'cop' && this.police.offDuty(b, p, humans);
      if (gone || far || offDuty) this.remove(p.id);
    }
    // Vehicles the city spawned are cleared once nobody is near and no player
    // is aboard; map vehicles keep their own respawn cycle.
    for (const v of [...world.vehicles.values()]) {
      if (v.spawnIndex !== -1) continue;
      const riders = [v.driverId, ...v.passengers]
        .map((id) => (id ? world.players.get(id) : undefined))
        .filter((p): p is PlayerEntity => !!p);
      if (riders.some((p) => !p.npc)) continue;
      if (v.protectedFor && world.players.has(v.protectedFor)) continue;
      if (this.nearestHumanDist(v.x, v.y, humans) <= CITY.despawnDist) continue;
      for (const r of riders) this.remove(r.id);
      world.vehicles.delete(v.id);
    }
  }

  private populate(): void {
    const humans = this.humans().filter((h) => h.life === 'alive');
    let peds = 0;
    let traffic = 0;
    for (const b of this.brains.values()) {
      if (b.kind === 'ped') peds++;
      else if (b.kind === 'driver') traffic++;
    }
    for (const h of shuffle(humans, this.world.rng)) {
      const nearby = this.countNear(h, CITY.spawnMaxDist);
      if (nearby.peds < CITY.pedsPerPlayer && peds < CITY.maxPeds) {
        if (this.spawnPed(h, humans)) peds++;
      }
      if (nearby.traffic < CITY.trafficPerPlayer && traffic < CITY.maxTraffic) {
        if (this.spawnTraffic(h, humans)) traffic++;
      }
    }
  }

  private countNear(h: PlayerEntity, radius: number): { peds: number; traffic: number } {
    let peds = 0;
    let traffic = 0;
    const r2 = radius * radius;
    for (const b of this.brains.values()) {
      const p = this.world.players.get(b.id);
      if (!p || (p.x - h.x) ** 2 + (p.y - h.y) ** 2 > r2) continue;
      if (b.kind === 'ped') peds++;
      else if (b.kind === 'driver') traffic++;
    }
    return { peds, traffic };
  }

  private spawnPed(h: PlayerEntity, humans: PlayerEntity[]): boolean {
    const nodes = this.spawnNodes(h, humans, CITY.spawnMinDist, CITY.spawnMaxDist);
    if (nodes.length === 0) return false;
    return this.spawnPedAt(nodes[Math.floor(this.world.rng() * nodes.length)]) !== null;
  }

  /**
   * A pedestrian on a random kerb corner of `node`, or null if none fits. An
   * armed one (a bounty fugitive) carries a sidearm and uses it.
   */
  spawnPedAt(node: number, armed = false): PlayerEntity | null {
    const rng = this.world.rng;
    if (this.net.nodes[node].rural) return null;
    const corner: Corner = { node, sx: rng() < 0.5 ? -1 : 1, sy: rng() < 0.5 ? -1 : 1 };
    if (!this.net.adj[node].some((m) => this.net.kerbClear(corner, m))) return null;
    const at = this.net.cornerPoint(corner);
    if (this.world.grid.circleBlocked(at.x, at.y, GAMEPLAY.player.radius)) return null;

    const p = this.addResident('ped', at.x, at.y, armed ? 100 : CITY.pedHealth, armed ? 'pistol' : null);
    this.brains.set(p.id, {
      kind: 'ped', id: p.id, seq: 0, lastX: at.x, lastY: at.y, stuckMs: 0,
      corner, prevNode: -1, panicUntil: 0, threatX: 0, threatY: 0, armed,
    });
    return p;
  }

  /** A random lane segment starting at `from`, as a spawn pose. */
  lanePose(from: number): { to: number; x: number; y: number; rot: number } | null {
    const options = this.net.adj[from].filter((m) => this.net.laneClear(from, m));
    if (options.length === 0) return null;
    const to = options[Math.floor(this.world.rng() * options.length)];
    // Mid-block in the right-hand lane, facing along the road.
    const end = this.net.lanePoint(from, to);
    const a = this.net.nodes[from];
    const b = this.net.nodes[to];
    return {
      to,
      x: (a.x + end.x - b.x + end.x) / 2,
      y: (a.y + end.y - b.y + end.y) / 2,
      rot: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  private spawnTraffic(h: PlayerEntity, humans: PlayerEntity[]): boolean {
    const rng = this.world.rng;
    const nodes = this.spawnNodes(h, humans, CITY.spawnMinDist, CITY.spawnMaxDist);
    if (nodes.length === 0) return false;
    const from = nodes[Math.floor(rng() * nodes.length)];
    return this.spawnTrafficAt(from, pickWeighted(TRAFFIC_MIX, rng)) !== null;
  }

  /** A vehicle of `type` driven by a resident, in a lane leaving `from`. */
  spawnTrafficAt(from: number, type: VehicleTypeId): { vehicle: VehicleEntity; driver: PlayerEntity } | null {
    const pose = this.lanePose(from);
    if (!pose || !this.vehicleFits(type, pose.x, pose.y, pose.rot)) return null;
    const vehicle = this.world.addVehicle(type, pose.x, pose.y, pose.rot);
    const driver = this.addResident('ped', pose.x, pose.y, CITY.pedHealth, null);
    vehicle.driverId = driver.id;
    driver.vehicleId = vehicle.id;
    this.brains.set(driver.id, {
      kind: 'driver', id: driver.id, seq: 0, lastX: pose.x, lastY: pose.y, stuckMs: 0,
      vehicleId: vehicle.id, from, to: pose.to, blockedMs: 0, pushThroughUntil: 0,
    });
    return { vehicle, driver };
  }

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  /** Gunfire, blasts and injuries send nearby pedestrians running. */
  private reactToTrouble(): void {
    const world = this.world;
    const r2 = CITY.panicRadius ** 2;
    for (const e of world.events) {
      let x: number;
      let y: number;
      if (e.e === 'shot' || e.e === 'explosion') {
        x = e.x;
        y = e.y;
      } else if (e.e === 'damage') {
        const b = this.brains.get(e.to);
        if (b?.kind === 'ped') this.panic(b, e.fromX, e.fromY);
        continue;
      } else continue;
      for (const b of this.brains.values()) {
        if (b.kind !== 'ped') continue;
        const p = world.players.get(b.id);
        if (p && (p.x - x) ** 2 + (p.y - y) ** 2 < r2) this.panic(b, x, y);
      }
    }
  }

  private panic(b: PedBrain, x: number, y: number): void {
    const already = this.world.now < b.panicUntil;
    b.panicUntil = this.world.now + CITY.panicSec * 1000;
    b.threatX = x;
    b.threatY = y;
    // Turn and run now rather than finishing the current stroll first.
    if (!already) {
      const p = this.world.players.get(b.id);
      if (p) this.chooseNextCorner(b, p);
    }
  }

  private think(b: Brain): void {
    const p = this.world.players.get(b.id);
    if (!p) {
      this.brains.delete(b.id);
      return;
    }
    if (p.life !== 'alive') return;

    let cmd: Command;
    if (b.kind === 'ped') cmd = this.pedestrian(b, p);
    else if (b.kind === 'driver') cmd = this.drive(b, p);
    else if (b.kind === 'crew') cmd = this.crews.think(b, p);
    else cmd = this.police.think(b, p);

    // A driver wedged against a wall reverses out with the wheel turned. The
    // check runs before any brain's own stuck handling (searching picks a new
    // destination at 1.5 s), which would otherwise keep it wedged forever.
    const v = p.vehicleId !== null ? this.world.vehicles.get(p.vehicleId) : undefined;
    if (v && v.driverId === p.id) {
      if (this.world.now < (b.unstickUntil ?? 0)) {
        cmd = { buttons: Btn.Down | ((b.unstickSteer ?? 1) > 0 ? Btn.Right : Btn.Left), aim: v.rot };
      } else if (b.stuckMs > 1200) {
        b.unstickUntil = this.world.now + 900;
        b.unstickSteer = this.world.rng() < 0.5 ? -1 : 1;
        b.stuckMs = 0;
      }
    }

    // Stuck tracking is shared: anyone who has not moved for a while needs a
    // different idea.
    // A car scraping along a wall still creeps forward, so drivers count as
    // stuck below a crawl rather than only when perfectly still.
    const moved = Math.hypot(p.x - b.lastX, p.y - b.lastY);
    const minStep = v && v.driverId === p.id ? 40 * this.world.dt : 0.6;
    b.stuckMs = moved < minStep && (cmd.ax || cmd.ay) ? b.stuckMs + this.world.dt * 1000 : 0;
    b.lastX = p.x;
    b.lastY = p.y;

    this.send(p, b, cmd);
  }

  // --- pedestrians -----------------------------------------------------------

  private pedestrian(b: PedBrain, p: PlayerEntity): Command {
    // A hit target keeps an eye out for whoever is hunting it.
    if (p.markedFor) {
      const hunter = this.world.players.get(p.markedFor);
      // A fugitive with a gun turns and fights once the hunter is close.
      if (b.armed && hunter && hunter.life === 'alive') {
        const d = Math.hypot(hunter.x - p.x, hunter.y - p.y);
        if (d < 420 && this.world.grid.lineOfSight(p.x, p.y, hunter.x, hunter.y)) {
          b.toggle = !b.toggle;
          const aim = Math.atan2(hunter.y - p.y, hunter.x - p.x) + (this.world.rng() * 2 - 1) * 0.16;
          const gun = p.slots[p.slot];
          if (gun && gun.reserve < 12) gun.reserve = 24;
          const buttons = gun && gun.ammo === 0 ? Btn.Reload : b.toggle ? Btn.Fire : 0;
          // Back away while shooting, so a fight is a chase too.
          const away = { x: 2 * p.x - hunter.x, y: 2 * p.y - hunter.y };
          return { ...towards(p, away, 0.55, buttons), aim };
        }
      }
      if (hunter && Math.hypot(hunter.x - p.x, hunter.y - p.y) < 340 &&
          this.world.now >= b.panicUntil) {
        this.panic(b, hunter.x, hunter.y);
      }
    }
    return this.walk(b, p, 1);
  }

  walk(b: BrainBase & WalkState, p: PlayerEntity, paceScale: number): Command {
    let target = this.net.cornerPoint(b.corner);
    if (Math.hypot(target.x - p.x, target.y - p.y) < 12 || b.stuckMs > 1500) {
      if (b.stuckMs > 1500) b.prevNode = -1;
      b.stuckMs = 0;
      this.chooseNextCorner(b, p);
      target = this.net.cornerPoint(b.corner);
    }
    const panicking = this.world.now < b.panicUntil;
    const pace = (panicking ? 1 : CITY.pedStroll) * paceScale;
    return towards(p, target, pace, panicking ? Btn.Sprint : 0);
  }

  private chooseNextCorner(b: WalkState, p: PlayerEntity): void {
    const net = this.net;
    const here: Corner = b.corner;
    // Highway points are for vehicles; pedestrians stay in town.
    let options = net.adj[here.node].filter((m) => !net.nodes[m].rural && net.kerbClear(here, m));
    if (options.length > 1) options = options.filter((m) => m !== b.prevNode);
    if (options.length === 0) {
      // Boxed in on this corner: cross to the next corner of the intersection.
      b.corner = { node: here.node, sx: -here.sx, sy: here.sy };
      return;
    }
    let pick: number;
    if (this.world.now < b.panicUntil) {
      // Run for whichever corner leads furthest from the trouble.
      pick = options[0];
      let best = -Infinity;
      for (const m of options) {
        const pt = net.cornerPoint(net.kerbStep(here, m));
        const d = Math.hypot(pt.x - b.threatX, pt.y - b.threatY) -
          Math.hypot(pt.x - p.x, pt.y - p.y) * 0.25;
        if (d > best) {
          best = d;
          pick = m;
        }
      }
    } else {
      pick = options[Math.floor(this.world.rng() * options.length)];
    }
    b.prevNode = here.node;
    b.corner = net.kerbStep(here, pick);
  }

  // --- traffic ---------------------------------------------------------------

  private drive(b: DriverBrain, p: PlayerEntity): Command {
    const v = this.world.vehicles.get(b.vehicleId);
    if (!v || v.destroyed || p.vehicleId !== v.id) {
      // Carjacked, wrecked or thrown clear: just another frightened pedestrian.
      this.becomePedestrian(b, p);
      return { buttons: 0, aim: p.aim };
    }
    return this.followLanes(b, v, CITY.trafficThrottle);
  }

  /** Drives `v` along right-hand lanes, yielding to anything in the way. */
  followLanes(b: LaneState, v: VehicleEntity, throttle: number): Command {
    const world = this.world;
    if (b.from < 0 || b.to < 0) {
      // Pick the road the vehicle is already pointing along, so it does not
      // start by turning into a wall.
      b.from = this.net.nearestNode(v.x, v.y);
      const at = this.net.nodes[b.from];
      let best = -Infinity;
      b.to = b.from;
      for (const m of this.net.adj[b.from] ?? []) {
        const n = this.net.nodes[m];
        const len = Math.hypot(n.x - at.x, n.y - at.y) || 1;
        const dot = ((n.x - at.x) * Math.cos(v.rot) + (n.y - at.y) * Math.sin(v.rot)) / len;
        if (dot > best) {
          best = dot;
          b.to = m;
        }
      }
    }
    let target = this.net.lanePoint(b.from, b.to);
    if (Math.hypot(target.x - v.x, target.y - v.y) < 46) {
      const back = b.from;
      b.from = b.to;
      let options = this.net.adj[b.to].filter((m) => m !== back && this.net.laneClear(b.from, m));
      if (options.length === 0) options = this.net.adj[b.to].filter((m) => this.net.laneClear(b.from, m));
      b.to = options.length > 0 ? options[Math.floor(world.rng() * options.length)] : back;
      target = this.net.lanePoint(b.from, b.to);
    }

    const dist = Math.hypot(target.x - v.x, target.y - v.y);
    const along = v.vx * Math.cos(v.rot) + v.vy * Math.sin(v.rot);
    const blocked = world.now >= b.pushThroughUntil && this.obstacleAhead(v, along);
    if (blocked) {
      b.blockedMs += world.dt * 1000;
      if (b.blockedMs > CITY.trafficPatienceSec * 1000) {
        b.blockedMs = 0;
        b.pushThroughUntil = world.now + 1500;
      }
      // Brake to a stop and wait; never reverse into whoever is behind.
      return { buttons: along > 15 ? Btn.Down : 0, aim: v.rot };
    }
    b.blockedMs = 0;
    const pace = throttle * (dist < CITY.turnSlowDist ? 0.6 : 1);
    return towards(v, target, pace, 0, v.rot);
  }

  /** Someone on foot or another vehicle in this vehicle's path. */
  private obstacleAhead(v: VehicleEntity, along: number): boolean {
    const def = vehicleDef(v.type);
    const fx = Math.cos(v.rot);
    const fy = Math.sin(v.rot);
    const look = def.length / 2 + 40 + Math.max(0, along) * 0.55;
    const check = (x: number, y: number, halfWidth: number): boolean => {
      const rx = x - v.x;
      const ry = y - v.y;
      const fwd = rx * fx + ry * fy;
      if (fwd <= def.length / 4 || fwd > look) return false;
      return Math.abs(rx * fy - ry * fx) < def.width / 2 + halfWidth;
    };
    for (const p of this.world.players.values()) {
      if (p.life !== 'alive' || p.vehicleId !== null) continue;
      if (check(p.x, p.y, GAMEPLAY.player.radius + 6)) return true;
    }
    for (const o of this.world.vehicles.values()) {
      if (o.id === v.id || o.destroyed) continue;
      if (check(o.x, o.y, vehicleDef(o.type).width / 2)) return true;
    }
    return false;
  }

  private becomePedestrian(b: Brain, p: PlayerEntity): void {
    const node = this.net.nearestNode(p.x, p.y);
    const n = this.net.nodes[node];
    this.brains.set(b.id, {
      kind: 'ped', id: b.id, seq: b.seq, lastX: p.x, lastY: p.y, stuckMs: 0,
      corner: { node, sx: p.x < n.x ? -1 : 1, sy: p.y < n.y ? -1 : 1 },
      prevNode: -1,
      panicUntil: this.world.now + CITY.panicSec * 1000,
      threatX: p.x, threatY: p.y,
    });
  }
}
