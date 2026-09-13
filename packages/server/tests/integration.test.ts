import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  Btn, PROTOCOL_VERSION, type ServerMessage, type SnapshotMsg,
} from '@gridlock/shared';
import { createGameServer, type GameServer } from '../src/app.js';

/**
 * End-to-end coverage over real WebSocket connections.
 *
 * These are the acceptance criteria that only hold once the whole stack is
 * wired together: two clients in one match, synchronised movement between them,
 * and a reconnect that reuses the slot instead of duplicating the player.
 */

let game: GameServer;
let port: number;

beforeAll(async () => {
  game = createGameServer();
  port = await game.listen(0, '127.0.0.1');
});

afterAll(async () => {
  await game.close();
});

/** A minimal scripted client, mirroring what the browser client sends. */
class TestClient {
  ws!: WebSocket;
  playerId: string | null = null;
  resumeToken: string | undefined;
  roomCode: string | null = null;
  snapshots: SnapshotMsg[] = [];
  errors: string[] = [];
  lobbySizes: number[] = [];
  memberIds: string[] = [];
  private seq = 1;

  constructor(readonly name: string) {}

  connect(resume?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('welcome timed out')), 4000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          t: 'hello', name: this.name, resumeToken: resume, protocol: PROTOCOL_VERSION,
        }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        switch (msg.t) {
          case 'welcome':
            this.playerId = msg.playerId;
            this.resumeToken = msg.resumeToken;
            clearTimeout(timer);
            resolve();
            break;
          case 'room_state':
            this.roomCode = msg.code;
            this.lobbySizes.push(msg.members.length);
            this.memberIds = msg.members.map((m) => m.playerId);
            break;
          case 'snap':
            this.snapshots.push(msg);
            break;
          case 'error':
            this.errors.push(`${msg.code}: ${msg.message}`);
            break;
          case 'kicked':
            this.errors.push(`kicked: ${msg.reason}`);
            break;
        }
      });
      ws.on('error', (e) => reject(e));
    });
  }

  send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Sends `count` movement commands with the given buttons held. */
  move(buttons: number, count: number): void {
    const cmds = Array.from({ length: count }, () => ({
      seq: this.seq++, dtMs: 33, buttons, aim: 0, slot: -1,
    }));
    // Batched the way the real client batches, in packets of ten.
    for (let i = 0; i < cmds.length; i += 10) {
      this.send({ t: 'input', cmds: cmds.slice(i, i + 10) });
    }
  }

  close(): void {
    this.ws.close();
  }

  /** Most recent view this client has of another player. */
  viewOf(playerId: string): { x: number; y: number } | null {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const p = this.snapshots[i].players.find((q) => q.id === playerId);
      if (p) return { x: p.x, y: p.y };
    }
    return null;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('two clients in one match', () => {
  const a = new TestClient('AlphaTester');
  const b = new TestClient('BetaTester');

  it('both connect and receive distinct identities', async () => {
    await a.connect();
    await b.connect();
    expect(a.playerId).toBeTruthy();
    expect(b.playerId).toBeTruthy();
    expect(a.playerId).not.toBe(b.playerId);
  });

  it('joins the same private room by code', async () => {
    a.send({
      t: 'create_room',
      isPrivate: true,
      config: {
        mapId: 'depot-yard', teamCount: 2, teamSize: 4,
        scoreTarget: 200, matchDurationSec: 600, botsEnabled: false,
      },
    });
    await wait(300);
    expect(a.roomCode).toBeTruthy();

    b.send({ t: 'join_room', code: a.roomCode });
    await wait(300);

    expect(b.roomCode).toBe(a.roomCode);
    expect(a.memberIds).toHaveLength(2);
    expect(new Set(a.memberIds).size).toBe(2);
  });

  it('starts the match and delivers snapshots to both clients', async () => {
    a.send({ t: 'start_match' });
    // Countdown, then a little live time.
    await wait(6500);

    expect(a.snapshots.length).toBeGreaterThan(10);
    expect(b.snapshots.length).toBeGreaterThan(10);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  }, 15000);

  it('shows one client the other moving', async () => {
    // Put them on the same team so interest management cannot hide the target,
    // then move A east for about a second.
    const before = b.viewOf(a.playerId!);
    expect(before).not.toBeNull();

    a.move(Btn.Right, 30);
    await wait(1200);

    const after = b.viewOf(a.playerId!);
    expect(after).not.toBeNull();
    // B's view of A tracks A's actual movement, not a stale position.
    expect(after!.x).toBeGreaterThan(before!.x + 40);

    const serverX = game.rooms.roomFor(a.playerId!)!.simulation!.players.get(a.playerId!)!.x;
    expect(Math.abs(after!.x - serverX)).toBeLessThan(120);
  }, 10000);

  it('acknowledges the input it has consumed', () => {
    const last = a.snapshots[a.snapshots.length - 1];
    expect(last.self.ack).toBeGreaterThan(0);
  });

  it('reconnects into the same slot without duplicating the player', async () => {
    const room = game.rooms.roomFor(a.playerId!)!;
    const membersBefore = room.members.size;
    const entity = room.simulation!.players.get(b.playerId!)!;
    entity.stats.kills = 4;

    b.close();
    await wait(400);
    expect(room.members.size).toBe(membersBefore);

    const resumed = new TestClient('BetaTester');
    await resumed.connect(b.resumeToken);
    await wait(600);

    expect(resumed.playerId).toBe(b.playerId);
    expect(room.members.size).toBe(membersBefore);
    expect(room.simulation!.players.size).toBe(membersBefore);
    expect(room.simulation!.players.get(b.playerId!)!.stats.kills).toBe(4);
    expect(new Set(resumed.memberIds).size).toBe(resumed.memberIds.length);

    resumed.close();
    a.close();
  }, 10000);
});

describe('server rejects hostile clients', () => {
  it('kicks a client speaking the wrong protocol version', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const kicked = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', name: 'Old', protocol: 999 }));
      });
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString()) as ServerMessage;
        if (msg.t === 'kicked') {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    ws.close();
    expect(kicked).toBe(true);
  }, 6000);

  it('refuses to act on messages sent before hello', async () => {
    const c = new TestClient('Impatient');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const err = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(''), 3000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'quick_play' })));
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString()) as ServerMessage;
        if (msg.t === 'error') {
          clearTimeout(timer);
          resolve(msg.code);
        }
      });
    });
    ws.close();
    void c;
    expect(err).toBe('no_session');
  }, 6000);

  it('disconnects a client that floods garbage', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      ws.on('open', () => {
        for (let i = 0; i < 400; i++) ws.send('}{not json');
      });
      ws.on('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(closed).toBe(true);
  }, 8000);
});
