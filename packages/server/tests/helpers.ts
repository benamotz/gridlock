import { DEFAULT_MATCH_CONFIG, getMap, type MatchConfig } from '@gridlock/shared';
import { World } from '../src/sim/World.js';
import { createMode } from '../src/modes/index.js';
import type { GameMode } from '../src/modes/GameMode.js';
import type { PlayerEntity } from '../src/sim/entities.js';

export interface Harness {
  world: World;
  mode: GameMode;
  /** Advances the simulation by `ms` of game time. */
  advance(ms: number): void;
}

/** Builds a deterministic world plus its game mode, wired the way a room does. */
export function makeWorld(overrides: Partial<MatchConfig> = {}, seed = 42): Harness {
  const config: MatchConfig = {
    ...DEFAULT_MATCH_CONFIG,
    mapId: 'depot-yard',
    teamCount: 2,
    teamSize: 4,
    ...overrides,
  };
  const world = new World(getMap(config.mapId), config, seed);
  const mode = createMode(config);
  world.onKill = (victim, killer) => {
    mode.onKill(world, victim, killer);
    return mode.respawnDelayMs(world, victim);
  };
  mode.onMatchStart(world);

  return {
    world,
    mode,
    advance(ms: number) {
      const steps = Math.max(1, Math.round(ms / (world.dt * 1000)));
      for (let i = 0; i < steps; i++) {
        world.step();
        mode.update(world);
      }
    },
  };
}

/** Adds a player at an exact position, clear of spawn-point selection. */
export function placePlayer(
  world: World,
  id: string,
  team: number,
  x: number,
  y: number,
): PlayerEntity {
  const p = world.addPlayer(id, id, team, false);
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  // Tests care about mechanics, not the spawn shield.
  p.spawnProtectedUntil = 0;
  return p;
}

/** An open stretch of the test arena, clear of geometry. */
export const OPEN = { x: 960, y: 300 };
