import { type VehicleDef, weaponDef, type WeaponId } from '@gridlock/shared';
import { PLAYER, VEHICLE } from './assets.js';
import { drawWeaponIconCanvas } from './weaponIcons.js';

/** Rounded rectangle path helper, used by both the car and character sprites. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export interface CarOptions {
  def: VehicleDef;
  /** 0 = pristine, 1 = destroyed. */
  damage: number;
  destroyed: boolean;
  occupied: boolean;
  /** Team colour of the driver, or null when driverless. */
  driverColor: string | null;
  /** Set while the car is moving, to light the brake and head lamps. */
  speed: number;
  braking: boolean;
}

/**
 * Draws a car body in local space, nose pointing +x.
 *
 * The shape is a bonnet-cabin-boot silhouette with glass, lamps and visible
 * wheels, which is what makes a top-down rectangle read as a vehicle rather
 * than a crate.
 */
export function drawCar(ctx: CanvasRenderingContext2D, o: CarOptions): void {
  const { def } = o;
  const L = def.length;
  const W = def.width;
  const hl = L / 2;
  const hw = W / 2;

  // Wheels first so they sit under the body.
  ctx.fillStyle = VEHICLE.tyre;
  const wheelW = L * 0.16;
  const wheelH = 5;
  for (const sx of [-hl * 0.58, hl * 0.52]) {
    for (const sy of [-hw - 1, hw - wheelH + 1]) {
      ctx.fillRect(sx - wheelW / 2, sy, wheelW, wheelH);
    }
  }

  // Body.
  const bodyColor = o.destroyed ? VEHICLE.wreck : shade(def.color, -o.damage * 0.35);
  ctx.fillStyle = bodyColor;
  roundRect(ctx, -hl, -hw, L, W, Math.min(9, W * 0.3));
  ctx.fill();

  ctx.strokeStyle = VEHICLE.trim;
  ctx.lineWidth = 2;
  ctx.stroke();

  if (o.destroyed) {
    // Scorched panels and a blown-out cabin.
    ctx.fillStyle = VEHICLE.wreckChar;
    roundRect(ctx, -hl * 0.55, -hw + 3, L * 0.55, W - 6, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(-hl * 0.2, i * 4);
      ctx.lineTo(hl * 0.7, i * 6);
      ctx.stroke();
    }
    return;
  }

  // Roof panel, slightly inset and lighter, gives the body a centre line.
  ctx.fillStyle = shade(bodyColor, 0.1);
  roundRect(ctx, -hl * 0.34, -hw + 3.5, L * 0.46, W - 7, 4);
  ctx.fill();

  // Windscreen (front) and rear window.
  ctx.fillStyle = o.occupied ? VEHICLE.glassLit : VEHICLE.glass;
  roundRect(ctx, hl * 0.12, -hw + 4.5, L * 0.19, W - 9, 3);
  ctx.fill();
  roundRect(ctx, -hl * 0.44, -hw + 4.5, L * 0.13, W - 9, 3);
  ctx.fill();

  // Side glazing.
  ctx.fillStyle = VEHICLE.glass;
  ctx.fillRect(-hl * 0.3, -hw + 2.5, L * 0.4, 2);
  ctx.fillRect(-hl * 0.3, hw - 4.5, L * 0.4, 2);

  // Lamps.
  ctx.fillStyle = VEHICLE.headlight;
  ctx.fillRect(hl - 4, -hw + 4, 3, 5);
  ctx.fillRect(hl - 4, hw - 9, 3, 5);
  ctx.fillStyle = o.braking ? '#ff5a5a' : VEHICLE.taillight;
  ctx.fillRect(-hl + 1, -hw + 4, 3, 5);
  ctx.fillRect(-hl + 1, hw - 9, 3, 5);

  // Headlight cone while driving, so a car bearing down on you is unmistakable.
  if (o.speed > 40) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.22, o.speed / 1600);
    ctx.fillStyle = VEHICLE.headlight;
    ctx.beginPath();
    ctx.moveTo(hl - 2, -hw + 5);
    ctx.lineTo(hl + 90, -hw - 22);
    ctx.lineTo(hl + 90, hw + 22);
    ctx.lineTo(hl - 2, hw - 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // A driver's team colour shows as a roof stripe.
  if (o.driverColor) {
    ctx.fillStyle = o.driverColor;
    ctx.fillRect(-hl * 0.32, -1.5, L * 0.44, 3);
  }
}

