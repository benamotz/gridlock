import type { WeaponId } from '@gridlock/shared';

/**
 * Weapon silhouettes, authored once as SVG paths in a 24x24 box.
 *
 * The same data drives both surfaces: React renders them as `<svg>` in the HUD
 * and the loadout chips, and the canvas renderer draws them with `Path2D`,
 * which accepts the identical path strings. One definition, so a pickup on the
 * ground and the slot it lands in can never disagree.
 *
 * Every icon points right, sits on the horizontal centre line, and fills the
 * box, so they read at 14px without further tuning.
 */
export interface WeaponIcon {
  /** Filled shapes making up the body of the weapon. */
  paths: string[];
  /** Optional accent shapes drawn in a lighter tone (sights, muzzles). */
  accents?: string[];
}

export const WEAPON_ICONS: Record<WeaponId, WeaponIcon> = {
  fists: {
    // A clenched fist: knuckle block plus thumb.
    paths: ['M5 8 H16 A3 3 0 0 1 19 11 V15 A3 3 0 0 1 16 18 H5 A2 2 0 0 1 3 16 V10 A2 2 0 0 1 5 8 Z'],
    accents: ['M8 8 V18 M11 8 V18 M14 8 V18'],
  },
  sentry: {
    // A tripod-mounted gun, matching the deployable it belongs to.
    paths: [
      'M4 10 H16 V13.5 H4 Z',
      'M9 13.5 L6 20 H8.5 L10.5 15 H11.5 L13.5 20 H16 L13 13.5 Z',
    ],
    accents: ['M16 10.8 H21 V12.7 H16 Z', 'M6 7.5 H11 V9.6 H6 Z'],
  },
  mine: {
    // A pressure charge with a detonator and a sensor strip.
    paths: ['M12 7 A6 6 0 1 1 12 19 A6 6 0 1 1 12 7 Z'],
    accents: ['M11 3.5 H13 V7.5 H11 Z', 'M9.5 12.2 H14.5 V13.8 H9.5 Z'],
  },
  pipe: {
    // A length of steel with a threaded collar near the grip.
    paths: ['M3 11 H21 V14 H3 Z'],
    accents: ['M6 9.5 H8.5 V15.5 H6 Z'],
  },
  pistol: {
    // Compact slide over an angled grip.
    paths: [
      'M4 9 H17 V13 H4 Z',
      'M5 13 H10 L8 19 H4 Z',
    ],
    accents: ['M17 10 H20 V12 H17 Z'],
  },
  smg: {
    // Short barrel, deep magazine, folded stock.
    paths: [
      'M3 9 H18 V12.5 H3 Z',
      'M8 12.5 H11.5 L10.5 19 H7 Z',
      'M2 10 H4 V14 H2 Z',
    ],
    accents: ['M18 9.8 H21.5 V11.7 H18 Z'],
  },
  shotgun: {
    // Long twin-tube barrel with a pump under the fore-end.
    paths: [
      'M2 9.5 H21 V12 H2 Z',
      'M4 12 H8 L7 17.5 H3.5 Z',
    ],
    accents: [
      'M11 12 H16 V14.5 H11 Z',
      'M19 8.6 H21.5 V12.8 H19 Z',
    ],
  },
  rifle: {
    // Full-length barrel, curved magazine, shoulder stock.
    paths: [
      'M2 9.5 H20 V12.3 H2 Z',
      'M9 12.3 H12.5 L11 18.5 H7.5 Z',
      'M1 10 H3.5 V14.2 H1 Z',
    ],
    accents: [
      'M13.5 7.6 H16 V9.5 H13.5 Z',
      'M20 10.1 H22.5 V11.7 H20 Z',
    ],
  },
  marksman: {
    // Long, thin barrel with a prominent scope and a bipod.
    paths: [
      'M2 10.4 H22 V12.4 H2 Z',
      'M8 12.4 H11 L9.5 18 H6.5 Z',
      'M1 10.8 H3 V14 H1 Z',
    ],
    accents: [
      'M10 7.2 H17 V9.6 H10 Z',
      'M17 14 L19 18 M17 14 L15 18',
    ],
  },
  grenade: {
    // Body, lever and pin ring.
    paths: ['M8 9 A5 5 0 1 1 8 19 A5 5 0 1 1 8 9 Z'],
    accents: [
      'M11 8 H16 V10 H11 Z',
      'M16 6 A2.4 2.4 0 1 1 16 10.8 A2.4 2.4 0 1 1 16 6 Z',
    ],
  },
  launcher: {
    // Wide tube with a flared muzzle and a shoulder grip.
    paths: [
      'M3 8.5 H19 V14 H3 Z',
      'M8 14 H12 L10.5 19.5 H6.5 Z',
    ],
    accents: [
      'M19 7 H22 V15.5 H19 Z',
      'M1 9.6 H3 V13 H1 Z',
    ],
  },
};

const cache = new Map<string, Path2D[]>();

/** Parses (and caches) the Path2D objects for one weapon. */
function pathsFor(id: WeaponId, accents: boolean): Path2D[] {
  const key = `${id}:${accents ? 'a' : 'b'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const icon = WEAPON_ICONS[id];
  const source = accents ? icon.accents ?? [] : icon.paths;
  const built = source.map((d) => new Path2D(d));
  cache.set(key, built);
  return built;
}

/**
 * Draws a weapon icon on canvas, centred on the current origin and scaled to
 * `size` pixels across. Uses the same paths the HUD renders as SVG.
 */
export function drawWeaponIconCanvas(
  ctx: CanvasRenderingContext2D,
  id: WeaponId,
  size: number,
  fill: string,
  accent: string,
): void {
  const scale = size / 24;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-12, -12);

  ctx.fillStyle = fill;
  ctx.strokeStyle = fill;
  ctx.lineWidth = 1.6;
  for (const path of pathsFor(id, false)) ctx.fill(path);

  ctx.fillStyle = accent;
  ctx.strokeStyle = accent;
  for (const path of pathsFor(id, true)) {
    ctx.fill(path);
    // Accents that are open strokes (bipod legs, knuckle lines) need stroking
    // as well; filling a line path is a no-op, so this is safe for both.
    ctx.stroke(path);
  }
  ctx.restore();
}
