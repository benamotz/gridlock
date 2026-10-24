import type { Rect } from '../math.js';
import { pointInRect } from '../math.js';
import type { GameMapDef, RoadGraph, ServiceDef, ShopItemId, ZoneKind } from '../types.js';
import { MapBuilder } from './builder.js';

const W = 16384;
const H = 12288;

/** The river runs the full height of the region, between the two northern towns. */
const RIVER: Rect = { x: 8576, y: 0, w: 256, h: H };
/** Sea along the west coast and the south shore, with a beach before it. */
const WEST_SEA: Rect = { x: 0, y: 0, w: 448, h: H };
const SOUTH_SEA: Rect = { x: 448, y: 11840, w: W - 448, h: H - 11840 };
const BEACH: Rect = { x: 448, y: 11328, w: W - 448, h: 512 };

const HIGHWAY_W = 160;
/** Highway points are spaced so police and traffic can always find one nearby. */
const HIGHWAY_NODE_STEP = 512;

interface TownSpec {
  name: string;
  rect: Rect;
  avenue: number;
  street: number;
  roadW: number;
  ground: ZoneKind;
  density: number;
  alley: number;
  minSize: number;
  /** Chance a block is left open as a park or yard. */
  park: number;
}

/**
 * Town grids are aligned so the highways meet a real intersection at each end:
 * Harborside and Ironvale share streets at y=2560 and y=4096, Harborside and
 * Sandmere share the avenue at x=4864, Ironvale and Sandmere the one at x=11008.
 */
const TOWNS: TownSpec[] = [
  {
    name: 'Harborside',
    rect: { x: 1024, y: 1024, w: 5120, h: 4096 },
    avenue: 640, street: 512, roadW: 112,
    ground: 'downtown', density: 6, alley: 44, minSize: 84, park: 0.06,
  },
  {
    name: 'Ironvale',
    rect: { x: 10240, y: 1024, w: 4608, h: 4608 },
    avenue: 768, street: 768, roadW: 112,
    ground: 'industrial', density: 3, alley: 60, minSize: 140, park: 0.05,
  },
  {
    name: 'Sandmere',
    rect: { x: 4096, y: 7680, w: 7680, h: 3200 },
    avenue: 768, street: 640, roadW: 112,
    ground: 'residential', density: 2, alley: 70, minSize: 100, park: 0.14,
  },
];

/**
 * Where each town's businesses are, by block: `col`/`row` count avenues and
 * streets from the town's north-west corner, and the service sits mid-block.
 * Vehicle services (chop shop, respray) sit on the street itself so a car can
 * pull in; the rest sit on the kerb. Columns that would land on the river are
 * avoided by hand.
 */
interface ServicePlan {
  kind: ServiceDef['kind'];
  col: number;
  row: number;
  /** A shop's counters, one per item, side by side along the kerb. */
  items?: ShopItemId[];
}

const TOWN_SERVICES: ServicePlan[][] = [
  [
    { kind: 'chopshop', col: 1, row: 6 },
    { kind: 'respray', col: 6, row: 2 },
    { kind: 'store', col: 2, row: 2 },
    { kind: 'store', col: 5, row: 5 },
    { kind: 'shop', col: 3, row: 4, items: ['smg', 'shotgun', 'armor', 'medkit', 'phone'] },
    { kind: 'phone', col: 1, row: 1 },
    { kind: 'phone', col: 4, row: 3 },
    { kind: 'phone', col: 7, row: 7 },
  ],
  [
    { kind: 'chopshop', col: 2, row: 4 },
    { kind: 'respray', col: 4, row: 1 },
    { kind: 'store', col: 1, row: 2 },
    { kind: 'shop', col: 3, row: 3, items: ['smg', 'shotgun', 'rifle', 'armor', 'phone'] },
    { kind: 'phone', col: 5, row: 5 },
    { kind: 'phone', col: 2, row: 1 },
  ],
  [
    { kind: 'chopshop', col: 8, row: 3 },
    { kind: 'respray', col: 2, row: 2 },
    { kind: 'store', col: 3, row: 4 },
    { kind: 'store', col: 9, row: 1 },
    { kind: 'shop', col: 1, row: 3, items: ['smg', 'armor', 'medkit', 'phone'] },
    { kind: 'phone', col: 4, row: 1 },
    { kind: 'phone', col: 8, row: 4 },
  ],
];

