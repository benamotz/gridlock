import type { Rect } from '../math.js';
import { segmentRect } from '../math.js';
import type { GameMapDef, SolidDef } from '../types.js';

const CELL = 128;

/**
 * Uniform-grid index over a map's static solids.
 *
 * Both the server sim and the client's prediction build this from the same map
 * definition, so collision responses agree bit-for-bit and prediction does not
 * fight the server around building corners.
 */
export class CollisionGrid {
  readonly cell = CELL;
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  private readonly buckets: SolidDef[][];

  constructor(mapDef: GameMapDef) {
    this.width = mapDef.width;
    this.height = mapDef.height;
    this.cols = Math.ceil(mapDef.width / CELL);
    this.rows = Math.ceil(mapDef.height / CELL);
    this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
    for (const s of mapDef.solids) this.insert(s);
  }

  /**
   * Registers a solid that can later be removed again.
   *
   * Deployed barricades and sentry guns are real obstacles - they block
   * movement and bullets - but they come and go during a match. Both the
   * server and the client's prediction add and remove them here, so predicted
   * movement keeps agreeing with the server around a freshly placed defence.
   */
  addSolid(s: SolidDef): void {
    this.insert(s);
  }

  /** Removes a previously added solid. Safe to call for one never added. */
  removeSolid(s: SolidDef): void {
    const x0 = Math.max(0, Math.floor(s.rect.x / CELL));
    const y0 = Math.max(0, Math.floor(s.rect.y / CELL));
    const x1 = Math.min(this.cols - 1, Math.floor((s.rect.x + s.rect.w) / CELL));
    const y1 = Math.min(this.rows - 1, Math.floor((s.rect.y + s.rect.h) / CELL));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const bucket = this.buckets[y * this.cols + x];
        const i = bucket.indexOf(s);
        if (i >= 0) bucket.splice(i, 1);
      }
    }
  }

  private insert(s: SolidDef): void {
    const x0 = Math.max(0, Math.floor(s.rect.x / CELL));
    const y0 = Math.max(0, Math.floor(s.rect.y / CELL));
    const x1 = Math.min(this.cols - 1, Math.floor((s.rect.x + s.rect.w) / CELL));
    const y1 = Math.min(this.rows - 1, Math.floor((s.rect.y + s.rect.h) / CELL));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.buckets[y * this.cols + x].push(s);
    }
  }

  /** All solids whose bucket overlaps the query rect (may include duplicates-free set). */
  query(area: Rect): SolidDef[] {
    const x0 = Math.max(0, Math.floor(area.x / CELL));
    const y0 = Math.max(0, Math.floor(area.y / CELL));
    const x1 = Math.min(this.cols - 1, Math.floor((area.x + area.w) / CELL));
    const y1 = Math.min(this.rows - 1, Math.floor((area.y + area.h) / CELL));
    if (x1 < x0 || y1 < y0) return [];
    const seen = new Set<SolidDef>();
    const out: SolidDef[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (const s of this.buckets[y * this.cols + x]) {
          if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
          }
        }
      }
    }
    return out;
  }

  /** True when a circle at (x, y) overlaps any solid or leaves the world. */
  circleBlocked(x: number, y: number, r: number): boolean {
    if (x - r < 0 || y - r < 0 || x + r > this.width || y + r > this.height) return true;
    const near = this.query({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
    for (const s of near) {
      const cx = Math.max(s.rect.x, Math.min(x, s.rect.x + s.rect.w));
      const cy = Math.max(s.rect.y, Math.min(y, s.rect.y + s.rect.h));
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }

  /**
   * Pushes a circle out of anything it is currently overlapping.
   *
   * Nothing in normal movement puts an actor inside a wall, but a vehicle
   * shove, an explosion impulse or stepping out of a car parked against a
   * building all can - and once inside, every candidate position is blocked and
   * the player can never move again. This runs before each movement step so
   * that state is always recoverable.
   */
  resolvePenetration(x: number, y: number, r: number): { x: number; y: number } {
    let nx = x;
    let ny = y;

    // A few relaxation passes settle inside corners where two solids overlap.
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const s of this.query({ x: nx - r, y: ny - r, w: r * 2, h: r * 2 })) {
        const cx = Math.max(s.rect.x, Math.min(nx, s.rect.x + s.rect.w));
        const cy = Math.max(s.rect.y, Math.min(ny, s.rect.y + s.rect.h));
        let dx = nx - cx;
        let dy = ny - cy;
        let d = Math.hypot(dx, dy);

        if (d >= r) continue;
        if (d < 1e-6) {
          // Dead centre inside the solid: leave by the nearest face.
          const left = nx - s.rect.x;
          const right = s.rect.x + s.rect.w - nx;
          const top = ny - s.rect.y;
          const bottom = s.rect.y + s.rect.h - ny;
          const min = Math.min(left, right, top, bottom);
          if (min === left) { dx = -1; dy = 0; d = 0; nx = s.rect.x - r; }
          else if (min === right) { dx = 1; dy = 0; d = 0; nx = s.rect.x + s.rect.w + r; }
          else if (min === top) { dx = 0; dy = -1; d = 0; ny = s.rect.y - r; }
          else { dx = 0; dy = 1; d = 0; ny = s.rect.y + s.rect.h + r; }
          moved = true;
          continue;
        }
        const push = (r - d) + 0.01;
        nx += (dx / d) * push;
        ny += (dy / d) * push;
        moved = true;
      }
      if (!moved) break;
    }

    // Keep the actor inside the world regardless.
    nx = Math.max(r, Math.min(this.width - r, nx));
    ny = Math.max(r, Math.min(this.height - r, ny));
    return { x: nx, y: ny };
  }

  /**
   * Moves a circle from its current position by (dx, dy), sliding along solids.
   * Axis-separated resolution keeps movement smooth against building walls and
   * is cheap enough to run every predicted tick on the client.
   */
  moveCircle(
    x: number,
    y: number,
    r: number,
    dx: number,
    dy: number,
  ): { x: number; y: number; hitX: boolean; hitY: boolean } {
    // Recover first: if we start inside geometry every candidate below is
    // blocked, and the actor would be frozen in place forever.
    if (this.circleBlocked(x, y, r)) {
      const freed = this.resolvePenetration(x, y, r);
      x = freed.x;
      y = freed.y;
    }

    let nx = x;
    let ny = y;
    let hitX = false;
    let hitY = false;

    // Sub-step so fast movement cannot tunnel through thin walls.
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (r * 0.8)));
    const sx = dx / steps;
    const sy = dy / steps;

    for (let i = 0; i < steps; i++) {
      if (!this.circleBlocked(nx + sx, ny, r)) nx += sx;
      else hitX = true;
      if (!this.circleBlocked(nx, ny + sy, r)) ny += sy;
      else hitY = true;
    }
    return { x: nx, y: ny, hitX, hitY };
  }

  /**
   * Raycast against static solids. Returns the nearest hit fraction `t` in
   * [0,1] along the segment, or 1 when the ray reaches its end unobstructed.
   */
  raycast(x0: number, y0: number, x1: number, y1: number): number {
    const area: Rect = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    };
    let best = 1;
    for (const s of this.query(area)) {
      const t = segmentRect(x0, y0, x1, y1, s.rect);
      if (t !== null && t < best) best = t;
    }
    return best;
  }

  /** True when nothing static blocks the straight line between two points. */
  lineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.raycast(x0, y0, x1, y1) >= 1;
  }
}
