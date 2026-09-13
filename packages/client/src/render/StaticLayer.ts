import type { CollisionGrid, GameMapDef, Rect, SolidDef, ZoneDef } from '@gridlock/shared';
import { rectsOverlap } from '@gridlock/shared';
import { GROUND, BUILDING, PROP, ROAD } from './assets.js';

const CHUNK = 512;
const MAX_CACHED_CHUNKS = 96;

/** Stable pseudo-random in [0,1) from a pair of integers - no global RNG state. */
function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/**
 * Cached static-world renderer.
 *
 * The city is drawn once per 512x512 chunk into an offscreen canvas and then
 * blitted, so the ground, road markings and building detail can be as rich as
 * we like without costing anything per frame. Chunks are built on demand as the
 * camera reaches them and evicted least-recently-used, which keeps memory flat
 * even on the 5120x4096 map.
 */
export class StaticLayer {
  private chunks = new Map<string, HTMLCanvasElement>();
  private lru: string[] = [];

  private readonly roadsH: Rect[] = [];
  private readonly roadsV: Rect[] = [];
  private readonly junctions: Rect[] = [];
  private readonly groundZones: ZoneDef[] = [];

  constructor(
    private readonly map: GameMapDef,
    private readonly grid: CollisionGrid,
  ) {
    for (const z of map.zones) {
      if (z.kind === 'road') {
        (z.rect.w >= z.rect.h ? this.roadsH : this.roadsV).push(z.rect);
      } else {
        this.groundZones.push(z);
      }
    }
    // Junctions are where a horizontal and a vertical carriageway cross; they
    // get stop lines and crossings instead of lane dashes.
    for (const h of this.roadsH) {
      for (const v of this.roadsV) {
        if (!rectsOverlap(h, v)) continue;
        this.junctions.push({
          x: Math.max(h.x, v.x),
          y: Math.max(h.y, v.y),
          w: Math.min(h.x + h.w, v.x + v.w) - Math.max(h.x, v.x),
          h: Math.min(h.y + h.h, v.y + v.h) - Math.max(h.y, v.y),
        });
      }
    }
  }

