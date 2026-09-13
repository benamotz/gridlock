/** Small deterministic math helpers shared by client prediction and the server sim. */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest signed angular distance from `a` to `b`, in radians. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const lerpAngle = (a: number, b: number, t: number): number =>
  a + angleDelta(a, b) * t;

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.sqrt(dist2(ax, ay, bx, by));

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const pointInRect = (x: number, y: number, r: Rect): boolean =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * Deterministic 32-bit PRNG (mulberry32). Used for map generation and any
 * server-side randomness we want to be reproducible in tests.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random element using an injectable RNG so callers stay testable. */
export function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/**
 * Segment vs axis-aligned rect intersection (slab method).
 * Returns the entry `t` in [0,1] along the segment, or null when there is no hit.
 */
export function segmentRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: Rect,
): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let tmin = 0;
  let tmax = 1;

  for (let axis = 0; axis < 2; axis++) {
    const p = axis === 0 ? x0 : y0;
    const d = axis === 0 ? dx : dy;
    const lo = axis === 0 ? r.x : r.y;
    const hi = axis === 0 ? r.x + r.w : r.y + r.h;
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return null;
    } else {
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/**
 * Segment vs circle intersection. Returns the nearest entry `t` in [0,1] or null.
 */
export function segmentCircle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  radius: number,
): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

/** Rotated-rectangle corner helper, used for vehicle bodies. */
export function rotatedRectCorners(
  cx: number,
  cy: number,
  w: number,
  h: number,
  rot: number,
): Vec2[] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const hw = w / 2;
  const hh = h / 2;
  return [
    { x: cx + c * -hw - s * -hh, y: cy + s * -hw + c * -hh },
    { x: cx + c * hw - s * -hh, y: cy + s * hw + c * -hh },
    { x: cx + c * hw - s * hh, y: cy + s * hw + c * hh },
    { x: cx + c * -hw - s * hh, y: cy + s * -hw + c * hh },
  ];
}
