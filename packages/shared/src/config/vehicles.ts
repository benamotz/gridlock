import type { VehicleDef, VehicleTypeId } from '../types.js';

/**
 * The vehicle roster.
 *
 * Six categories, each built around a trade-off rather than a size step, so
 * choosing a vehicle is a tactical decision:
 *
 *   Motorcycle - fastest off the line, riders exposed to gunfire
 *   Car        - the balanced all-rounder
 *   Sports Car - highest top speed, slides and breaks easily
 *   Van        - carries a full squad, slow and wide
 *   Truck      - a battering ram that smashes defences, sluggish
 *   Armored    - shrugs off bullets, still vulnerable to explosives
 *
 * All handling, durability and damage values are data here; the physics and
 * combat code only ever read them.
 */
export const VEHICLES: Record<VehicleTypeId, VehicleDef> = {
  motorcycle: {
    id: 'motorcycle', category: 'Motorcycle', name: 'Wasp 250',
    length: 48, width: 18,
    maxSpeed: 500, reverseSpeed: 90, acceleration: 720, braking: 620, drag: 1.5,
    steering: 4.7, steeringAtSpeed: 0.55, grip: 0.02,
    durability: 110, mass: 0.4, seats: 2, ramDamage: 0.25, cameraZoom: 0.64,
    bulletDamageMult: 1.3, explosiveDamageMult: 1.4, shieldsOccupants: false,
    demolition: 0.2, inlineSeats: true,
    crashDamageMult: 0.3, wreckBlast: 0, topplesWhenRiderless: true,
    pros: ['Fastest acceleration', 'Very agile', 'Threads through alleys'],
    cons: ['Riders exposed to gunfire', 'Fragile', '2 seats'],
    color: '#ff9f4d',
  },
  car: {
    id: 'car', category: 'Car', name: 'Corvid Sedan',
    length: 72, width: 36,
    maxSpeed: 390, reverseSpeed: 160, acceleration: 450, braking: 600, drag: 1.35,
    steering: 3.4, steeringAtSpeed: 0.58, grip: 0.025,
    durability: 340, mass: 1.2, seats: 4, ramDamage: 0.5, cameraZoom: 0.70,
    bulletDamageMult: 1.0, explosiveDamageMult: 1.0, shieldsOccupants: true,
    demolition: 0.7, crashDamageMult: 1.0, wreckBlast: 1.0,
    pros: ['Well balanced', '4 seats', 'Easy to handle'],
    cons: ['No standout strength'],
    color: '#c8cede',
  },
  sports: {
    id: 'sports', category: 'Sports Car', name: 'Vanta GT',
    length: 72, width: 34,
    maxSpeed: 560, reverseSpeed: 160, acceleration: 640, braking: 740, drag: 1.2,
    steering: 3.3, steeringAtSpeed: 0.40, grip: 0.07,
    durability: 220, mass: 1.05, seats: 2, ramDamage: 0.6, cameraZoom: 0.58,
    bulletDamageMult: 1.15, explosiveDamageMult: 1.2, shieldsOccupants: true,
    demolition: 0.6, crashDamageMult: 1.0, wreckBlast: 0.9,
    pros: ['Highest top speed', 'Strong acceleration'],
    cons: ['Slides at speed', 'Light armour', '2 seats'],
    color: '#ff5f7e',
  },
  van: {
    id: 'van', category: 'Van', name: 'Haulmate Van',
    length: 96, width: 44,
    maxSpeed: 320, reverseSpeed: 135, acceleration: 340, braking: 500, drag: 1.5,
    steering: 2.6, steeringAtSpeed: 0.60, grip: 0.02,
    durability: 540, mass: 1.9, seats: 6, ramDamage: 0.7, cameraZoom: 0.72,
    bulletDamageMult: 0.85, explosiveDamageMult: 1.0, shieldsOccupants: true,
    demolition: 1.1, crashDamageMult: 0.9, wreckBlast: 1.1,
    pros: ['6 seats - moves a squad', 'Sturdy', 'Good cover for riders'],
    cons: ['Slow', 'Wide turning circle', 'Big target'],
    color: '#e6d3a3',
  },
  truck: {
    id: 'truck', category: 'Truck', name: 'Ironback Hauler',
    length: 126, width: 50,
    maxSpeed: 290, reverseSpeed: 110, acceleration: 250, braking: 440, drag: 1.7,
    steering: 2.0, steeringAtSpeed: 0.66, grip: 0.02,
    durability: 820, mass: 3.2, seats: 3, ramDamage: 1.2, cameraZoom: 0.74,
    bulletDamageMult: 0.7, explosiveDamageMult: 0.9, shieldsOccupants: true,
    demolition: 3.0, crashDamageMult: 0.6, wreckBlast: 1.4,
    pros: ['Smashes barricades', 'Devastating ram', 'Very durable'],
    cons: ['Slowest to accelerate', 'Hard to turn', '3 seats'],
    color: '#c98a4b',
  },
  armored: {
    id: 'armored', category: 'Armored', name: 'Bastion APC',
    length: 102, width: 48,
    maxSpeed: 300, reverseSpeed: 120, acceleration: 280, braking: 480, drag: 1.6,
    steering: 2.3, steeringAtSpeed: 0.62, grip: 0.02,
    durability: 1000, mass: 2.8, seats: 4, ramDamage: 0.9, cameraZoom: 0.72,
    bulletDamageMult: 0.3, explosiveDamageMult: 1.1, shieldsOccupants: true,
    demolition: 2.0, crashDamageMult: 0.5, wreckBlast: 1.2,
    pros: ['Nearly bulletproof', 'Huge durability', '4 seats'],
    cons: ['Rare', 'Slow', 'Explosives and mines still hurt'],
    color: '#6f7d55',
  },
};

