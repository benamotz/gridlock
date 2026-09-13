import {
  Btn,
  CollisionGrid,
  type DeployableKind,
  type DeployableWire,
  type SolidDef,
  deployableDef,
  segmentCircle,
  shotIntervalMs,
  GAMEPLAY,
  type GameEvent,
  type GameMapDef,
  type InputCommand,
  type MatchConfig,
  type MatchPhase,
  type PickupWire,
  type PlayerWire,
  type ProjectileWire,
  type SnapshotMsg,
  type VehicleWire,
  angleDelta,
  getMap,
  lerp,
  lerpAngle,
  stepPlayerMovement,
  stepVehicle,
  seatIndexOf,
  vehicleDef,
  weaponDef,
} from '@gridlock/shared';
import { Renderer, type Effect } from '../render/Renderer.js';
import { Minimap } from '../render/minimap.js';
import { InputManager } from './input.js';
import type { ClientSocket } from '../net/ClientSocket.js';
import { GameAudio } from '../audio/Audio.js';
import type { HudState, Settings } from '../store.js';
import { deployableSolids, type MoveResult, type VehicleTypeId } from '@gridlock/shared';
import { PlacementController, type PlacementGhost } from './placement.js';
import { CollectionPredictor } from './collection.js';

interface TimedSnapshot {
  time: number;
  players: PlayerWire[];
  vehicles: VehicleWire[];
  deployables: DeployableWire[];
  projectiles: ProjectileWire[];
  pickups: PickupWire[];
}

/** Locally predicted copy of the player, replayed against server corrections. */
interface Predicted {
  x: number;
  y: number;
  vx: number;
  vy: number;
  stamina: number;
  sprinting: boolean;
  air: number;
  jumpCd: number;
  jumpHeld: boolean;
}

const SLOT_COUNT = 4;

/**
 * The in-match client: input, prediction, interpolation and rendering.
 *
 * The server is authoritative for everything. This class predicts only the
 * local player's movement (and the vehicle they are driving), replays
 * unacknowledged input whenever a correction arrives, and interpolates
 * everything else a fixed delay behind the newest snapshot.
 */
export class GameClient {
  private renderer: Renderer;
  private minimap = new Minimap();
  private input: InputManager;
  private audio: GameAudio;

  private map: GameMapDef;
  private grid: CollisionGrid;
  private config: MatchConfig;

  private buffer: TimedSnapshot[] = [];
  private latest: SnapshotMsg | null = null;
  private renderTime = 0;
  private seq = 1;
  private pending: InputCommand[] = [];
  private unsent: InputCommand[] = [];
  private lastSendAt = 0;

  private predicted: Predicted = {
    x: 0, y: 0, vx: 0, vy: 0, stamina: 100, sprinting: false,
    air: 0, jumpCd: 0, jumpHeld: false,
  };
  /** Residual prediction error, decayed each frame so corrections never snap. */
  private errorX = 0;
  private errorY = 0;
  private predictedVehicle: { x: number; y: number; rot: number; vx: number; vy: number } | null = null;

  private effects: Effect[] = [];
  private raf = 0;
  private lastFrameAt = 0;
  private running = false;
  private mapExpanded = false;
  private lastEventTick = -1;

  /** Local fire-cadence gate, mirroring the server's so prediction agrees. */
  private nextLocalFireAt = 0;
  private firePressedLast = false;
  /** Shots predicted since the last snapshot, subtracted from the HUD's ammo. */
  private predictedShots = 0;
  private playerId: string | null = null;
  /** Wall-clock time of the last confirmed hit, driving the crosshair marker. */
  private lastHitAt = 0;
  private lastHitLethal = false;

  /** Defence placement mode and its current preview. */
  private placement = new PlacementController();
  private lastGhost: PlacementGhost | null = null;
  /** Predicted pickup grabs and their animations. */
  private collection = new CollectionPredictor();
  private lastCollect: HudState['lastCollect'] = null;
  /**
   * Jump button state of the last command the server acknowledged. Replayed
   * prediction starts from it, so an unacknowledged jump still triggers on
   * replay instead of flickering off until the server catches up.
   */
  private ackJumpHeld = false;
  /** A deploy request in flight; clicks wait for its answer instead of stacking. */
  private deployPending: { kind: DeployableKind; at: number } | null = null;
  /** The server's most recent refusal, shown in the placement banner. */
  private deployRefusal: { reason: string; at: number } | null = null;

  settings: Settings;

