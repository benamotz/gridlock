import type { ClanRef, MatchConfig, PlayerProfile, PlayerStats } from '@gridlock/shared';

export interface MatchRecord {
  matchId: string;
  endedAt: number;
  mapId: string;
  config: MatchConfig;
  winningTeam: number | null;
  entries: { playerId: string; name: string; team: number; stats: PlayerStats }[];
}

/**
 * Persistence boundary.
 *
 * The MVP runs entirely in memory with guest identities. This interface is what
 * a PostgreSQL implementation will satisfy later; nothing in the game code
 * touches a store directly, so swapping the implementation is a one-line change
 * in `index.ts`.
 */
export interface Store {
  createGuest(displayName: string): Promise<PlayerProfile>;
  getProfile(playerId: string): Promise<PlayerProfile | null>;
  setDisplayName(playerId: string, name: string): Promise<void>;
  recordMatch(record: MatchRecord): Promise<void>;
  recentMatches(limit: number): Promise<MatchRecord[]>;
  /** Moderation hook: appended to, never read by gameplay. */
  logReport(fromId: string, targetId: string, reason: string): Promise<void>;
  clanFor(playerId: string): Promise<ClanRef | null>;
}

export class MemoryStore implements Store {
  private profiles = new Map<string, PlayerProfile>();
  private matches: MatchRecord[] = [];
  private reports: { at: number; from: string; target: string; reason: string }[] = [];
  private seq = 0;

  async createGuest(displayName: string): Promise<PlayerProfile> {
    const playerId = `g${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const profile: PlayerProfile = { playerId, displayName, guest: true };
    this.profiles.set(playerId, profile);
    return profile;
  }

  async getProfile(playerId: string): Promise<PlayerProfile | null> {
    return this.profiles.get(playerId) ?? null;
  }

  async setDisplayName(playerId: string, name: string): Promise<void> {
    const p = this.profiles.get(playerId);
    if (p) p.displayName = name;
  }

  async recordMatch(record: MatchRecord): Promise<void> {
    this.matches.unshift(record);
    // Bounded history keeps a long-running dev server from growing forever.
    if (this.matches.length > 200) this.matches.length = 200;
  }

  async recentMatches(limit: number): Promise<MatchRecord[]> {
    return this.matches.slice(0, limit);
  }

  async logReport(fromId: string, targetId: string, reason: string): Promise<void> {
    this.reports.push({ at: Date.now(), from: fromId, target: targetId, reason });
    if (this.reports.length > 500) this.reports.shift();
  }

  async clanFor(): Promise<ClanRef | null> {
    // Persistent clans arrive in a later milestone; match teams are unrelated.
    return null;
  }
}