function buildServices(): ServiceDef[] {
  const out: ServiceDef[] = [];
  TOWNS.forEach((t, town) => {
    for (const plan of TOWN_SERVICES[town]) {
      const x = t.rect.x + plan.col * t.avenue + t.avenue / 2;
      const street = t.rect.y + plan.row * t.street;
      const onRoad = plan.kind === 'chopshop' || plan.kind === 'respray';
      // The pavement strip is too narrow to stand a booth on, so kerb services
      // sit at the road's edge; their trigger reaches across the pavement.
      const y = onRoad ? street : street + t.roadW / 2 - 16;
      const id = `${plan.kind}-${town}-${plan.col}-${plan.row}`;
      if (plan.items) {
        plan.items.forEach((item, i) => {
          const offset = (i - (plan.items!.length - 1) / 2) * 76;
          out.push({ id: `${id}-${item}`, kind: plan.kind, x: x + offset, y, r: 30, town, item });
        });
      } else {
        out.push({ id, kind: plan.kind, x, y, r: onRoad ? 70 : 40, town });
      }
    }
  });
  return out;
}

/** Straight, axis-aligned highways between town edge intersections. */
const HIGHWAYS: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [
  { a: { x: 6144, y: 2560 }, b: { x: 10240, y: 2560 } },
  { a: { x: 6144, y: 4096 }, b: { x: 10240, y: 4096 } },
  { a: { x: 4864, y: 5120 }, b: { x: 4864, y: 7680 } },
  { a: { x: 11008, y: 5632 }, b: { x: 11008, y: 7680 } },
];