  constructor(
    private canvas: HTMLCanvasElement,
    private minimapCanvas: HTMLCanvasElement,
    private socket: ClientSocket,
    mapId: string,
    config: MatchConfig,
    settings: Settings,
    private readonly callbacks: {
      onHud(state: HudState): void;
      onScoreboard(down: boolean): void;
      onMenu(): void;
      onChat(): void;
    },
  ) {
    this.map = getMap(mapId);
    this.grid = new CollisionGrid(this.map);
    this.config = config;
    this.settings = settings;
    this.renderer = new Renderer(canvas, this.map, this.grid);
    this.audio = new GameAudio(settings);
    this.input = new InputManager(canvas, {
      onToggleScoreboard: (down) => this.callbacks.onScoreboard(down),
      onToggleMap: () => {
        this.mapExpanded = !this.mapExpanded;
      },
      onMenu: () => this.callbacks.onMenu(),
      onChat: () => this.callbacks.onChat(),
      onDeploy: (kind) => this.onDeployKey(kind),
      onWheel: (direction) => this.placement.rotate(direction),
      onPrimaryClick: () => this.confirmPlacement(),
      onSecondaryClick: () => this.cancelPlacement(),
      onCancel: () => this.cancelPlacement(),
    }, settings.bindings);
    this.input.sensitivity = settings.sensitivity;
  }

  /** The server-assigned id, used to skip echoes of our own predicted shots. */
  setPlayerId(id: string | null): void {
    this.playerId = id;
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.input.setBindings(settings.bindings);
    this.input.sensitivity = settings.sensitivity;
    this.audio.applySettings(settings);
    this.handleResize();
  }

