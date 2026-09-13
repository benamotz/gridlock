import {
  Btn,
  CollisionGrid,
  GAMEPLAY,
  type GameEvent,
  type GameMapDef,
  type InputCommand,
  type MatchConfig,
  commandAxes,
  makeRng,
  stepPlayerMovement,
  vehicleDef,
  weaponDef,
} from '@gridlock/shared';
import {
  type DeployableEntity,
  type PickupEntity,
  type PlayerEntity,
  type ProjectileEntity,
  type VehicleEntity,
  createPlayer,
} from './entities.js';
import { buildLoadout, bestSlot } from './loadout.js';
import { selectSpawn } from './spawn.js';
import { fireWeapon, startReload, stepProjectiles, tryFinishReload } from './combat.js';
import {
  initPickups, stepPickups, tryClaimPickups, useArmorPlate, useMedkit,
} from './pickups.js';
import { destroyDeployable, stepDeployables } from './deployables.js';
import {
  driveVehicle, stepVehicles, tryEnterExitVehicle, vehiclePrompt,
} from './vehicles.js';

/**
 * The authoritative match simulation.
 *
 * Everything that decides an outcome - movement, firing, ammunition, pickups,
 * damage, deaths, vehicle state - happens here on a fixed tick. Clients only
 * ever send intent (`InputCommand`), never results.
 */
export class World {
  readonly grid: CollisionGrid;
  readonly players = new Map<string, PlayerEntity>();
  readonly vehicles = new Map<number, VehicleEntity>();
  readonly projectiles = new Map<number, ProjectileEntity>();
  readonly pickups = new Map<string, PickupEntity>();
  readonly deployables = new Map<number, DeployableEntity>();

  /** Events produced this tick, drained when snapshots are built. */
  events: GameEvent[] = [];
  /** Kill feed entries kept across ticks so late snapshots still show them. */
  readonly killFeed: { at: number; event: GameEvent }[] = [];

  /**
   * Hook the room installs so the active game mode learns about eliminations
   * and can override the respawn delay, without the simulation depending on
   * any particular mode.
   */
  onKill: ((victim: PlayerEntity, killer: PlayerEntity | null) => number | null) | null = null;

  /** Map vehicle spawn points waiting to re-arm after a wreck cleared. */
  readonly pendingVehicleSpawns: { spawnIndex: number; at: number }[] = [];

  tick = 0;
  /** Simulated match clock in ms; the single source of time for all systems. */
  now = 0;
  readonly dt: number;
  readonly rng: () => number;

  private nextEntityId = 1;

  constructor(
    readonly mapDef: GameMapDef,
    readonly config: MatchConfig,
    seed = Date.now() & 0xffffffff,
  ) {
    this.grid = new CollisionGrid(mapDef);
    this.rng = makeRng(seed);
    this.dt = 1 / GAMEPLAY.tickHz;
    initPickups(this);
    if (config.vehiclesEnabled) this.spawnAllVehicles();
  }

  allocId(): number {
    return this.nextEntityId++;
  }

