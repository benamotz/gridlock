import type { Rect } from '../math.js';
import { makeRng } from '../math.js';
import type {
  PickupSpawnDef,
  SolidDef,
  VehicleSpawnDef,
  WeaponId,
  ZoneDef,
  ZoneKind,
} from '../types.js';
import { GAMEPLAY } from '../config/gameplay.js';
import { rollVehicleType, vehicleBodyCircles, vehicleDef } from '../config/vehicles.js';

/**
 * Helpers for assembling maps procedurally from a compact description.
 *
 * Maps are data, not art: a map is a list of zones (ground painting), solids
 * (collision + buildings) and spawn points. That keeps the repo asset-free
 * while remaining trivially replaceable by a Tiled import later - a Tiled
 * loader only has to emit the same three lists.
 */
export class MapBuilder {
  readonly zones: ZoneDef[] = [];
  readonly solids: SolidDef[] = [];
  readonly vehicleSpawns: VehicleSpawnDef[] = [];
  readonly pickupSpawns: PickupSpawnDef[] = [];
  readonly rng: () => number;
  private pickupSeq = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    seed: number,
  ) {
    this.rng = makeRng(seed);
  }

  zone(kind: ZoneKind, rect: Rect, label?: string, team?: number): this {
    this.zones.push({ kind, rect, label, team });
    return this;
  }

  building(rect: Rect, height = 1): this {
    this.solids.push({ rect, kind: 'building', height });
    return this;
  }

  wall(rect: Rect): this {
    this.solids.push({ rect, kind: 'wall' });
    return this;
  }

  prop(rect: Rect): this {
    this.solids.push({ rect, kind: 'prop' });
    return this;
  }

  /** Places a vehicle. Omit `type` to roll one from the spawn weights. */
  vehicle(x: number, y: number, rot: number, type?: VehicleSpawnDef['type']): this {
    this.vehicleSpawns.push({
      x, y, rot,
      type: type ?? rollVehicleType(this.rng),
      respawnSec: 25,
    });
    return this;
  }

  weaponPickup(x: number, y: number, weapon?: WeaponId, tier?: 1 | 2 | 3): this {
    this.pickupSpawns.push({
      id: `p${this.pickupSeq++}`,
      x, y,
      kind: 'weapon',
      weapon,
      tier,
      respawnSec: GAMEPLAY.pickups.weaponRespawnSec,
    });
    return this;
  }

  ammoPickup(x: number, y: number): this {
    this.pickupSpawns.push({
      id: `p${this.pickupSeq++}`,
      x, y, kind: 'ammo',
      respawnSec: GAMEPLAY.pickups.ammoRespawnSec,
    });
    return this;
  }

  healthPickup(x: number, y: number): this {
    this.pickupSpawns.push({
      id: `p${this.pickupSeq++}`,
      x, y, kind: 'health',
      respawnSec: GAMEPLAY.pickups.healthRespawnSec,
    });
    return this;
  }

  armorPickup(x: number, y: number): this {
    this.pickupSpawns.push({
      id: `p${this.pickupSeq++}`,
      x, y, kind: 'armor',
      respawnSec: GAMEPLAY.pickups.armorRespawnSec,
    });
    return this;
  }

  /** Outer boundary walls so nothing can leave the world. */
  borderWalls(thickness = 40): this {
    const { width: w, height: h } = this;
    this.wall({ x: -thickness, y: -thickness, w: w + thickness * 2, h: thickness });
    this.wall({ x: -thickness, y: h, w: w + thickness * 2, h: thickness });
    this.wall({ x: -thickness, y: 0, w: thickness, h });
    this.wall({ x: w, y: 0, w: thickness, h });
    return this;
  }

  /**
   * Drops any pickup or vehicle spawn that ended up inside generated geometry.
   *
   * Procedural layout occasionally drops a spawn point on top of a building;
   * pruning here means the simulation never has to special-case an
   * unreachable pickup, and the map-validity test can assert zero blocked
   * spawns for every registered map.
   */
  pruneBlockedSpawns(pickupRadius = 14): this {
    const blocked = (x: number, y: number, r: number): boolean => {
      if (x - r < 0 || y - r < 0 || x + r > this.width || y + r > this.height) return true;
      for (const s of this.solids) {
        const cx = Math.max(s.rect.x, Math.min(x, s.rect.x + s.rect.w));
        const cy = Math.max(s.rect.y, Math.min(y, s.rect.y + s.rect.h));
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy < r * r) return true;
      }
      return false;
    };
    let i = this.pickupSpawns.length;
    while (i--) {
      const p = this.pickupSpawns[i];
      if (blocked(p.x, p.y, pickupRadius)) this.pickupSpawns.splice(i, 1);
    }
    let j = this.vehicleSpawns.length;
    while (j--) {
      const v = this.vehicleSpawns[j];
      // Check the whole body at its parked heading, so a truck is never left
      // with its nose inside a building.
      const body = vehicleBodyCircles(vehicleDef(v.type));
      const c = Math.cos(v.rot);
      const sn = Math.sin(v.rot);
      if (body.offsets.some((o) => blocked(v.x + c * o, v.y + sn * o, body.radius + 5))) {
        this.vehicleSpawns.splice(j, 1);
      }
    }
    return this;
  }

  /**
   * Fills a city block with buildings, leaving alleys between them. Density
   * controls how many sub-buildings the block is split into.
   */
  cityBlock(rect: Rect, opts: { density: number; alley: number; minSize: number }): void {
    const { density, alley, minSize } = opts;
    const pieces: Rect[] = [rect];

    for (let i = 0; i < density; i++) {
      // Split the largest piece so blocks subdivide evenly rather than shredding.
      pieces.sort((a, b) => b.w * b.h - a.w * a.h);
      const piece = pieces.shift();
      if (!piece) break;
      const splitVertical = piece.w > piece.h;
      const size = splitVertical ? piece.w : piece.h;
      if (size < minSize * 2 + alley) {
        pieces.push(piece);
        break;
      }
      const cut = size * (0.35 + this.rng() * 0.3);
      if (splitVertical) {
        pieces.push({ x: piece.x, y: piece.y, w: cut - alley / 2, h: piece.h });
        pieces.push({
          x: piece.x + cut + alley / 2, y: piece.y,
          w: piece.w - cut - alley / 2, h: piece.h,
        });
      } else {
        pieces.push({ x: piece.x, y: piece.y, w: piece.w, h: cut - alley / 2 });
        pieces.push({
          x: piece.x, y: piece.y + cut + alley / 2,
          w: piece.w, h: piece.h - cut - alley / 2,
        });
      }
    }

    for (const p of pieces) {
      if (p.w < minSize || p.h < minSize) continue;
      this.building(p, 1 + Math.floor(this.rng() * 3));
    }
  }
}
