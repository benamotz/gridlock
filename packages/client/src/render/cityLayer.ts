import {
  GAMEPLAY,
  type JobWire,
  type MoneyWire,
  type PlayerWire,
  SERVICE_NAMES,
  SHOP_ITEMS,
  type ServiceDef,
  type ServiceKind,
} from '@gridlock/shared';
import type { Rect } from '@gridlock/shared';

/**
 * Free-roam overlays drawn in world space: the businesses on the street, cash
 * lying around, the hit target, and an arrow to the current job.
 */

const SERVICE_STYLE: Record<ServiceKind, { fill: string; glyph: string }> = {
  chopshop: { fill: '#ff9f43', glyph: '$' },
  respray: { fill: '#54a0ff', glyph: 'R' },
  store: { fill: '#feca57', glyph: 'S' },
  shop: { fill: '#ee5253', glyph: 'G' },
  phone: { fill: '#1dd1a1', glyph: 'J' },
};

export const serviceStyle = (kind: ServiceKind) => SERVICE_STYLE[kind];

const inRect = (x: number, y: number, r: Rect, pad = 0) =>
  x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;

/** Ground pads with a glyph and a name, so a business can be found by eye. */
export function drawServices(
  ctx: CanvasRenderingContext2D, services: ServiceDef[], cull: Rect, time: number,
): void {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const pulse = 0.55 + 0.25 * Math.sin(time / 380);
  for (const s of services) {
    if (!inRect(s.x, s.y, cull, s.r)) continue;
    const style = SERVICE_STYLE[s.kind];
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = style.fill;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = style.fill;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.fillStyle = 'rgba(8,10,15,0.8)';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = style.fill;
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.fillText(style.glyph, s.x, s.y + 1);

    const label = s.item
      ? `${SHOP_ITEMS[s.item].name} $${SHOP_ITEMS[s.item].price}`
      : SERVICE_NAMES[s.kind];
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(8,10,15,0.75)';
    const w = ctx.measureText(label).width + 8;
    ctx.fillRect(s.x - w / 2, s.y - 30, w, 13);
    ctx.fillStyle = '#eef2f8';
    ctx.fillText(label, s.x, s.y - 23);
  }
  ctx.restore();
}

/** Dropped cash: a little green bundle with its value. */
export function drawMoney(ctx: CanvasRenderingContext2D, money: MoneyWire[], cull: Rect, time: number): void {
  if (money.length === 0) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 10px ui-monospace, monospace';
  for (const m of money) {
    if (!inRect(m.x, m.y, cull)) continue;
    const bob = Math.sin(time / 260 + m.id) * 1.5;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(m.x - 9, m.y - 3, 18, 10);
    ctx.fillStyle = '#2ecc71';
    ctx.fillRect(m.x - 10, m.y - 6 + bob, 20, 11);
    ctx.fillStyle = '#145a32';
    ctx.fillRect(m.x - 3, m.y - 6 + bob, 6, 11);
    ctx.fillStyle = '#d5f5e3';
    ctx.fillText(`$${m.amount}`, m.x, m.y - 14 + bob);
  }
  ctx.restore();
}

/** A pulsing red ring around the hit target, visible only to the hit man. */
export function drawMarked(ctx: CanvasRenderingContext2D, players: PlayerWire[], time: number): void {
  const pulse = 1 + 0.15 * Math.sin(time / 160);
  for (const p of players) {
    if (!p.marked || p.life !== 'alive') continue;
    ctx.save();
    ctx.strokeStyle = '#ff3b4e';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 22 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(p.x + dx * 26 * pulse, p.y + dy * 26 * pulse);
      ctx.lineTo(p.x + dx * 34 * pulse, p.y + dy * 34 * pulse);
    }
    ctx.stroke();
    ctx.restore();
  }
}

const JOB_COLOR: Record<JobWire['kind'], string> = {
  courier: '#1dd1a1', hit: '#ff3b4e', bounty: '#ff3b4e',
  boost: '#ff9f43', armored: '#feca57', decoy: '#54a0ff', hideout: '#ff6b6b',
};

export const jobColor = (kind: JobWire['kind']): string => JOB_COLOR[kind];

/** The drop-off ring, or an arrow at the edge of the view pointing to the job. */
export function drawJob(
  ctx: CanvasRenderingContext2D, job: JobWire | null, selfX: number, selfY: number,
  view: Rect, time: number,
): void {
  if (!job) return;
  ctx.save();
  if (job.kind === 'courier' && inRect(job.x, job.y, view)) {
    const r = GAMEPLAY.jobs.courierRadius;
    ctx.strokeStyle = '#1dd1a1';
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.6 + 0.3 * Math.sin(time / 200);
    ctx.beginPath();
    ctx.arc(job.x, job.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Jobs aimed at something moving - the cash van, a car to steal, a wanted
  // player - get a target ring on it. (A hit target's ring comes with it.)
  const ringed = job.kind === 'armored' || job.kind === 'boost' || job.kind === 'bounty' || job.kind === 'hideout';
  if (ringed && inRect(job.x, job.y, view)) {
    ctx.save();
    ctx.strokeStyle = JOB_COLOR[job.kind];
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.65 + 0.3 * Math.sin(time / 170);
    ctx.setLineDash([10, 7]);
    ctx.beginPath();
    ctx.arc(job.x, job.y, 42 + 4 * Math.sin(time / 240), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (!inRect(job.x, job.y, view, -40)) {
    const a = Math.atan2(job.y - selfY, job.x - selfX);
    // Walk out from the player until the arrow would leave the view.
    const margin = 46;
    const hw = view.w / 2 - margin;
    const hh = view.h / 2 - margin;
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    const t = Math.min(
      Math.abs(Math.cos(a)) > 1e-6 ? hw / Math.abs(Math.cos(a)) : Infinity,
      Math.abs(Math.sin(a)) > 1e-6 ? hh / Math.abs(Math.sin(a)) : Infinity,
    );
    const x = cx + Math.cos(a) * t;
    const y = cy + Math.sin(a) * t;
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = JOB_COLOR[job.kind];
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(-8, -11);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-8, 11);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
