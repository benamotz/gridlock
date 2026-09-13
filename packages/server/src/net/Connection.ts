import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  GAMEPLAY,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  mapSummaries,
  parseClientMessage,
} from '@gridlock/shared';
import { RateLimiter, ViolationCounter } from './rateLimit.js';
import { filterChat, sanitizeName } from '../names.js';
import type { RoomManager } from '../rooms/RoomManager.js';
import type { Room } from '../rooms/Room.js';
import type { Store } from '../persistence/index.js';

const SERVER_FULL =
  "The server is at its match limit right now. Join a friend's match by code, " +
  'or try again in a few minutes.';

/** Resume tokens are opaque and server-generated - clients never choose an id. */
export interface Session {
  playerId: string;
  resumeToken: string;
  name: string;
  lastSeen: number;
}

export class SessionRegistry {
  private byToken = new Map<string, Session>();

  create(playerId: string, name: string): Session {
    const session: Session = {
      playerId,
      resumeToken: randomBytes(24).toString('base64url'),
      name,
      lastSeen: Date.now(),
    };
    this.byToken.set(session.resumeToken, session);
    return session;
  }

  resolve(token: string | undefined): Session | null {
    if (!token) return null;
    const s = this.byToken.get(token);
    if (s) s.lastSeen = Date.now();
    return s ?? null;
  }

  /** Drops sessions nobody has used for an hour. */
  sweep(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [token, s] of this.byToken) {
      if (s.lastSeen < cutoff) this.byToken.delete(token);
    }
  }
}