  emit(e: GameEvent): void {
    this.events.push(e);
    if (e.e === 'kill' || e.e === 'flag') this.killFeed.push({ at: this.now, event: e });
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  addPlayer(id: string, name: string, team: number, isBot: boolean): PlayerEntity {
    const p = createPlayer(id, name, team, isBot);
    this.players.set(id, p);
    this.respawnPlayer(p, 0);
    return p;
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    // A departing player's defences go with them, so a team cannot bank
    // permanent fortifications by cycling players through the slot.
    for (const d of [...this.deployables.values()]) {
      if (d.ownerId === id) destroyDeployable(this, d);
    }
    if (p.vehicleId !== null) {
      const v = this.vehicles.get(p.vehicleId);
      if (v) {
        if (v.driverId === id) v.driverId = null;
        v.passengers = v.passengers.filter((pid) => pid !== id);
      }
    }
    this.players.delete(id);
  }

  /** Places a player at a fresh spawn point with a full loadout. */
  respawnPlayer(p: PlayerEntity, delayMs: number): void {
    if (delayMs > 0) {
      p.life = 'respawning';
      p.respawnAt = this.now + delayMs;
      return;
    }
    const others = [...this.players.values()]
      .filter((o) => o.id !== p.id)
      .map((o) => ({ x: o.x, y: o.y, team: o.team, alive: o.life === 'alive' }));
    const point = selectSpawn(this.mapDef, this.grid, p.team, others, this.rng);

    p.x = point.x;
    p.y = point.y;
    p.vx = 0;
    p.vy = 0;
    p.hp = GAMEPLAY.player.maxHealth;
    p.armor = 0;
    p.stamina = GAMEPLAY.player.staminaMax;
    p.air = 0;
    p.jumpCd = 0;
    p.medkits = GAMEPLAY.pouch.startMedkits;
    p.armorPlates = GAMEPLAY.pouch.startArmorPlates;
    p.pouchReadyAt = 0;
    p.life = 'alive';
    p.respawnAt = 0;
    p.corpseUntil = 0;
    p.spawnProtectedUntil = this.now + GAMEPLAY.player.spawnProtectionSec * 1000;
    p.slots = buildLoadout(this.config.loadoutRule, p.team, this.rng);
    p.slot = bestSlot(p.slots);
    p.spread = 0;
    p.reloadEndsAt = 0;
    p.reloadingSlot = -1;
    p.nextFireAt = 0;
    p.vehicleId = null;
    p.damageTakenFrom.clear();
    p.stats.streak = 0;
  }

  // -------------------------------------------------------------------------
  // Vehicles
  // -------------------------------------------------------------------------

  private spawnAllVehicles(): void {
    this.mapDef.vehicleSpawns.forEach((s, i) => this.spawnVehicle(i));
    void 0;
  }

  spawnVehicle(spawnIndex: number): VehicleEntity {
    const s = this.mapDef.vehicleSpawns[spawnIndex];
    const def = vehicleDef(s.type);
    const v: VehicleEntity = {
      id: this.allocId(),
      type: s.type,
      x: s.x, y: s.y, rot: s.rot,
      vx: 0, vy: 0,
      hp: def.durability, maxHp: def.durability,
      driverId: null, passengers: [],
      destroyed: false, despawnAt: 0, respawnAt: 0,
      spawnIndex,
      lastDamagedBy: null,
      lastDamagedAt: 0,
    };
    this.vehicles.set(v.id, v);
    return v;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * Queues validated commands. The buffer is bounded: a client that floods
   * input has its oldest commands dropped rather than gaining extra movement.
   */
  queueInput(playerId: string, cmds: InputCommand[]): void {
    const p = this.players.get(playerId);
    if (!p) return;
    for (const c of cmds) {
      // Replayed or out-of-order commands are ignored outright.
      if (c.seq <= p.lastProcessedSeq) continue;
      p.pending.push(c);
    }
    p.pending.sort((a, b) => a.seq - b.seq);
    if (p.pending.length > GAMEPLAY.maxCommandBuffer) {
      p.pending.splice(0, p.pending.length - GAMEPLAY.maxCommandBuffer);
    }
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  step(): void {
    this.now += this.dt * 1000;
    this.tick++;

    for (const p of this.players.values()) this.stepPlayer(p);
    stepVehicles(this);
    stepDeployables(this);
    stepProjectiles(this);
    stepPickups(this);

    // Trim the kill feed to the window the HUD displays.
    while (this.killFeed.length > 0 && this.now - this.killFeed[0].at > 8000) {
      this.killFeed.shift();
    }
  }

  private stepPlayer(p: PlayerEntity): void {
    // A body lies where it fell, then the player joins the respawn queue.
    if (p.life === 'dead' && this.now >= p.corpseUntil) {
      p.life = 'respawning';
    }
    if (
      (p.life === 'respawning' || p.life === 'dead') &&
      p.respawnAt > 0 && this.now >= p.respawnAt
    ) {
      this.respawnPlayer(p, 0);
    }

    tryFinishReload(this, p);

    // A disconnected player stands still but stays in the world until their
    // reconnect grace expires, so their slot and stats survive a dropped link.
    if (p.connection === 'reconnecting') {
      p.pending.length = 0;
      p.vx = 0;
      p.vy = 0;
      return;
    }

    if (p.life !== 'alive') {
      p.pending.length = 0;
      return;
    }

    // Consume at most a bounded number of commands per tick. This is the core
    // speed-hack defence: extra commands wait for the next tick instead of
    // granting extra distance now.
    const maxPerTick = 3;
    let consumed = 0;
    while (p.pending.length > 0 && consumed < maxPerTick) {
      const cmd = p.pending.shift()!;
      this.applyCommand(p, cmd);
      p.lastProcessedSeq = cmd.seq;
      consumed++;
    }
    if (consumed === 0) {
      // No input arrived this tick - keep simulating with the last known
      // buttons cleared so a stalled client coasts to a stop rather than
      // sliding forever.
      this.applyCommand(p, {
        seq: p.lastProcessedSeq,
        dtMs: this.dt * 1000,
        buttons: 0,
        aim: p.aim,
        slot: -1,
      });
    }
  }

  private applyCommand(p: PlayerEntity, cmd: InputCommand): void {
    const dt = Math.min(cmd.dtMs, GAMEPLAY.maxCommandDtMs) / 1000;
    p.aim = cmd.aim;

    if (cmd.slot >= 0 && cmd.slot < p.slots.length && p.slots[cmd.slot]) {
      if (cmd.slot !== p.slot) {
        p.slot = cmd.slot;
        p.reloadingSlot = -1;
        p.reloadEndsAt = 0;
      }
    }

    p.lastButtons = cmd.buttons;

    const vehicle = p.vehicleId !== null ? this.vehicles.get(p.vehicleId) ?? null : null;
    const inVehicle = vehicle !== null;
    if (!inVehicle) {
      // `PlayerEntity` satisfies `MovableActor` structurally, so the exact same
      // movement code runs here and in the client's prediction.
      const move = stepPlayerMovement(
        p, this.currentWeaponId(p), cmd.buttons, dt, this.grid, commandAxes(cmd),
      );
      if (move.jumped) this.emit({ e: 'jump', by: p.id, x: p.x, y: p.y });
    } else if (vehicle.driverId === p.id) {
      driveVehicle(this, vehicle, p, cmd.buttons, dt, commandAxes(cmd));
    }

    // Aim spread decays whenever the trigger is not being pulled.
    p.spread = Math.max(0, p.spread - GAMEPLAY.combat.spreadDecay * dt);

    const reloadHeld = (cmd.buttons & Btn.Reload) !== 0;
    if (reloadHeld && !inVehicle) startReload(this, p);

    const interactHeld = (cmd.buttons & Btn.Interact) !== 0;
    if (interactHeld && !p.interactPressed) tryEnterExitVehicle(this, p);
    p.interactPressed = interactHeld;

    const swapHeld = (cmd.buttons & Btn.Swap) !== 0;
    if (swapHeld && !p.swapPressed && !inVehicle) tryClaimPickups(this, p, true);
    p.swapPressed = swapHeld;

    // Automatic pickups (ammo, health, armor, empty weapon slots) every tick.
    if (!inVehicle) tryClaimPickups(this, p, false);
    // Nothing to pick up here - advertise a nearby vehicle instead.
    if (inVehicle) p.prompt = null;
    else if (!p.prompt) p.prompt = vehiclePrompt(this, p);

    // Consumables are edge-triggered, so holding the key uses exactly one.
    const medkitHeld = (cmd.buttons & Btn.UseMedkit) !== 0;
    if (medkitHeld && !p.medkitHeld) useMedkit(this, p);
    p.medkitHeld = medkitHeld;
    const armorHeld = (cmd.buttons & Btn.UseArmor) !== 0;
    if (armorHeld && !p.armorHeld) useArmorPlate(this, p);
    p.armorHeld = armorHeld;

    const fireHeld = (cmd.buttons & Btn.Fire) !== 0;
    if (fireHeld && !inVehicle) {
      fireWeapon(this, p, p.firePressed, cmd.buttons);
    }
    p.firePressed = fireHeld;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  alivePlayers(): PlayerEntity[] {
    return [...this.players.values()].filter((p) => p.life === 'alive');
  }

  isProtected(p: PlayerEntity): boolean {
    return this.now < p.spawnProtectedUntil;
  }

  /** Friendly fire is off by default, and always off in free-for-all. */
  canDamage(attacker: PlayerEntity | null, target: PlayerEntity): boolean {
    if (!attacker) return true;
    if (attacker.id === target.id) return true;
    if (attacker.team < 0 || target.team < 0) return true;
    if (attacker.team !== target.team) return true;
    return this.config.friendlyFire;
  }

  currentWeaponId(p: PlayerEntity) {
    return p.slots[p.slot]?.id ?? 'fists';
  }

  /** Effective spread in radians, including movement and sprint penalties. */
  effectiveSpread(p: PlayerEntity): number {
    const def = weaponDef(this.currentWeaponId(p));
    let s = def.spread + p.spread;
    const speed = Math.hypot(p.vx, p.vy);
    if (p.sprinting) s *= GAMEPLAY.combat.sprintSpreadMult;
    else if (speed > GAMEPLAY.player.walkSpeed * 0.6) s *= GAMEPLAY.combat.moveSpreadMult;
    return s;
  }
}
