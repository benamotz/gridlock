import type { GameModeId, MatchConfig } from '@gridlock/shared';
import type { PlayerEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';

export interface MatchResult {
  winningTeam: number | null;
  reason: 'score' | 'time' | 'lastStanding' | 'aborted';
}

/**
 * A game mode owns everything about how a match is won.
 *
 * The room drives the simulation; the mode only observes it and decides
 * scoring, respawn policy and the end condition. New modes plug in through the
 * registry at the bottom of this file without touching the room or the world.
 */
export interface GameMode {
  readonly id: GameModeId;
  readonly name: string;

  /** Called once when the match starts, after the world exists. */
  onMatchStart(world: World): void;

  /** Called every tick, after the world has stepped. */
  update(world: World): void;

  /** Called when a player is killed, before respawn is scheduled. */
  onKill(world: World, victim: PlayerEntity, killer: PlayerEntity | null): void;

  /** Per-team score used by the HUD and the results screen. */
  teamScores(world: World): number[];

  /** Non-null once the match is decided. */
  checkEnd(world: World, elapsedMs: number): MatchResult | null;

  /** Respawn delay in ms, or null when the player should not respawn at all. */
  respawnDelayMs(world: World, player: PlayerEntity): number | null;

  /** Short instruction shown in the HUD. */
  objectiveText(): string;
}

export interface ModeContext {
  config: MatchConfig;
}

export type ModeFactory = (ctx: ModeContext) => GameMode;
