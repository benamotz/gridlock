import type { MatchConfig } from './types.js';

/** Baseline match settings. Room hosts override individual fields. */
export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  mapId: 'harbor-reach',
  mode: 'tdm',
  teamCount: 2,
  teamSize: 4,
  scoreTarget: 40,
  matchDurationSec: 720,
  respawnDelaySec: 5,
  loadoutRule: 'fixed',
  botsEnabled: true,
  botDifficulty: 'normal',
  friendlyFire: false,
  vehiclesEnabled: true,
};

/** Quick-play uses the small map and a shorter target for faster iteration. */
export const QUICKPLAY_CONFIG: MatchConfig = {
  ...DEFAULT_MATCH_CONFIG,
  mapId: 'depot-yard',
  scoreTarget: 25,
  matchDurationSec: 480,
};

export const PRACTICE_CONFIG: MatchConfig = {
  ...DEFAULT_MATCH_CONFIG,
  mapId: 'depot-yard',
  teamCount: 2,
  teamSize: 4,
  scoreTarget: 15,
  matchDurationSec: 480,
  botsEnabled: true,
};

/**
 * The always-on city. Durations are 0 because the world never ends; team
 * fields only satisfy `MatchConfig` - every free-roam player is `NO_TEAM`.
 */
export const FREEROAM_CONFIG: MatchConfig = {
  ...DEFAULT_MATCH_CONFIG,
  mapId: 'kestrel-region',
  mode: 'freeroam',
  scoreTarget: 0,
  matchDurationSec: 0,
  respawnDelaySec: 4,
  botsEnabled: false,
};

/** Hard cap on humans in one match for this milestone (see README roadmap). */
export const MAX_PLAYERS_PER_MATCH = 20;
export const MVP_MAX_HUMANS = 8;