export interface VehicleOptions extends CarOptions {
  /** Team colours of exposed riders (motorcycle), drawn on the sprite. */
  riderColors: string[];
}

/**
 * Draws any vehicle in local space, nose pointing +x.
 *
 * Every category has its own silhouette - a motorcycle is two wheels and a
 * rider, a truck is a cab and a cargo box - so what a vehicle is for can be
 * read at a glance rather than inferred from its size.
 */
export function drawVehicle(ctx: CanvasRenderingContext2D, o: VehicleOptions): void {
  if (o.destroyed) {
    drawWreck(ctx, o.def.length, o.def.width, o.def.id === 'motorcycle');
    return;
  }
  switch (o.def.id) {
    case 'motorcycle': drawMotorcycle(ctx, o); break;
    case 'sports': drawSports(ctx, o); break;
    case 'van': drawVan(ctx, o); break;
    case 'truck': drawTruck(ctx, o); break;
    case 'armored': drawArmored(ctx, o); break;
    default: drawCar(ctx, o); break;
  }
}

function drawWheels(
  ctx: CanvasRenderingContext2D,
  L: number, W: number,
  xs: number[],
  wheelLen = L * 0.14,
): void {
  ctx.fillStyle = VEHICLE.tyre;
  const hw = W / 2;
  for (const x of xs) {
    ctx.fillRect(x - wheelLen / 2, -hw - 2, wheelLen, 5);
    ctx.fillRect(x - wheelLen / 2, hw - 3, wheelLen, 5);
  }
}