const overlaps = (a: Rect, b: Rect, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w > b.x - pad &&
  a.y < b.y + b.h + pad && a.y + a.h > b.y - pad;

const inRiverColumn = (x: number) => x > RIVER.x - 40 && x < RIVER.x + RIVER.w + 40;

/**
 * "Kestrel Region" - the free-roam world.
 *
 * Three towns with their own character, joined by highways across open
 * country and a river, so a chase can leave town and a getaway means getting
 * somewhere. About nine times the area of Harbor Reach, built from the same
 * procedural pieces: a few thousand rectangles, not tile data.
 */
export function buildRegion(): GameMapDef {
  const b = new MapBuilder(W, H, 0x6e57);
  const roadRects: Rect[] = [];
  const road = (r: Rect) => {
    b.zone('road', r);
    roadRects.push(r);
  };

  // Ground: open country, then the coast, then each town paved over it.
  b.zone('grass', { x: 0, y: 0, w: W, h: H });
  b.zone('sand', BEACH);
  b.zone('water', WEST_SEA, 'Western Sound');
  b.zone('water', SOUTH_SEA, 'Gull Bay');
  b.zone('water', RIVER, 'Kestrel River');
  for (const t of TOWNS) b.zone('sidewalk', t.rect);
  for (const t of TOWNS) b.zone(t.ground, t.rect, t.name);

  // Town street grids. Avenues that would run down the river are left out.
  for (const t of TOWNS) {
    const half = t.roadW / 2;
    for (let x = t.rect.x; x <= t.rect.x + t.rect.w; x += t.avenue) {
      if (inRiverColumn(x)) continue;
      road({ x: x - half, y: t.rect.y - half, w: t.roadW, h: t.rect.h + t.roadW });
    }
    for (let y = t.rect.y; y <= t.rect.y + t.rect.h; y += t.street) {
      road({ x: t.rect.x - half, y: y - half, w: t.rect.w + t.roadW, h: t.roadW });
    }
  }
  for (const h of HIGHWAYS) {
    const half = HIGHWAY_W / 2;
    road({
      x: Math.min(h.a.x, h.b.x) - half,
      y: Math.min(h.a.y, h.b.y) - half,
      w: Math.abs(h.b.x - h.a.x) + HIGHWAY_W,
      h: Math.abs(h.b.y - h.a.y) + HIGHWAY_W,
    });
  }

  // Water is solid except where a road bridges it.
  b.wall(WEST_SEA);
  b.wall(SOUTH_SEA);
  const bridges = roadRects
    .filter((r) => r.w > r.h && overlaps(r, RIVER))
    .map((r) => ({ y0: r.y, y1: r.y + r.h }))
    .sort((p, q) => p.y0 - q.y0);
  let y = 0;
  for (const br of bridges) {
    if (br.y0 > y) b.wall({ x: RIVER.x, y, w: RIVER.w, h: br.y0 - y });
    y = Math.max(y, br.y1);
  }
  if (y < H) b.wall({ x: RIVER.x, y, w: RIVER.w, h: H - y });

  // Blocks.
  for (const t of TOWNS) fillTown(b, t);

  scatterCountryside(b, roadRects);
  parkTraffic(b);
  placePickups(b);

  b.borderWalls();
  b.pruneBlockedSpawns();

  const hub = TOWNS[0].rect;
  return {
    id: 'kestrel-region',
    name: 'Kestrel Region',
    width: W,
    height: H,
    tileSize: 32,
    zones: b.zones,
    solids: b.solids,
    // Team modes do not use this map; one spawn zone satisfies the contract.
    teamSpawns: [{ team: 0, zone: { x: hub.x + 1200, y: hub.y + 1000, w: 600, h: 400 } }],
    vehicleSpawns: b.vehicleSpawns,
    pickupSpawns: b.pickupSpawns,
    flagBases: [],
    safeZone: { x: W / 2, y: H / 2, startRadius: W / 2 },
    modes: ['freeroam'],
    roads: buildRoadGraph(),
    towns: TOWNS.map((t) => ({ name: t.name, rect: t.rect })),
    services: buildServices(),
    hub,
    recommendedPlayers: 32,
    // Free roam only: everyone is NO_TEAM, and team matches never pick this map.
    maxTeams: 1,
  };
}

function fillTown(b: MapBuilder, t: TownSpec): void {
  const inset = t.roadW / 2 + 14;
  for (let bx = t.rect.x; bx < t.rect.x + t.rect.w; bx += t.avenue) {
    for (let by = t.rect.y; by < t.rect.y + t.rect.h; by += t.street) {
      const rect: Rect = {
        x: bx + inset, y: by + inset,
        w: t.avenue - inset * 2, h: t.street - inset * 2,
      };
      // A block the river runs through keeps whichever side is larger.
      if (overlaps(rect, RIVER, 24)) {
        const left = RIVER.x - 24 - rect.x;
        const right = rect.x + rect.w - (RIVER.x + RIVER.w + 24);
        if (left >= right) rect.w = left;
        else {
          rect.x = RIVER.x + RIVER.w + 24;
          rect.w = right;
        }
        if (rect.w < 110) continue;
      }
      if (b.rng() < t.park) {
        for (let i = 0; i < 3; i++) {
          const s = 30 + b.rng() * 24;
          b.prop({
            x: rect.x + b.rng() * (rect.w - s),
            y: rect.y + b.rng() * (rect.h - s),
            w: s, h: s,
          });
        }
        continue;
      }
      b.cityBlock(rect, { density: t.density, alley: t.alley, minSize: t.minSize });
    }
  }
}

/** Hedgerows, barns and rock outcrops, kept well clear of roads and water. */
function scatterCountryside(b: MapBuilder, roads: Rect[]): void {
  const blocked = (r: Rect) =>
    roads.some((rd) => overlaps(r, rd, 70)) ||
    TOWNS.some((t) => overlaps(r, t.rect, 160)) ||
    overlaps(r, RIVER, 60) || overlaps(r, WEST_SEA, 60) ||
    overlaps(r, BEACH, 20) || overlaps(r, SOUTH_SEA, 60);

  for (let i = 0; i < 360; i++) {
    const s = 28 + b.rng() * 40;
    const r = { x: 480 + b.rng() * (W - 960), y: 200 + b.rng() * (H - 1500), w: s, h: s * (0.6 + b.rng() * 0.8) };
    if (!blocked(r)) b.prop(r);
  }
  for (let i = 0; i < 40; i++) {
    const r = { x: 480 + b.rng() * (W - 960), y: 200 + b.rng() * (H - 1500), w: 120 + b.rng() * 80, h: 90 + b.rng() * 60 };
    if (!blocked(r)) b.building(r, 1);
  }
}

/** Parked cars along every other avenue in each town. */
function parkTraffic(b: MapBuilder): void {
  for (const t of TOWNS) {
    let col = 0;
    for (let x = t.rect.x + t.avenue; x < t.rect.x + t.rect.w; x += t.avenue, col++) {
      if (inRiverColumn(x) || col % 2 === 1) continue;
      for (let y = t.rect.y + t.street; y < t.rect.y + t.rect.h; y += t.street * 2) {
        // Kerbside, facing along the avenue.
        b.vehicle(x + 30, y + t.street / 2, Math.PI / 2);
      }
    }
  }
}

function placePickups(b: MapBuilder): void {
  for (const t of TOWNS) {
    for (let x = t.rect.x + t.avenue; x < t.rect.x + t.rect.w; x += t.avenue) {
      for (let y = t.rect.y + t.street; y < t.rect.y + t.rect.h; y += t.street) {
        if (inRiverColumn(x)) continue;
        const roll = b.rng();
        if (roll < 0.14) b.ammoPickup(x, y);
        else if (roll < 0.26) b.weaponPickup(x, y, undefined, roll < 0.17 ? 3 : 2);
        else if (roll < 0.34) b.healthPickup(x, y);
        else if (roll < 0.38) b.armorPickup(x, y);
      }
    }
  }
}

/**
 * Every town intersection plus points along each highway. Nodes on a highway
 * between towns are `rural`: traffic and police use them, pedestrians do not.
 */
function buildRoadGraph(): RoadGraph {
  const nodes: RoadGraph['nodes'] = [];
  const index = new Map<string, number>();
  const edges: [number, number][] = [];
  const node = (x: number, y: number, rural = false): number => {
    const key = `${x},${y}`;
    let i = index.get(key);
    if (i === undefined) {
      i = nodes.length;
      nodes.push(rural ? { x, y, rural } : { x, y });
      index.set(key, i);
    }
    return i;
  };

  for (const t of TOWNS) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let x = t.rect.x; x <= t.rect.x + t.rect.w; x += t.avenue) if (!inRiverColumn(x)) xs.push(x);
    for (let y = t.rect.y; y <= t.rect.y + t.rect.h; y += t.street) ys.push(y);
    for (const y of ys) {
      for (let i = 0; i + 1 < xs.length; i++) edges.push([node(xs[i], y), node(xs[i + 1], y)]);
    }
    for (const x of xs) {
      for (let i = 0; i + 1 < ys.length; i++) edges.push([node(x, ys[i]), node(x, ys[i + 1])]);
    }
  }

  for (const h of HIGHWAYS) {
    const len = Math.abs(h.b.x - h.a.x) + Math.abs(h.b.y - h.a.y);
    const steps = Math.round(len / HIGHWAY_NODE_STEP);
    let prev = node(h.a.x, h.a.y);
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const x = Math.round(h.a.x + (h.b.x - h.a.x) * f);
      const y = Math.round(h.a.y + (h.b.y - h.a.y) * f);
      const end = s === steps;
      const cur = node(x, y, !end);
      edges.push([prev, cur]);
      prev = cur;
    }
  }
  return { nodes, edges };
}

/** Which town a point is in, or -1 out in the country. */
export function townAt(map: GameMapDef, x: number, y: number): number {
  return map.towns?.findIndex((t) => pointInRect(x, y, t.rect)) ?? -1;
}
