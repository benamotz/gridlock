import {
  DEFAULT_MATCH_CONFIG,
  FREEROAM_CONFIG,
  GAMEPLAY,
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
  private city: Room | null = null;

  constructor(
    private readonly store: Store,
    private readonly maxRooms: number = GAMEPLAY.net.maxRooms,
  ) {}

  get count(): number {
    return this.rooms.size;
  }

  /**
   * True when no new room may be opened. Existing rooms stay joinable, so a
   * busy server still lets friends join each other's matches by code.
   */
  get atCapacity(): boolean {
    return this.rooms.size >= this.maxRooms;
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
    const existing = this.bestPublicRoom();
    if (existing) return existing;
    return this.createRoom(playerId, { ...QUICKPLAY_CONFIG }, false);
  }

  /**
   * The always-on city. Opened on first request and never closed after that,
   * so the world keeps running between visitors. It is exempt from the room
   * cap: refusing the one shared world because private matches filled the
   * server would be the wrong way round.
   */
  freeRoam(): Room {
    if (this.city) return this.city;
    const code = generateRoomCode((c) => this.rooms.has(c));
    const room = new Room({
      code,
      hostId: '',
      isPrivate: false,
      persistent: true,
      config: { ...FREEROAM_CONFIG },
      store: this.store,
      onEmpty: (r) => {
        this.rooms.delete(r.code);
        if (this.city === r) this.city = null;
      },
    });
    this.rooms.set(code, room);
    this.city = room;
    return room;
  }

  /** The joinable public room quick-play would pick, if there is one. */
  bestPublicRoom(): Room | undefined {
    return this.list()
      // The city is entered on purpose, never as a quick-play fallback.
      .filter((r) => !r.isPrivate && !r.persistent && r.isJoinable)
      // Prefer the fullest room so matches fill rather than fragmenting.
      .sort((a, b) => b.humanCount - a.humanCount)[0];
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
    this.city = null;
  }
}

export type { MemberSocket };
