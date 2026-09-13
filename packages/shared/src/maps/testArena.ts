import type { GameMapDef } from '../types.js';
import { MapBuilder } from './builder.js';

/**
 * "Depot Yard" - the small testing map.
 *
 * Deliberately compact: everything (spawn, cover, a vehicle, every pickup type,
 * and both bases) is reachable in a few seconds so combat, pickups, respawning
 * and networking can be exercised without a cross-city commute.
 */
export function buildTestArena(): GameMapDef {
  const W = 1920;
  const H = 1280;
  const b = new MapBuilder(W, H, 0x51ee7);

  b.zone('industrial', { x: 0, y: 0, w: W, h: H }, 'Depot Yard');
  b.zone('road', { x: 0, y: H / 2 - 90, w: W, h: 180 });
  b.zone('road', { x: W / 2 - 90, y: 0, w: 180, h: H });
  b.zone('base', { x: 60, y: H / 2 - 150, w: 260, h: 300 }, 'West Dock', 0);
  b.zone('base', { x: W - 320, y: H / 2 - 150, w: 260, h: 300 }, 'East Dock', 1);
  b.borderWalls();

  // Four container clusters give cover without long uninterrupted sightlines.
  const clusters: [number, number][] = [
    [430, 250], [430, H - 250], [W - 430, 250], [W - 430, H - 250],
  ];
  for (const [cx, cy] of clusters) {
    b.building({ x: cx - 110, y: cy - 60, w: 130, h: 52 }, 1);
    b.building({ x: cx + 40, y: cy - 10, w: 100, h: 120 }, 2);
    b.prop({ x: cx - 90, y: cy + 60, w: 60, h: 60 });
  }

  // Central block breaks the base-to-base sightline.
  b.building({ x: W / 2 - 70, y: H / 2 - 140, w: 140, h: 90 }, 3);
  b.building({ x: W / 2 - 70, y: H / 2 + 50, w: 140, h: 90 }, 3);

  b.weaponPickup(W / 2, 170, 'shotgun');
  b.weaponPickup(W / 2, H - 170, 'rifle');
  b.weaponPickup(300, H / 2, 'smg');
  b.weaponPickup(W - 300, H / 2, 'smg');
  b.weaponPickup(W / 2, H / 2, undefined, 3);
  b.ammoPickup(640, 320);
  b.ammoPickup(640, H - 320);
  b.ammoPickup(W - 640, 320);
  b.ammoPickup(W - 640, H - 320);
  b.healthPickup(W / 2 - 260, H / 2);
  b.healthPickup(W / 2 + 260, H / 2);
  b.armorPickup(W / 2, H / 2 - 300);
  // Extra health and armour out on the flanks, so stocking the pouch is a
  // reason to leave the centre lane.
  b.healthPickup(250, 160);
  b.healthPickup(W - 250, H - 160);
  b.armorPickup(W - 250, 160);
  b.armorPickup(250, H - 160);

  // One of each handling extreme, so the test map exercises the whole roster.
  b.vehicle(700, H / 2 - 250, 0, 'van');
  b.vehicle(W - 700, H / 2 + 250, Math.PI, 'car');
  b.vehicle(700, H / 2 + 250, 0, 'motorcycle');
  b.vehicle(W - 700, H / 2 - 250, Math.PI, 'sports');
  b.vehicle(W / 2, H / 2 + 330, 0, 'truck');
  b.vehicle(W / 2, H / 2 - 330, Math.PI, 'armored');
  b.pruneBlockedSpawns();

  return {
    id: 'depot-yard',
    name: 'Depot Yard',
    width: W,
    height: H,
    tileSize: 32,
    zones: b.zones,
    solids: b.solids,
    teamSpawns: [
      { team: 0, zone: { x: 80, y: H / 2 - 130, w: 220, h: 260 } },
      { team: 1, zone: { x: W - 300, y: H / 2 - 130, w: 220, h: 260 } },
      { team: 2, zone: { x: W / 2 - 110, y: 70, w: 220, h: 160 } },
      { team: 3, zone: { x: W / 2 - 110, y: H - 230, w: 220, h: 160 } },
    ],
    vehicleSpawns: b.vehicleSpawns,
    pickupSpawns: b.pickupSpawns,
    flagBases: [
      { team: 0, x: 190, y: H / 2, captureRadius: 70 },
      { team: 1, x: W - 190, y: H / 2, captureRadius: 70 },
    ],
    safeZone: { x: W / 2, y: H / 2, startRadius: 1100 },
    modes: ['tdm', 'ctf', 'br'],
    recommendedPlayers: 8,
    maxTeams: 4,
  };
}
