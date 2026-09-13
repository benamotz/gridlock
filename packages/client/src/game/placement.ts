import {
  type CollisionGrid,
  DEPLOYABLES,
  DEPLOY_ROT_STEP,
  type DeployStatusWire,
  type DeployableKind,
  type DeployableWire,
  GAMEPLAY,
  type GameMapDef,
  type PlayerWire,
  type Rect,
  type VehicleWire,
  defaultDeployRot,
  deployPlacementPoint,
  deployZoneFor,
  deployableSolids,
  dist2,
  pointInRect,
  quantizeDeployRot,
  vehicleBodyWorld,
} from '@gridlock/shared';

export interface PlacementGhost {
  kind: DeployableKind;
  x: number;
  y: number;
  rot: number;
  valid: boolean;
  /** Why placement would be refused, for the HUD. Null when valid. */
  reason: string | null;
  /** Collision footprint, drawn faintly so angled cover shows what it blocks. */
  footprint: Rect[];
}

export interface PlacementContext {
  map: GameMapDef;
  grid: CollisionGrid;
  playerX: number;
  playerY: number;
  aim: number;
  team: number;
  status: DeployStatusWire[];
  players: PlayerWire[];
  vehicles: VehicleWire[];
  deployables: DeployableWire[];
  selfId: string | null;
}

/**
 * Client-side placement mode for base defences.
 *
 * Pressing a defence key opens a ghost preview in front of the player. The
 * mouse wheel rotates rotatable defences in 15 degree steps, and the ghost is
 * tinted green or red using the same geometry and zone rules the server
 * applies. The preview is advisory: the server re-validates everything when
 * the deploy request arrives.
 */
export class PlacementController {
  kind: DeployableKind | null = null;
  private rotOffset = 0;

  get active(): boolean {
    return this.kind !== null;
  }

  begin(kind: DeployableKind): void {
    this.kind = kind;
    this.rotOffset = 0;
  }

  cancel(): void {
    this.kind = null;
    this.rotOffset = 0;
  }

  /** Rotates by whole steps. Returns false when the current kind cannot rotate. */
  rotate(steps: number): boolean {
    if (!this.kind || !DEPLOYABLES[this.kind].rotatable) return false;
    this.rotOffset += steps * DEPLOY_ROT_STEP;
    return true;
  }

  ghost(ctx: PlacementContext): PlacementGhost | null {
    const kind = this.kind;
    if (!kind) return null;
    const def = DEPLOYABLES[kind];

    const rot = def.rotatable
      ? quantizeDeployRot(defaultDeployRot(kind, ctx.aim) + this.rotOffset)
      : 0;
    const at = deployPlacementPoint(kind, ctx.playerX, ctx.playerY, ctx.aim, rot);
    const solids = deployableSolids(kind, at.x, at.y, rot);
    const footprint = solids.length > 0
      ? solids.map((s) => s.rect)
      : [{ x: at.x - def.length / 2, y: at.y - def.width / 2, w: def.length, h: def.width }];

    const reason = this.refusal(ctx, kind, at, footprint);
    return { kind, x: at.x, y: at.y, rot, valid: reason === null, reason, footprint };
  }

  private refusal(
    ctx: PlacementContext,
    kind: DeployableKind,
    at: { x: number; y: number },
    footprint: Rect[],
  ): string | null {
    const status = ctx.status.find((s) => s.kind === kind);
    if (status && status.remaining <= 0) return 'Team limit reached';
    if (status && status.cooldownMs > 0) {
      return `Ready in ${Math.ceil(status.cooldownMs / 1000)}s`;
    }

    const zone = deployZoneFor(ctx.map, ctx.team);
    if (!pointInRect(ctx.playerX, ctx.playerY, zone) || !pointInRect(at.x, at.y, zone)) {
      return 'Only inside your base';
    }

    const margin = 6;
    for (const r of footprint) {
      const probe = { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 };
      for (const solid of ctx.grid.query(probe)) {
        const sr = solid.rect;
        if (sr.x < probe.x + probe.w && sr.x + sr.w > probe.x &&
            sr.y < probe.y + probe.h && sr.y + sr.h > probe.y) {
          return 'Blocked';
        }
      }
      const near = (x: number, y: number, reach: number): boolean => {
        const cx = Math.max(r.x, Math.min(x, r.x + r.w));
        const cy = Math.max(r.y, Math.min(y, r.y + r.h));
        return dist2(x, y, cx, cy) < reach * reach;
      };
      if (near(ctx.playerX, ctx.playerY, GAMEPLAY.player.radius + margin)) return 'Blocked';
      for (const p of ctx.players) {
        if (p.life !== 'alive' || p.vehicleId !== null) continue;
        if (near(p.x, p.y, GAMEPLAY.player.radius + margin)) return 'Blocked';
      }
      for (const v of ctx.vehicles) {
        if (v.destroyed) continue;
        for (const c of vehicleBodyWorld(v)) {
          if (near(c.x, c.y, c.r + margin)) return 'Blocked';
        }
      }
      for (const d of ctx.deployables) {
        const def = DEPLOYABLES[d.kind];
        if (near(d.x, d.y, Math.max(def.length, def.width) / 2)) return 'Blocked';
      }
    }
    return null;
  }
}
