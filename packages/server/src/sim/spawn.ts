import {
  type CollisionGrid,
  type GameMapDef,
  GAMEPLAY,
  NO_TEAM,
  dist2,
} from '@gridlock/shared';

export interface SpawnCandidateSource {
  x: number;
  y: number;
  team: number;
  alive: boolean;
  /** City residents (officers); absent for players. */
  npc?: boolean;
}

export interface SpawnPoint {
  x: number;
  y: number;
}

/**
 * Picks a spawn point inside the team's spawn zone.
 *
 * Candidates are sampled from the zone, rejected if they collide with geometry,
 * then scored: heavily penalised for nearby enemies (which is what stops
 * spawn-camping paying off) and mildly rewarded for nearby living teammates.
 */
export function selectSpawn(
  mapDef: GameMapDef,
  grid: CollisionGrid,
  team: number,
  others: SpawnCandidateSource[],
  rng: () => number,
): SpawnPoint {
  if (team === NO_TEAM) return selectCitySpawn(mapDef, grid, others, rng);
  const zoneDef =
    mapDef.teamSpawns.find((s) => s.team === team) ?? mapDef.teamSpawns[0];
  const zone = zoneDef.zone;
  const r = GAMEPLAY.player.radius;

  let best: SpawnPoint | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < GAMEPLAY.spawn.candidates; i++) {
    const x = zone.x + r + rng() * Math.max(1, zone.w - r * 2);
    const y = zone.y + r + rng() * Math.max(1, zone.h - r * 2);
    if (grid.circleBlocked(x, y, r + 2)) continue;

    let score = 0;
    for (const o of others) {
      if (!o.alive) continue;
      const d2 = dist2(x, y, o.x, o.y);
      if (o.team === team) {
        if (d2 < GAMEPLAY.spawn.allyBonusRadius ** 2) score += 25;
      } else {
        const avoid = GAMEPLAY.spawn.enemyAvoidRadius;
        if (d2 < avoid * avoid) {
          // Closer enemies hurt more, and line of sight is worst of all.
          score -= 400 * (1 - Math.sqrt(d2) / avoid);
          if (grid.lineOfSight(x, y, o.x, o.y)) score -= 500;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }

  if (best) return best;

  // Every sample collided (a badly authored zone) - fall back to the centre and
  // nudge outward until it is clear, so a player never spawns inside a wall.
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;
  if (!grid.circleBlocked(cx, cy, r)) return { x: cx, y: cy };
  for (let radius = 24; radius < 600; radius += 24) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const x = cx + Math.cos(ang) * radius;
      const y = cy + Math.sin(ang) * radius;
      if (!grid.circleBlocked(x, y, r)) return { x, y };
    }
  }
  return { x: cx, y: cy };
}

/**
 * Free roam has no bases. A big world is only social if people meet, so a
 * player arrives within reach of someone already playing - near a random other
 * player, or in the hub town when the world is empty. Water and buildings are
 * solid, so `circleBlocked` alone rejects them. Within that area everyone
 * counts as a threat and the safest sample wins, so a fresh spawn is never
 * dropped next to someone who just killed them.
 */
function selectCitySpawn(
  mapDef: GameMapDef,
  grid: CollisionGrid,
  others: SpawnCandidateSource[],
  rng: () => number,
): SpawnPoint {
  const r = GAMEPLAY.player.radius;
  const avoid = GAMEPLAY.spawn.enemyAvoidRadius;
  const margin = r + 40;
  const near = GAMEPLAY.freeRoam.spawnNearPlayer;
  const players = others.filter((o) => o.alive && !o.npc);
  const anchor = players.length > 0 ? players[Math.floor(rng() * players.length)] : null;
  const area = mapDef.hub ?? { x: 0, y: 0, w: mapDef.width, h: mapDef.height };
  let best: SpawnPoint | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < GAMEPLAY.freeRoam.spawnCandidates; i++) {
    let x: number;
    let y: number;
    if (anchor) {
      const a = rng() * Math.PI * 2;
      const d = near.min + rng() * (near.max - near.min);
      x = anchor.x + Math.cos(a) * d;
      y = anchor.y + Math.sin(a) * d;
    } else {
      x = area.x + rng() * area.w;
      y = area.y + rng() * area.h;
    }
    x = Math.max(margin, Math.min(mapDef.width - margin, x));
    y = Math.max(margin, Math.min(mapDef.height - margin, y));
    if (grid.circleBlocked(x, y, r + 2)) continue;

    let score = 0;
    for (const o of others) {
      if (!o.alive) continue;
      const d2 = dist2(x, y, o.x, o.y);
      if (d2 < avoid * avoid) {
        score -= 400 * (1 - Math.sqrt(d2) / avoid);
        if (grid.lineOfSight(x, y, o.x, o.y)) score -= 500;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  if (best) return best;

  // Vanishingly unlikely on a city map; fall back to the first team zone's
  // search, which already handles a fully blocked sample set.
  return selectSpawn(mapDef, grid, 0, [], rng);
}
