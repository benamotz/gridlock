import {
  DEFAULT_MATCH_CONFIG,
  GAMEPLAY,
  type GameEvent,
  type LobbyMember,
  MVP_MAX_HUMANS,
  type MatchConfig,
  type MatchPhase,
  type ScoreEntry,
  type ServerMessage,
  getMap,
  makeRng,
} from '@gridlock/shared';
import { World } from '../sim/World.js';
import type { PlayerEntity } from '../sim/entities.js';
import { BotController } from '../bots/BotController.js';
import { createMode, type GameMode, type MatchResult } from '../modes/index.js';
import { balanceTeams, botsNeeded, pickTeamForJoin, type Balanceable } from '../teams.js';
import { buildSnapshot } from '../net/snapshot.js';
import { tryDeploy } from '../sim/deployables.js';
import { randomName } from '../names.js';
import type { Store } from '../persistence/index.js';
import { CATCH_UP_CAP_MS, TickStats } from './tickStats.js';

export interface MemberSocket {
  send(msg: ServerMessage): void;
  close(reason: string): void;
}

export interface RoomMember extends Balanceable {
  name: string;
  ready: boolean;
  socket: MemberSocket | null;
  /** Wall-clock time this member's link dropped, 0 while connected. */
  disconnectedAt: number;
  bot: BotController | null;
}

export interface RoomOptions {
  code: string;
  hostId: string;
  isPrivate: boolean;
  config: Partial<MatchConfig>;
  store: Store;
  onEmpty: (room: Room) => void;
}

/**
 * One match room: lobby, countdown, live match, results.
 *
 * The room owns the tick loop and is the only thing that talks to both the
 * simulation and the sockets. Everything a client sends arrives here already
 * parsed and clamped by the protocol layer.
 */
export class Room {
  readonly code: string;
  readonly isPrivate: boolean;
  readonly members = new Map<string, RoomMember>();
  hostId: string;
  config: MatchConfig;
  phase: MatchPhase = 'lobby';
  /** Whether the live match keeps real time; read by the health endpoint. */
  readonly tickStats = new TickStats();

  private world: World | null = null;
  /** True while the previous update was measured, to start a window per match. */
  private measuring = false;
  private mode: GameMode | null = null;
  private timer: NodeJS.Timeout | null = null;
  private accumulator = 0;
  private lastStepAt = 0;
  private matchStartedAt = 0;
  private countdownEndsAt = 0;
  private resultsUntil = 0;
  private snapshotCounter = 0;
  private lastResult: MatchResult | null = null;
  private emptySince = 0;
  private readonly rng = makeRng((Math.random() * 0xffffffff) >>> 0);
  private botSeq = 0;
  private closed = false;

