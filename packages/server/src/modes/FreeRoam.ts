import type { MatchConfig } from '@gridlock/shared';
import type { PlayerEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';
import { CityDirector } from '../npc/CityDirector.js';
import { Economy } from '../economy/Economy.js';
import type { GameMode, MatchResult } from './GameMode.js';

/**
 * The always-on city.
 *
 * There is nothing to win: the world never ends, nobody is on a team, and
 * kills only feed each player's own stats (which combat already records). The
 * mode owns the city's residents - pedestrians, traffic and police - through
 * the `CityDirector`, and its money through the `Economy`.
 */
export class FreeRoam implements GameMode {
  readonly id = 'freeroam' as const;
  readonly name = 'Free Roam';
  director: CityDirector | null = null;
  economy: Economy | null = null;

  constructor(private readonly config: MatchConfig) {}

  onMatchStart(world: World): void {
    this.director = new CityDirector(world);
    this.economy = new Economy(world, this.director);
    world.city = this.economy;
  }

  update(): void {
    this.director?.update();
    this.economy?.update();
  }

  onKill(_world: World, victim: PlayerEntity, killer: PlayerEntity | null): void {
    this.economy?.onKill(victim, killer);
  }

  teamScores(): number[] {
    return [];
  }

  checkEnd(_world: World, _elapsedMs: number): MatchResult | null {
    return null;
  }

  respawnDelayMs(_world: World, p: PlayerEntity): number {
    // Residents never respawn; the director clears the body and replaces them.
    if (p.npc) return Infinity;
    return this.config.respawnDelaySec * 1000;
  }

  objectiveText(): string {
    return 'Free roam - the city never sleeps.';
  }
}
