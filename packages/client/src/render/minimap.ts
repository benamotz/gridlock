import type {
  DeployableWire, GameMapDef, JobWire, PickupWire, PlayerWire, VehicleWire,
} from '@gridlock/shared';
import { CREW_COLOR, RESIDENT, ZONE_STYLES, teamColorFor } from './assets.js';
import { jobColor } from './cityLayer.js';
import { drawHealthPickupIcon, drawMapLegend, drawPlaceIcon, drawWeaponPickupIcon } from './mapIcons.js';

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
 * The compact form shows a window around the player; the expanded form (M, or
 * a tap on a phone) fits the whole map. Everything is drawn at the screen's
 * full pixel density: the canvas is sized in device pixels and this works in
 * CSS pixels through a transform.
 *
 * The ground is drawn as vectors, not scaled from a pre-rendered image: on a
 * phone the old 2048-pixel image of the whole region was stretched 1.6x in the
 * compact window and looked blurry. The compact window draws only the few
 * dozen shapes in view each frame; the expanded map is drawn once per size
 * into a cache and reused, since it never moves.
 */
export class Minimap {
  private expandedCache: { key: string; canvas: HTMLCanvasElement } | null = null;

  /** Ground (zones and buildings) for the world rect in view, at `scale`. */
  private drawGround(
    ctx: CanvasRenderingContext2D, map: GameMapDef,
    cx: number, cy: number, scale: number,
    view: { x0: number; y0: number; x1: number; y1: number },
  ): void {
    const visible = (r: { x: number; y: number; w: number; h: number }): boolean =>
      r.x < view.x1 && r.x + r.w > view.x0 && r.y < view.y1 && r.y + r.h > view.y0;
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(cx + view.x0 * scale, cy + view.y0 * scale, (view.x1 - view.x0) * scale, (view.y1 - view.y0) * scale);
    for (const z of map.zones) {
      if (!visible(z.rect)) continue;
      ctx.fillStyle = ZONE_STYLES[z.kind].fill;
      ctx.fillRect(cx + z.rect.x * scale, cy + z.rect.y * scale, z.rect.w * scale, z.rect.h * scale);
    }
    ctx.fillStyle = '#0b0d12';
    for (const so of map.solids) {
      if (so.kind === 'prop' || !visible(so.rect)) continue;
      ctx.fillRect(cx + so.rect.x * scale, cy + so.rect.y * scale, so.rect.w * scale, so.rect.h * scale);
    }
    // A hairline edge on buildings keeps blocks readable at small scales.
    if (scale > 0.05) {
      ctx.strokeStyle = 'rgba(120, 132, 160, 0.22)';
      ctx.lineWidth = 0.75;
      for (const so of map.solids) {
        if (so.kind !== 'building' || !visible(so.rect)) continue;
        ctx.strokeRect(cx + so.rect.x * scale, cy + so.rect.y * scale, so.rect.w * scale, so.rect.h * scale);
      }
    }
  }

  draw(canvas: HTMLCanvasElement, s: MinimapState): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Work in CSS pixels; the canvas itself is sized in device pixels.
    const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.clearRect(0, 0, w, h);
    ctx.save();

    // Compact: a fixed window of world around the player. Expanded: the whole
    // map, fitted to the canvas whatever its shape.
    const scale = s.expanded
      ? Math.min(w / s.map.width, h / s.map.height)
      : Math.min(w, h) / 1500;
    const cx = s.expanded ? w / 2 - (s.map.width * scale) / 2 : w / 2 - s.selfX * scale;
    const cy = s.expanded ? h / 2 - (s.map.height * scale) / 2 : h / 2 - s.selfY * scale;

    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    if (s.expanded) {
      const key = `${s.map.id}:${canvas.width}x${canvas.height}`;
      if (this.expandedCache?.key !== key) {
        const c = document.createElement('canvas');
        c.width = canvas.width;
        c.height = canvas.height;
        const g = c.getContext('2d')!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.drawGround(g, s.map, cx, cy, scale, { x0: 0, y0: 0, x1: s.map.width, y1: s.map.height });
        this.expandedCache = { key, canvas: c };
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.expandedCache.canvas, 0, 0);
      ctx.restore();
    } else {
      this.drawGround(ctx, s.map, cx, cy, scale, {
        x0: Math.max(0, -cx / scale), y0: Math.max(0, -cy / scale),
        x1: Math.min(s.map.width, (w - cx) / scale), y1: Math.min(s.map.height, (h - cy) / scale),
      });
    }

    const wx = (x: number) => cx + x * scale;
    const wy = (y: number) => cy + y * scale;


    // Businesses as coloured dots; phone booths and shops are what players look
    // for on the big map.
    // Weapons and health first, so a business symbol is never hidden under one.
    const pickupR = s.expanded ? 3.5 : 3;
    for (const p of s.pickups) {
      if (p.kind === 'weapon') drawWeaponPickupIcon(ctx, wx(p.x), wy(p.y), pickupR);
      else if (p.kind === 'health') drawHealthPickupIcon(ctx, wx(p.x), wy(p.y), pickupR);
    }

    // Businesses as symbols: each kind its own colour and pictogram.
    const iconR = s.expanded ? 7 : 5.5;
    for (const svc of s.map.services ?? []) {
      const x = wx(svc.x);
      const y = wy(svc.y);
      if (x < -iconR || y < -iconR || x > w + iconR || y > h + iconR) continue;
      drawPlaceIcon(ctx, svc.kind, x, y, iconR);
    }

    // Area names on the big map, over the symbols and outlined so a symbol
    // underneath never makes one unreadable.
    if (s.expanded) {
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(8, 10, 15, 0.85)';
      ctx.fillStyle = 'rgba(236, 241, 248, 0.92)';
      for (const z of s.map.zones) {
        if (!z.label) continue;
        const lx = wx(z.rect.x + z.rect.w / 2);
        const ly = wy(z.rect.y + z.rect.h / 2);
        ctx.strokeText(z.label, lx, ly);
        ctx.fillText(z.label, lx, ly);
      }
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
      // Your crew, wherever they are in the city (they are sent city-wide).
      if (p.crewmate) {
        ctx.fillStyle = CREW_COLOR;
        ctx.strokeStyle = '#0b0e14';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(wx(p.x), wy(p.y), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        continue;
      }
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
    // The big map's key, on maps that have businesses to explain.
    if (s.expanded && (s.map.services?.length ?? 0) > 0) drawMapLegend(ctx, 8, h - 8);
  }
}
