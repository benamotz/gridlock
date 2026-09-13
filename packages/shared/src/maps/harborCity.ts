import type { Rect } from '../math.js';
import { pointInRect } from '../math.js';
import type { GameMapDef, ZoneKind } from '../types.js';
import { MapBuilder } from './builder.js';

const W = 5120;
const H = 4096;
const AVENUE = 640; // spacing of north-south avenues
const STREET = 512; // spacing of east-west streets
const ROAD_W = 112;
const CANAL_X = 2560; // avenue 4 is replaced by a canal
const CANAL_W = 150;

const DISTRICTS: { kind: ZoneKind; rect: Rect; label: string; density: number }[] = [
  { kind: 'downtown', rect: { x: 1280, y: 1024, w: 1280, h: 2048 }, label: 'Ironmarket', density: 7 },
  { kind: 'residential', rect: { x: 2660, y: 0, w: 2460, h: 1536 }, label: 'Northrow', density: 4 },
  { kind: 'industrial', rect: { x: 0, y: 2048, w: 1280, h: 2048 }, label: 'Foundry Flats', density: 3 },
  { kind: 'park', rect: { x: 2660, y: 2048, w: 1540, h: 1536 }, label: 'Kettle Green', density: 0 },
];

const HARBOR: Rect = { x: 4180, y: 2180, w: 940, h: 840 };

/** Base plazas are kept clear of generated buildings. */
const BASES: { team: number; rect: Rect; label: string }[] = [
  { team: 0, rect: { x: 180, y: 180, w: 460, h: 360 }, label: 'Northgate Yard' },
  { team: 1, rect: { x: W - 640, y: H - 540, w: 460, h: 360 }, label: 'Southpier Lot' },
  { team: 2, rect: { x: W - 640, y: 180, w: 460, h: 360 }, label: 'Eastline Depot' },
  { team: 3, rect: { x: 180, y: H - 540, w: 460, h: 360 }, label: 'Westend Works' },
];

const districtAt = (x: number, y: number) =>
  DISTRICTS.find((d) => pointInRect(x, y, d.rect));

const inHarbor = (r: Rect) =>
  r.x < HARBOR.x + HARBOR.w && r.x + r.w > HARBOR.x &&
  r.y < HARBOR.y + HARBOR.h && r.y + r.h > HARBOR.y;

const BASE_CLEARANCE = 18;

const inAnyBase = (r: Rect) =>
  BASES.some((bs) =>
    r.x < bs.rect.x + bs.rect.w + BASE_CLEARANCE &&
    r.x + r.w > bs.rect.x - BASE_CLEARANCE &&
    r.y < bs.rect.y + bs.rect.h + BASE_CLEARANCE &&
    r.y + r.h > bs.rect.y - BASE_CLEARANCE);

/**
 * "Harbor Reach" - the large city map.
 *
 * Assembled procedurally from a road grid plus district descriptors, so the
 * whole 5120x4096 world is a few hundred rectangles rather than a megabyte of
 * tile data. A canal splits the city into two halves joined by eight bridges,
 * which produces natural chokepoints and long avenues for vehicle chases.
 */
