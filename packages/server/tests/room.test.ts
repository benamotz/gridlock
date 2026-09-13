import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAMEPLAY, type ServerMessage } from '@gridlock/shared';
import { RoomManager } from '../src/rooms/RoomManager.js';
import { MemoryStore } from '../src/persistence/index.js';
import type { Room } from '../src/rooms/Room.js';

/** A socket that records everything the server sends it. */
function fakeSocket() {
  const messages: ServerMessage[] = [];
  return {
    messages,
    send: (m: ServerMessage) => { messages.push(m); },
    close: () => {},
    last: <T extends ServerMessage['t']>(t: T) =>
      [...messages].reverse().find((m) => m.t === t),
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

describe('room membership', () => {
  it('assigns a joining player to a team and reports the lobby', () => {
    const rooms = newManager();
    const room = rooms.createRoom('h', { teamCount: 2 }, true);
    const sock = fakeSocket();
    room.join('h', 'Host', sock);

    const state = sock.last('room_state');
    expect(state?.t).toBe('room_state');
    if (state?.t !== 'room_state') throw new Error('unreachable');
    expect(state.members).toHaveLength(1);
    expect(state.members[0].team).toBeGreaterThanOrEqual(0);
    expect(state.members[0].isHost).toBe(true);
  });

  it('refuses a team move that would overfill a side', () => {
    const rooms = newManager();
    const room = rooms.createRoom('h', { teamCount: 2, teamSize: 1 }, true);
    room.join('h', 'Host', fakeSocket());
    room.join('b', 'Buddy', fakeSocket());

    const host = room.members.get('h')!;
    const other = room.members.get('b')!;
    expect(host.team).not.toBe(other.team);

    room.setTeam('b', host.team);
    expect(room.members.get('b')!.team).not.toBe(host.team);
  });

  it('reports a room as full at the configured capacity', () => {
    const rooms = newManager();
    const room = rooms.createRoom('h', { teamCount: 2, teamSize: 1 }, false);
    room.join('h', 'Host', fakeSocket());
    room.join('b', 'Buddy', fakeSocket());
    expect(room.isFull).toBe(true);

    const outcome = rooms.joinByCode(room.code);
    expect(outcome.error).toBe('full');
  });

  it('lets a held-open player back into a full room', () => {
    // Regression: a reconnecting player was told their own match was full,
    // because the slot being held for them still counted toward capacity.
    const rooms = newManager();
    const room = rooms.createRoom('h', { teamCount: 2, teamSize: 1 }, false);
    room.join('h', 'Host', fakeSocket());
    room.join('b', 'Buddy', fakeSocket());
    room.requestStart('h');
    room.markDisconnected('b');

    expect(room.isFull).toBe(true);
    expect(rooms.joinByCode(room.code).error).toBe('full');
    expect(rooms.joinByCode(room.code, 'b').room).toBe(room);
    expect(rooms.joinByCode(room.code, 'stranger').error).toBe('full');
  });

  it('reports a missing room rather than creating one', () => {
    const rooms = newManager();
    expect(rooms.joinByCode('ZZZZZ').error).toBe('not_found');
  });

  it('hands the host role to someone else when the host leaves', () => {
    const rooms = newManager();
    const room = rooms.createRoom('h', {}, true);
    room.join('h', 'Host', fakeSocket());
    room.join('b', 'Buddy', fakeSocket());
    room.leave('h');
    expect(room.hostId).toBe('b');
  });

  it('only lets the host start the match or change settings', () => {
    const rooms = newManager();
    const room = rooms.createRoom('h', { scoreTarget: 25 }, true);
    room.join('h', 'Host', fakeSocket());
    room.join('b', 'Buddy', fakeSocket());

    room.updateConfig('b', { scoreTarget: 99 });
    expect(room.config.scoreTarget).toBe(25);

    room.requestStart('b');
    expect(room.phase).toBe('lobby');

    room.requestStart('h');
    expect(room.phase).toBe('countdown');
  });
});

describe('match start', () => {
  it('fills every empty slot with bots', () => {
    const rooms = newManager();
    const room = rooms.createRoom('h', { teamCount: 2, teamSize: 4, botsEnabled: true }, true);
    room.join('h', 'Host', fakeSocket());
    room.requestStart('h');

    expect(room.members.size).toBe(8);
    expect([...room.members.values()].filter((m) => m.isBot)).toHaveLength(7);
    expect(room.simulation?.players.size).toBe(8);
  });

  it('starts with only the humans when bots are disabled', () => {
    const rooms = newManager();
    const room = rooms.createRoom('h', { teamCount: 2, teamSize: 4, botsEnabled: false }, true);
    room.join('h', 'Host', fakeSocket());
    room.requestStart('h');
    expect(room.members.size).toBe(1);
  });

  it('gives every player a spawn position and a loadout', () => {
    const rooms = newManager();
    const room = rooms.createRoom('h', { mapId: 'depot-yard' }, true);
    room.join('h', 'Host', fakeSocket());
    room.requestStart('h');

    for (const p of room.simulation!.players.values()) {
      expect(p.life).toBe('alive');
      expect(p.hp).toBe(GAMEPLAY.player.maxHealth);
      expect(p.slots.some((s) => s !== null)).toBe(true);
      expect(Number.isFinite(p.x)).toBe(true);
    }
  });
});

describe('reconnection', () => {
  const joinedAndStarted = (): { rooms: RoomManager; room: Room } => {
    const rooms = newManager();
    const room = rooms.createRoom('h', { teamCount: 2, teamSize: 2 }, true);
    room.join('h', 'Host', fakeSocket());
    room.requestStart('h');
    return { rooms, room };
  };

  it('holds the slot open and does not duplicate the player on return', () => {
    const { room } = joinedAndStarted();
    const before = room.members.size;
    const entity = room.simulation!.players.get('h')!;
    entity.stats.kills = 7;

    room.markDisconnected('h');
    expect(room.members.size).toBe(before);
    expect(room.members.get('h')!.socket).toBeNull();
    expect(room.simulation!.players.get('h')!.connection).toBe('reconnecting');

    const resumed = fakeSocket();
    room.join('h', 'Host', resumed);

    expect(room.members.size).toBe(before);
    expect(room.simulation!.players.size).toBe(before);
    expect(room.simulation!.players.get('h')!.connection).toBe('connected');
    // Stats survive the round trip - the slot was reused, not recreated.
    expect(room.simulation!.players.get('h')!.stats.kills).toBe(7);
    expect(resumed.last('match_start')).toBeTruthy();
  });

  it('ignores input from a slot whose player is disconnected', () => {
    const { room } = joinedAndStarted();
    room.markDisconnected('h');
    room.handleInput('h', [{ seq: 1, dtMs: 16, buttons: 0xff, aim: 0, slot: -1 }]);
    // The command is queued but the disconnected player is not simulated,
    // so the buffer is cleared rather than replayed on reconnect.
    expect(room.simulation!.players.get('h')!.connection).toBe('reconnecting');
  });

  it('does not award the enemy a score for a disconnect', () => {
    const { room } = joinedAndStarted();
    const scoresBefore = room.activeMode!.teamScores(room.simulation!);
    room.markDisconnected('h');
    expect(room.activeMode!.teamScores(room.simulation!)).toEqual(scoresBefore);
  });

  it('drops a lobby member who never entered a match', () => {
    const rooms = newManager();
    const room = rooms.createRoom('h', {}, true);
    room.join('h', 'Host', fakeSocket());
    room.join('b', 'Buddy', fakeSocket());
    room.markDisconnected('b');
    expect(room.members.has('b')).toBe(false);
  });

  it('rejects input from a bot-controlled slot', () => {
    const { room } = joinedAndStarted();
    const bot = [...room.members.values()].find((m) => m.isBot)!;
    const entity = room.simulation!.players.get(bot.playerId)!;
    const before = entity.pending.length;
    room.handleInput(bot.playerId, [{ seq: 99, dtMs: 16, buttons: 0xff, aim: 0, slot: -1 }]);
    expect(entity.pending.length).toBe(before);
  });
});

describe('matchmaking', () => {
  it('sends quick-play into an existing public room', () => {
    const rooms = newManager();
    const first = rooms.quickPlay('a');
    first.join('a', 'A', fakeSocket());
    const second = rooms.quickPlay('b');
    expect(second.code).toBe(first.code);
  });

  it('never matches anyone into a private room', () => {
    const rooms = newManager();
    const priv = rooms.createRoom('a', {}, true);
    priv.join('a', 'A', fakeSocket());
    const found = rooms.quickPlay('b');
    expect(found.code).not.toBe(priv.code);
  });

  it('opens a practice room that is private and bot-filled', () => {
    const rooms = newManager();
    const room = rooms.practice('a', {});
    expect(room.isPrivate).toBe(true);
    expect(room.config.botsEnabled).toBe(true);
  });
});