export const vehicleDef = (id: VehicleTypeId): VehicleDef => VEHICLES[id];

export const vehicleTypes = Object.keys(VEHICLES) as VehicleTypeId[];

/**
 * Spawn weighting for maps that ask for a random vehicle. Cars are common;
 * the armored carrier is a rare prize worth fighting over.
 */
export const VEHICLE_SPAWN_WEIGHTS: { type: VehicleTypeId; weight: number }[] = [
  { type: 'car', weight: 3.0 },
  { type: 'motorcycle', weight: 1.8 },
  { type: 'van', weight: 1.4 },
  { type: 'sports', weight: 1.0 },
  { type: 'truck', weight: 0.8 },
  { type: 'armored', weight: 0.3 },
];

/** Picks a vehicle type using the spawn weights and an injectable RNG. */
export function rollVehicleType(rng: () => number): VehicleTypeId {
  const total = VEHICLE_SPAWN_WEIGHTS.reduce((sum, v) => sum + v.weight, 0);
  let r = rng() * total;
  for (const entry of VEHICLE_SPAWN_WEIGHTS) {
    r -= entry.weight;
    if (r <= 0) return entry.type;
  }
  return 'car';
}

/**
 * Normalised 0..1 ratings for the HUD vehicle card, computed from the data so
 * the card can never disagree with how the vehicle actually behaves.
 */
export function vehicleRatings(def: VehicleDef): {
  speed: number; acceleration: number; handling: number; armour: number; ram: number;
} {
  const all = Object.values(VEHICLES);
  const range = (pick: (v: VehicleDef) => number) => {
    const values = all.map(pick);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return (v: number) => (hi > lo ? 0.12 + 0.88 * ((v - lo) / (hi - lo)) : 1);
  };
  // Effective toughness: raw durability divided by how much bullets hurt.
  const toughness = (v: VehicleDef) => v.durability / v.bulletDamageMult;
  return {
    speed: range((v) => v.maxSpeed)(def.maxSpeed),
    acceleration: range((v) => v.acceleration)(def.acceleration),
    handling: range((v) => v.steering)(def.steering),
    armour: range(toughness)(toughness(def)),
    ram: range((v) => v.ramDamage * v.mass)(def.ramDamage * def.mass),
  };
}

/**
 * A vehicle's collision body: equal circles in a row along its length, each
 * with a radius of half the width, spaced so they overlap and so the end
 * circles reach exactly the nose and the tail.
 *
 * A single circle cannot describe a long, narrow body - with one of radius
 * `width / 2`, a truck's nose went 38 units into a wall and a motorcycle's 15.
 * A row of circles keeps the collision within a few units of the drawn shape
 * while staying compatible with the circle-based collision grid.
 */
export function vehicleBodyCircles(def: VehicleDef): { radius: number; offsets: number[] } {
  const radius = def.width / 2;
  const span = Math.max(0, def.length - def.width);
  if (span === 0) return { radius, offsets: [0] };
  const count = Math.ceil(span / radius) + 1;
  const offsets = Array.from({ length: count }, (_, i) => -span / 2 + (span * i) / (count - 1));
  return { radius, offsets };
}

/** The body circles of a vehicle placed in the world. */
export function vehicleBodyWorld(v: {
  x: number; y: number; rot: number; type: VehicleTypeId;
}): { x: number; y: number; r: number }[] {
  const { radius, offsets } = vehicleBodyCircles(VEHICLES[v.type]);
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  return offsets.map((o) => ({ x: v.x + c * o, y: v.y + s * o, r: radius }));
}

/**
 * Where each seat sits in the vehicle's local frame, nose pointing +x.
 *
 * Seat 0 is the driver. Cars and vans fill front-to-back in side-by-side
 * pairs; a motorcycle seats its passenger directly behind the rider. Either
 * way, passengers get a firing position offset from the body centre.
 */
export function seatOffset(def: VehicleDef, index: number): { x: number; y: number } {
  if (def.inlineSeats) {
    return { x: def.length * 0.1 - index * def.length * 0.3, y: 0 };
  }
  const rows = Math.max(1, Math.ceil(def.seats / 2));
  const row = Math.floor(index / 2);
  const side = index % 2 === 0 ? -1 : 1;
  const usable = def.length * 0.62;
  const step = rows > 1 ? usable / (rows - 1) : 0;
  const x = usable / 2 - row * step;
  const y = (def.width * 0.26) * (def.seats > 1 ? side : 0);
  return { x, y };
}

/** Seat index of a player in a vehicle: 0 for the driver, 1+ for passengers. */
export function seatIndexOf(
  driverId: string | null,
  passengers: readonly string[],
  playerId: string,
): number {
  if (driverId === playerId) return 0;
  const i = passengers.indexOf(playerId);
  return i < 0 ? -1 : i + 1;
}
