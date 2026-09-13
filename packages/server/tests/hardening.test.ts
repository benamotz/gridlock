import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '@gridlock/shared';
import { createGameServer, type GameServer, type GameServerOptions } from '../src/app.js';
import { CLOSE_REFUSED, ConnectionAdmission, originAllowed } from '../src/net/admission.js';

describe('per-address connection limits', () => {
  it('lets a whole house or office play from one shared address', () => {
    const admission = new ConnectionAdmission(undefined, () => 0);
    const results = Array.from({ length: 16 }, () => admission.admit('203.0.113.9'));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('refuses sockets beyond the cap and frees a slot when one closes', () => {
    const admission = new ConnectionAdmission(
      { maxPerAddress: 3, burst: 10, refillPerSec: 10 }, () => 0,
    );
    const held = [admission.admit('x'), admission.admit('x'), admission.admit('x')];
    expect(admission.admit('x')).toEqual({ ok: false, reason: 'too_many_connections' });

    const first = held[0];
    if (!first.ok) throw new Error('expected the first socket to be admitted');
    // A socket's close and error can both report the end; that frees one slot, not two.
    first.release();
    first.release();
    expect(admission.admit('x').ok).toBe(true);
    expect(admission.admit('x').ok).toBe(false);
  });

  it('lets a group reconnect together but throttles a reconnect loop', () => {
    let now = 0;
    const admission = new ConnectionAdmission(
      { maxPerAddress: 1000, burst: 24, refillPerSec: 2 }, () => now,
    );
    for (let i = 0; i < 24; i++) expect(admission.admit('x').ok).toBe(true);
    expect(admission.admit('x')).toEqual({ ok: false, reason: 'connecting_too_fast' });

    now += 1000;
    expect(admission.admit('x').ok).toBe(true);
    expect(admission.admit('x').ok).toBe(true);
    expect(admission.admit('x').ok).toBe(false);
  });

  it('keeps each address separate', () => {
    const admission = new ConnectionAdmission(
      { maxPerAddress: 1, burst: 5, refillPerSec: 1 }, () => 0,
    );
    expect(admission.admit('home').ok).toBe(true);
    expect(admission.admit('office').ok).toBe(true);
    expect(admission.admit('home').ok).toBe(false);
  });

  it('forgets idle addresses so memory stays bounded', () => {
    let now = 0;
    const admission = new ConnectionAdmission(
      { maxPerAddress: 5, burst: 2, refillPerSec: 1 }, () => now,
    );
    const socket = admission.admit('x');
    if (!socket.ok) throw new Error('expected admission');
    socket.release();
    now += 5000;
    admission.sweep();
    expect(admission.trackedAddresses).toBe(0);
  });
});

describe('websocket origin check', () => {
  const req = (headers: Record<string, string>) =>
    ({ headers }) as unknown as Parameters<typeof originAllowed>[0];

  it('accepts the game page on its own host without configuration', () => {
    const r = req({ origin: 'https://gridlock.onrender.com', host: 'gridlock.onrender.com' });
    expect(originAllowed(r, [], 1)).toBe(true);
  });

  it('refuses a connection opened from another website', () => {
    const r = req({ origin: 'https://evil.example', host: 'gridlock.onrender.com' });
    expect(originAllowed(r, [], 1)).toBe(false);
  });

  it('accepts clients that send no origin, such as the load test', () => {
    expect(originAllowed(req({ host: 'gridlock.onrender.com' }), [], 0)).toBe(true);
  });

  it('trusts a forwarded host only behind a trusted proxy', () => {
    const r = req({
      origin: 'https://game.example', host: 'internal:10000', 'x-forwarded-host': 'game.example',
    });
    expect(originAllowed(r, [], 0)).toBe(false);
    expect(originAllowed(r, [], 1)).toBe(true);
  });

  it('accepts origins listed in ALLOWED_ORIGINS', () => {
    const r = req({ origin: 'https://play.example', host: 'gridlock.onrender.com' });
    expect(originAllowed(r, ['https://play.example'], 0)).toBe(true);
    expect(originAllowed(r, ['*'], 0)).toBe(true);
  });
});

describe('limits on a running server', () => {
  let game: GameServer | null = null;

  afterEach(async () => {
    await game?.close();
    game = null;
  });

  const boot = async (opts: GameServerOptions = {}): Promise<number> => {
    game = createGameServer(opts);
    return game.listen(0, '127.0.0.1');
  };

  interface Outcome {
    ws: WebSocket;
    first: ServerMessage | null;
    closeCode: number | null;
    httpStatus: number | null;
  }

  /** Opens a socket, says hello, and settles on welcome, close or a refused handshake. */
  const connect = (port: number, headers: Record<string, string> = {}): Promise<Outcome> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      const out: Outcome = { ws, first: null, closeCode: null, httpStatus: null };
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', name: 'Tester', protocol: PROTOCOL_VERSION }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (out.first || (msg.t !== 'welcome' && msg.t !== 'kicked')) return;
        out.first = msg;
        if (msg.t === 'welcome') resolve(out);
      });
      ws.on('close', (code) => {
        out.closeCode = code;
        resolve(out);
      });
      ws.on('unexpected-response', (request, response) => {
        out.httpStatus = response.statusCode ?? null;
        request.destroy();
        resolve(out);
      });
      ws.on('error', () => resolve(out));
    });

  const waitFor = (ws: WebSocket, match: (m: ServerMessage) => boolean): Promise<ServerMessage> =>
    new Promise((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData): void => {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (!match(msg)) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        ws.off('message', onMessage);
        reject(new Error('timed out waiting for a message'));
      }, 3000);
      ws.on('message', onMessage);
    });

  it('lets ten players on one network all join', async () => {
    const port = await boot();
    const players = await Promise.all(Array.from({ length: 10 }, () => connect(port)));
    expect(players.map((p) => p.first?.t)).toEqual(Array(10).fill('welcome'));
    for (const p of players) p.ws.close();
  });

  it('tells a player refused for too many connections why, instead of failing silently', async () => {
    const port = await boot({ admission: { maxPerAddress: 2 } });
    const held = [await connect(port), await connect(port)];
    const refused = await connect(port);
    expect(refused.first?.t).toBe('kicked');
    expect(refused.first?.t === 'kicked' && refused.first.reason).toContain('network');
    expect(refused.closeCode).toBe(CLOSE_REFUSED);
    for (const p of held) p.ws.close();
  });

  it('refuses a connection opened by another website but accepts its own page', async () => {
    const port = await boot();
    const foreign = await connect(port, { origin: 'https://evil.example' });
    expect(foreign.httpStatus).toBe(403);

    const own = await connect(port, { origin: `http://127.0.0.1:${port}` });
    expect(own.first?.t).toBe('welcome');
    own.ws.close();
  });

  it('still lets friends join by code when the server is at its room limit', async () => {
    const port = await boot({ maxRooms: 1 });
    const host = await connect(port);
    const hostRoom = waitFor(host.ws, (m) => m.t === 'room_state');
    host.ws.send(JSON.stringify({ t: 'create_room', config: {}, isPrivate: true }));
    const state = await hostRoom;
    if (state.t !== 'room_state') throw new Error('expected room state');

    const friend = await connect(port);
    const refusal = waitFor(friend.ws, (m) => m.t === 'error');
    friend.ws.send(JSON.stringify({ t: 'create_room', config: {}, isPrivate: true }));
    expect(await refusal).toMatchObject({ t: 'error', code: 'server_full' });

    const joined = waitFor(friend.ws, (m) => m.t === 'room_state');
    friend.ws.send(JSON.stringify({ t: 'join_room', code: state.code }));
    expect(await joined).toMatchObject({ t: 'room_state', code: state.code });

    host.ws.close();
    friend.ws.close();
  });
});
