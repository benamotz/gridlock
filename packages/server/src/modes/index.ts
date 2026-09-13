import type { GameModeId, MatchConfig } from '@gridlock/shared';
import type { GameMode } from './GameMode.js';
import { TeamDeathmatch } from './TeamDeathmatch.js';

/**
 * Mode registry.
 *
 * Capture the Flag and Battle Royale are the next milestones; they slot in here
 * by implementing `GameMode`. Until then, requesting them falls back to TDM
 * rather than failing a room creation.
 */
const factories: Partial<Record<GameModeId, (c: MatchConfig) => GameMode>> = {
  tdm: (c) => new TeamDeathmatch(c),
};

export function createMode(config: MatchConfig): GameMode {
  const factory = factories[config.mode] ?? factories.tdm!;
  return factory(config);
}

export const implementedModes = (): GameModeId[] =>
  Object.keys(factories) as GameModeId[];

export * from './GameMode.js';
export { TeamDeathmatch };
