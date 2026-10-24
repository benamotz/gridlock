import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GAMEPLAY, NO_TEAM, type ServerMessage, parseClientMessage, pointInRect,
} from '@gridlock/shared';
import { RoomManager } from '../src/rooms/RoomManager.js';
import { MemoryStore } from '../src/persistence/index.js';

function fakeSocket() {
  const messages: ServerMessage[] = [];
  return {
    messages,
    send: (m: ServerMessage) => { messages.push(m); },
    close: () => {},
  };
}

const managers: RoomManager[] = [];
function newManager(): RoomManager {
  const m = new RoomManager(new MemoryStore());
  managers.push(m);
  return m;
}

afterEach(() => {
  for (const m of managers.splice(0)) m.shutdown();
  vi.useRealTimers();
});

describe('always-on city', () => {
  it('is live before anyone arrives and is the same world for everyone', () => {
    const rooms = newManager();
    const city = rooms.freeRoam();
    expect(city.phase).toBe('active');
    expect(city.simulation).not.toBeNull();
    expect(rooms.freeRoam()).toBe(city);
  });

  it('drops a joining player straight into the world, on no team', () => {
    const rooms = newManager();
    const city = rooms.freeRoam();
    const sock = fakeSocket();
    city.join('a', 'Alex', sock);

    expect(sock.messages.some((m) => m.t === 'match_start')).toBe(true);
    expect(city.members.get('a')!.team).toBe(NO_TEAM);
    expect(city.simulation!.players.get('a')!.life).toBe('alive');
  });

  it('keeps running after everyone leaves, well past the empty-room timeout', () => {
    vi.useFakeTimers();
    const rooms = newManager();
    const city = rooms.freeRoam();
    city.join('a', 'Alex', fakeSocket());
    city.leave('a');

    vi.advanceTimersByTime((GAMEPLAY.match.emptyRoomTimeoutSec + 5) * 1000);
    expect(rooms.list()).toContain(city);
    expect(rooms.freeRoam()).toBe(city);
    expect(city.phase).toBe('active');
  });

  it('lets a player who never returns leave, instead of a bot taking their place', () => {
    vi.useFakeTimers();
    const rooms = newManager();
    const city = rooms.freeRoam();
    city.join('a', 'Alex', fakeSocket());
    city.markDisconnected('a');

    vi.advanceTimersByTime((GAMEPLAY.match.reconnectGraceSec + 1) * 1000);
    expect(city.members.has('a')).toBe(false);
    expect(city.simulation!.players.has('a')).toBe(false);
  });

  it('is never chosen by quick play', () => {
    const rooms = newManager();
    const city = rooms.freeRoam();
    const room = rooms.quickPlay('q');
    expect(room).not.toBe(city);
    expect(rooms.bestPublicRoom()).not.toBe(city);
  });

  it('fills at the free-roam cap, not the team-match cap', () => {
    const rooms = newManager();
    const city = rooms.freeRoam();
    for (let i = 0; i < GAMEPLAY.freeRoam.maxPlayers - 1; i++) {
      city.join(`p${i}`, `P${i}`, fakeSocket());
    }
    expect(city.isFull).toBe(false);
    city.join('last', 'Last', fakeSocket());
    expect(city.isFull).toBe(true);
  });

  it('drops the first arrival in the hub town and later ones near someone', () => {
    const rooms = newManager();
    const city = rooms.freeRoam();
    const world = city.simulation!;
    const hub = world.mapDef.hub!;
    city.join('first', 'First', fakeSocket());
    const first = world.players.get('first')!;
    expect(pointInRect(first.x, first.y, hub)).toBe(true);

    for (let i = 0; i < 6; i++) {
      city.join(`p${i}`, `P${i}`, fakeSocket());
      const p = world.players.get(`p${i}`)!;
      expect(world.grid.circleBlocked(p.x, p.y, GAMEPLAY.player.radius)).toBe(false);
      const nearest = Math.min(...[...world.players.values()]
        .filter((o) => o.id !== p.id && !o.npc)
        .map((o) => Math.hypot(o.x - p.x, o.y - p.y)));
      expect(nearest).toBeLessThan(GAMEPLAY.freeRoam.spawnNearPlayer.max + 50);
    }
  });

  it('lets any two players hurt each other', () => {
    const rooms = newManager();
    const city = rooms.freeRoam();
    city.join('a', 'Alex', fakeSocket());
    city.join('b', 'Blair', fakeSocket());
    const world = city.simulation!;
    expect(world.canDamage(world.players.get('a')!, world.players.get('b')!)).toBe(true);
  });

  it('refuses base defences, which need a team base', () => {
    const rooms = newManager();
    const city = rooms.freeRoam();
    city.join('a', 'Alex', fakeSocket());
    const result = city.handleDeploy('a', 'barricade');
    expect(result?.ok).toBe(false);
  });

  it('cannot be cloned by a client-created room', () => {
    const msg = parseClientMessage({
      t: 'create_room', config: { mode: 'freeroam' }, isPrivate: true,
    });
    expect(msg?.t).toBe('create_room');
    if (msg?.t !== 'create_room') throw new Error('unreachable');
    expect(msg.config.mode).not.toBe('freeroam');
  });
});