  constructor(private readonly opts: RoomOptions) {
    this.code = opts.code;
    this.hostId = opts.hostId;
    this.isPrivate = opts.isPrivate;
    this.config = { ...DEFAULT_MATCH_CONFIG, ...opts.config };
    this.clampConfig();
    this.startLoop();
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  get humanCount(): number {
    return [...this.members.values()].filter((m) => !m.isBot).length;
  }

  get isFull(): boolean {
    const cap = Math.min(this.config.teamCount * this.config.teamSize, MVP_MAX_HUMANS);
    return this.humanCount >= cap;
  }

  get isJoinable(): boolean {
    // Concluded matches never accept new players; a live match does, because
    // dropping into a match in progress is normal for this genre.
    return !this.closed && this.phase !== 'concluded' && !this.isFull;
  }

  join(playerId: string, name: string, socket: MemberSocket): RoomMember {
    const existing = this.members.get(playerId);
    if (existing) {
      // Reconnect: reattach the socket to the slot that was held open. The
      // member is never recreated, so the player cannot be duplicated.
      existing.socket = socket;
      existing.disconnectedAt = 0;
      existing.name = name;
      const entity = this.world?.players.get(playerId);
      if (entity) {
        entity.connection = 'connected';
        entity.disconnectedAt = 0;
        entity.name = name;
        // A bot may have been covering this slot - hand control back.
        existing.bot = null;
        entity.isBot = false;
      }
      this.broadcastRoomState();
      if (this.world && this.mode && this.phase !== 'lobby') this.sendMatchStart(existing);
      return existing;
    }

    const member: RoomMember = {
      playerId,
      name,
      team: -1,
      isBot: false,
      pinned: false,
      ready: false,
      socket,
      disconnectedAt: 0,
      bot: null,
    };
    member.team = pickTeamForJoin([...this.members.values()], this.config.teamCount);
    this.members.set(playerId, member);

    // Joining mid-match: take a bot's place if one is holding a slot.
    if (this.world && this.phase !== 'lobby') {
      this.releaseBotSlot(member.team);
      const entity = this.world.addPlayer(playerId, name, member.team, false);
      entity.connection = 'connected';
      this.sendMatchStart(member);
    }

    this.emptySince = 0;
    this.broadcastRoomState();
    return member;
  }

  /** Called when a socket closes. The slot is held for the reconnect grace. */
  markDisconnected(playerId: string): void {
    const m = this.members.get(playerId);
    if (!m) return;
    m.socket = null;
    m.disconnectedAt = Date.now();
    m.ready = false;

    const entity = this.world?.players.get(playerId);
    if (entity) {
      entity.connection = 'reconnecting';
      entity.disconnectedAt = this.world!.now;
    } else {
      // Never entered a match, so there is nothing to preserve.
      this.members.delete(playerId);
      if (this.hostId === playerId) this.reassignHost();
    }
    this.broadcastRoomState();
  }

  /** Explicit leave: the slot is released immediately. */
  leave(playerId: string): void {
    const m = this.members.get(playerId);
    if (!m) return;
    this.members.delete(playerId);
    this.world?.removePlayer(playerId);
    if (this.hostId === playerId) this.reassignHost();
    this.broadcastRoomState();
  }

  private reassignHost(): void {
    const next = [...this.members.values()].find((m) => !m.isBot);
    this.hostId = next?.playerId ?? '';
  }

  setTeam(playerId: string, team: number): void {
    if (this.phase !== 'lobby') return;
    const m = this.members.get(playerId);
    if (!m || team < 0 || team >= this.config.teamCount) return;
    // Refuse a move that would make the teams lopsided.
    const counts = new Array(this.config.teamCount).fill(0);
    for (const other of this.members.values()) {
      if (other.playerId !== playerId && other.team >= 0) counts[other.team]++;
    }
    if (counts[team] >= this.config.teamSize) return;
    m.team = team;
    m.pinned = true;
    this.broadcastRoomState();
  }

  setReady(playerId: string, ready: boolean): void {
    const m = this.members.get(playerId);
    if (!m) return;
    m.ready = ready;
    this.broadcastRoomState();
  }

  updateConfig(playerId: string, patch: Partial<MatchConfig>): void {
    if (playerId !== this.hostId || this.phase !== 'lobby') return;
    this.config = { ...this.config, ...patch };
    this.clampConfig();
    this.broadcastRoomState();
  }

  private clampConfig(): void {
    // A config can arrive from a host who picked a map that does not support
    // their mode or team count; clamp rather than reject.
    let map;
    try {
      map = getMap(this.config.mapId);
    } catch {
      this.config.mapId = DEFAULT_MATCH_CONFIG.mapId;
      map = getMap(this.config.mapId);
    }
    this.config.teamCount = Math.max(2, Math.min(this.config.teamCount, map.maxTeams));
    this.config.teamSize = Math.max(1, Math.min(5, this.config.teamSize));
    if (!map.modes.includes(this.config.mode)) this.config.mode = 'tdm';
  }

  // -------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------

  requestStart(playerId: string): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== 'lobby') return;
    this.beginCountdown();
  }

  requestRematch(playerId: string): void {
    if (playerId !== this.hostId || this.phase !== 'concluded') return;
    this.returnToLobby();
  }

  private beginCountdown(): void {
    this.phase = 'countdown';
    this.countdownEndsAt = Date.now() + GAMEPLAY.match.countdownSec * 1000;
    this.startMatch();
    this.broadcastRoomState();
  }

  private startMatch(): void {
    const mapDef = getMap(this.config.mapId);
    this.world = new World(mapDef, this.config, (Math.random() * 0xffffffff) >>> 0);
    this.mode = createMode(this.config);

    // Balance humans, then fill the remaining slots with bots.
    balanceTeams([...this.members.values()], this.config.teamCount);
    this.removeAllBots();
    if (this.config.botsEnabled) this.fillWithBots();

    for (const m of this.members.values()) {
      const entity = this.world.addPlayer(m.playerId, m.name, m.team, m.isBot);
      entity.connection = m.socket || m.isBot ? 'connected' : 'reconnecting';
    }

    this.world.onKill = (victim, killer) => {
      this.mode!.onKill(this.world!, victim, killer);
      return this.mode!.respawnDelayMs(this.world!, victim);
    };
    this.mode.onMatchStart(this.world);

    this.matchStartedAt = Date.now() + GAMEPLAY.match.countdownSec * 1000;
    this.lastStepAt = Date.now();
    this.accumulator = 0;

    for (const m of this.members.values()) this.sendMatchStart(m);
  }

  private fillWithBots(): void {
    const need = botsNeeded(
      [...this.members.values()], this.config.teamCount, this.config.teamSize,
    );
    need.forEach((count, team) => {
      for (let i = 0; i < count; i++) this.addBot(team);
    });
  }

  private addBot(team: number): RoomMember {
    const playerId = `bot-${this.code}-${this.botSeq++}`;
    const member: RoomMember = {
      playerId,
      name: randomName(),
      team,
      isBot: true,
      pinned: false,
      ready: true,
      socket: null,
      disconnectedAt: 0,
      bot: BotController.forDifficulty(playerId, this.config.botDifficulty, this.rng),
    };
    this.members.set(playerId, member);
    return member;
  }

  private removeAllBots(): void {
    for (const [id, m] of [...this.members]) {
      if (m.isBot) {
        this.members.delete(id);
        this.world?.removePlayer(id);
      }
    }
  }

  /** Frees one bot slot on a team so a joining human can take it. */
  private releaseBotSlot(team: number): void {
    const bot = [...this.members.values()].find((m) => m.isBot && m.team === team);
    if (!bot) return;
    this.members.delete(bot.playerId);
    this.world?.removePlayer(bot.playerId);
  }

  /** Replaces a player who never came back with a bot, keeping teams full. */
  private convertToBot(m: RoomMember): void {
    if (!this.config.botsEnabled || !this.world) {
      this.members.delete(m.playerId);
      this.world?.removePlayer(m.playerId);
      if (this.hostId === m.playerId) this.reassignHost();
      return;
    }
    m.isBot = true;
    m.socket = null;
    m.bot = BotController.forDifficulty(m.playerId, this.config.botDifficulty, this.rng);
    m.name = `${m.name} (bot)`;
    const entity = this.world.players.get(m.playerId);
    if (entity) {
      entity.isBot = true;
      entity.connection = 'connected';
      entity.name = m.name;
    }
    if (this.hostId === m.playerId) this.reassignHost();
  }

  private endMatch(result: MatchResult): void {
    if (this.phase === 'concluded') return;
    this.phase = 'concluded';
    this.lastResult = result;
    this.resultsUntil = Date.now() + GAMEPLAY.match.resultsSec * 1000;

    const entries = this.scoreEntries();
    this.broadcast({
      t: 'match_end',
      winningTeam: result.winningTeam,
      teamScores: this.mode?.teamScores(this.world!) ?? [],
      entries,
      reason: result.reason,
    });

    void this.opts.store.recordMatch({
      matchId: `${this.code}-${Date.now()}`,
      endedAt: Date.now(),
      mapId: this.config.mapId,
      config: this.config,
      winningTeam: result.winningTeam,
      entries: entries.map((e) => ({
        playerId: e.playerId, name: e.name, team: e.team, stats: e.stats,
      })),
    });
  }

  private returnToLobby(): void {
    this.phase = 'lobby';
    this.world = null;
    this.mode = null;
    this.lastResult = null;
    this.removeAllBots();
    for (const m of this.members.values()) m.ready = false;
    this.broadcastRoomState();
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  private startLoop(): void {
    const stepMs = 1000 / GAMEPLAY.tickHz;
    this.timer = setInterval(() => this.update(stepMs), stepMs);
  }

  private update(stepMs: number): void {
    if (this.closed) return;
    const now = Date.now();

    this.reapDisconnected(now);
    this.reapEmpty(now);

    if (this.phase === 'countdown' && now >= this.countdownEndsAt) {
      this.phase = 'active';
      this.matchStartedAt = now;
      this.broadcastRoomState();
    }

    if (this.phase === 'concluded' && now >= this.resultsUntil) {
      this.returnToLobby();
      return;
    }

    if (!this.world || !this.mode) return;
    if (this.phase !== 'active' && this.phase !== 'countdown') return;

    // Fixed-step simulation with an accumulator, so a late timer callback
    // catches up rather than making the world run slow.
    const elapsed = now - this.lastStepAt;
    this.lastStepAt = now;
    this.accumulator += Math.min(elapsed, CATCH_UP_CAP_MS);

    // Only live play is measured; the countdown does almost no work and would
    // make a fresh match look slow.
    const measured = this.phase === 'active';
    if (measured && !this.measuring) this.tickStats.reset(now);
    this.measuring = measured;
    const workStart = performance.now();
    let steps = 0;

    while (this.accumulator >= stepMs) {
      this.accumulator -= stepMs;
      if (this.phase === 'active') {
        steps++;
        this.driveBots(stepMs);
        this.world.step();
        this.mode.update(this.world);
        const result = this.mode.checkEnd(this.world, now - this.matchStartedAt);
        if (result) {
          this.endMatch(result);
          return;
        }
      }
    }

    // Snapshots go out at a lower rate than the simulation ticks.
    const perSnapshot = Math.max(1, Math.round(GAMEPLAY.tickHz / GAMEPLAY.snapshotHz));
    if (++this.snapshotCounter >= perSnapshot) {
      this.snapshotCounter = 0;
      this.sendSnapshots();
      this.world.events = [];
    }
    if (measured) {
      this.tickStats.record(now, steps, performance.now() - workStart, elapsed, stepMs);
    }
  }

  private driveBots(stepMs: number): void {
    if (!this.world) return;
    for (const m of this.members.values()) {
      if (!m.bot) continue;
      const cmd = m.bot.think(this.world, stepMs);
      if (cmd) this.world.queueInput(m.playerId, [cmd]);
    }
  }

  private reapDisconnected(now: number): void {
    const graceMs = GAMEPLAY.match.reconnectGraceSec * 1000;
    for (const m of [...this.members.values()]) {
      if (m.isBot || m.socket || m.disconnectedAt === 0) continue;
      if (now - m.disconnectedAt < graceMs) continue;
      if (this.world && this.phase !== 'lobby') this.convertToBot(m);
      else {
        this.members.delete(m.playerId);
        if (this.hostId === m.playerId) this.reassignHost();
      }
      this.broadcastRoomState();
    }
  }

  private reapEmpty(now: number): void {
    const anyHuman = [...this.members.values()].some((m) => !m.isBot && m.socket);
    if (anyHuman) {
      this.emptySince = 0;
      return;
    }
    if (this.emptySince === 0) this.emptySince = now;
    else if (now - this.emptySince > GAMEPLAY.match.emptyRoomTimeoutSec * 1000) {
      this.close();
    }
  }

  // -------------------------------------------------------------------------
  // Input from clients
  // -------------------------------------------------------------------------

  handleInput(playerId: string, cmds: Parameters<World['queueInput']>[1]): void {
    if (!this.world || this.phase !== 'active') return;
    const m = this.members.get(playerId);
    // A bot-controlled slot ignores client input outright.
    if (!m || m.isBot) return;
    this.world.queueInput(playerId, cmds);
  }

  /** Requests a base defence for a player. All validation happens in the sim. */
  handleDeploy(
    playerId: string,
    kind: Parameters<typeof tryDeploy>[2],
    rot = 0,
    aim?: number,
  ): ReturnType<typeof tryDeploy> | null {
    if (!this.world || this.phase !== 'active') return null;
    const member = this.members.get(playerId);
    if (!member || member.isBot) return null;
    const entity = this.world.players.get(playerId);
    if (!entity) return null;
    return tryDeploy(this.world, entity, kind, rot, aim);
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  broadcast(msg: ServerMessage): void {
    for (const m of this.members.values()) m.socket?.send(msg);
  }

  broadcastRoomState(): void {
    const msg = this.roomStateMessage();
    for (const m of this.members.values()) m.socket?.send(msg);
  }

  roomStateMessage(): ServerMessage {
    const members: LobbyMember[] = [...this.members.values()].map((m) => ({
      playerId: m.playerId,
      name: m.name,
      team: m.team,
      ready: m.ready,
      isBot: m.isBot,
      isHost: m.playerId === this.hostId,
      connection: m.isBot ? 'connected' : m.socket ? 'connected' : 'reconnecting',
    }));
    return {
      t: 'room_state',
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      config: this.config,
      members,
      countdownEndsAt: this.phase === 'countdown' ? this.countdownEndsAt : undefined,
      isPrivate: this.isPrivate,
    };
  }

  private sendMatchStart(m: RoomMember): void {
    m.socket?.send({
      t: 'match_start',
      mapId: this.config.mapId,
      config: this.config,
      yourTeam: m.team,
      serverTime: this.world?.now ?? 0,
      tickHz: GAMEPLAY.tickHz,
    });
  }

  private sendSnapshots(): void {
    if (!this.world || !this.mode) return;
    const scores = this.mode.teamScores(this.world);
    const timeLeft = Math.max(
      0, this.config.matchDurationSec * 1000 - (Date.now() - this.matchStartedAt),
    );
    const events: GameEvent[] = this.world.events;

    for (const m of this.members.values()) {
      if (!m.socket) continue;
      const entity = this.world.players.get(m.playerId);
      if (!entity) continue;
      m.socket.send(
        buildSnapshot(this.world, entity, this.phase, scores, timeLeft, events),
      );
    }
  }

  scoreEntries(): ScoreEntry[] {
    const out: ScoreEntry[] = [];
    for (const m of this.members.values()) {
      const e: PlayerEntity | undefined = this.world?.players.get(m.playerId);
      out.push({
        playerId: m.playerId,
        name: m.name,
        team: m.team,
        isBot: m.isBot,
        connection: m.isBot ? 'connected' : m.socket ? 'connected' : 'reconnecting',
        stats: e
          ? e.stats
          : { kills: 0, deaths: 0, assists: 0, objectiveScore: 0, score: 0, streak: 0, bestStreak: 0, damageDealt: 0 },
      });
    }
    return out.sort((a, b) => b.stats.score - a.stats.score || b.stats.kills - a.stats.kills);
  }

  sendScoreboard(playerId: string): void {
    const m = this.members.get(playerId);
    if (!m?.socket || !this.world || !this.mode) return;
    m.socket.send({
      t: 'scoreboard',
      entries: this.scoreEntries(),
      teamScores: this.mode.teamScores(this.world),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.opts.onEmpty(this);
  }

  get result(): MatchResult | null {
    return this.lastResult;
  }

  /** Exposed for tests and the load-test harness. */
  get simulation(): World | null {
    return this.world;
  }

  get activeMode(): GameMode | null {
    return this.mode;
  }
}
