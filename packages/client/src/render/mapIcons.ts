import type { ServiceKind } from '@gridlock/shared';

/**
 * Map symbols for the city's places. Each kind has its own colour *and* its
 * own pictogram, so a shop, a store you rob and a weapon lying in the street
 * can be told apart at a glance (playtesting: as plain coloured squares, the
 * shop, the stores and weapon pickups all looked alike). Drawn with canvas
 * paths rather than emoji, so they look the same on every phone and stay sharp
 * at any size.
 */
export const PLACE_COLORS: Record<ServiceKind, string> = {
  shop: '#a78bfa',
  store: '#feca57',
  chopshop: '#ff9f43',
  respray: '#54a0ff',
  phone: '#1dd1a1',
};

/** Names for the big map's key; the store is the one you hold up. */
export const PLACE_LABELS: Record<ServiceKind, string> = {
  shop: 'Shop',
  store: 'Store (rob)',
  chopshop: 'Chop shop',
  respray: 'Respray',
  phone: 'Phone (jobs)',
};

export const WEAPON_PICKUP_COLOR = '#ff9f1a';
export const HEALTH_PICKUP_COLOR = '#7ef3a4';

/** A round badge in the place's colour with a dark pictogram, radius `r`. */
export function drawPlaceIcon(
  ctx: CanvasRenderingContext2D, kind: ServiceKind, x: number, y: number, r: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = PLACE_COLORS[kind];
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.18);
  ctx.strokeStyle = 'rgba(8, 10, 15, 0.9)';
  ctx.stroke();

  // Pictogram in a unit box (-1..1), scaled to sit inside the badge.
  const k = r * 0.58;
  ctx.scale(k, k);
  ctx.fillStyle = '#10131a';
  ctx.strokeStyle = '#10131a';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (kind) {
    case 'shop': {
      // Shopping bag: body and handle.
      ctx.fillRect(-0.75, -0.3, 1.5, 1.15);
      ctx.lineWidth = 0.28;
      ctx.beginPath();
      ctx.arc(0, -0.3, 0.42, Math.PI, 0);
      ctx.stroke();
      break;
    }
    case 'store': {
      // Storefront: an awning over a shop with a door.
      ctx.beginPath();
      ctx.moveTo(-0.95, -0.15);
      ctx.lineTo(-0.7, -0.8);
      ctx.lineTo(0.7, -0.8);
      ctx.lineTo(0.95, -0.15);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-0.75, -0.05, 1.5, 0.9);
      ctx.fillStyle = PLACE_COLORS.store;
      ctx.fillRect(-0.2, 0.25, 0.4, 0.6);
      break;
    }
    case 'chopshop': {
      // Wrench: a handle and an open jaw.
      ctx.lineWidth = 0.38;
      ctx.beginPath();
      ctx.moveTo(-0.7, 0.7);
      ctx.lineTo(0.15, -0.15);
      ctx.stroke();
      ctx.lineWidth = 0.3;
      ctx.beginPath();
      ctx.arc(0.38, -0.38, 0.38, Math.PI * 0.95, Math.PI * 2.55);
      ctx.stroke();
      break;
    }
    case 'respray': {
      // Paint drop.
      ctx.beginPath();
      ctx.moveTo(0, -0.9);
      ctx.bezierCurveTo(0.35, -0.35, 0.7, 0, 0.7, 0.3);
      ctx.arc(0, 0.3, 0.7, 0, Math.PI);
      ctx.bezierCurveTo(-0.7, 0, -0.35, -0.35, 0, -0.9);
      ctx.fill();
      break;
    }
    case 'phone': {
      // Handset: a phone with a screen.
      ctx.fillRect(-0.48, -0.85, 0.96, 1.7);
      ctx.fillStyle = PLACE_COLORS.phone;
      ctx.fillRect(-0.3, -0.62, 0.6, 1.0);
      ctx.fillStyle = '#10131a';
      ctx.beginPath();
      ctx.arc(0, 0.6, 0.11, 0, Math.PI * 2);
      ctx.fillStyle = PLACE_COLORS.phone;
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

/** A weapon lying in the street: a small orange triangle (pointing up). */
export function drawWeaponPickupIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.95, y + r * 0.75);
  ctx.lineTo(x - r * 0.95, y + r * 0.75);
  ctx.closePath();
  ctx.fillStyle = WEAPON_PICKUP_COLOR;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(8, 10, 15, 0.9)';
  ctx.stroke();
  ctx.restore();
}

/** Health lying in the street: a small green cross. */
export function drawHealthPickupIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const t = r * 0.42;
  ctx.save();
  ctx.fillStyle = 'rgba(8, 10, 15, 0.9)';
  ctx.fillRect(x - r - 1, y - t - 1, r * 2 + 2, t * 2 + 2);
  ctx.fillRect(x - t - 1, y - r - 1, t * 2 + 2, r * 2 + 2);
  ctx.fillStyle = HEALTH_PICKUP_COLOR;
  ctx.fillRect(x - r, y - t, r * 2, t * 2);
  ctx.fillRect(x - t, y - r, t * 2, r * 2);
  ctx.restore();
}

/** The big map's key: every symbol with its name, in a panel at bottom-left. */
export function drawMapLegend(ctx: CanvasRenderingContext2D, x: number, bottom: number): void {
  const kinds: ServiceKind[] = ['shop', 'store', 'phone', 'chopshop', 'respray'];
  const rows = kinds.length + 2;
  const lineH = 19;
  const w = 128;
  const h = rows * lineH + 10;
  const y = bottom - h;
  ctx.save();
  ctx.fillStyle = 'rgba(8, 10, 15, 0.82)';
  ctx.strokeStyle = 'rgba(120, 132, 160, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let row = 0;
  const line = (draw: (cx: number, cy: number) => void, label: string): void => {
    const cy = y + 5 + lineH * row + lineH / 2;
    draw(x + 15, cy);
    ctx.fillStyle = '#e6ecf5';
    ctx.fillText(label, x + 30, cy + 0.5);
    row++;
  };
  for (const k of kinds) line((cx, cy) => drawPlaceIcon(ctx, k, cx, cy, 7), PLACE_LABELS[k]);
  line((cx, cy) => drawWeaponPickupIcon(ctx, cx, cy, 5), 'Weapon');
  line((cx, cy) => drawHealthPickupIcon(ctx, cx, cy, 5), 'Health');
  ctx.restore();
}
