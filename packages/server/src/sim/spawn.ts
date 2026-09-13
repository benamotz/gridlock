import {
  type CollisionGrid,
  type GameMapDef,
  GAMEPLAY,
  dist2,
} from '@gridlock/shared';

export interface SpawnCandidateSource {
  x: number;
  y: number;
  team: number;
  alive: boolean;
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
