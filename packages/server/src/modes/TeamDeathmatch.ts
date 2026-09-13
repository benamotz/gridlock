import type { MatchConfig } from '@gridlock/shared';
import type { PlayerEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';
import type { GameMode, MatchResult } from './GameMode.js';

/**
 * Team Deathmatch.
 *
 * Every elimination scores one point for the killer's team; a self-inflicted
 * death takes one back off the victim's team instead of rewarding anyone. The
 * first team to the score target wins, otherwise the highest score when the
 * clock expires takes it, and an exact tie is a draw.
 */
export class TeamDeathmatch implements GameMode {
  readonly id = 'tdm' as const;
  readonly name = 'Team Deathmatch';
  private scores: number[];

  constructor(private readonly config: MatchConfig) {
    this.scores = new Array(config.teamCount).fill(0);
  }

  onMatchStart(): void {
    this.scores = new Array(this.config.teamCount).fill(0);
  }

  update(): void {
    // Scoring is entirely event-driven; nothing to do per tick.
  }

  onKill(world: World, victim: PlayerEntity, killer: PlayerEntity | null): void {
    const suicide = !killer || killer.id === victim.id;
    if (suicide) {
      if (victim.team >= 0 && victim.team < this.scores.length) {
        this.scores[victim.team] = Math.max(0, this.scores[victim.team] - 1);
      }
      return;
    }
    // A friendly-fire kill costs the team a point rather than gaining one.
    if (killer.team === victim.team) {
      if (killer.team >= 0 && killer.team < this.scores.length) {
        this.scores[killer.team] = Math.max(0, this.scores[killer.team] - 1);
      }
      return;
    }
    if (killer.team >= 0 && killer.team < this.scores.length) {
      this.scores[killer.team]++;
    }
  }

  teamScores(): number[] {
    return this.scores.slice();
  }

  checkEnd(world: World, elapsedMs: number): MatchResult | null {
    const target = this.config.scoreTarget;
    let leader = 0;
    for (let t = 1; t < this.scores.length; t++) {
      if (this.scores[t] > this.scores[leader]) leader = t;
    }

    if (this.scores[leader] >= target) {
      return { winningTeam: leader, reason: 'score' };
    }

    if (elapsedMs >= this.config.matchDurationSec * 1000) {
      const top = this.scores[leader];
      const tied = this.scores.filter((s) => s === top).length > 1;
      return { winningTeam: tied ? null : leader, reason: 'time' };
    }
    return null;
  }

  respawnDelayMs(): number {
    return this.config.respawnDelaySec * 1000;
  }

  objectiveText(): string {
    return `Eliminate the enemy team. First to ${this.config.scoreTarget}.`;
  }
}