  setInputEnabled(on: boolean): void {
    this.input.setEnabled(on);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameAt = performance.now();
    this.handleResize();
    window.addEventListener('resize', this.handleResize);
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.handleResize);
    this.input.dispose();
    this.audio.dispose();
  }

  private handleResize = (): void => {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    this.renderer.resize(
      rect?.width ?? window.innerWidth,
      rect?.height ?? window.innerHeight,
      this.settings.quality,
    );
  };

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  onSnapshot(snap: SnapshotMsg): void {
    this.latest = snap;
    this.buffer.push({
      time: snap.serverTime,
      players: snap.players,
      vehicles: snap.vehicles,
      deployables: snap.deployables,
      projectiles: snap.projectiles,
      pickups: snap.pickups,
    });
    // Deployed defences are real obstacles, so the prediction grid has to know
    // about them or predicted movement will walk straight through a barricade
    // the server has already placed.
    this.syncDeployableSolids(snap.deployables);
    // Two seconds of history is plenty for a 120ms interpolation delay.
    while (this.buffer.length > 40) this.buffer.shift();
    if (this.renderTime === 0) this.renderTime = snap.serverTime - GAMEPLAY.interpDelayMs;

    this.predictedShots = 0;
    this.reconcile(snap);
    if (snap.tick !== this.lastEventTick) {
      this.lastEventTick = snap.tick;
      for (const e of snap.events) this.onEvent(e);
    }
    this.pushHud(snap);
  }

  /**
   * Applies the authoritative state, then replays every input the server has
   * not acknowledged yet. The visible position keeps whatever error existed
   * before the correction and decays it away, so a correction never teleports
   * the player.
   */
  private reconcile(snap: SnapshotMsg): void {
    const beforeX = this.predicted.x;
    const beforeY = this.predicted.y;

    this.predicted.x = snap.self.x;
    this.predicted.y = snap.self.y;
    this.predicted.vx = snap.self.vx;
    this.predicted.vy = snap.self.vy;
    this.predicted.stamina = snap.self.stamina;
    this.predicted.air = snap.self.air;
    this.predicted.jumpCd = snap.self.jumpCd;

    const acked = this.pending.find((c) => c.seq === snap.self.ack);
    if (acked) this.ackJumpHeld = (acked.buttons & Btn.Jump) !== 0;
    this.predicted.jumpHeld = this.ackJumpHeld;

    this.pending = this.pending.filter((c) => c.seq > snap.self.ack);

    const inVehicle = snap.self.vehicleId !== null;
    const serverVehicle = inVehicle
      ? snap.vehicles.find((v) => v.id === snap.self.vehicleId)
      : undefined;

    if (inVehicle && serverVehicle && snap.self.seat === 0) {
      this.predictedVehicle = {
        x: serverVehicle.x, y: serverVehicle.y, rot: serverVehicle.rot,
        vx: serverVehicle.vx, vy: serverVehicle.vy,
      };
      for (const cmd of this.pending) this.applyLocal(cmd, snap, serverVehicle.type);
      this.predicted.x = this.predictedVehicle.x;
      this.predicted.y = this.predictedVehicle.y;
    } else {
      this.predictedVehicle = null;
      for (const cmd of this.pending) this.applyLocal(cmd, snap);
    }

    // Only smooth small corrections; a respawn or a vehicle exit is a real
    // teleport and should be shown immediately.
    const dx = beforeX - this.predicted.x;
    const dy = beforeY - this.predicted.y;
    if (Math.hypot(dx, dy) < 220) {
      this.errorX = dx;
      this.errorY = dy;
    } else {
      this.errorX = 0;
      this.errorY = 0;
    }
  }

  private applyLocal(
    cmd: InputCommand,
    snap: SnapshotMsg,
    vehicleType?: VehicleWire['type'],
  ): MoveResult | null {
    const dt = Math.min(cmd.dtMs, GAMEPLAY.maxCommandDtMs) / 1000;
    if (this.predictedVehicle && vehicleType) {
      const v = { ...this.predictedVehicle, type: vehicleType };
      stepVehicle(v, cmd.buttons, dt, this.grid);
      this.predictedVehicle = { x: v.x, y: v.y, rot: v.rot, vx: v.vx, vy: v.vy };
      return null;
    }
    const weapon = snap.self.weapons[snap.self.slot]?.id ?? 'fists';
    return stepPlayerMovement(this.predicted, weapon, cmd.buttons, dt, this.grid);
  }

  private onEvent(e: GameEvent): void {
    const now = performance.now();
    switch (e.e) {
      case 'shot': {
        // Our own shots were already drawn the moment the trigger was pulled;
        // replaying the server's echo would double every muzzle flash.
        if (this.playerId && e.by === this.playerId) break;
        const def = weaponDef(e.w);
        if (e.len > 0) {
          this.effects.push({
            kind: 'tracer',
            x: e.x, y: e.y,
            x2: e.x + Math.cos(e.a) * e.len,
            y2: e.y + Math.sin(e.a) * e.len,
            color: def.class === 'heavy' ? undefined : def.color,
            born: now, life: 70,
          });
        }
        this.effects.push({ kind: 'muzzle', x: e.x, y: e.y, born: now, life: 90 });
        this.audio.play(def.sfx, this.panFor(e.x), this.gainFor(e.x, e.y));
        break;
      }
      case 'hit':
        this.effects.push({
          kind: e.onPlayer ? 'blood' : 'impact',
          x: e.x, y: e.y, born: now, life: e.onPlayer ? 420 : 260,
        });
        break;
      case 'hitmark': {
        // Our shot connected. Confirm it three ways - crosshair marker, a
        // floating damage number, and a short tone - because a top-down view
        // gives no other read on whether a distant shot landed.
        this.lastHitAt = now;
        this.lastHitLethal = e.lethal;
        this.effects.push({
          kind: 'damageNumber',
          x: e.x + (Math.random() - 0.5) * 14,
          y: e.y - 18,
          text: e.lethal ? 'KILL' : String(Math.round(e.amount)),
          color: e.lethal ? '#ff6b7a' : '#ffe2a8',
          r: e.lethal ? 18 : 15,
          born: now,
          life: e.lethal ? 1100 : 750,
        });
        this.effects.push({ kind: 'blood', x: e.x, y: e.y, born: now, life: 420 });
        this.audio.play(e.lethal ? 'killmark' : 'hitmark', 0, 1);
        break;
      }
      case 'explosion':
        this.effects.push({ kind: 'explosion', x: e.x, y: e.y, r: e.r, born: now, life: 420 });
        this.audio.play('explosion', this.panFor(e.x), this.gainFor(e.x, e.y));
        this.renderer.camera.addShake(0.6);
        break;
      case 'damage':
        this.audio.play('hurt', 0, 1);
        this.renderer.camera.addShake(Math.min(0.35, e.amount / 90));
        break;
      case 'pickup': {
        if (this.playerId && e.by === this.playerId) {
          // Ours: the grab was usually already animated the moment we reached
          // it. Either way, confirm it and raise the HUD toast.
          const kind = e.kind as PickupWire['kind'];
          const predicted = this.collection.confirm(e.id, kind, e.weapon, e.x, e.y, now);
          if (!predicted) this.audio.play('pickup', 0, 1);
          this.lastCollect = {
            label: e.label, kind: e.kind, weapon: e.weapon ?? null,
            stored: e.stored ?? false, at: now,
          };
        } else {
          this.effects.push({ kind: 'pickup', x: e.x, y: e.y, born: now, life: 380 });
          this.audio.play('pickup', this.panFor(e.x), this.gainFor(e.x, e.y) * 0.6);
        }
        break;
      }
      case 'useItem': {
        const color = e.kind === 'health' ? '#7ef3a4' : '#c4a4ff';
        this.effects.push({ kind: 'pickup', x: e.x, y: e.y, color, born: now, life: 520 });
        this.effects.push({
          kind: 'damageNumber', x: e.x, y: e.y - 22,
          text: `+${Math.round(e.amount)}${e.kind === 'armor' ? ' armor' : ''}`,
          color, r: 15, born: now, life: 900,
        });
        this.audio.play('pickup', this.panFor(e.x), this.gainFor(e.x, e.y));
        break;
      }
      case 'jump':
        // Our own jump was already shown by prediction.
        if (this.playerId && e.by === this.playerId) break;
        this.effects.push({ kind: 'dust', x: e.x, y: e.y, born: now, life: 360 });
        break;
      case 'reload':
        this.audio.play('reload', this.panFor(e.x), this.gainFor(e.x, e.y) * 0.7);
        break;
      case 'vehicleHit':
        this.audio.play('crash', this.panFor(e.x), this.gainFor(e.x, e.y));
        this.renderer.camera.addShake(Math.min(0.5, e.force / 700));
        break;
      case 'kill':
        this.audio.play('death', 0, 0.5);
        break;
      case 'deploy':
        this.effects.push({
          kind: 'pickup', x: e.x, y: e.y,
          color: '#9fd0ff', born: now, life: 460,
        });
        this.audio.play('pickup', this.panFor(e.x), this.gainFor(e.x, e.y));
        break;
      case 'deployDown':
        this.effects.push({
          kind: 'explosion', x: e.x, y: e.y, r: 46, born: now, life: 380,
        });
        this.audio.play('crash', this.panFor(e.x), this.gainFor(e.x, e.y));
        break;
    }
    // Effects are capped so a heavy firefight cannot grow the array unbounded.
    if (this.effects.length > 260) this.effects.splice(0, this.effects.length - 260);
  }

  private panFor(x: number): number {
    const dx = (x - this.predicted.x) / 900;
    return Math.max(-1, Math.min(1, dx));
  }

  private gainFor(x: number, y: number): number {
    const d = Math.hypot(x - this.predicted.x, y - this.predicted.y);
    return Math.max(0, 1 - d / 1400);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);

    const dt = Math.min(0.05, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;

    const snap = this.latest;
    if (!snap) return;

    this.sampleAndSendInput(snap, dt, now);

    // Advance the interpolation clock, nudging it toward the ideal delay so it
    // recovers smoothly from jitter instead of stuttering.
    const newest = this.buffer[this.buffer.length - 1];
    if (newest) {
      this.renderTime += dt * 1000;
      const target = newest.time - GAMEPLAY.interpDelayMs;
      this.renderTime += (target - this.renderTime) * Math.min(1, dt * 3);
    }

    this.errorX *= Math.exp(-9 * dt);
    this.errorY *= Math.exp(-9 * dt);

    const drawX = this.predicted.x + this.errorX;
    const drawY = this.predicted.y + this.errorY;

    const inVehicle = snap.self.vehicleId !== null;
    const drivingDef = inVehicle
      ? snap.vehicles.find((v) => v.id === snap.self.vehicleId)
      : undefined;
    this.renderer.camera.setZoom(
      drivingDef ? vehicleDef(drivingDef.type).cameraZoom : 1,
    );
    // Look further ahead when driving; a short lead toward the aim on foot.
    const vel = this.predictedVehicle ?? this.predicted;
    this.renderer.camera.follow(
      drawX, drawY,
      vel.vx, vel.vy,
      drivingDef ? 220 : 60,
      dt,
      this.renderer.viewWidth, this.renderer.viewHeight,
    );

    const interpolated = this.interpolate();
    // Substitute our predicted body for the server's copy of the car we drive.
    if (this.predictedVehicle && snap.self.vehicleId !== null) {
      const idx = interpolated.vehicles.findIndex((v) => v.id === snap.self.vehicleId);
      if (idx >= 0) {
        interpolated.vehicles[idx] = {
          ...interpolated.vehicles[idx],
          x: this.predictedVehicle.x + this.errorX,
          y: this.predictedVehicle.y + this.errorY,
          rot: this.predictedVehicle.rot,
        };
      }
    }

    // Keep the aim anchor on the player's screen position.
    const sx = this.renderer.viewWidth / 2 +
      (drawX - this.renderer.camera.x) * this.renderer.camera.zoom;
    const sy = this.renderer.viewHeight / 2 +
      (drawY - this.renderer.camera.y) * this.renderer.camera.zoom;
    this.input.setAnchor(sx, sy);

    this.effects = this.effects.filter((f) => now - f.born < f.life);

    // Nothing can be collected before the round starts; predicting grabs during
    // the countdown made items vanish and reappear on a loop.
    if (snap.self.vehicleId === null && snap.phase === 'active') {
      this.collection.update(now, snap.self, drawX, drawY, snap.pickups);
    }
    this.lastGhost = this.placement.active
      ? this.computeGhost(this.lastAim, interpolated.players, interpolated.vehicles)
      : null;
    // A request the server never answered must not lock placement forever.
    if (this.deployPending && now - this.deployPending.at > 1500) this.deployPending = null;

    this.renderer.draw({
      map: this.map,
      grid: this.grid,
      selfId: this.playerId,
      selfX: drawX,
      selfY: drawY,
      selfAim: this.lastAim,
      selfTeam: snap.self.team,
      selfAlive: snap.self.life === 'alive',
      selfSpread: snap.self.spread,
      selfVehicleId: snap.self.vehicleId,
      selfMoving: Math.hypot(this.predicted.vx, this.predicted.vy) > 20,
      selfSprinting: this.predicted.sprinting,
      selfWeapon: snap.self.weapons[snap.self.slot]?.id ?? 'fists',
      selfAir: snap.self.vehicleId === null ? this.predicted.air : 0,
      ghost: this.lastGhost,
      collectAnims: this.collection.anims,
      players: interpolated.players,
      vehicles: interpolated.vehicles,
      deployables: snap.deployables,
      projectiles: interpolated.projectiles,
      // Anything we have already grabbed is gone from our view immediately.
      pickups: snap.pickups.filter((p) => !this.collection.isHidden(p.id)),
      effects: this.effects,
      colorblind: this.settings.colorblind,
      screenShake: this.settings.screenShake,
      quality: this.settings.quality,
      lastHitAt: this.lastHitAt,
      lastHitLethal: this.lastHitLethal,
      time: now,
    }, dt);

    this.minimap.draw(this.minimapCanvas, {
      map: this.map,
      selfX: drawX,
      selfY: drawY,
      selfAim: this.lastAim,
      selfTeam: snap.self.team,
      players: interpolated.players,
      vehicles: interpolated.vehicles,
      deployables: snap.deployables,
      pickups: snap.pickups,
      colorblind: this.settings.colorblind,
      expanded: this.mapExpanded,
    });
  };

  private lastAim = 0;

  /** Solids currently registered with the prediction grid, by deployable id. */
  private deployableSolids = new Map<number, SolidDef[]>();

  /**
   * Mirrors the server's deployables into the local collision grid, using the
   * same shared geometry the server uses - so an angled barricade blocks
   * predicted movement exactly where it blocks the server's.
   *
   * Only entities inside the interest radius are sent, so a deployable that
   * drops out of view is unregistered too.
   */
  private syncDeployableSolids(list: DeployableWire[]): void {
    const seen = new Set<number>();
    for (const d of list) {
      seen.add(d.id);
      if (this.deployableSolids.has(d.id)) continue;
      const solids = deployableSolids(d.kind, d.x, d.y, d.rot);
      this.deployableSolids.set(d.id, solids);
      for (const solid of solids) this.grid.addSolid(solid);
    }
    for (const [id, solids] of [...this.deployableSolids]) {
      if (seen.has(id)) continue;
      for (const solid of solids) this.grid.removeSolid(solid);
      this.deployableSolids.delete(id);
    }
  }

  /**
   * A defence key opens placement mode for that defence; pressing the same key
   * again places it, so an experienced player can drop one with a double tap.
   */
  private onDeployKey(kind: DeployableKind): void {
    const snap = this.latest;
    if (!snap || snap.phase !== 'active') return;
    if (snap.self.life !== 'alive' || snap.self.vehicleId !== null) return;
    if (this.placement.kind === kind) {
      this.confirmPlacement();
      return;
    }
    this.placement.begin(kind);
    this.deployRefusal = null;
  }

  /** The placement preview for a given aim, from the newest snapshot. */
  private computeGhost(
    aim: number,
    players?: PlayerWire[],
    vehicles?: VehicleWire[],
  ): PlacementGhost | null {
    const snap = this.latest;
    if (!snap || !this.placement.active) return null;
    return this.placement.ghost({
      map: this.map,
      grid: this.grid,
      playerX: this.predicted.x,
      playerY: this.predicted.y,
      aim,
      team: snap.self.team,
      status: snap.self.deployables,
      players: players ?? snap.players,
      vehicles: vehicles ?? snap.vehicles,
      deployables: snap.deployables,
      selfId: this.playerId,
    });
  }

  /**
   * The server's answer to a placement. Success closes placement mode; a
   * refusal keeps it open and says why, so a declined placement is never a
   * silent, confusing no-op.
   */
  onDeployResult(msg: { kind: DeployableKind; ok: boolean; reason: string | null }): void {
    this.deployPending = null;
    if (msg.ok) {
      if (this.placement.kind === msg.kind) this.placement.cancel();
      this.lastGhost = null;
      this.deployRefusal = null;
      return;
    }
    const reasons: Record<string, string> = {
      blocked: 'Blocked - try another spot',
      'out-of-base': 'Only inside your base',
      'team-limit': 'Team limit reached',
      cooldown: 'Still cooling down',
    };
    this.deployRefusal = {
      reason: reasons[msg.reason ?? ''] ?? 'Cannot place right now',
      at: performance.now(),
    };
    this.audio.play('reload', 0, 0.6);
  }

  /**
   * Places the previewed defence. Returns true while placement mode is open, so
   * the click is never also treated as a shot.
   *
   * The preview is recomputed from the aim at this exact instant, and that aim
   * travels with the request. Using last frame's preview and letting the server
   * fall back on its last received input is what made the first click miss.
   */
  private confirmPlacement(): boolean {
    if (!this.placement.active) return false;
    if (this.deployPending) return true;

    const aim = this.input.aimNow();
    const ghost = this.computeGhost(aim);
    if (!ghost) return true;
    this.lastGhost = ghost;

    if (!ghost.valid) {
      this.audio.play('reload', 0, 0.6);
      return true;
    }
    this.deployPending = { kind: ghost.kind, at: performance.now() };
    this.socket.send({ t: 'deploy', kind: ghost.kind, rot: ghost.rot, aim });
    return true;
  }

  private cancelPlacement(): boolean {
    if (!this.placement.active) return false;
    this.placement.cancel();
    this.lastGhost = null;
    this.deployPending = null;
    this.deployRefusal = null;
    return true;
  }

  private sampleAndSendInput(snap: SnapshotMsg, dt: number, now: number): void {
    const sample = this.input.sample(snap.self.slot, SLOT_COUNT);
    // Aim assist pulls toward nearby enemies, which would drag a placement
    // preview toward whoever is shooting you - and away from the aim the click
    // actually sends. Placing a defence always uses the raw aim.
    if (!this.placement.active) sample.aim = this.applyAimAssist(sample.aim, snap);
    this.lastAim = sample.aim;

    // Placement mode closes itself when it stops making sense.
    if (this.placement.active && (snap.self.life !== 'alive' || snap.self.vehicleId !== null)) {
      this.cancelPlacement();
    }
    // Clicking places the defence, so the click must not also fire a shot.
    if (this.placement.active) sample.buttons &= ~Btn.Fire;

    if (snap.self.life !== 'alive' || snap.phase !== 'active') return;

    const cmd: InputCommand = {
      seq: this.seq++,
      dtMs: Math.max(1, Math.min(GAMEPLAY.maxCommandDtMs, dt * 1000)),
      buttons: sample.buttons,
      aim: sample.aim,
      slot: sample.slot,
    };

    // Predict immediately, so the local player responds on the same frame the
    // key was pressed rather than a round trip later.
    if (this.predictedVehicle && snap.self.vehicleId !== null && snap.self.seat === 0) {
      const v = snap.vehicles.find((x) => x.id === snap.self.vehicleId);
      this.applyLocal(cmd, snap, v?.type);
      this.predicted.x = this.predictedVehicle.x;
      this.predicted.y = this.predictedVehicle.y;
    } else if (snap.self.vehicleId === null) {
      const move = this.applyLocal(cmd, snap);
      if (move?.jumped) {
        this.effects.push({
          kind: 'dust', x: this.predicted.x, y: this.predicted.y, born: now, life: 360,
        });
        this.audio.play('throw', 0, 0.55);
      }
    }
    // A passenger predicts nothing: the vehicle is not theirs to steer, so
    // their position comes straight from the interpolated car.

    // Fire feedback is predicted locally so the muzzle flash, tracer and sound
    // land on the frame the trigger was pulled instead of a round trip later.
    // The server still decides whether the shot actually happened - this only
    // affects what the shooter sees and hears.
    this.predictFire(snap, sample.buttons, now);

    this.pending.push(cmd);
    this.unsent.push(cmd);
    if (this.pending.length > GAMEPLAY.maxCommandBuffer) this.pending.shift();

    // Batch outbound input to roughly the tick rate; one packet per rendered
    // frame would be wasteful at 144Hz.
    const sendInterval = 1000 / GAMEPLAY.tickHz;
    if (now - this.lastSendAt >= sendInterval && this.unsent.length > 0) {
      this.lastSendAt = now;
      this.socket.send({ t: 'input', cmds: this.unsent.splice(0, 10) });
    }
  }

  /**
   * Nudges the aim toward the nearest enemy inside a narrow cone.
   *
   * This is a client-side comfort feature: it adjusts the angle the player is
   * already pointing before that angle is sent, and the server still decides
   * whether any shot hits. The pull is capped, falls off with angular distance
   * and range, requires line of sight, and is fully adjustable (0 disables it),
   * so it helps tracking without aiming for the player.
   */
  private applyAimAssist(aim: number, snap: SnapshotMsg): number {
    const strength = this.settings.aimAssist;
    if (strength <= 0 || snap.self.life !== 'alive') return aim;

    const latest = this.buffer[this.buffer.length - 1];
    if (!latest) return aim;

    const weapon = snap.self.weapons[snap.self.slot];
    const range = weapon ? weaponDef(weapon.id).range : 600;
    const maxCone = 0.16;

    let bestDelta = 0;
    let bestScore = 0;

    for (const p of latest.players) {
      if (p.life !== 'alive') continue;
      if (snap.self.team >= 0 && p.team === snap.self.team) continue;

      const dx = p.x - this.predicted.x;
      const dy = p.y - this.predicted.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1 || dist > range) continue;

      const delta = angleDelta(aim, Math.atan2(dy, dx));
      if (Math.abs(delta) > maxCone) continue;
      if (!this.grid.lineOfSight(this.predicted.x, this.predicted.y, p.x, p.y)) continue;

      // Prefer targets that are already close to the crosshair and nearby.
      const score = (1 - Math.abs(delta) / maxCone) * (1 - dist / range);
      if (score > bestScore) {
        bestScore = score;
        bestDelta = delta;
      }
    }

    if (bestScore <= 0) return aim;
    // Cap the correction so the crosshair is guided, never taken over.
    const pull = Math.min(Math.abs(bestDelta), maxCone * 0.55) * strength * bestScore;
    return aim + Math.sign(bestDelta) * pull;
  }

  /**
   * Draws and plays the local player's shot immediately.
   *
   * Cadence, ammunition and semi-auto behaviour mirror the server's rules, so a
   * predicted shot is one the server will also accept; when it disagrees the
   * next snapshot corrects the ammo counter within ~66ms.
   */
  private predictFire(snap: SnapshotMsg, buttons: number, now: number): void {
    const held = (buttons & Btn.Fire) !== 0;
    const wasHeld = this.firePressedLast;
    this.firePressedLast = held;
    if (!held) return;
    // Riding shotgun is allowed; driving and shooting is not.
    if (snap.self.vehicleId !== null && snap.self.seat === 0) return;

    const weapon = snap.self.weapons[snap.self.slot];
    if (!weapon) return;
    const def = weaponDef(weapon.id);

    const semiAuto = def.rpm < 200 || def.class === 'throwable';
    if (semiAuto && wasHeld) return;
    if (now < this.nextLocalFireAt) return;

    const ammo = weapon.ammo < 0 ? Infinity : weapon.ammo - this.predictedShots;
    if (ammo <= 0) return;
    if (snap.serverTime < snap.self.reloadEndsAt) return;

    this.nextLocalFireAt = now + shotIntervalMs(weapon.id);
    this.predictedShots++;

    const aim = this.lastAim;
    // Mirror the server's muzzle placement so the predicted tracer starts where
    // the authoritative one will.
    let ox = this.predicted.x;
    let oy = this.predicted.y;
    if (snap.self.vehicleId !== null) {
      const v = snap.vehicles.find((x) => x.id === snap.self.vehicleId);
      if (v) {
        const def = vehicleDef(v.type);
        const clear = Math.max(def.width, def.length) * 0.5 + 6;
        ox += Math.cos(aim) * clear;
        oy += Math.sin(aim) * clear;
      }
    }

    this.effects.push({ kind: 'muzzle', x: ox, y: oy, a: aim, born: now, life: 85 });
    if (def.class !== 'melee' && def.projectileSpeed === 0) {
      const pellets = Math.min(def.pellets, 6);
      for (let i = 0; i < pellets; i++) {
        const jitter = (Math.random() * 2 - 1) * (def.spread + snap.self.spread);
        const a = aim + jitter;
        const len = this.traceLocal(ox, oy, a, def.range);
        this.effects.push({
          kind: 'tracer',
          x: ox + Math.cos(a) * 16, y: oy + Math.sin(a) * 16,
          x2: ox + Math.cos(a) * len, y2: oy + Math.sin(a) * len,
          color: def.color, born: now, life: 75,
        });
        this.effects.push({
          kind: 'impact',
          x: ox + Math.cos(a) * len, y: oy + Math.sin(a) * len,
          a, born: now, life: 220,
        });
      }
      // Ejected casing, thrown to the shooter's right.
      this.effects.push({
        kind: 'shell', x: ox, y: oy,
        x2: Math.cos(aim + 1.9) * 26, y2: Math.sin(aim + 1.9) * 26,
        born: now, life: 420,
      });
    }

    this.audio.resume();
    this.audio.play(def.sfx, 0, 1);
    this.renderer.camera.addShake(Math.min(0.3, def.damage / 300));
  }

  /**
   * Predicts where a shot lands, using static geometry plus the interpolated
   * positions we already have. It only decides how long to draw the tracer;
   * damage remains entirely the server's call.
   */
  private traceLocal(x: number, y: number, angle: number, range: number): number {
    const x1 = x + Math.cos(angle) * range;
    const y1 = y + Math.sin(angle) * range;
    let t = this.grid.raycast(x, y, x1, y1);

    const latest = this.buffer[this.buffer.length - 1];
    if (latest) {
      for (const p of latest.players) {
        if (p.life !== 'alive' || p.vehicleId !== null) continue;
        const hit = segmentCircle(x, y, x1, y1, p.x, p.y, GAMEPLAY.player.radius);
        if (hit !== null && hit < t) t = hit;
      }
    }
    return range * t;
  }

  /** Interpolates remote entities between the two snapshots straddling renderTime. */
  private interpolate(): {
    players: PlayerWire[];
    vehicles: VehicleWire[];
    projectiles: ProjectileWire[];
  } {
    const buf = this.buffer;
    if (buf.length === 0) {
      return { players: [], vehicles: [], projectiles: [] };
    }
    if (buf.length === 1 || this.renderTime >= buf[buf.length - 1].time) {
      const last = buf[buf.length - 1];
      return { players: last.players, vehicles: last.vehicles, projectiles: last.projectiles };
    }

    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].time <= this.renderTime && buf[i + 1].time >= this.renderTime) {
        a = buf[i];
        b = buf[i + 1];
        break;
      }
    }
    const span = b.time - a.time;
    const alpha = span > 0 ? Math.max(0, Math.min(1, (this.renderTime - a.time) / span)) : 1;

    const players = b.players.map((nb) => {
      const na = a.players.find((p) => p.id === nb.id);
      if (!na) return nb;
      return {
        ...nb,
        x: lerp(na.x, nb.x, alpha),
        y: lerp(na.y, nb.y, alpha),
        aim: lerpAngle(na.aim, nb.aim, alpha),
      };
    });

    const vehicles = b.vehicles.map((nb) => {
      const na = a.vehicles.find((v) => v.id === nb.id);
      if (!na) return nb;
      return {
        ...nb,
        x: lerp(na.x, nb.x, alpha),
        y: lerp(na.y, nb.y, alpha),
        rot: lerpAngle(na.rot, nb.rot, alpha),
      };
    });

    // Projectiles move fast and live briefly; extrapolating them looks worse
    // than simply showing the newest known position.
    return { players, vehicles, projectiles: b.projectiles };
  }

  // -------------------------------------------------------------------------

  private pushHud(snap: SnapshotMsg): void {
    const weapon = snap.self.weapons[snap.self.slot];
    const def = weapon ? weaponDef(weapon.id) : null;
    this.callbacks.onHud({
      hp: snap.self.hp,
      armor: snap.self.armor,
      stamina: snap.self.stamina,
      life: snap.self.life,
      respawnInMs: Math.max(0, snap.self.respawnAt - snap.serverTime),
      weaponName: def?.name ?? 'Unarmed',
      weaponId: weapon?.id ?? null,
      ammo: weapon && weapon.ammo >= 0
        ? Math.max(0, weapon.ammo - this.predictedShots)
        : -1,
      reserve: weapon?.reserve ?? 0,
      slots: snap.self.weapons.map((w, i) => {
        // The wire format uses a fists placeholder for an empty slot.
        const empty = w.ammo === -1 && w.id === 'fists' && i !== 0;
        return {
          index: i,
          name: empty ? '' : weaponDef(w.id).name,
          weapon: empty ? null : w.id,
          active: i === snap.self.slot,
          ammo: w.ammo,
        };
      }),
      team: snap.self.team,
      teamScores: snap.teamScores,
      timeLeftMs: snap.timeLeftMs,
      phase: snap.phase as MatchPhase,
      prompt: snap.prompt,
      reloading: snap.serverTime < snap.self.reloadEndsAt,
      protectedUntilMs: Math.max(0, snap.self.spawnProtectedUntil - snap.serverTime),
      lastHitAt: this.lastHitAt,
      lastHitLethal: this.lastHitLethal,
      inVehicle: snap.self.vehicleId !== null,
      vehicleHp: (() => {
        const v = snap.vehicles.find((x) => x.id === snap.self.vehicleId);
        return v ? v.hp / v.maxHp : 1;
      })(),
      seat: snap.self.seat,
      vehicleOccupants: (() => {
        const v = snap.vehicles.find((x) => x.id === snap.self.vehicleId);
        return v ? v.passengers.length + (v.driver ? 1 : 0) : 0;
      })(),
      vehicleSeats: (() => {
        const v = snap.vehicles.find((x) => x.id === snap.self.vehicleId);
        return v ? vehicleDef(v.type).seats : 0;
      })(),
      vehicleName: (() => {
        const v = snap.vehicles.find((x) => x.id === snap.self.vehicleId);
        return v ? vehicleDef(v.type).name : '';
      })(),
      deployables: snap.self.deployables,
      medkits: snap.self.medkits,
      armorPlates: snap.self.armorPlates,
      pouchCooldownMs: snap.self.pouchCooldownMs,
      jumpCooldownFrac: Math.max(0, Math.min(1, this.predicted.jumpCd / GAMEPLAY.player.jumpCooldown)),
      placing: this.placement.kind
        ? (() => {
          // A fresh server refusal outranks the preview's own verdict briefly.
          const refused = this.deployRefusal &&
            performance.now() - this.deployRefusal.at < 1800;
          return {
            kind: this.placement.kind,
            valid: refused ? false : this.lastGhost?.valid ?? false,
            reason: refused ? this.deployRefusal!.reason : this.lastGhost?.reason ?? null,
          };
        })()
        : null,
      nearbyVehicle: this.nearbyVehicle(snap),
      lastCollect: this.lastCollect,
      killFeed: snap.events
        .filter((e): e is Extract<GameEvent, { e: 'kill' }> => e.e === 'kill')
        .map((e) => ({
          killer: e.killer, victim: e.victim, weapon: e.weapon,
          killerTeam: e.killerTeam, victimTeam: e.victimTeam,
        })),
      objective: this.config.mode === 'tdm'
        ? `First to ${this.config.scoreTarget} eliminations`
        : 'Objective',
      rtt: this.socket.rtt,
    });
  }

  /**
   * The vehicle the HUD should describe: the one the player is in, or the
   * nearest they could board. Showing the card before boarding is what makes
   * picking a vehicle an informed choice.
   */
  private nearbyVehicle(snap: SnapshotMsg): VehicleTypeId | null {
    if (snap.self.vehicleId !== null) {
      return snap.vehicles.find((v) => v.id === snap.self.vehicleId)?.type ?? null;
    }
    if (snap.self.life !== 'alive') return null;
    let best: VehicleTypeId | null = null;
    let bestD = GAMEPLAY.player.interactRange + 40;
    for (const v of snap.vehicles) {
      if (v.destroyed) continue;
      const def = vehicleDef(v.type);
      const d = Math.hypot(v.x - this.predicted.x, v.y - this.predicted.y) -
        (def.length + def.width) / 4;
      if (d < bestD) {
        bestD = d;
        best = v.type;
      }
    }
    return best;
  }

  /** Fires the interact button once (used by on-screen prompts). */
  pressInteract(): void {
    this.socket.send({
      t: 'input',
      cmds: [{ seq: this.seq++, dtMs: 16, buttons: Btn.Interact, aim: this.lastAim, slot: -1 }],
    });
  }
}