export interface ConnectionDeps {
  rooms: RoomManager;
  sessions: SessionRegistry;
  store: Store;
  log: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * One client socket.
 *
 * Everything inbound is parsed and clamped by `parseClientMessage` before this
 * class sees it, and every action is dispatched to the room rather than applied
 * directly - the connection layer holds no game state of its own.
 */
export class Connection {
  private session: Session | null = null;
  private room: Room | null = null;
  private readonly limiter = new RateLimiter(GAMEPLAY.net.messageRateLimit);
  private readonly violations = new ViolationCounter(20, 5000);
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: ConnectionDeps,
    readonly remote: string,
  ) {
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => this.onClose());
    ws.on('error', () => this.onClose());
  }

  get playerId(): string | null {
    return this.session?.playerId ?? null;
  }

  send(msg: ServerMessage): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private fail(code: string, message: string): void {
    this.send({ t: 'error', code, message });
  }

  private kick(reason: string): void {
    this.send({ t: 'kicked', reason });
    this.ws.close(4000, reason.slice(0, 80));
  }

  private async onMessage(data: unknown, isBinary: boolean): Promise<void> {
    if (isBinary) return;
    const raw = String(data);
    if (raw.length > GAMEPLAY.net.maxMessageBytes) {
      if (this.violations.record()) this.kick('Message too large');
      return;
    }
    if (!this.limiter.allow()) {
      if (this.violations.record()) this.kick('Too many messages');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (this.violations.record()) this.kick('Malformed message');
      return;
    }

    const msg = parseClientMessage(parsed);
    if (!msg) {
      if (this.violations.record()) this.kick('Unrecognised message');
      return;
    }
    await this.dispatch(msg);
  }

  private async dispatch(msg: ClientMessage): Promise<void> {
    if (msg.t === 'hello') return this.onHello(msg.name, msg.resumeToken, msg.protocol);
    if (!this.session) return this.fail('no_session', 'Send hello first');

    switch (msg.t) {
      case 'ping':
        this.send({ t: 'pong', id: msg.id, serverTime: Date.now() });
        break;

      case 'create_room': {
        // Checked before leaving, so a refused player keeps the room they are in.
        if (this.deps.rooms.atCapacity) return this.fail('server_full', SERVER_FULL);
        this.leaveCurrentRoom();
        const room = this.deps.rooms.createRoom(
          this.session.playerId, msg.config, msg.isPrivate,
        );
        this.enter(room);
        break;
      }

      case 'join_room': {
        const outcome = this.deps.rooms.joinByCode(msg.code, this.session.playerId);
        if (!outcome.room) {
          const reasons: Record<string, string> = {
            not_found: 'No match with that code',
            full: 'That match is full',
            finished: 'That match has already ended',
          };
          this.fail(outcome.error ?? 'join_failed', reasons[outcome.error ?? ''] ?? 'Could not join');
          return;
        }
        if (this.room && this.room !== outcome.room) this.leaveCurrentRoom();
        this.enter(outcome.room);
        break;
      }

      case 'quick_play': {
        if (this.deps.rooms.atCapacity && !this.deps.rooms.bestPublicRoom()) {
          return this.fail('server_full', SERVER_FULL);
        }
        this.leaveCurrentRoom();
        this.enter(this.deps.rooms.quickPlay(this.session.playerId));
        break;
      }

      case 'practice': {
        if (this.deps.rooms.atCapacity) return this.fail('server_full', SERVER_FULL);
        this.leaveCurrentRoom();
        const room = this.deps.rooms.practice(this.session.playerId, msg.config);
        this.enter(room);
        // Practice starts immediately - there is nobody else to wait for.
        room.requestStart(this.session.playerId);
        break;
      }

      case 'leave_room':
        this.leaveCurrentRoom();
        break;

      case 'set_team':
        this.room?.setTeam(this.session.playerId, msg.team);
        break;

      case 'set_ready':
        this.room?.setReady(this.session.playerId, msg.ready);
        break;

      case 'update_config':
        this.room?.updateConfig(this.session.playerId, msg.config);
        break;

      case 'start_match':
        this.room?.requestStart(this.session.playerId);
        break;

      case 'rematch':
        this.room?.requestRematch(this.session.playerId);
        break;

      case 'input':
        this.room?.handleInput(this.session.playerId, msg.cmds);
        break;

      case 'chat': {
        const text = filterChat(msg.text).trim();
        if (!text || !this.room) break;
        const member = this.room.members.get(this.session.playerId);
        this.room.broadcast({
          t: 'chat',
          from: this.session.name,
          team: member?.team ?? -1,
          text,
        });
        break;
      }

      case 'deploy':
      {
        // Always answer: a refused placement must never look like a dead click.
        const result = this.room?.handleDeploy(
          this.session.playerId, msg.kind, msg.rot, msg.aim,
        );
        this.send({
          t: 'deploy_result',
          kind: msg.kind,
          ok: result?.ok ?? false,
          reason: result?.ok ? null : result?.reason ?? 'unavailable',
        });
        break;
      }

      case 'scoreboard':
        this.room?.sendScoreboard(this.session.playerId);
        break;

      case 'set_name': {
        const { name } = sanitizeName(msg.name);
        this.session.name = name;
        await this.deps.store.setDisplayName(this.session.playerId, name);
        const member = this.room?.members.get(this.session.playerId);
        if (member) {
          member.name = name;
          this.room?.broadcastRoomState();
        }
        break;
      }

      case 'report':
        await this.deps.store.logReport(this.session.playerId, msg.targetId, msg.reason);
        this.deps.log('warn', 'player report filed', {
          from: this.session.playerId, target: msg.targetId,
        });
        break;
    }
  }

  private async onHello(
    rawName: string,
    resumeToken: string | undefined,
    protocol: number,
  ): Promise<void> {
    if (protocol !== PROTOCOL_VERSION) {
      this.kick(`Protocol mismatch: server speaks v${PROTOCOL_VERSION}`);
      return;
    }
    if (this.session) return; // hello is idempotent per connection

    const { name } = sanitizeName(rawName);
    const resumed = this.deps.sessions.resolve(resumeToken);

    if (resumed) {
      this.session = resumed;
      this.session.name = name;
      await this.deps.store.setDisplayName(resumed.playerId, name);
    } else {
      const profile = await this.deps.store.createGuest(name);
      this.session = this.deps.sessions.create(profile.playerId, name);
    }

    this.send({
      t: 'welcome',
      playerId: this.session.playerId,
      resumeToken: this.session.resumeToken,
      serverTime: Date.now(),
      maps: mapSummaries().map((m) => ({ ...m, modes: [...m.modes] })),
      protocol: PROTOCOL_VERSION,
    });

    // Rejoin whatever match this identity was in, if it is still running.
    const existing = this.deps.rooms.roomFor(this.session.playerId);
    if (existing) this.enter(existing);
  }

  private enter(room: Room): void {
    if (!this.session) return;
    this.room = room;
    room.join(this.session.playerId, this.session.name, {
      send: (m) => this.send(m),
      close: (reason) => this.kick(reason),
    });
    this.send(room.roomStateMessage());
  }

  private leaveCurrentRoom(): void {
    if (this.room && this.session) this.room.leave(this.session.playerId);
    this.room = null;
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    // The slot is held open for the reconnect grace period, so the player can
    // come back into the same match without being duplicated.
    if (this.room && this.session) this.room.markDisconnected(this.session.playerId);
    this.room = null;
  }
}
