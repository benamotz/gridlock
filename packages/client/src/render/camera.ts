import { type GameMapDef, clamp, lerp } from '@gridlock/shared';

/** Smoothly-following camera with map clamping and a zoom for fast vehicles. */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  private targetZoom = 1;
  private leadX = 0;
  private leadY = 0;
  private shake = 0;
  private shakeSeed = Math.random() * 1000;

  constructor(private map: GameMapDef) {}

  setMap(map: GameMapDef): void {
    this.map = map;
  }

  /**
   * Follows a target, leading it in the direction of travel.
   *
   * The look-ahead is what makes driving readable: at speed the camera sits
   * ahead of the car so you see the corner you are about to take rather than
   * the road you just left. On foot the lead is small, and it eases in and out
   * so the framing never snaps.
   */
  follow(
    tx: number,
    ty: number,
    vx: number,
    vy: number,
    maxLead: number,
    dt: number,
    viewW: number,
    viewH: number,
  ): void {
    const speed = Math.hypot(vx, vy);
    if (speed > 12) {
      // Lead scales with speed and saturates, so it never runs away.
      const want = Math.min(1, speed / 340) * maxLead;
      this.leadX = lerp(this.leadX, (vx / speed) * want, 1 - Math.exp(-3.2 * dt));
      this.leadY = lerp(this.leadY, (vy / speed) * want, 1 - Math.exp(-3.2 * dt));
    } else {
      this.leadX = lerp(this.leadX, 0, 1 - Math.exp(-3.2 * dt));
      this.leadY = lerp(this.leadY, 0, 1 - Math.exp(-3.2 * dt));
    }

    // Critically-damped-ish follow: fast enough to feel connected, slow enough
    // to smooth out the 15Hz snapshot cadence.
    const k = 1 - Math.exp(-12 * dt);
    this.x = lerp(this.x, tx + this.leadX, k);
    this.y = lerp(this.y, ty + this.leadY, k);
    this.zoom = lerp(this.zoom, this.targetZoom, 1 - Math.exp(-3.2 * dt));
    this.shake = Math.max(0, this.shake - dt * 2.4);
    this.clampToMap(viewW, viewH);
  }

  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  setZoom(z: number): void {
    this.targetZoom = z;
  }

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  /** Screen-space offset for the current shake, respecting the accessibility toggle. */
  shakeOffset(enabled: boolean, time: number): { x: number; y: number } {
    if (!enabled || this.shake <= 0) return { x: 0, y: 0 };
    const s = this.shake * this.shake * 14;
    return {
      x: Math.sin(time * 0.06 + this.shakeSeed) * s,
      y: Math.cos(time * 0.083 + this.shakeSeed * 1.7) * s,
    };
  }

  private clampToMap(viewW: number, viewH: number): void {
    const halfW = viewW / (2 * this.zoom);
    const halfH = viewH / (2 * this.zoom);
    if (this.map.width > halfW * 2) this.x = clamp(this.x, halfW, this.map.width - halfW);
    else this.x = this.map.width / 2;
    if (this.map.height > halfH * 2) this.y = clamp(this.y, halfH, this.map.height - halfH);
    else this.y = this.map.height / 2;
  }

  /** Visible world rectangle, used for culling. */
  viewRect(viewW: number, viewH: number): { x: number; y: number; w: number; h: number } {
    const w = viewW / this.zoom;
    const h = viewH / this.zoom;
    return { x: this.x - w / 2, y: this.y - h / 2, w, h };
  }
}