  /** Blits every chunk overlapping the view rect. */
  drawInto(ctx: CanvasRenderingContext2D, view: Rect): void {
    const x0 = Math.floor(view.x / CHUNK);
    const y0 = Math.floor(view.y / CHUNK);
    const x1 = Math.floor((view.x + view.w) / CHUNK);
    const y1 = Math.floor((view.y + view.h) / CHUNK);

    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cy < 0) continue;
        if (cx * CHUNK >= this.map.width || cy * CHUNK >= this.map.height) continue;
        const chunk = this.chunk(cx, cy);
        ctx.drawImage(chunk, cx * CHUNK, cy * CHUNK);
      }
    }
  }

  private chunk(cx: number, cy: number): HTMLCanvasElement {
    const key = `${cx},${cy}`;
    const cached = this.chunks.get(key);
    if (cached) {
      // Touch for LRU.
      const i = this.lru.indexOf(key);
      if (i >= 0) this.lru.splice(i, 1);
      this.lru.push(key);
      return cached;
    }

    const canvas = document.createElement('canvas');
    canvas.width = CHUNK;
    canvas.height = CHUNK;
    const ctx = canvas.getContext('2d')!;
    this.paintChunk(ctx, cx, cy);

    this.chunks.set(key, canvas);
    this.lru.push(key);
    while (this.lru.length > MAX_CACHED_CHUNKS) {
      const evict = this.lru.shift();
      if (evict) this.chunks.delete(evict);
    }
    return canvas;
  }

  private paintChunk(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    const ox = cx * CHUNK;
    const oy = cy * CHUNK;
    const area: Rect = { x: ox - 8, y: oy - 8, w: CHUNK + 16, h: CHUNK + 16 };

    ctx.save();
    ctx.translate(-ox, -oy);

    // 1. Ground: base pavement, then district washes.
    ctx.fillStyle = GROUND.base;
    ctx.fillRect(ox, oy, CHUNK, CHUNK);
    for (const z of this.groundZones) {
      if (!rectsOverlap(z.rect, area)) continue;
      const style = GROUND.zones[z.kind];
      if (!style) continue;
      ctx.fillStyle = style.fill;
      ctx.fillRect(z.rect.x, z.rect.y, z.rect.w, z.rect.h);
    }

    // 2. Pavement slab grid over the whole chunk, then speckle grit.
    this.paveGrid(ctx, ox, oy);

    // 3. Water gets its own treatment before roads, so bridges sit on top.
    for (const z of this.groundZones) {
      if (z.kind !== 'water' || !rectsOverlap(z.rect, area)) continue;
      this.paintWater(ctx, z.rect, area);
    }

    // 4. Base plazas: team wash plus hazard chevrons at the threshold.
    for (const z of this.groundZones) {
      if (z.kind !== 'base' || !rectsOverlap(z.rect, area)) continue;
      this.paintBase(ctx, z);
    }

    // 5. Roads, then the lamps that light them.
    this.paintRoads(ctx, area);
    this.paintStreetFurniture(ctx, area);

    // 6. Geometry.
    for (const s of this.grid.query(area)) {
      if (s.kind === 'prop') this.paintProp(ctx, s);
    }
    for (const s of this.grid.query(area)) {
      if (s.kind === 'building') this.paintBuilding(ctx, s);
      else if (s.kind === 'wall') this.paintWall(ctx, s);
    }

    ctx.restore();
  }

  // -- ground ---------------------------------------------------------------

  private paveGrid(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
    const step = 64;
    ctx.save();
    ctx.strokeStyle = GROUND.slabLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox; x <= ox + CHUNK; x += step) {
      ctx.moveTo(x + 0.5, oy);
      ctx.lineTo(x + 0.5, oy + CHUNK);
    }
    for (let y = oy; y <= oy + CHUNK; y += step) {
      ctx.moveTo(ox, y + 0.5);
      ctx.lineTo(ox + CHUNK, y + 0.5);
    }
    ctx.stroke();

    // Grit speckle: cheap, deterministic, and it stops large flats reading flat.
    ctx.fillStyle = GROUND.grit;
    for (let i = 0; i < 260; i++) {
      const rx = hash2(ox + i, oy);
      const ry = hash2(oy + i, ox + 7);
      const size = hash2(i, ox + oy) > 0.86 ? 2 : 1;
      ctx.fillRect(ox + rx * CHUNK, oy + ry * CHUNK, size, size);
    }
    ctx.restore();
  }

  private paintWater(ctx: CanvasRenderingContext2D, r: Rect, area: Rect): void {
    ctx.save();
    ctx.fillStyle = GROUND.zones.water.fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);

    // Quay edging so the waterline reads as a hard edge, not a colour change.
    ctx.strokeStyle = GROUND.quay;
    ctx.lineWidth = 6;
    ctx.strokeRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);

    ctx.strokeStyle = GROUND.ripple;
    ctx.lineWidth = 2;
    const x0 = Math.max(r.x + 10, area.x);
    const x1 = Math.min(r.x + r.w - 10, area.x + area.w);
    for (let y = r.y + 18; y < r.y + r.h - 10; y += 26) {
      const jitter = hash2(y, r.x) * 22;
      ctx.beginPath();
      ctx.moveTo(Math.max(x0, x0 + jitter), y);
      ctx.lineTo(Math.min(x1, x0 + jitter + 40 + hash2(r.x, y) * 60), y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintBase(ctx: CanvasRenderingContext2D, z: ZoneDef): void {
    const r = z.rect;
    const color = z.team !== undefined ? GROUND.teamTint[z.team % 4] : '#888';
    ctx.save();
    // A restrained wash: enough to own the ground without drowning the actors.
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = color;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;

    // Painted boundary marking the protected spawn zone.
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash([22, 18]);
    ctx.strokeRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Parking bays along the top edge and a loading square in the middle.
    ctx.strokeStyle = GROUND.bayLine;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    for (let x = r.x + 34; x < r.x + r.w - 24; x += 44) {
      ctx.beginPath();
      ctx.moveTo(x, r.y + 16);
      ctx.lineTo(x, r.y + 54);
      ctx.stroke();
    }
    ctx.setLineDash([10, 10]);
    ctx.strokeRect(r.x + r.w * 0.3, r.y + r.h * 0.45, r.w * 0.4, r.h * 0.35);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private paintRoads(ctx: CanvasRenderingContext2D, area: Rect): void {
    const all = [...this.roadsH, ...this.roadsV];

    // Carriageway.
    ctx.fillStyle = ROAD.asphalt;
    for (const r of all) {
      if (!rectsOverlap(r, area)) continue;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }

    // Kerbs along both long edges.
    ctx.strokeStyle = ROAD.kerb;
    ctx.lineWidth = 3;
    for (const r of all) {
      if (!rectsOverlap(r, area)) continue;
      ctx.beginPath();
      if (r.w >= r.h) {
        ctx.moveTo(r.x, r.y + 1.5);
        ctx.lineTo(r.x + r.w, r.y + 1.5);
        ctx.moveTo(r.x, r.y + r.h - 1.5);
        ctx.lineTo(r.x + r.w, r.y + r.h - 1.5);
      } else {
        ctx.moveTo(r.x + 1.5, r.y);
        ctx.lineTo(r.x + 1.5, r.y + r.h);
        ctx.moveTo(r.x + r.w - 1.5, r.y);
        ctx.lineTo(r.x + r.w - 1.5, r.y + r.h);
      }
      ctx.stroke();
    }

    // Asphalt wear: darker patches so long roads are not uniform.
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = ROAD.wear;
    for (const r of all) {
      if (!rectsOverlap(r, area)) continue;
      const along = r.w >= r.h ? r.w : r.h;
      for (let d = 0; d < along; d += 180) {
        const h1 = hash2(r.x + d, r.y);
        if (h1 < 0.55) continue;
        if (r.w >= r.h) ctx.fillRect(r.x + d, r.y + 6 + h1 * 20, 90 + h1 * 60, 14);
        else ctx.fillRect(r.x + 6 + h1 * 20, r.y + d, 14, 90 + h1 * 60);
      }
    }
    ctx.restore();

    // Lane dashes, broken at junctions.
    ctx.strokeStyle = ROAD.laneLine;
    ctx.lineWidth = 3;
    ctx.setLineDash([28, 34]);
    for (const r of all) {
      if (!rectsOverlap(r, area)) continue;
      ctx.beginPath();
      if (r.w >= r.h) {
        const y = r.y + r.h / 2;
        ctx.moveTo(Math.max(r.x, area.x), y);
        ctx.lineTo(Math.min(r.x + r.w, area.x + area.w), y);
      } else {
        const x = r.x + r.w / 2;
        ctx.moveTo(x, Math.max(r.y, area.y));
        ctx.lineTo(x, Math.min(r.y + r.h, area.y + area.h));
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Junctions: clear the dashes, then paint crossings on each approach.
    for (const j of this.junctions) {
      if (!rectsOverlap(j, area)) continue;
      ctx.fillStyle = ROAD.asphalt;
      ctx.fillRect(j.x, j.y, j.w, j.h);
      this.paintCrossing(ctx, j);
    }
  }

  private paintCrossing(ctx: CanvasRenderingContext2D, j: Rect): void {
    const band = 16;
    const gap = 11;
    ctx.save();
    ctx.fillStyle = ROAD.paint;

    // North and south approaches: vertical stripes.
    for (let x = j.x + 6; x < j.x + j.w - 8; x += gap + 5) {
      ctx.fillRect(x, j.y - band - 2, 6, band);
      ctx.fillRect(x, j.y + j.h + 2, 6, band);
    }
    // East and west approaches: horizontal stripes.
    for (let y = j.y + 6; y < j.y + j.h - 8; y += gap + 5) {
      ctx.fillRect(j.x - band - 2, y, band, 6);
      ctx.fillRect(j.x + j.w + 2, y, band, 6);
    }

    // Drain covers in the corners.
    ctx.fillStyle = ROAD.drain;
    for (const [dx, dy] of [[6, 6], [j.w - 14, 6], [6, j.h - 14], [j.w - 14, j.h - 14]]) {
      ctx.fillRect(j.x + dx, j.y + dy, 8, 8);
    }
    ctx.restore();
  }

  // -- geometry -------------------------------------------------------------

  private paintProp(ctx: CanvasRenderingContext2D, s: SolidDef): void {
    const r = s.rect;
    ctx.save();
    // Contact shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(r.x + 4, r.y + 5, r.w, r.h);

    ctx.fillStyle = PROP.fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    // Lit top-left edge, dark bottom-right edge: instant readable volume.
    ctx.fillStyle = PROP.lit;
    ctx.fillRect(r.x, r.y, r.w, 3);
    ctx.fillRect(r.x, r.y, 3, r.h);
    ctx.fillStyle = PROP.shade;
    ctx.fillRect(r.x, r.y + r.h - 3, r.w, 3);
    ctx.fillRect(r.x + r.w - 3, r.y, 3, r.h);

    ctx.strokeStyle = PROP.edge;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);

    // Crate banding.
    ctx.strokeStyle = PROP.band;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r.x + r.w * 0.5, r.y + 4);
    ctx.lineTo(r.x + r.w * 0.5, r.y + r.h - 4);
    ctx.stroke();
    ctx.restore();
  }

  private paintWall(ctx: CanvasRenderingContext2D, s: SolidDef): void {
    const r = s.rect;
    ctx.fillStyle = BUILDING.wallSolid;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  /**
   * Buildings are drawn as a footprint plus extruded side faces and a detailed
   * roof, all offset away from the map centre. That single trick is what makes
   * a flat top-down city read as a city of solid blocks.
   */
  private paintBuilding(ctx: CanvasRenderingContext2D, s: SolidDef): void {
    const r = s.rect;
    const storeys = Math.max(1, s.height ?? 1);
    const cx = this.map.width / 2;
    const cy = this.map.height / 2;

    const bx = r.x + r.w / 2;
    const by = r.y + r.h / 2;
    let dx = (bx - cx) / Math.max(1, cx);
    let dy = (by - cy) / Math.max(1, cy);
    const mag = Math.hypot(dx, dy) || 1;
    // Normalise so buildings near the centre still get a little extrusion.
    dx = (dx / mag) * Math.min(1, mag * 1.8 + 0.25);
    dy = (dy / mag) * Math.min(1, mag * 1.8 + 0.25);

    const lift = storeys * BUILDING.storeyOffset;
    const ex = dx * lift;
    const ey = dy * lift;

    const seed = hash2(r.x, r.y);
    const roof = BUILDING.roofs[Math.floor(seed * BUILDING.roofs.length)];

    ctx.save();

    // Ground shadow, cast opposite the extrusion.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(r.x - ex * 0.35, r.y - ey * 0.35, r.w, r.h);

    // Footprint.
    ctx.fillStyle = BUILDING.footprint;
    ctx.fillRect(r.x, r.y, r.w, r.h);

    // Side faces with window rows.
    this.paintFaces(ctx, r, ex, ey, storeys, seed);

    // Roof slab.
    const rx = r.x + ex;
    const ry = r.y + ey;
    ctx.fillStyle = roof.fill;
    ctx.fillRect(rx, ry, r.w, r.h);

    // Parapet: lit and shaded edges.
    ctx.fillStyle = roof.lit;
    ctx.fillRect(rx, ry, r.w, 3);
    ctx.fillRect(rx, ry, 3, r.h);
    ctx.fillStyle = roof.shade;
    ctx.fillRect(rx, ry + r.h - 3, r.w, 3);
    ctx.fillRect(rx + r.w - 3, ry, 3, r.h);
    ctx.strokeStyle = BUILDING.outline;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx + 0.5, ry + 0.5, r.w - 1, r.h - 1);

    this.paintRoofDetail(ctx, { x: rx, y: ry, w: r.w, h: r.h }, seed, roof);
    ctx.restore();
  }

  private paintFaces(
    ctx: CanvasRenderingContext2D,
    r: Rect,
    ex: number,
    ey: number,
    storeys: number,
    seed: number,
  ): void {
    const face = (pts: [number, number][], fill: string): void => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fill();
    };

    const right = r.x + r.w;
    const bottom = r.y + r.h;

    if (ex > 0.5) {
      face([[right, r.y], [right + ex, r.y + ey], [right + ex, bottom + ey], [right, bottom]],
        BUILDING.faceSide);
      this.paintWindows(ctx, right, r.y, ex, ey, r.h, storeys, seed, true);
    } else if (ex < -0.5) {
      face([[r.x, r.y], [r.x + ex, r.y + ey], [r.x + ex, bottom + ey], [r.x, bottom]],
        BUILDING.faceSide);
      this.paintWindows(ctx, r.x, r.y, ex, ey, r.h, storeys, seed, true);
    }

    if (ey > 0.5) {
      face([[r.x, bottom], [r.x + ex, bottom + ey], [right + ex, bottom + ey], [right, bottom]],
        BUILDING.faceFront);
      this.paintWindows(ctx, r.x, bottom, ex, ey, r.w, storeys, seed, false);
    } else if (ey < -0.5) {
      face([[r.x, r.y], [r.x + ex, r.y + ey], [right + ex, r.y + ey], [right, r.y]],
        BUILDING.faceFront);
      this.paintWindows(ctx, r.x, r.y, ex, ey, r.w, storeys, seed, false);
    }
  }

  /** Lit window rows along an extruded face - the main "this is a tower" cue. */
  private paintWindows(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    ex: number, ey: number,
    span: number,
    storeys: number,
    seed: number,
    vertical: boolean,
  ): void {
    const rows = Math.max(1, Math.min(4, storeys));
    ctx.save();
    for (let row = 0; row < rows; row++) {
      const t = (row + 0.6) / (rows + 0.2);
      for (let d = 10; d < span - 8; d += 14) {
        const lit = hash2(Math.round(x + d), Math.round(y + row * 31 + seed * 100));
        if (lit < 0.42) continue;
        ctx.fillStyle = lit > 0.9 ? BUILDING.windowBright : BUILDING.windowLit;
        if (vertical) ctx.fillRect(x + ex * t - 2, y + d + ey * t, 4, 6);
        else ctx.fillRect(x + d + ex * t, y + ey * t - 2, 6, 4);
      }
    }
    ctx.restore();
  }

  private paintRoofDetail(
    ctx: CanvasRenderingContext2D,
    r: Rect,
    seed: number,
    roof: { fill: string; lit: string; shade: string; detail: string },
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
    ctx.clip();

    // Gravel texture: a scatter of dark flecks so no roof is a flat colour.
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    const flecks = Math.min(120, Math.floor((r.w * r.h) / 90));
    for (let i = 0; i < flecks; i++) {
      const fx = r.x + hash2(r.x + i * 3, r.y + i) * r.w;
      const fy = r.y + hash2(r.y + i, r.x + i * 5) * r.h;
      ctx.fillRect(fx, fy, 2, 2);
    }

    if (r.w < 44 || r.h < 44) {
      ctx.restore();
      return;
    }

    // A roof-edge walkway inset, which reads as a parapet from above.
    ctx.strokeStyle = roof.shade;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x + 7.5, r.y + 7.5, r.w - 15, r.h - 15);

    // Plant: vents, water tanks, skylights and a stair head.
    const units = 2 + Math.floor(seed * 3);
    for (let i = 0; i < units; i++) {
      const ux = r.x + 12 + hash2(r.x + i * 13, r.y + i) * Math.max(1, r.w - 46);
      const uy = r.y + 12 + hash2(r.y + i * 7, r.x + i) * Math.max(1, r.h - 46);
      const kind = hash2(i * 31, r.x + r.y);

      if (kind < 0.34) {
        // Air-handling box.
        const uw = 14 + hash2(i, r.x) * 16;
        const uh = 10 + hash2(r.y, i) * 12;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(ux + 3, uy + 4, uw, uh);
        ctx.fillStyle = roof.detail;
        ctx.fillRect(ux, uy, uw, uh);
        ctx.fillStyle = roof.lit;
        ctx.fillRect(ux, uy, uw, 2.5);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        for (let g = 3; g < uw - 2; g += 4) {
          ctx.beginPath();
          ctx.moveTo(ux + g, uy + 3);
          ctx.lineTo(ux + g, uy + uh - 2);
          ctx.stroke();
        }
      } else if (kind < 0.6) {
        // Water tank: a circle with a shadow.
        const rad = 6 + hash2(i, r.y) * 6;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath();
        ctx.arc(ux + rad + 3, uy + rad + 4, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = roof.detail;
        ctx.beginPath();
        ctx.arc(ux + rad, uy + rad, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = roof.lit;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ux + rad, uy + rad, rad * 0.55, 0, Math.PI * 2);
        ctx.stroke();
      } else if (kind < 0.82) {
        // Skylight: a lit panel, the strongest "this roof is inhabited" cue.
        const uw = 12 + hash2(i, r.x + 3) * 14;
        const uh = 9 + hash2(i, r.y + 3) * 10;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(ux + 2, uy + 3, uw, uh);
        ctx.fillStyle = hash2(i, r.x + r.y) > 0.45
          ? 'rgba(255,214,150,0.42)'
          : 'rgba(150,180,220,0.16)';
        ctx.fillRect(ux, uy, uw, uh);
        ctx.strokeStyle = roof.shade;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ux + 0.5, uy + 0.5, uw - 1, uh - 1);
      } else {
        // Stair head with a door.
        const uw = 16 + hash2(i, r.x) * 8;
        const uh = 14 + hash2(i, r.y) * 6;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(ux + 3, uy + 4, uw, uh);
        ctx.fillStyle = roof.shade;
        ctx.fillRect(ux, uy, uw, uh);
        ctx.fillStyle = roof.lit;
        ctx.fillRect(ux, uy, uw, 2.5);
        ctx.fillStyle = '#1a1512';
        ctx.fillRect(ux + uw * 0.3, uy + uh - 6, uw * 0.4, 6);
      }
    }
    ctx.restore();
  }

  /**
   * Street lamps along every carriageway.
   *
   * Warm pools of light are what turn a grey road grid into a night city, and
   * they cost nothing at runtime because they are baked into the chunk.
   */
  private paintStreetFurniture(ctx: CanvasRenderingContext2D, area: Rect): void {
    const spacing = 300;
    ctx.save();
    for (const r of [...this.roadsH, ...this.roadsV]) {
      if (!rectsOverlap(r, area)) continue;
      const horizontal = r.w >= r.h;
      const along = horizontal ? r.w : r.h;
      const start = horizontal ? r.x : r.y;

      for (let d = spacing / 2; d < along; d += spacing) {
        // Alternate sides so lamps stagger down the street instead of pairing.
        const sides = hash2(Math.round(start + d), Math.round(r.x + r.y)) > 0.5 ? [0] : [1];
        for (const side of sides) {
          const lx = horizontal
            ? start + d
            : r.x + (side === 0 ? -4 : r.w + 4);
          const ly = horizontal
            ? r.y + (side === 0 ? -4 : r.h + 4)
            : start + d;
          if (lx < area.x - 60 || lx > area.x + area.w + 60) continue;
          if (ly < area.y - 60 || ly > area.y + area.h + 60) continue;

          // A tight pool, not a floodlight: enough to warm the kerb line.
          const glow = ctx.createRadialGradient(lx, ly, 2, lx, ly, 46);
          glow.addColorStop(0, GROUND.lampGlow);
          glow.addColorStop(1, 'rgba(255,206,140,0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(lx, ly, 46, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = GROUND.lampPost;
          ctx.fillRect(lx - 2.5, ly - 2.5, 5, 5);
          ctx.fillStyle = GROUND.lampHead;
          ctx.fillRect(lx - 1.5, ly - 1.5, 3, 3);
        }
      }
    }
    ctx.restore();
  }

  /** Drops every cached chunk, e.g. after a quality change. */
  invalidate(): void {
    this.chunks.clear();
    this.lru.length = 0;
  }
}
