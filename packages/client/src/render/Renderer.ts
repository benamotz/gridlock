import {
  CollisionGrid,
  type GameMapDef,
  type PickupWire,
  type DeployableWire,
  type PlayerWire,
  type ProjectileWire,
  type Rect,
  type VehicleWire,
  deployableDef,
  jumpHeight,
  vehicleDef,
  weaponDef,
} from '@gridlock/shared';
import { Camera } from './camera.js';
import { StaticLayer } from './StaticLayer.js';
import { drawActorBody, drawCorpse, drawPickupIcon, drawVehicle, shade } from './sprites.js';
import type { PlacementGhost } from '../game/placement.js';
import { COLLECT_ANIM_MS, type CollectAnim } from '../game/collection.js';
import { drawWeaponIconCanvas } from './weaponIcons.js';
import {
  FX, PICKUP_STYLE, PLAYER, VEHICLE, WORLD, teamColorFor, teamSymbol,
} from './assets.js';

/** A short-lived visual effect spawned from a server event or a local action. */
export interface Effect {
  kind: 'tracer' | 'impact' | 'explosion' | 'muzzle' | 'pickup' | 'blood'
    | 'shell' | 'damageNumber' | 'dust';
  /** Text for `damageNumber` effects. */
  text?: string;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  r?: number;
  a?: number;
  color?: string;
  born: number;
  life: number;
}

export interface RenderState {
  map: GameMapDef;
  grid: CollisionGrid;
  selfId: string | null;
  selfX: number;
  selfY: number;
  selfAim: number;
  selfTeam: number;
  selfAlive: boolean;
  selfSpread: number;
  selfVehicleId: number | null;
  selfMoving: boolean;
  selfSprinting: boolean;
  selfWeapon: PlayerWire['weapon'];
  /** Predicted airtime remaining for the local player's jump arc. */
  selfAir: number;
  /** Defence placement preview, when placement mode is open. */
  ghost: PlacementGhost | null;
  /** Pickups flying into the local player. */
  collectAnims: CollectAnim[];
  players: PlayerWire[];
  vehicles: VehicleWire[];
  deployables: DeployableWire[];
  projectiles: ProjectileWire[];
  pickups: PickupWire[];
  effects: Effect[];
  colorblind: boolean;
  screenShake: boolean;
  quality: 'low' | 'medium' | 'high';
  /** Timestamp of the last confirmed hit, for the crosshair marker. */
  lastHitAt: number;
  lastHitLethal: boolean;
  time: number;
}

/**
 * Canvas2D world renderer.
 *
 * Static geometry comes from a chunked, cached `StaticLayer`; only actors,
 * pickups and effects are drawn per frame. Everything culls against the camera
 * rect, so the 5120x4096 city costs about the same to draw as the test arena.
 */
export class Renderer {
  readonly camera: Camera;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private statics: StaticLayer;
  private walkPhase = 0;
  /** First time each body was seen, so corpses fade on their own clock. */
  private corpseSeenAt = new Map<string, number>();

  constructor(
    private canvas: HTMLCanvasElement,
    map: GameMapDef,
    grid: CollisionGrid,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.camera = new Camera(map);
    this.statics = new StaticLayer(map, grid);
  }

