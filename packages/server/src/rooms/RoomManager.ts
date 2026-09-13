import {
  DEFAULT_MATCH_CONFIG,
  type MatchConfig,
  PRACTICE_CONFIG,
  QUICKPLAY_CONFIG,
} from '@gridlock/shared';
import type { Store } from '../persistence/index.js';
import { Room, type MemberSocket } from './Room.js';
import { generateRoomCode, normalizeRoomCode } from './roomCode.js';

export type JoinFailure =
  | 'not_found'
  | 'full'
  | 'finished';

export interface JoinOutcome {
  room?: Room;
  error?: JoinFailure;
}

/**
 * Owns every live room and the matchmaking entry points.
 *
 * Quick-play uses a simple "join the fullest joinable public room, otherwise
 * open a new one" queue. A real matchmaker (skill, region, party) replaces this
 * function without touching the rooms themselves.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();

  constructor(private readonly store: Store) {}

  get count(): number {
    return this.rooms.size;
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  createRoom(
    hostId: string,
    config: Partial<MatchConfig>,
    isPrivate: boolean,
  ): Room {
    const code = generateRoomCode((c) => this.rooms.has(c));
    const room = new Room({
      code,
      hostId,
      isPrivate,
      config,
      store: this.store,
      onEmpty: (r) => this.rooms.delete(r.code),
    });
    this.rooms.set(code, room);
    return room;
  }

  /**
   * Resolves a room code.
   *
   * `playerId` matters on reconnection: a player whose slot is still being held
   * open is already a member, so a full room must not turn them away from the
   * match they are in the middle of.
   */
  joinByCode(rawCode: string, playerId?: string): JoinOutcome {
    const code = normalizeRoomCode(rawCode);
    const room = this.rooms.get(code);
    if (!room) return { error: 'not_found' };
    const rejoining = playerId !== undefined && room.members.has(playerId);
    if (rejoining) return { room };
    if (room.phase === 'concluded') return { error: 'finished' };
    if (room.isFull) return { error: 'full' };
    return { room };
  }

  /** Finds the best public room to drop into, or opens a fresh one. */
  quickPlay(playerId: string): Room {
    const candidates = this.list()
      .filter((r) => !r.isPrivate && r.isJoinable)
      // Prefer the fullest room so matches fill rather than fragmenting.
      .sort((a, b) => b.humanCount - a.humanCount);
    const existing = candidates[0];
    if (existing) return existing;
    return this.createRoom(playerId, { ...QUICKPLAY_CONFIG }, false);
  }

  /** A private, bot-filled room for offline-style single-player practice. */
  practice(playerId: string, config: Partial<MatchConfig>): Room {
    const merged: Partial<MatchConfig> = {
      ...PRACTICE_CONFIG,
      ...config,
      botsEnabled: true,
    };
    return this.createRoom(playerId, merged, true);
  }

  /** The room a given player currently belongs to, if any. */
  roomFor(playerId: string): Room | null {
    for (const r of this.rooms.values()) {
      if (r.members.has(playerId)) return r;
    }
    return null;
  }

  defaultConfig(): MatchConfig {
    return { ...DEFAULT_MATCH_CONFIG };
  }

  shutdown(): void {
    for (const r of this.list()) r.close();
    this.rooms.clear();
  }
}

export type { MemberSocket };
