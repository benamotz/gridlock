import { GAMEPLAY } from '../config/gameplay.js';
import type { Rect } from '../math.js';
import {
  DEPLOYABLES,
  type DeployableKind,
  type GameMapDef,
  type SolidDef,
} from '../types.js';

/** Rotations snap to 15 degree steps, which is fine-grained but predictable. */
export const DEPLOY_ROT_STEP = Math.PI / 12;

/** Snaps a requested rotation to the step and normalises it to [-PI, PI). */
export function quantizeDeployRot(rot: number): number {
  if (!Number.isFinite(rot)) return 0;
  let q = Math.round(rot / DEPLOY_ROT_STEP) * DEPLOY_ROT_STEP;
  q = ((q + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return q;
}

/**
 * Default placement rotation: a barricade stands across your line of sight so
 * it faces the direction you are looking, which is almost always what you want.
 */
export function defaultDeployRot(kind: DeployableKind, aim: number): number {
  return kind === 'barricade' ? quantizeDeployRot(aim + Math.PI / 2) : 0;
}

/**
 * Where a deployable lands relative to the player placing it.
 *
 * The distance grows with how far the footprint extends back toward the
 * player, so a barricade turned to run along your line of sight is pushed out
 * far enough that its near end never lands on you.
 */
export function deployPlacementPoint(
  kind: DeployableKind,
  px: number,
  py: number,
  aim: number,
  rot = 0,
): { x: number; y: number } {
  const def = DEPLOYABLES[kind];
  const rel = rot - aim;
  const halfExtent = def.rotatable
    ? Math.abs(Math.cos(rel)) * def.length / 2 + Math.abs(Math.sin(rel)) * def.width / 2
    : Math.max(def.length, def.width) / 2;
  const offset = Math.max(def.placeOffset, halfExtent + GAMEPLAY.player.radius + 10);
  return { x: px + Math.cos(aim) * offset, y: py + Math.sin(aim) * offset };
}

/** The area a team may fortify: their spawn zone, grown by the deploy radius. */
export function deployZoneFor(map: GameMapDef, team: number): Rect {
  const zone =
    map.teamSpawns.find((s) => s.team === team)?.zone ?? map.teamSpawns[0].zone;
  const pad = GAMEPLAY.defences.deployRadius;
  return { x: zone.x - pad, y: zone.y - pad, w: zone.w + pad * 2, h: zone.h + pad * 2 };
}

/**
 * Collision rects for a deployable.
 *
 * The collision grid stores axis-aligned rects. An axis-aligned barricade is a
 * single rect; an angled one is approximated by a chain of overlapping squares
 * laid along its length. The overlap is tight enough that neither a player nor
 * a bullet can slip between links, and it lets angled cover work with the same
 * grid, raycasts and client prediction as everything else.
 *
 * Server and client both call this, so they always agree on the shape.
 */
export function deployableSolids(
  kind: DeployableKind,
  x: number,
  y: number,
  rot: number,
): SolidDef[] {
  const def = DEPLOYABLES[kind];
  if (!def.blocks) return [];

  if (kind !== 'barricade') {
    return [{
      rect: { x: x - def.length / 2, y: y - def.width / 2, w: def.length, h: def.width },
      kind: 'prop',
    }];
  }

  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const L = def.length;
  const W = def.width;

  if (Math.abs(c) > 0.999 || Math.abs(s) > 0.999) {
    const horizontal = Math.abs(c) > 0.5;
    const w = horizontal ? L : W;
    const h = horizontal ? W : L;
    return [{ rect: { x: x - w / 2, y: y - h / 2, w, h }, kind: 'prop' }];
  }

  // Slightly smaller links, so the diagonal corners of the squares do not make
  // an angled wall noticeably fatter than it looks.
  const size = W * 0.82;
  const span = L - size;
  const count = Math.max(2, Math.ceil(span / (size * 0.55)) + 1);
  const solids: SolidDef[] = [];
  for (let i = 0; i < count; i++) {
    const t = -span / 2 + (span * i) / (count - 1);
    const cx = x + c * t;
    const cy = y + s * t;
    solids.push({
      rect: { x: cx - size / 2, y: cy - size / 2, w: size, h: size },
      kind: 'prop',
    });
  }
  return solids;
}
