import { getMap, DEFAULT_MATCH_CONFIG } from '@gridlock/shared';
import { World } from '../src/sim/World.js';
import { BotController } from '../src/bots/BotController.js';
import { createMode } from '../src/modes/index.js';
import { makeRng } from '@gridlock/shared';

const config = { ...DEFAULT_MATCH_CONFIG, mapId: 'depot-yard', scoreTarget: 99999, teamSize: 4 };
const world = new World(getMap(config.mapId), config, 1234);
const mode = createMode(config);
world.onKill = (v, k) => { mode.onKill(world, v, k); return mode.respawnDelayMs(world, v); };
const rng = makeRng(7);
const bots: BotController[] = [];
for (let t = 0; t < 2; t++) {
  for (let i = 0; i < 4; i++) {
    const id = `b${t}-${i}`;
    world.addPlayer(id, id, t, true);
    bots.push(BotController.forDifficulty(id, 'normal', rng));
  }
}

const sizes = () => ({
  players: world.players.size, vehicles: world.vehicles.size,
  proj: world.projectiles.size, pickups: world.pickups.size,
  events: world.events.length, killFeed: world.killFeed.length,
  pendingVeh: world.pendingVehicleSpawns.length,
  pendingCmds: [...world.players.values()].reduce((s, p) => s + p.pending.length, 0),
  heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
});

const TICKS = 30 * 240; // 4 simulated minutes
for (let i = 1; i <= TICKS; i++) {
  for (const b of bots) {
    const cmd = b.think(world, 1000 / 30);
    if (cmd) world.queueInput(b.playerId, [cmd]);
  }
  world.step();
  mode.update(world);
  if (i % 2 === 0) world.events = [];
  if (i % (30 * 30) === 0) console.log(`t=${(i / 30).toFixed(0)}s`, JSON.stringify(sizes()));
}
console.log('scores', mode.teamScores(world));
