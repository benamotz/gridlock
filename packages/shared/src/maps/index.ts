import type { GameMapDef } from '../types.js';
import { buildHarborCity } from './harborCity.js';
import { buildTestArena } from './testArena.js';

/**
 * Map registry. Definitions are built lazily and cached - generation is
 * deterministic, so the server and every client produce identical geometry.
 */
const builders: Record<string, () => GameMapDef> = {
  'depot-yard': buildTestArena,
  'harbor-reach': buildHarborCity,
};

const cache = new Map<string, GameMapDef>();

export function getMap(id: string): GameMapDef {
  const cached = cache.get(id);
  if (cached) return cached;
  const build = builders[id];
  if (!build) throw new Error(`Unknown map id: ${id}`);
  const def = build();
  cache.set(id, def);
  return def;
}

export const mapIds = (): string[] => Object.keys(builders);

export interface MapSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  modes: GameMapDef['modes'];
  recommendedPlayers: number;
  maxTeams: number;
}

export const mapSummaries = (): MapSummary[] =>
  mapIds().map((id) => {
    const m = getMap(id);
    return {
      id: m.id,
      name: m.name,
      width: m.width,
      height: m.height,
      modes: m.modes,
      recommendedPlayers: m.recommendedPlayers,
      maxTeams: m.maxTeams,
    };
  });

export { buildTestArena, buildHarborCity };