export function buildHarborCity(): GameMapDef {
  const b = new MapBuilder(W, H, 0x9a71c);

  // Ground: sidewalk everywhere, districts painted on top, then roads.
  b.zone('sidewalk', { x: 0, y: 0, w: W, h: H });
  for (const d of DISTRICTS) b.zone(d.kind, d.rect, d.label);
  b.zone('water', HARBOR, 'The Reach');

  for (let x = 0; x <= W; x += AVENUE) {
    if (x === CANAL_X) continue;
    b.zone('road', { x: x - ROAD_W / 2, y: 0, w: ROAD_W, h: H });
  }
  for (let y = 0; y <= H; y += STREET) {
    b.zone('road', { x: 0, y: y - ROAD_W / 2, w: W, h: ROAD_W });
  }

  // Canal with bridges at every east-west street.
  b.zone('water', { x: CANAL_X - CANAL_W / 2, y: 0, w: CANAL_W, h: H }, 'Mill Canal');
  for (let y = 0; y <= H; y += STREET) {
    b.zone('road', { x: CANAL_X - CANAL_W / 2, y: y - ROAD_W / 2, w: CANAL_W, h: ROAD_W });
  }
  // Water is solid: the segments between bridges block movement and bullets.
  for (let y = 0; y < H; y += STREET) {
    const top = y + ROAD_W / 2;
    const bottom = y + STREET - ROAD_W / 2;
    if (bottom > top) {
      b.wall({ x: CANAL_X - CANAL_W / 2, y: top, w: CANAL_W, h: bottom - top });
    }
  }
  b.wall(HARBOR);

  for (const bs of BASES) {
    b.zone('base', { ...bs.rect, x: bs.rect.x - 40, y: bs.rect.y - 40, w: bs.rect.w + 80, h: bs.rect.h + 80 }, bs.label, bs.team);
  }

  // Fill each city block.
  for (let bx = 0; bx < W; bx += AVENUE) {
    for (let by = 0; by < H; by += STREET) {
      const rect: Rect = {
        x: bx + ROAD_W / 2 + 14,
        y: by + ROAD_W / 2 + 14,
        w: AVENUE - ROAD_W - 28,
        h: STREET - ROAD_W - 28,
      };
      if (rect.w <= 0 || rect.h <= 0) continue;
      if (inHarbor(rect) || inAnyBase(rect)) continue;

      // Clip the block back from the canal rather than discarding it, so the
      // waterfront still gets buildings instead of two empty columns.
      const canalL = CANAL_X - CANAL_W / 2;
      const canalR = CANAL_X + CANAL_W / 2;
      if (rect.x < canalR && rect.x + rect.w > canalL) {
        if (rect.x + rect.w / 2 < CANAL_X) rect.w = canalL - 24 - rect.x;
        else {
          const shift = canalR + 24 - rect.x;
          rect.x += shift;
          rect.w -= shift;
        }
        if (rect.w < 110) continue;
      }

      const d = districtAt(rect.x + rect.w / 2, rect.y + rect.h / 2);
      if (!d) {
        // Outskirts: sparse low buildings.
        b.cityBlock(rect, { density: 2, alley: 46, minSize: 90 });
        continue;
      }
      if (d.kind === 'park') {
        // Open combat area: only scattered cover.
        for (let i = 0; i < 3; i++) {
          const s = 34 + b.rng() * 26;
          b.prop({
            x: rect.x + b.rng() * (rect.w - s),
            y: rect.y + b.rng() * (rect.h - s),
            w: s, h: s,
          });
        }
        continue;
      }
      b.cityBlock(rect, {
        density: d.density,
        alley: d.kind === 'downtown' ? 40 : 56,
        minSize: d.kind === 'industrial' ? 130 : 84,
      });
    }
  }

  // Mixed traffic parked along the major avenues - the type is rolled from the
  // spawn weights, so most finds are ordinary cars and a motorcycle or an
  // armored carrier is a genuine prize.
  for (let x = AVENUE; x < W; x += AVENUE) {
    if (x === CANAL_X) continue;
    for (let y = STREET; y < H; y += STREET * 2) {
      // Parked facing the middle of the map, so forward drives into play.
      const vy = y + STREET / 2;
      // Two avenues run along base plazas. Never park traffic across one:
      // players spawn there, and spawn selection does not know about vehicles.
      if (inAnyBase({ x: x - 40, y: vy - 70, w: 80, h: 140 })) continue;
      b.vehicle(x, vy, vy < H / 2 ? Math.PI / 2 : -Math.PI / 2);
    }
  }
  // A truck at each end of the central east-west route - the base-breakers.
  b.vehicle(AVENUE, H / 2 + 40, Math.PI / 2, 'truck');
  b.vehicle(W - AVENUE, H / 2 + 40, Math.PI / 2, 'truck');
  // Prizes in the open, worth the run across exposed ground.
  b.vehicle(3430, 2600, 0, 'sports');
  b.vehicle(3430, 3000, 0, 'armored');
  b.vehicle(1920, 2300, Math.PI, 'motorcycle');

  // Every base gets a squad van plus a motorcycle, so a team can move out
  // together or a lone player can go scouting.
  for (const bs of BASES) {
    // Face the map centre: the eastern bases previously parked facing the
    // boundary wall, so pressing forward drove straight into it.
    const cx = bs.rect.x + bs.rect.w / 2;
    const towardCentre = cx < W / 2 ? 1 : -1;
    const heading = towardCentre > 0 ? 0 : Math.PI;

    if (bs.rect.y > H / 2) {
      // Southern plazas have clear kerb below them.
      const y = bs.rect.y + bs.rect.h + 90;
      b.vehicle(cx, y, heading, 'van');
      b.vehicle(cx, y - 58, heading, 'motorcycle');
    } else {
      // Northern plazas back onto a street with a city block beyond it, so
      // "below the plaza" is inside a building and both vehicles were being
      // removed by spawn validation - those bases had no vehicles at all.
      // Park on that street instead, just past the plaza's inner edge and
      // outside the spawn zone: van in one lane, motorcycle in the other.
      const edge = towardCentre > 0 ? bs.rect.x + bs.rect.w : bs.rect.x;
      const x = edge + towardCentre * 78;
      b.vehicle(x, STREET - 22, heading, 'van');
      b.vehicle(x, STREET + 28, heading, 'motorcycle');
    }
  }

  // Pickups at street intersections, weighted toward the contested middle.
  for (let x = AVENUE; x < W; x += AVENUE) {
    for (let y = STREET; y < H; y += STREET) {
      if (Math.abs(x - CANAL_X) < CANAL_W) continue;
      if (pointInRect(x, y, HARBOR)) continue;
      const centrality =
        1 - (Math.abs(x - W / 2) / (W / 2) + Math.abs(y - H / 2) / (H / 2)) / 2;
      const roll = b.rng();
      if (roll < 0.30) b.ammoPickup(x, y);
      else if (roll < 0.55) b.weaponPickup(x, y, undefined, centrality > 0.6 ? 3 : 2);
      else if (roll < 0.72) b.healthPickup(x, y);
      else if (roll < 0.80) b.armorPickup(x, y);
    }
  }
  // Depot furniture inside each plaza: crates for cover, kept clear of the
  // spawn strip along the left edge so nobody spawns inside a container.
  for (const bs of BASES) {
    const r = bs.rect;
    b.prop({ x: r.x + r.w * 0.52, y: r.y + 26, w: 62, h: 42 });
    b.prop({ x: r.x + r.w * 0.34, y: r.y + r.h - 74, w: 46, h: 46 });
    b.prop({ x: r.x + r.w - 76, y: r.y + r.h * 0.36, w: 44, h: 62 });
  }

  // Guaranteed sidearm and health inside each base plaza.
  for (const bs of BASES) {
    b.weaponPickup(bs.rect.x + 70, bs.rect.y + bs.rect.h / 2, 'pistol');
    b.healthPickup(bs.rect.x + bs.rect.w - 70, bs.rect.y + bs.rect.h / 2);
    b.ammoPickup(bs.rect.x + bs.rect.w / 2, bs.rect.y + bs.rect.h - 60);
  }
  // A high-tier prize in the park to pull players into open ground.
  b.weaponPickup(3430, 2816, 'launcher');
  b.weaponPickup(1920, 2048, 'marksman');

  b.borderWalls();
  b.pruneBlockedSpawns();

  return {
    id: 'harbor-reach',
    name: 'Harbor Reach',
    width: W,
    height: H,
    tileSize: 32,
    zones: b.zones,
    solids: b.solids,
    teamSpawns: BASES.map((bs) => ({ team: bs.team, zone: bs.rect })),
    vehicleSpawns: b.vehicleSpawns,
    pickupSpawns: b.pickupSpawns,
    flagBases: BASES.map((bs) => ({
      team: bs.team,
      x: bs.rect.x + bs.rect.w / 2,
      y: bs.rect.y + bs.rect.h / 2,
      captureRadius: 80,
    })),
    safeZone: { x: 3200, y: 2400, startRadius: 3000 },
    modes: ['tdm', 'ctf', 'br'],
    recommendedPlayers: 16,
    maxTeams: 4,
  };
}