function drawLamps(
  ctx: CanvasRenderingContext2D, L: number, W: number, speed: number,
): void {
  const hl = L / 2;
  const hw = W / 2;
  ctx.fillStyle = VEHICLE.headlight;
  ctx.fillRect(hl - 4, -hw + 4, 3, 5);
  ctx.fillRect(hl - 4, hw - 9, 3, 5);
  ctx.fillStyle = VEHICLE.taillight;
  ctx.fillRect(-hl + 1, -hw + 4, 3, 5);
  ctx.fillRect(-hl + 1, hw - 9, 3, 5);
  if (speed > 40) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.22, speed / 1600);
    ctx.fillStyle = VEHICLE.headlight;
    ctx.beginPath();
    ctx.moveTo(hl - 2, -hw + 5);
    ctx.lineTo(hl + 90, -hw - 22);
    ctx.lineTo(hl + 90, hw + 22);
    ctx.lineTo(hl - 2, hw - 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawWreck(
  ctx: CanvasRenderingContext2D, L: number, W: number, bike: boolean,
): void {
  const hl = L / 2;
  const hw = W / 2;
  ctx.fillStyle = VEHICLE.wreck;
  roundRect(ctx, -hl, -hw, L, W, bike ? W / 2 : 6);
  ctx.fill();
  ctx.strokeStyle = VEHICLE.trim;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = VEHICLE.wreckChar;
  roundRect(ctx, -hl * 0.6, -hw + 3, L * 0.6, Math.max(2, W - 6), 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(-hl * 0.3, i * (W / 10));
    ctx.lineTo(hl * 0.7, i * (W / 7));
    ctx.stroke();
  }
}

/** Team marker on the roof, so a crewed vehicle shows whose side it is on. */
function drawTeamMarker(ctx: CanvasRenderingContext2D, color: string | null, x: number, len: number): void {
  if (!color) return;
  ctx.fillStyle = color;
  ctx.fillRect(x - len / 2, -2, len, 4);
}

function drawMotorcycle(ctx: CanvasRenderingContext2D, o: VehicleOptions): void {
  const { def } = o;
  const L = def.length;
  const hl = L / 2;
  const body = shade(def.color, -o.damage * 0.35);

  // Wheels, in line.
  ctx.fillStyle = VEHICLE.tyre;
  ctx.beginPath();
  ctx.ellipse(hl - 7, 0, 7, 3.4, 0, 0, Math.PI * 2);
  ctx.ellipse(-hl + 7, 0, 7.5, 3.8, 0, 0, Math.PI * 2);
  ctx.fill();

  // Frame and fairing.
  ctx.fillStyle = body;
  roundRect(ctx, -hl * 0.62, -4.5, L * 0.98 * 0.62 + hl * 0.3, 9, 4);
  ctx.fill();
  ctx.strokeStyle = VEHICLE.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Fuel tank and seat.
  ctx.fillStyle = shade(body, 0.18);
  ctx.beginPath();
  ctx.ellipse(hl * 0.12, 0, 6.5, 4.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1b1d24';
  roundRect(ctx, -hl * 0.5, -3, hl * 0.52, 6, 3);
  ctx.fill();

  // Handlebars, wider than the frame - the unmistakable motorcycle cue.
  ctx.strokeStyle = '#11141a';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hl * 0.46, -def.width / 2 - 1);
  ctx.lineTo(hl * 0.46, def.width / 2 + 1);
  ctx.stroke();

  ctx.fillStyle = VEHICLE.headlight;
  ctx.beginPath();
  ctx.arc(hl - 1, 0, 2.2, 0, Math.PI * 2);
  ctx.fill();

  // Exposed riders: the sprite shows who is on it and that they can be shot.
  o.riderColors.forEach((color, i) => {
    const x = hl * 0.15 - i * L * 0.3;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, 0, 6, 7.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0a0c10';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#2a2f3a';
    ctx.beginPath();
    ctx.arc(x + 1.5, 0, 3.6, 0, Math.PI * 2);
    ctx.fill();
  });

  if (o.speed > 40) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.18, o.speed / 2000);
    ctx.fillStyle = VEHICLE.headlight;
    ctx.beginPath();
    ctx.moveTo(hl, -2);
    ctx.lineTo(hl + 80, -18);
    ctx.lineTo(hl + 80, 18);
    ctx.lineTo(hl, 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawSports(ctx: CanvasRenderingContext2D, o: VehicleOptions): void {
  const { def } = o;
  const L = def.length;
  const W = def.width;
  const hl = L / 2;
  const hw = W / 2;
  const body = shade(def.color, -o.damage * 0.35);

  drawWheels(ctx, L, W, [-hl * 0.55, hl * 0.55], L * 0.15);

  // Low wedge: narrow nose, wide haunches.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(hl, -hw + 6);
  ctx.quadraticCurveTo(hl + 2, 0, hl, hw - 6);
  ctx.lineTo(-hl + 6, hw);
  ctx.lineTo(-hl, hw - 4);
  ctx.lineTo(-hl, -hw + 4);
  ctx.lineTo(-hl + 6, -hw);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = VEHICLE.trim;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Racing stripes down the long bonnet.
  ctx.fillStyle = shade(body, 0.45);
  ctx.fillRect(-hl + 8, -4, L - 10, 2.4);
  ctx.fillRect(-hl + 8, 1.6, L - 10, 2.4);

  // Small cockpit set well back.
  ctx.fillStyle = o.occupied ? VEHICLE.glassLit : VEHICLE.glass;
  roundRect(ctx, -hl * 0.35, -hw + 6, L * 0.3, W - 12, 5);
  ctx.fill();

  // Rear wing.
  ctx.fillStyle = '#15171d';
  ctx.fillRect(-hl - 3, -hw + 1, 5, W - 2);

  drawLamps(ctx, L, W, o.speed);
  drawTeamMarker(ctx, o.driverColor, -hl * 0.2, 10);
}

function drawVan(ctx: CanvasRenderingContext2D, o: VehicleOptions): void {
  const { def } = o;
  const L = def.length;
  const W = def.width;
  const hl = L / 2;
  const hw = W / 2;
  const body = shade(def.color, -o.damage * 0.35);

  drawWheels(ctx, L, W, [-hl * 0.62, hl * 0.55]);

  ctx.fillStyle = body;
  roundRect(ctx, -hl, -hw, L, W, 5);
  ctx.fill();
  ctx.strokeStyle = VEHICLE.trim;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Short cab at the front, long boxy load area behind it.
  ctx.fillStyle = o.occupied ? VEHICLE.glassLit : VEHICLE.glass;
  roundRect(ctx, hl * 0.62, -hw + 5, L * 0.15, W - 10, 3);
  ctx.fill();

  ctx.fillStyle = shade(body, 0.1);
  ctx.fillRect(-hl + 5, -hw + 5, L * 0.78, W - 10);
  // Roof rack rails.
  ctx.strokeStyle = shade(body, -0.28);
  ctx.lineWidth = 1.4;
  for (let x = -hl + 12; x < hl * 0.5; x += 12) {
    ctx.beginPath();
    ctx.moveTo(x, -hw + 7);
    ctx.lineTo(x, hw - 7);
    ctx.stroke();
  }
  // Sliding side door seam.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.moveTo(hl * 0.05, -hw + 1);
  ctx.lineTo(hl * 0.05, hw - 1);
  ctx.stroke();

  drawLamps(ctx, L, W, o.speed);
  drawTeamMarker(ctx, o.driverColor, -hl * 0.1, L * 0.4);
}

function drawTruck(ctx: CanvasRenderingContext2D, o: VehicleOptions): void {
  const { def } = o;
  const L = def.length;
  const W = def.width;
  const hl = L / 2;
  const hw = W / 2;
  const body = shade(def.color, -o.damage * 0.35);
  const cabLen = 32;

  // Dual rear axles and a front axle.
  drawWheels(ctx, L, W, [-hl * 0.72, -hl * 0.5, hl - cabLen * 0.5], 14);

  // Cargo box.
  const boxLen = L - cabLen - 4;
  ctx.fillStyle = shade(body, -0.18);
  roundRect(ctx, -hl, -hw, boxLen, W, 3);
  ctx.fill();
  ctx.strokeStyle = VEHICLE.trim;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = 1.5;
  for (let x = -hl + 10; x < -hl + boxLen - 4; x += 10) {
    ctx.beginPath();
    ctx.moveTo(x, -hw + 2);
    ctx.lineTo(x, hw - 2);
    ctx.stroke();
  }
  ctx.fillStyle = shade(body, 0.08);
  ctx.fillRect(-hl + 2, -hw + 2, boxLen - 4, 3);

  // Cab, separated from the box by a visible gap.
  const cabX = hl - cabLen;
  ctx.fillStyle = body;
  roundRect(ctx, cabX, -hw + 2, cabLen, W - 4, 6);
  ctx.fill();
  ctx.strokeStyle = VEHICLE.trim;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = o.occupied ? VEHICLE.glassLit : VEHICLE.glass;
  roundRect(ctx, hl - 13, -hw + 7, 9, W - 14, 2);
  ctx.fill();
  // Bull bar: a truck announces that it is built to hit things.
  ctx.fillStyle = '#23262e';
  ctx.fillRect(hl - 1, -hw + 3, 4, W - 6);
  // Mirrors.
  ctx.fillRect(hl - 12, -hw - 4, 5, 4);
  ctx.fillRect(hl - 12, hw, 5, 4);

  ctx.fillStyle = VEHICLE.headlight;
  ctx.fillRect(hl - 4, -hw + 5, 3, 6);
  ctx.fillRect(hl - 4, hw - 11, 3, 6);
  drawTeamMarker(ctx, o.driverColor, cabX + cabLen * 0.35, 12);
  if (o.speed > 40) drawLamps(ctx, L, W, o.speed);
}

function drawArmored(ctx: CanvasRenderingContext2D, o: VehicleOptions): void {
  const { def } = o;
  const L = def.length;
  const W = def.width;
  const hl = L / 2;
  const hw = W / 2;
  const body = shade(def.color, -o.damage * 0.35);
  const cut = 11;

  drawWheels(ctx, L, W, [-hl * 0.6, 0, hl * 0.6], 15);

  // Chamfered hull.
  const hull = (inset: number): void => {
    const x0 = -hl + inset;
    const x1 = hl - inset;
    const y0 = -hw + inset;
    const y1 = hw - inset;
    const c = Math.max(2, cut - inset);
    ctx.beginPath();
    ctx.moveTo(x0 + c, y0);
    ctx.lineTo(x1 - c, y0);
    ctx.lineTo(x1, y0 + c);
    ctx.lineTo(x1, y1 - c);
    ctx.lineTo(x1 - c, y1);
    ctx.lineTo(x0 + c, y1);
    ctx.lineTo(x0, y1 - c);
    ctx.lineTo(x0, y0 + c);
    ctx.closePath();
  };
  ctx.fillStyle = body;
  hull(0);
  ctx.fill();
  ctx.strokeStyle = VEHICLE.trim;
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // Raised armour deck.
  ctx.fillStyle = shade(body, 0.12);
  hull(7);
  ctx.fill();
  ctx.strokeStyle = shade(body, -0.3);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Rivets along the plates.
  ctx.fillStyle = shade(body, -0.35);
  for (let x = -hl + 14; x <= hl - 14; x += 12) {
    ctx.fillRect(x - 1, -hw + 4, 2, 2);
    ctx.fillRect(x - 1, hw - 6, 2, 2);
  }

  // Vision slits instead of a windscreen.
  ctx.fillStyle = '#0c0f14';
  ctx.fillRect(hl - 12, -hw + 12, 3, 8);
  ctx.fillRect(hl - 12, hw - 20, 3, 8);

  // Roof hatch, ringed in the crew's colour.
  ctx.fillStyle = shade(body, -0.2);
  ctx.beginPath();
  ctx.arc(-hl * 0.15, 0, 8, 0, Math.PI * 2);
  ctx.fill();
  if (o.driverColor) {
    ctx.strokeStyle = o.driverColor;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  drawLamps(ctx, L, W, o.speed);
}

export interface ActorOptions {
  /** Team colour used for the jacket. */
  color: string;
  aim: number;
  weapon: WeaponId;
  sprinting: boolean;
  /** Walk-cycle phase in radians, driven by movement speed. */
  phase: number;
  moving: boolean;
}

/**
 * Draws a person from above: shoulders, head, and the weapon held out along
 * the aim direction. Called with the canvas already translated to the actor.
 */
export function drawActorBody(ctx: CanvasRenderingContext2D, o: ActorOptions): void {
  const r = PLAYER.radius;
  ctx.save();
  ctx.rotate(o.aim);

  // Legs: a small swing so movement reads even without animation frames.
  const swing = o.moving ? Math.sin(o.phase) * (o.sprinting ? 4.5 : 3) : 0;
  ctx.fillStyle = PLAYER.boots;
  ctx.fillRect(-4, -r * 0.62 + swing, 7, 4.5);
  ctx.fillRect(-4, r * 0.62 - 4.5 - swing, 7, 4.5);

  // Torso: an oval wider across the shoulders than front-to-back.
  ctx.fillStyle = o.color;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.72, r * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PLAYER.outline;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Arms reaching toward the weapon.
  ctx.strokeStyle = o.color;
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(2, -r * 0.5);
  ctx.lineTo(r * 0.75, -3);
  ctx.moveTo(2, r * 0.5);
  ctx.lineTo(r * 0.75, 3);
  ctx.stroke();

  // Weapon, sized from its data so a shotgun reads longer than a pistol.
  const def = weaponDef(o.weapon);
  if (def.class !== 'melee') {
    const len = def.class === 'sidearm' ? 11 : def.class === 'heavy' ? 22 : 17;
    ctx.fillStyle = PLAYER.gun;
    ctx.fillRect(r * 0.55, -2, len, 4);
    ctx.fillStyle = PLAYER.gunHighlight;
    ctx.fillRect(r * 0.55 + len - 3, -2, 3, 2);
  }

  // Head last, so it sits on top of the shoulders.
  ctx.fillStyle = PLAYER.skin;
  ctx.beginPath();
  ctx.arc(1.5, 0, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PLAYER.outline;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

/**
 * Draws a body: a slumped silhouette in the team colour with a spreading pool
 * beneath it. Called with the canvas translated to the corpse position.
 */
export function drawCorpse(
  ctx: CanvasRenderingContext2D,
  color: string,
  aim: number,
  /** 0 at the moment of death, 1 as the body fades out. */
  age: number,
): void {
  const r = PLAYER.radius;

  // Pool, which spreads for the first second or so.
  ctx.save();
  ctx.globalAlpha = 0.55 * (1 - age * 0.55);
  ctx.fillStyle = '#5c1018';
  ctx.beginPath();
  ctx.ellipse(0, 2, r * (1.1 + Math.min(0.7, age * 2.4)), r * (0.8 + Math.min(0.5, age * 1.8)), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 1 - age * 0.8;
  ctx.rotate(aim);

  // Slumped torso: flatter and duller than a standing actor.
  ctx.fillStyle = shade(color, -0.42);
  ctx.beginPath();
  ctx.ellipse(-2, 0, r * 0.78, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PLAYER.outline;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Splayed limbs.
  ctx.strokeStyle = shade(color, -0.5);
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-2, -3);
  ctx.lineTo(r * 0.85, -r * 0.6);
  ctx.moveTo(-2, 3);
  ctx.lineTo(r * 0.5, r * 0.85);
  ctx.stroke();

  ctx.fillStyle = shade(PLAYER.skin, -0.35);
  ctx.beginPath();
  ctx.arc(r * 0.55, 2, r * 0.36, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Lightens (t > 0) or darkens (t < 0) a hex colour. */
export function shade(hex: string, t: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const adjust = (c: number): number =>
    Math.max(0, Math.min(255, Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t))));
  const r = adjust((n >> 16) & 255);
  const g = adjust((n >> 8) & 255);
  const b = adjust(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Icon glyphs for pickups - shapes, not letters, so they read at a glance. */
export function drawPickupIcon(
  ctx: CanvasRenderingContext2D,
  kind: string,
  weapon: WeaponId | undefined,
): void {
  ctx.save();
  switch (kind) {
    case 'health':
      // A bold white-on-red cross reads as "life" at any distance.
      ctx.fillStyle = '#d7263d';
      ctx.fillRect(-3.2, -8.5, 6.4, 17);
      ctx.fillRect(-8.5, -3.2, 17, 6.4);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-1.6, -6.5, 3.2, 13);
      ctx.fillRect(-6.5, -1.6, 13, 3.2);
      break;
    case 'armor':
      // A shield, filled and edged, so it cannot be mistaken for anything else.
      ctx.fillStyle = '#2a1d4d';
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(7.5, -5.5);
      ctx.lineTo(7, 2.5);
      ctx.quadraticCurveTo(5, 7, 0, 9.5);
      ctx.quadraticCurveTo(-5, 7, -7, 2.5);
      ctx.lineTo(-7.5, -5.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#e9e1ff';
      ctx.fillRect(-1, -5, 2, 10);
      break;
    case 'ammo':
      ctx.fillStyle = '#101a2a';
      for (const dx of [-4, 0, 4]) {
        ctx.fillRect(dx - 1.2, -6, 2.4, 9);
        ctx.beginPath();
        ctx.arc(dx, -6, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    default: {
      // Weapon: the shared icon silhouette, so a pickup on the ground is
      // recognisable as the same weapon that appears in the loadout bar.
      if (weapon) drawWeaponIconCanvas(ctx, weapon, 27, '#20180a', '#443208');
      break;
    }
  }
  ctx.restore();
}
