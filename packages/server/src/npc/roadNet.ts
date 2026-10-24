import {
  type CollisionGrid,
  GAMEPLAY,
  type GameMapDef,
  vehicleDef,
} from '@gridlock/shared';

export interface Point {
  x: number;
  y: number;
}

/**
 * A pedestrian stands on one of the four kerb corners of an intersection:
 * `sx`/`sy` say which side (-1 or 1) of the centre lines it is on.
 */
export interface Corner {
  node: number;
  sx: number;
  sy: number;
}

const SAMPLE_STEP = 16;

/**
 * The map's street grid, checked against real collision geometry.
 *
 * Pedestrians walk corner to corner along kerb lines (crossing the road at the
 * crosswalk when they change side) and traffic follows right-hand lane lines.
 * Each line is sampled once, the first time anyone asks, so a segment blocked
 * by water or a wall is simply never used.
 */
export class RoadNet {
  readonly nodes: (Point & { rural?: boolean })[];
  /** Node index -> neighbouring node indices. */
  readonly adj: number[][];
  private readonly kerbOk = new Map<string, boolean>();
  private readonly laneOk = new Map<string, boolean>();

  constructor(map: GameMapDef, private readonly grid: CollisionGrid) {
    const roads = map.roads ?? { nodes: [], edges: [] };
    this.nodes = roads.nodes;
    this.adj = this.nodes.map(() => []);
    for (const [a, b] of roads.edges) {
      // The centre line itself must be open, or nobody could use the segment.
      if (!this.segmentClear(this.nodes[a], this.nodes[b], 6)) continue;
      this.adj[a].push(b);
      this.adj[b].push(a);
    }
  }

  get usable(): boolean {
    return this.adj.some((n) => n.length > 0);
  }

  cornerPoint(c: Corner): Point {
    const n = this.nodes[c.node];
    const o = GAMEPLAY.city.kerbOffset;
    return { x: n.x + c.sx * o, y: n.y + c.sy * o };
  }

  /**
   * Where a pedestrian standing at `from` ends up walking to neighbour `to`:
   * the near corner of the next intersection, on the same side of the street.
   */
  kerbStep(from: Corner, to: number): Corner {
    const a = this.nodes[from.node];
    const b = this.nodes[to];
    if (b.x !== a.x) return { node: to, sx: -Math.sign(b.x - a.x), sy: from.sy };
    return { node: to, sx: from.sx, sy: -Math.sign(b.y - a.y) };
  }

  /** True when a pedestrian can walk that kerb line without hitting anything. */
  kerbClear(from: Corner, to: number): boolean {
    const next = this.kerbStep(from, to);
    const key = `${from.node},${from.sx},${from.sy},${to}`;
    let ok = this.kerbOk.get(key);
    if (ok === undefined) {
      ok = this.segmentClear(
        this.cornerPoint(from), this.cornerPoint(next), GAMEPLAY.player.radius + 1,
      );
      this.kerbOk.set(key, ok);
    }
    return ok;
  }

  /** The right-hand lane point at `to` for traffic arriving from `from`. */
  lanePoint(from: number, to: number): Point {
    const a = this.nodes[from];
    const b = this.nodes[to];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    // Screen coordinates have y pointing down, so "right of heading" is (-dy, dx).
    const o = GAMEPLAY.city.laneOffset;
    return { x: b.x - dy * o, y: b.y + dx * o };
  }

  laneClear(from: number, to: number): boolean {
    const key = `${from},${to}`;
    let ok = this.laneOk.get(key);
    if (ok === undefined) {
      const a = this.nodes[from];
      const b = this.nodes[to];
      const end = this.lanePoint(from, to);
      // The same lateral offset applied at the start of the segment.
      const start = { x: a.x + end.x - b.x, y: a.y + end.y - b.y };
      ok = this.segmentClear(start, end, vehicleDef('car').width / 2);
      this.laneOk.set(key, ok);
    }
    return ok;
  }

  nearestNode(x: number, y: number): number {
    let best = -1;
    let bestD = Infinity;
    this.nodes.forEach((n, i) => {
      if (this.adj[i].length === 0) return;
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** Hops from every node to `goal` (-1 where unreachable). */
  hopsTo(goal: number): Int32Array {
    const hops = new Int32Array(this.nodes.length).fill(-1);
    if (goal < 0) return hops;
    hops[goal] = 0;
    const queue = [goal];
    for (let qi = 0; qi < queue.length; qi++) {
      const n = queue[qi];
      for (const m of this.adj[n]) {
        if (hops[m] !== -1) continue;
        hops[m] = hops[n] + 1;
        queue.push(m);
      }
    }
    return hops;
  }

  /** The first node to head for on the shortest route from `from` to `to`. */
  nextHop(from: number, to: number): number {
    if (from === to || from < 0 || to < 0) return to;
    const prev = new Int32Array(this.nodes.length).fill(-1);
    prev[from] = from;
    const queue = [from];
    for (let qi = 0; qi < queue.length; qi++) {
      const n = queue[qi];
      if (n === to) break;
      for (const m of this.adj[n]) {
        if (prev[m] !== -1) continue;
        prev[m] = n;
        queue.push(m);
      }
    }
    if (prev[to] === -1) return from;
    let step = to;
    while (prev[step] !== from) step = prev[step];
    return step;
  }

  /** True when a circle of radius `r` can travel straight from `a` to `b`. */
  segmentClear(a: Point, b: Point, r: number): boolean {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / SAMPLE_STEP));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (this.grid.circleBlocked(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r)) return false;
    }
    return true;
  }
}
