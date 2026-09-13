import { RoomManager } from '../src/rooms/RoomManager.js';
import { MemoryStore } from '../src/persistence/index.js';

const store = new MemoryStore();
const rooms = new RoomManager(store);
const room = rooms.createRoom('host', { mapId: 'depot-yard', scoreTarget: 99999, matchDurationSec: 99999 }, true);

let sent = 0;
room.join('host', 'Host', { send: () => { sent++; }, close: () => {} });
room.requestStart('host');

const report = (label: string) => {
  const w = room.simulation;
  console.log(label, JSON.stringify({
    members: room.members.size,
    heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
    sent,
    pickups: w?.pickups.size, vehicles: w?.vehicles.size,
    events: w?.events.length, killFeed: w?.killFeed.length,
    tick: w?.tick,
  }));
};

let n = 0;
const iv = setInterval(() => {
  n++;
  report(`t=${n * 10}s`);
  if (n >= 12) {
    clearInterval(iv);
    rooms.shutdown();
    process.exit(0);
  }
}, 10000);
