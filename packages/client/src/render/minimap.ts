import type {
  DeployableWire, GameMapDef, PickupWire, PlayerWire, VehicleWire,
} from '@gridlock/shared';
import { ZONE_STYLES, teamColorFor } from './assets.js';

export interface MinimapState {
  map: GameMapDef;
  selfX: number;
  selfY: number;
  selfAim: number;
  selfTeam: number;
  players: PlayerWire[];
  vehicles: VehicleWire[];
  deployables: DeployableWire[];
  pickups: PickupWire[];
  colorblind: boolean;
  /** Expanded mode draws the whole map with landmark labels. */
  expanded: boolean;
}

/**
 * Minimap renderer.
 *
 * The compact form shows a window around the player; the expanded form (M)
 * fits the whole map. Ground geometry is cached to an offscreen canvas the
 * first time a map is seen, because redrawing hundreds of rectangles every
 * frame for the city map is pure waste.
 */
export class Minimap {
  private cache = new Map<string, HTMLCanvasElement>();

  private baseLayer(map: GameMapDef): HTMLCanvasElement {
    const existing = this.cache.get(map.id);
    if (existing) return existing;

    const scale = 512 / Math.max(map.width, map.height);
    const c = document.createElement('canvas');
    c.width = Math.ceil(map.width * scale);
    c.height = Math.ceil(map.height * scale);
    const ctx = c.getContext('2d')!;

    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.scale(scale, scale);
    for (const z of map.zones) {
      ctx.fillStyle = ZONE_STYLES[z.kind].fill;
      ctx.fillRect(z.rect.x, z.rect.y, z.rect.w, z.rect.h);
    }
    ctx.fillStyle = '#0b0d12';
    for (const s of map.solids) {
      if (s.kind === 'prop') continue;
      ctx.fillRect(s.rect.x, s.rect.y, s.rect.w, s.rect.h);
    }
    ctx.restore();

    this.cache.set(map.id, c);
    return c;
  }

  draw(canvas: HTMLCanvasElement, s: MinimapState): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const base = this.baseLayer(s.map);

    ctx.clearRect(0, 0, w, h);
    ctx.save();

    // World units visible in the minimap window.
    const span = s.expanded ? Math.max(s.map.width, s.map.height) : 1500;
    const scale = Math.min(w, h) / span;
    const ox = w / 2 - s.selfX * scale;
    const oy = h / 2 - s.selfY * scale;
    const cx = s.expanded ? w / 2 - (s.map.width * scale) / 2 : ox;
    const cy = s.expanded ? h / 2 - (s.map.height * scale) / 2 : oy;

    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    ctx.drawImage(base, cx, cy, s.map.width * scale, s.map.height * scale);

    const wx = (x: number) => cx + x * scale;
    const wy = (y: number) => cy + y * scale;

    if (s.expanded) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(230,236,245,0.6)';
      ctx.textAlign = 'center';
      for (const z of s.map.zones) {
        if (!z.label) continue;
        ctx.fillText(z.label, wx(z.rect.x + z.rect.w / 2), wy(z.rect.y + z.rect.h / 2));
      }
    }

    for (const p of s.pickups) {
      if (p.kind !== 'weapon' && p.kind !== 'health') continue;
      ctx.fillStyle = p.kind === 'health' ? '#7ef3a4' : '#ffd479';
      ctx.fillRect(wx(p.x) - 1.5, wy(p.y) - 1.5, 3, 3);
    }

    for (const v of s.vehicles) {
      if (v.destroyed) continue;
      ctx.fillStyle = 'rgba(200,210,230,0.75)';
      ctx.fillRect(wx(v.x) - 2, wy(v.y) - 2, 4, 4);
    }

    for (const d of s.deployables) {
      ctx.fillStyle = teamColorFor(d.team, s.colorblind);
      ctx.globalAlpha = 0.85;
      ctx.fillRect(wx(d.x) - 2, wy(d.y) - 2, 4, 4);
      ctx.globalAlpha = 1;
    }

    for (const p of s.players) {
      if (p.life !== 'alive') continue;
      // Only teammates appear on the minimap - enemies must be spotted.
      if (p.team !== s.selfTeam || s.selfTeam < 0) continue;
      ctx.fillStyle = teamColorFor(p.team, s.colorblind);
      ctx.beginPath();
      ctx.arc(wx(p.x), wy(p.y), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Self: a triangle so facing is legible at this scale.
    ctx.save();
    ctx.translate(wx(s.selfX), wy(s.selfY));
    ctx.rotate(s.selfAim);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, 4);
    ctx.lineTo(-4, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }
}