  resize(width: number, height: number, quality: RenderState['quality']): void {
    // Quality presets trade resolution for framerate on weaker machines.
    const cap = quality === 'low' ? 1 : quality === 'medium' ? 1.5 : 2;
    this.dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.canvas.width = Math.floor(width * this.dpr);
    this.canvas.height = Math.floor(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  get viewWidth(): number {
    return this.canvas.width / this.dpr;
  }

  get viewHeight(): number {
    return this.canvas.height / this.dpr;
  }

  draw(s: RenderState, dt: number): void {
    const ctx = this.ctx;
    const vw = this.viewWidth;
    const vh = this.viewHeight;

    // Walk-cycle phase advances with time while the local player is moving.
    this.walkPhase += dt * (s.selfSprinting ? 17 : 11);

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = WORLD.outOfBounds;
    ctx.fillRect(0, 0, vw, vh);

    const shakeOff = this.camera.shakeOffset(s.screenShake, s.time);
    ctx.translate(vw / 2 + shakeOff.x, vh / 2 + shakeOff.y);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(-this.camera.x, -this.camera.y);

    const view = this.camera.viewRect(vw, vh);
    const cull: Rect = { x: view.x - 96, y: view.y - 96, w: view.w + 192, h: view.h + 192 };

    this.statics.drawInto(ctx, cull);
    this.drawPickups(s, cull);
    this.drawDeployables(s, cull);
    this.drawVehicles(s, cull);
    this.drawPlayers(s, cull);
    this.drawProjectiles(s, cull);
    this.drawEffects(s);
    this.drawCollections(s);
    this.drawGhost(s);
    this.drawLabels(s, cull);

    ctx.restore();

    if (s.selfAlive) this.drawCrosshair(s, vw, vh);
  }

  // -------------------------------------------------------------------------

  private drawPickups(s: RenderState, cull: Rect): void {
    const ctx = this.ctx;
    for (const p of s.pickups) {
      if (!inRect(p.x, p.y, cull)) continue;
      const style = PICKUP_STYLE[p.kind] ?? PICKUP_STYLE.ammo;
      const bob = Math.sin(s.time * 0.004 + p.x * 0.02) * 2;

      ctx.save();
      ctx.translate(p.x, p.y);

      // Ground shadow keeps the pickup anchored while it bobs.
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.ellipse(1, 7, p.kind === 'weapon' ? 15 : 10, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.translate(0, bob);

      // Glow halo, so pickups stay findable against busy ground.
      ctx.globalAlpha = 0.22 + Math.sin(s.time * 0.004) * 0.06;
      ctx.fillStyle = style.fill;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.kind === 'weapon' ? 24 : 17, 17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Plinth. Weapons get a wide plate so their silhouette has room to read;
      // consumables keep the compact diamond, which also tells the two apart
      // before you are close enough to make out the icon itself.
      ctx.fillStyle = style.fill;
      ctx.strokeStyle = '#0d1015';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (p.kind === 'weapon') {
        const w = 17;
        const h = 11;
        ctx.moveTo(-w, -h + 4);
        ctx.lineTo(-w + 4, -h);
        ctx.lineTo(w - 4, -h);
        ctx.lineTo(w, -h + 4);
        ctx.lineTo(w, h - 4);
        ctx.lineTo(w - 4, h);
        ctx.lineTo(-w + 4, h);
        ctx.lineTo(-w, h - 4);
      } else {
        ctx.moveTo(0, -11);
        ctx.lineTo(11, 0);
        ctx.lineTo(0, 11);
        ctx.lineTo(-11, 0);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      drawPickupIcon(ctx, p.kind, p.weapon);
      ctx.restore();
    }
  }

  /**
   * Base defences.
   *
   * Both kinds are drawn in the owning team's colour so you can tell your own
   * fortifications from an enemy's at a glance, with a health bar once damaged
   * and a barrel on the turret showing exactly where it is looking.
   */
  private drawDeployables(s: RenderState, cull: Rect): void {
    const ctx = this.ctx;
    for (const d of s.deployables) {
      if (!inRect(d.x, d.y, cull, 60)) continue;
      const def = deployableDef(d.kind);
      const color = teamColorFor(d.team, s.colorblind);
      const friendly = s.selfTeam >= 0 && d.team === s.selfTeam;

      ctx.save();
      ctx.translate(d.x, d.y);

      // Ground shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.save();
      ctx.rotate(d.rot);
      ctx.fillRect(-def.length / 2 + 3, -def.width / 2 + 4, def.length, def.width);
      ctx.restore();

      if (d.kind === 'barricade') {
        ctx.rotate(d.rot);
        drawBarricadeBody(ctx, def.length, def.width, def.color, color);
      } else if (d.kind === 'mine') {
        drawMineBody(ctx, def.length / 2, color, d.active, friendly, s.time);
      } else {
        // Turret: a hexagonal base, a team ring, and a traversing barrel.
        ctx.fillStyle = def.color;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const px = Math.cos(a) * (def.length / 2);
          const py = Math.sin(a) * (def.length / 2);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#0d1015';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, def.length / 2 - 4, 0, Math.PI * 2);
        ctx.stroke();

        ctx.rotate(d.aim);
        ctx.fillStyle = '#1c1f27';
        ctx.fillRect(2, -3.5, def.length * 0.72, 7);
        ctx.fillStyle = d.active ? '#ffd479' : '#5a6172';
        ctx.fillRect(def.length * 0.72 - 2, -2.5, 4, 5);
        ctx.rotate(-d.aim);

        // Arming pulse, so a turret that cannot shoot yet reads as inert.
        if (!d.active) {
          ctx.globalAlpha = 0.35 + Math.sin(s.time * 0.012) * 0.25;
          ctx.strokeStyle = '#ffd479';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, def.length / 2 + 6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();

      if (d.hp < d.maxHp) {
        this.drawBar(d.x, d.y - def.width / 2 - 12, 30, d.hp / d.maxHp,
          friendly ? '#3ad07a' : '#ff4d5e');
      }
    }
  }

  /**
   * The placement preview: the defence drawn where it would land, green when it
   * can go there and red when it cannot, with its collision footprint outlined
   * so an angled barricade shows exactly what it will block.
   */
  private drawGhost(s: RenderState): void {
    const g = s.ghost;
    if (!g) return;
    const ctx = this.ctx;
    const def = deployableDef(g.kind);
    const tint = g.valid ? '#3ad07a' : '#ff4d5e';

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = tint;
    for (const r of g.footprint) ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();

    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.globalAlpha = 0.55 + Math.sin(s.time * 0.01) * 0.12;
    if (g.kind === 'barricade') {
      ctx.rotate(g.rot);
      drawBarricadeBody(ctx, def.length, def.width, tint, tint);
      // Rotation handles at each end hint that the wheel turns it.
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = tint;
      ctx.lineWidth = 2;
      for (const end of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(end * (def.length / 2 + 8), 0, 5, 0, Math.PI * 1.5);
        ctx.stroke();
      }
    } else if (g.kind === 'mine') {
      drawMineBody(ctx, def.length / 2, tint, true, true, s.time);
    } else {
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.arc(0, 0, def.length / 2, 0, Math.PI * 2);
      ctx.fill();
      // The turret's reach, so placement shows what it will cover.
      ctx.globalAlpha = 0.2;
      ctx.setLineDash([10, 8]);
      ctx.strokeStyle = tint;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, def.range ?? 600, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /**
   * Collection animation: the item leaps into the player, shrinking as it
   * goes, then a ring bursts outward. It starts on the frame the player reaches
   * the item, because the grab is predicted rather than waiting on the server.
   */
  private drawCollections(s: RenderState): void {
    const ctx = this.ctx;
    const flight = 170;
    for (const a of s.collectAnims) {
      const t = s.time - a.born;
      if (t < 0 || t > COLLECT_ANIM_MS) continue;
      const style = PICKUP_STYLE[a.kind] ?? PICKUP_STYLE.ammo;

      if (t < flight) {
        const k = t / flight;
        const ease = k * k;
        // Arc upward on the way in, like the item being tossed to the player.
        const x = a.fromX + (s.selfX - a.fromX) * ease;
        const y = a.fromY + (s.selfY - a.fromY) * ease - Math.sin(Math.PI * k) * 16;
        const scale = 1.15 - 0.75 * ease;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        ctx.globalAlpha = 1;
        ctx.fillStyle = style.fill;
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, Math.PI * 2);
        ctx.fill();
        if (a.kind === 'weapon' && a.weapon) {
          drawWeaponIconCanvas(ctx, a.weapon, 22, '#20180a', '#443208');
        } else {
          drawPickupIcon(ctx, a.kind, a.weapon);
        }
        ctx.restore();
        continue;
      }

      const k = (t - flight) / (COLLECT_ANIM_MS - flight);
      ctx.save();
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.strokeStyle = style.fill;
      ctx.lineWidth = 3 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(s.selfX, s.selfY, 14 + k * 26, 0, Math.PI * 2);
      ctx.stroke();
      // Sparks thrown out with the ring.
      ctx.fillStyle = style.fill;
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + a.born * 0.001;
        const r = 16 + k * 30;
        ctx.fillRect(s.selfX + Math.cos(ang) * r - 1.5, s.selfY + Math.sin(ang) * r - 1.5, 3, 3);
      }
      ctx.restore();
    }
  }

  private drawVehicles(s: RenderState, cull: Rect): void {
    const ctx = this.ctx;
    for (const v of s.vehicles) {
      if (!inRect(v.x, v.y, cull, 120)) continue;
      const def = vehicleDef(v.type);
      const speed = Math.hypot(v.vx, v.vy);
      const driver = v.driver ? s.players.find((p) => p.id === v.driver) : null;
      const driverTeam = v.driver === s.selfId ? s.selfTeam : driver?.team ?? -1;

      ctx.save();
      // Drop shadow, offset away from the map centre like the buildings.
      ctx.translate(v.x, v.y);
      ctx.save();
      ctx.rotate(v.rot);
      ctx.fillStyle = VEHICLE.shadow;
      ctx.fillRect(-def.length / 2 + 4, -def.width / 2 + 5, def.length, def.width);
      ctx.restore();

      ctx.rotate(v.rot);
      // Riders a motorcycle cannot hide are drawn on it, in their team colour.
      const riderColors = def.shieldsOccupants
        ? []
        : [v.driver, ...v.passengers]
          .filter((id): id is string => !!id)
          .map((id) => {
            const team = id === s.selfId
              ? s.selfTeam
              : s.players.find((p) => p.id === id)?.team ?? -1;
            return teamColorFor(team, s.colorblind);
          });
      drawVehicle(ctx, {
        def,
        damage: 1 - v.hp / Math.max(1, v.maxHp),
        destroyed: v.destroyed,
        occupied: v.driver !== null,
        driverColor: v.driver !== null && driverTeam >= 0
          ? teamColorFor(driverTeam, s.colorblind)
          : null,
        speed,
        braking: false,
        riderColors,
      });
      ctx.restore();

      // Occupancy pips: how many are aboard, and how many seats remain.
      if (!v.destroyed && (v.driver || v.passengers.length > 0)) {
        const occupants = v.passengers.length + (v.driver ? 1 : 0);
        const total = def.seats;
        const pipY = v.y + def.width / 2 + 9;
        const startX = v.x - ((total - 1) * 5) / 2;
        ctx.save();
        for (let i = 0; i < total; i++) {
          ctx.fillStyle = i < occupants
            ? teamColorFor(driverTeam, s.colorblind)
            : 'rgba(255,255,255,0.22)';
          ctx.beginPath();
          ctx.arc(startX + i * 5, pipY, 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      if (!v.destroyed && v.hp < v.maxHp * 0.85) {
        this.drawBar(v.x, v.y - def.width - 4, 34, v.hp / v.maxHp, '#ffb020');
      }
      // Smoke plume on a badly damaged car.
      if (!v.destroyed && v.hp < v.maxHp * 0.3) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#8a8f98';
        const t = s.time * 0.003;
        for (let i = 0; i < 3; i++) {
          const p = (t + i * 0.33) % 1;
          ctx.beginPath();
          ctx.arc(v.x - Math.cos(v.rot) * 20, v.y - Math.sin(v.rot) * 20 - p * 22, 4 + p * 9, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  private drawPlayers(s: RenderState, cull: Rect): void {
    const ctx = this.ctx;
    // Bodies first, so a living player standing over one is drawn on top.
    for (const p of s.players) {
      if (p.life !== 'dead' || !inRect(p.x, p.y, cull)) continue;
      const born = this.corpseSeenAt.get(p.id) ?? s.time;
      this.corpseSeenAt.set(p.id, born);
      const age = Math.min(1, (s.time - born) / 3500);
      ctx.save();
      ctx.translate(p.x, p.y);
      drawCorpse(ctx, teamColorFor(p.team, s.colorblind), p.aim, age);
      ctx.restore();
    }
    // Forget bodies that are no longer being sent, so the map cannot grow.
    if (this.corpseSeenAt.size > 40) {
      const live = new Set(s.players.map((p) => p.id));
      for (const id of this.corpseSeenAt.keys()) {
        if (!live.has(id)) this.corpseSeenAt.delete(id);
      }
    }

    for (const p of s.players) {
      if (p.vehicleId !== null) continue; // riders are drawn by the vehicle
      if (!inRect(p.x, p.y, cull) || p.life !== 'alive') continue;
      const friendly = s.selfTeam >= 0 && p.team === s.selfTeam;
      this.drawActor(
        s, p.x, p.y, p.aim, p.team, p.weapon, p.sprinting, p.protected, friendly, false, p.air,
      );
      if (p.hp >= 0 && p.hp < 100) this.drawBar(p.x, p.y - 24, 26, p.hp / 100, '#3ad07a');
    }

    // The local player is drawn last so they are never hidden behind anyone.
    if (s.selfAlive && s.selfVehicleId === null) {
      this.drawActor(
        s, s.selfX, s.selfY, s.selfAim, s.selfTeam, s.selfWeapon,
        s.selfSprinting, false, true, true, s.selfAir,
      );
    }
  }

  private drawActor(
    s: RenderState,
    x: number, y: number, aim: number, team: number,
    weapon: PlayerWire['weapon'],
    sprinting: boolean, isProtected: boolean,
    friendly: boolean, isSelf: boolean,
    air = 0,
  ): void {
    const ctx = this.ctx;
    const color = teamColorFor(team, s.colorblind);
    // Jump arc: the shadow stays on the ground and shrinks while the body
    // lifts and grows, which is how height reads from directly above.
    const h = jumpHeight(air);

    ctx.save();
    ctx.translate(x, y);

    // Contact shadow.
    ctx.fillStyle = PLAYER.shadow;
    ctx.globalAlpha = 1 - h * 0.5;
    ctx.beginPath();
    ctx.ellipse(2 + h * 6, 4 + h * 10, 12 * (1 - h * 0.35), 8 * (1 - h * 0.35), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (h > 0) {
      ctx.translate(-h * 3, -h * 9);
      ctx.scale(1 + h * 0.28, 1 + h * 0.28);
    }

    // Friend/foe ring drawn under the body: a filled team ring for allies, a
    // hard hostile ring for enemies. Colour alone is never the only cue - the
    // ring style and the badge above both carry it too.
    if (!isSelf) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = friendly ? color : PLAYER.hostile;
      ctx.setLineDash(friendly ? [] : [5, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER.radius + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = PLAYER.selfRing;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER.radius + 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (isProtected) {
      ctx.strokeStyle = PLAYER.protectedRing;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER.radius + 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (sprinting) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER.radius + 9, 0, Math.PI * 2);
      ctx.fill();
    }

    drawActorBody(ctx, {
      color: isSelf ? shade(color, 0.12) : color,
      aim,
      weapon,
      sprinting,
      phase: this.walkPhase,
      moving: sprinting || isSelf ? s.selfMoving || sprinting : true,
    });

    ctx.restore();
  }

  /**
   * Name tags and team badges.
   *
   * Drawn in a separate pass, after every actor, so a label is never covered by
   * a player standing in front of the one it belongs to.
   */
  private drawLabels(s: RenderState, cull: Rect): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const p of s.players) {
      if (!inRect(p.x, p.y, cull) || p.life !== 'alive') continue;
      const friendly = s.selfTeam >= 0 && p.team === s.selfTeam;
      const color = teamColorFor(p.team, s.colorblind);
      const y = p.y - (p.vehicleId !== null ? 34 : 30);

      // Team badge: the shape carries team identity without relying on colour.
      ctx.font = 'bold 11px ui-monospace, monospace';
      const badge = teamSymbol(p.team);
      const label = `${badge} ${p.name}`;
      const width = ctx.measureText(label).width + 10;

      ctx.fillStyle = 'rgba(8,10,15,0.72)';
      ctx.fillRect(p.x - width / 2, y - 8, width, 15);
      ctx.fillStyle = friendly ? color : PLAYER.hostile;
      ctx.fillRect(p.x - width / 2, y - 8, 2.5, 15);

      ctx.fillStyle = friendly ? color : '#ffd7dc';
      ctx.fillText(label, p.x, y);
    }
    ctx.restore();
  }

  private drawBar(x: number, y: number, w: number, frac: number, color: string): void {
    const ctx = this.ctx;
    const h = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, frac)), h);
  }

  private drawProjectiles(s: RenderState, cull: Rect): void {
    const ctx = this.ctx;
    for (const pr of s.projectiles) {
      if (!inRect(pr.x, pr.y, cull)) continue;
      const def = weaponDef(pr.weapon);
      ctx.save();
      ctx.translate(pr.x, pr.y);
      ctx.rotate(pr.rot);
      ctx.fillStyle = 'rgba(255,170,90,0.5)';
      ctx.fillRect(-24, -2, 17, 4);
      ctx.fillStyle = def.color;
      ctx.fillRect(-7, -2.5, 14, 5);
      ctx.fillStyle = '#fff2d0';
      ctx.fillRect(4, -1.5, 4, 3);
      ctx.restore();
    }
  }

  private drawEffects(s: RenderState): void {
    const ctx = this.ctx;
    for (const fx of s.effects) {
      const age = (s.time - fx.born) / fx.life;
      if (age >= 1) continue;
      const fade = 1 - age;

      switch (fx.kind) {
        case 'tracer': {
          ctx.save();
          ctx.globalAlpha = fade * 0.95;
          ctx.strokeStyle = fx.color ?? FX.tracer;
          ctx.lineWidth = 2.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(fx.x, fx.y);
          ctx.lineTo(fx.x2 ?? fx.x, fx.y2 ?? fx.y);
          ctx.stroke();
          // Hot core.
          ctx.globalAlpha = fade * 0.6;
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 0.9;
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'muzzle': {
          ctx.save();
          ctx.translate(fx.x, fx.y);
          ctx.rotate(fx.a ?? 0);
          ctx.globalAlpha = fade;
          ctx.fillStyle = FX.muzzle;
          // A short flash cone rather than a circle - it points the shot.
          ctx.beginPath();
          ctx.moveTo(6, 0);
          ctx.lineTo(20 + fade * 8, -6 * fade);
          ctx.lineTo(24 + fade * 8, 0);
          ctx.lineTo(20 + fade * 8, 6 * fade);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.arc(8, 0, 4.5 * fade + 1.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'dust': {
          ctx.save();
          ctx.globalAlpha = fade * 0.35;
          ctx.fillStyle = '#c9ced8';
          for (let i = 0; i < 5; i++) {
            const ang = (i / 5) * Math.PI * 2;
            const r = 6 + age * 20;
            ctx.beginPath();
            ctx.arc(fx.x + Math.cos(ang) * r, fx.y + Math.sin(ang) * r * 0.6 + 6, 3 + age * 4, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
          break;
        }
        case 'shell': {
          ctx.save();
          ctx.globalAlpha = fade;
          ctx.fillStyle = '#c9a94e';
          ctx.translate(fx.x + (fx.x2 ?? 0) * age, fx.y + (fx.y2 ?? 0) * age);
          ctx.rotate(age * 9);
          ctx.fillRect(-2, -1, 4, 2);
          ctx.restore();
          break;
        }
        case 'impact':
        case 'blood': {
          const blood = fx.kind === 'blood';
          ctx.save();
          ctx.globalAlpha = fade;
          ctx.fillStyle = blood ? FX.bloodHit : FX.impact;
          // Blood reads bigger and throws more spray than a wall spark, so a
          // hit on a person is unmistakable at a glance.
          const spread = (blood ? 6 : 3) + (1 - fade) * (blood ? 14 : 6);
          ctx.beginPath();
          ctx.arc(fx.x, fx.y, spread * (blood ? 0.42 : 0.5), 0, Math.PI * 2);
          ctx.fill();
          const flecks = blood ? 8 : 4;
          for (let i = 0; i < flecks; i++) {
            const a = (i / flecks) * Math.PI * 2 + (fx.a ?? 0);
            const size = blood ? 2.6 : 1.6;
            ctx.fillRect(
              fx.x + Math.cos(a) * spread, fx.y + Math.sin(a) * spread, size, size,
            );
          }
          if (blood) {
            // A lingering splatter under the spray.
            ctx.globalAlpha = fade * 0.5;
            ctx.beginPath();
            ctx.ellipse(fx.x, fx.y + 3, spread * 0.7, spread * 0.45, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
          break;
        }
        case 'damageNumber': {
          ctx.save();
          ctx.globalAlpha = Math.min(1, fade * 1.6);
          ctx.font = `bold ${fx.r ?? 15}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const ry = fx.y - age * 30;
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.strokeText(fx.text ?? '', fx.x, ry);
          ctx.fillStyle = fx.color ?? '#ffd7a0';
          ctx.fillText(fx.text ?? '', fx.x, ry);
          ctx.restore();
          break;
        }
        case 'explosion': {
          const r = (fx.r ?? 100) * (0.35 + age * 0.75);
          ctx.save();
          ctx.globalAlpha = fade * 0.55;
          ctx.fillStyle = '#2a1a10';
          ctx.beginPath();
          ctx.arc(fx.x, fx.y, r * 1.05, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = fade * 0.85;
          ctx.fillStyle = FX.explosion;
          ctx.beginPath();
          ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = fade;
          ctx.fillStyle = FX.explosionCore;
          ctx.beginPath();
          ctx.arc(fx.x, fx.y, r * 0.42, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'pickup': {
          ctx.save();
          ctx.globalAlpha = fade;
          ctx.strokeStyle = fx.color ?? '#ffd479';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(fx.x, fx.y - age * 20, 10 + age * 14, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          break;
        }
      }
    }
  }

  /** Dynamic crosshair whose gap grows with the server-reported spread. */
  private drawCrosshair(s: RenderState, vw: number, vh: number): void {
    const ctx = this.ctx;
    const cx = vw / 2 + (s.selfX - this.camera.x) * this.camera.zoom;
    const cy = vh / 2 + (s.selfY - this.camera.y) * this.camera.zoom;
    const reach = 150 * this.camera.zoom;
    const px = cx + Math.cos(s.selfAim) * reach;
    const py = cy + Math.sin(s.selfAim) * reach;
    const gap = 5 + s.selfSpread * 280;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.6;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      ctx.beginPath();
      ctx.moveTo(px + dx * gap, py + dy * gap);
      ctx.lineTo(px + dx * (gap + 8), py + dy * (gap + 8));
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(px - 1, py - 1, 2, 2);

    // Hit marker: four diagonal ticks that flash on a confirmed hit, red and
    // larger for a kill. This is the primary "you connected" signal.
    const since = s.time - s.lastHitAt;
    const window = s.lastHitLethal ? 420 : 260;
    if (s.lastHitAt > 0 && since < window) {
      const t = 1 - since / window;
      const inner = 6 + (1 - t) * 7;
      const outer = inner + (s.lastHitLethal ? 12 : 8);
      ctx.globalAlpha = Math.min(1, t * 1.7);
      ctx.strokeStyle = s.lastHitLethal ? '#ff5f70' : '#ffffff';
      ctx.lineWidth = s.lastHitLethal ? 3 : 2.2;
      ctx.lineCap = 'round';
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        ctx.beginPath();
        ctx.moveTo(px + dx * inner, py + dy * inner);
        ctx.lineTo(px + dx * outer, py + dy * outer);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

const inRect = (x: number, y: number, r: Rect, pad = 0): boolean =>
  x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;

/** A sandbag wall along its local x axis, with a team stripe on one long face. */
function drawBarricadeBody(
  ctx: CanvasRenderingContext2D,
  length: number,
  width: number,
  fill: string,
  stripe: string,
): void {
  const hl = length / 2;
  const hw = width / 2;
  ctx.fillStyle = fill;
  ctx.fillRect(-hl, -hw, length, width);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(-hl, -hw, length, 3);
  // Bag divisions across the wall.
  ctx.strokeStyle = 'rgba(0,0,0,0.42)';
  ctx.lineWidth = 1.5;
  for (let o = -hl + 16; o < hl; o += 16) {
    ctx.beginPath();
    ctx.moveTo(o, -hw);
    ctx.lineTo(o, hw);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.moveTo(-hl, 0);
  ctx.lineTo(hl, 0);
  ctx.stroke();
  ctx.fillStyle = stripe;
  ctx.fillRect(-hl, hw - 3.5, length, 3.5);
  ctx.strokeStyle = '#0d1015';
  ctx.lineWidth = 2;
  ctx.strokeRect(-hl, -hw, length, width);
}

/**
 * A mine: a flat charge with a blinking arming light. An enemy mine that has
 * been spotted gets a pulsing warning ring, because the whole point of seeing
 * one is being able to react to it.
 */
function drawMineBody(
  ctx: CanvasRenderingContext2D,
  radius: number,
  teamColor: string,
  armed: boolean,
  friendly: boolean,
  time: number,
): void {
  ctx.fillStyle = '#3c4430';
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#11140e';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = teamColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, radius - 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#23281c';
  ctx.fillRect(-radius * 0.5, -1.5, radius, 3);

  const blink = Math.sin(time * (armed ? 0.012 : 0.03)) > 0;
  ctx.fillStyle = blink ? (armed ? '#ff4d5e' : '#ffd479') : '#5a2a2a';
  ctx.beginPath();
  ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
  ctx.fill();

  if (!friendly) {
    ctx.save();
    ctx.globalAlpha = 0.45 + Math.sin(time * 0.015) * 0.35;
    ctx.strokeStyle = '#ff4d5e';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(0, 0, radius + 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
