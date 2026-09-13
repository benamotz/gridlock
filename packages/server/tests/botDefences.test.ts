import { describe, expect, it } from 'vitest';
import { DEPLOYABLES, deployZoneFor, makeRng, pointInRect } from '@gridlock/shared';
import { makeWorld, type Harness } from './helpers.js';
import { BotController, botDeployCount, botShare } from '../src/bots/BotController.js';
import { teamDeployCount, tryDeploy } from '../src/sim/deployables.js';

/** Drives bots the way `Room.driveBots` does, defence requests included. */
function simulate(h: Harness, bots: BotController[], ms: number): void {
  const stepMs = h.world.dt * 1000;
  const steps = Math.round(ms / stepMs);
  for (let i = 0; i < steps; i++) {
    for (const bot of bots) {
      const cmd = bot.think(h.world, stepMs);
      if (cmd) h.world.queueInput(bot.playerId, [cmd]);
      const request = bot.takeDeployRequest();
      const me = h.world.players.get(bot.playerId);
      if (request && me) {
        bot.onDeployResult(tryDeploy(h.world, me, request.kind, request.rot, request.aim));
      }
    }
    h.world.step();
    h.mode.update(h.world);
  }
}

const botsOnTeam = (h: Harness, team: number, count: number): BotController[] => {
  const rng = makeRng(17);
  return Array.from({ length: count }, (_, i) => {
    const id = `bot${team}-${i}`;
    h.world.addPlayer(id, id, team, true);
    return BotController.forDifficulty(id, 'normal', rng, { fortifyChance: 1 });
  });
};

describe('bots and base defences', () => {
  it('fortify their own base after spawning', () => {
    const h = makeWorld({}, 5);
    const bots = botsOnTeam(h, 0, 4);
    simulate(h, bots, 20_000);

    const placed = [...h.world.deployables.values()].filter((d) => d.team === 0);
    expect(placed.length).toBeGreaterThan(0);
    const zone = deployZoneFor(h.world.mapDef, 0);
    for (const d of placed) expect(pointInRect(d.x, d.y, zone)).toBe(true);
  });

  it('leave at least half of every defence limit for human teammates', () => {
    const h = makeWorld({}, 9);
    const bots = botsOnTeam(h, 0, 8);
    simulate(h, bots, 30_000);

    for (const kind of Object.keys(DEPLOYABLES) as (keyof typeof DEPLOYABLES)[]) {
      const limit = DEPLOYABLES[kind].teamLimit;
      expect(botDeployCount(h.world, 0, kind)).toBeLessThanOrEqual(botShare(limit));
      expect(teamDeployCount(h.world, 0, kind)).toBeLessThan(limit);
    }
  });
});
