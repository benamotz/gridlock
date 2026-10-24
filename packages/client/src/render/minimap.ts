import type {
  DeployableWire, GameMapDef, JobWire, PickupWire, PlayerWire, VehicleWire,
} from '@gridlock/shared';
import { RESIDENT, ZONE_STYLES, teamColorFor } from './assets.js';
import { jobColor, serviceStyle } from './cityLayer.js';

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
  /** The local player's job, marked so it can be found from anywhere. */
  job?: JobWire | null;
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

    // Sharp enough that the compact window (a ~1500-unit slice) stays legible
    // on the big region map, where 512 px across would be 32 units a pixel.
    const scale = Math.min(0.25, 2048 / Math.max(map.width, map.height));
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

    // Businesses as coloured dots; phone booths and shops are what players look
    // for on the big map.
    for (const svc of s.map.services ?? []) {
      ctx.fillStyle = serviceStyle(svc.kind).fill;
      ctx.fillRect(wx(svc.x) - 2.5, wy(svc.y) - 2.5, 5, 5);
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
      // Officers nearby show up, so a chase can be read and escaped.
      if (p.npc === 'cop') {
        ctx.fillStyle = RESIDENT.police;
        ctx.fillRect(wx(p.x) - 2, wy(p.y) - 2, 4, 4);
        continue;
      }
      // Gunmen a job has set against you, so a fight can be read from the map.
      if (p.npc === 'thug' && p.marked) {
        ctx.fillStyle = '#ff3b4e';
        ctx.fillRect(wx(p.x) - 2, wy(p.y) - 2, 4, 4);
        continue;
      }
      if (p.npc) continue;
      // Wanted players nearby are flagged, the way a police scanner would.
      if (p.wanted > 0) {
        ctx.fillStyle = '#ff3b4e';
        ctx.beginPath();
        ctx.arc(wx(p.x), wy(p.y), 2.5 + p.wanted * 0.5, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      // Only teammates appear on the minimap - enemies must be spotted.
      if (p.team !== s.selfTeam || s.selfTeam < 0) continue;
      ctx.fillStyle = teamColorFor(p.team, s.colorblind);
      ctx.beginPath();
      ctx.arc(wx(p.x), wy(p.y), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (s.job) {
      // Clamped to the window edge when off it, so the direction is never lost.
      const jx = Math.max(6, Math.min(w - 6, wx(s.job.x)));
      const jy = Math.max(6, Math.min(h - 6, wy(s.job.y)));
      ctx.strokeStyle = jobColor(s.job.kind);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(jx, jy, 5, 0, Math.PI * 2);
      ctx.stroke();
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
