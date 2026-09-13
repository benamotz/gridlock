import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { type ServerMessage, mapSummaries } from '@gridlock/shared';
import { MemoryStore, type Store } from './persistence/index.js';
import { RoomManager } from './rooms/RoomManager.js';
import { Connection, SessionRegistry } from './net/Connection.js';
import { clientAddress } from './net/clientAddress.js';
import {
  type AdmissionLimits,
  CLOSE_REFUSED,
  ConnectionAdmission,
  DEFAULT_ADMISSION_LIMITS,
  REFUSAL_MESSAGES,
  originAllowed,
} from './net/admission.js';
import { ProcessLoad, healthReport } from './health.js';

export type LogFn = (
  level: 'info' | 'warn',
  msg: string,
  meta?: Record<string, unknown>,
) => void;

export interface GameServerOptions {
  store?: Store;
  log?: LogFn;
  /**
   * Directory of the built web client. When set, this server hosts the game
   * page itself, so one service and one URL serve both the page and its
   * WebSocket - which is also why the client can find the socket on its own.
   */
  clientDir?: string | null;
  /** Proxies in front of the server whose X-Forwarded-For entries are trusted. */
  trustedProxyHops?: number;
  /** Per-address connection limits; defaults come from `GAMEPLAY.net`. */
  admission?: Partial<AdmissionLimits>;
  /**
   * Extra page origins allowed to open game connections, e.g. a separate
   * domain the client is embedded in. "*" allows any. The server's own host is
   * always allowed.
   */
  allowedOrigins?: readonly string[];
  /** Most rooms the server holds at once. */
  maxRooms?: number;
}

export interface GameServer {
  server: http.Server;
  rooms: RoomManager;
  sessions: SessionRegistry;
  store: Store;
  /** Resolves once the socket is bound; returns the port actually used. */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const noopLog: LogFn = () => {};

/**
 * Builds the HTTP + WebSocket server.
 *
 * Kept separate from the process entry point so tests can boot a real server on
 * an ephemeral port and drive it over actual WebSocket connections, rather than
 * reaching into the room objects directly.
 */
export function createGameServer(opts: GameServerOptions = {}): GameServer {
  const store = opts.store ?? new MemoryStore();
  const log = opts.log ?? noopLog;
  const rooms = new RoomManager(store, opts.maxRooms);
  const sessions = new SessionRegistry();
  const hops = opts.trustedProxyHops ?? 0;
  const admission = new ConnectionAdmission({ ...DEFAULT_ADMISSION_LIMITS, ...opts.admission });
  const allowedOrigins = opts.allowedOrigins ?? [];

  const load = new ProcessLoad();

  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(healthReport(rooms, load.current(), Math.round(process.uptime())));
  });

  app.get('/api/maps', (_req, res) => {
    res.json(mapSummaries());
  });

  /** Public room list, used by the menu to show what is live right now. */
  app.get('/api/rooms', (_req, res) => {
    res.json(
      rooms
        .list()
        .filter((r) => !r.isPrivate)
        .map((r) => ({
          code: r.code,
          phase: r.phase,
          players: r.humanCount,
          mapId: r.config.mapId,
          mode: r.config.mode,
        })),
    );
  });

  /**
   * The caller's own address as the server resolves it. Checked once after a
   * deploy to confirm TRUST_PROXY matches the host's proxy chain: `address`
   * should be the caller's public IP, not a proxy's. It only ever shows a
   * caller their own request.
   */
  app.get('/api/whoami', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      address: clientAddress(req, hops),
      peer: req.socket.remoteAddress ?? null,
      forwardedFor: req.headers['x-forwarded-for'] ?? null,
      trustedProxyHops: hops,
    });
  });

  // Any other API path is a real 404, never the game page.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  if (opts.clientDir) serveClient(app, path.resolve(opts.clientDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 16 * 1024,
    verifyClient: (info, done) => {
      if (originAllowed(info.req, allowedOrigins, hops)) {
        done(true);
        return;
      }
      log('warn', 'websocket origin refused', { origin: info.origin, host: info.req.headers.host });
      done(false, 403, 'Origin not allowed');
    },
  });

  wss.on('connection', (ws, req) => {
    const address = clientAddress(req, hops);
    const admitted = admission.admit(address);
    if (!admitted.ok) {
      // Accept, explain, then close. A handshake refused outright reaches the
      // browser as a bare failure; a message lets the menu say what happened.
      log('warn', 'connection refused', { reason: admitted.reason, address });
      const msg: ServerMessage = { t: 'kicked', reason: REFUSAL_MESSAGES[admitted.reason] };
      ws.send(JSON.stringify(msg));
      ws.close(CLOSE_REFUSED, admitted.reason);
      return;
    }
    ws.once('close', admitted.release);

    const client = ws as typeof ws & { isAlive?: boolean };
    client.isAlive = true;
    ws.on('pong', () => {
      client.isAlive = true;
    });
    new Connection(ws, { rooms, sessions, store, log }, address);
  });

  // Drop sockets that stop responding, so dead links free their slot promptly
  // rather than sitting out the whole reconnect grace period.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const client = ws as typeof ws & { isAlive?: boolean };
      if (client.isAlive === false) {
        ws.terminate();
        continue;
      }
      client.isAlive = false;
      ws.ping();
    }
    sessions.sweep();
    admission.sweep();
  }, 15000);
  heartbeat.unref?.();

  return {
    server,
    rooms,
    sessions,
    store,
    listen: (port, host = '0.0.0.0') =>
      new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        load.stop();
        rooms.shutdown();
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

/**
 * Hosts the built client.
 *
 * Vite fingerprints everything under /assets, so those files can be cached for
 * a year. index.html is never cached, so a redeploy reaches players on their
 * next page load rather than whenever a cache happens to expire.
 */
function serveClient(app: express.Express, dir: string): void {
  app.use('/assets', express.static(path.join(dir, 'assets'), {
    immutable: true, maxAge: '1y', index: false,
  }));
  // A missing asset is a plain 404. Letting the static handler raise it as an
  // error printed a stack trace for every stray request, which on a public URL
  // means log spam from every scanner that probes it.
  app.use('/assets', (_req, res) => {
    res.status(404).end();
  });
  app.use(express.static(dir, { index: false, maxAge: '1h' }));
  const shell = path.join(dir, 'index.html');
  // Every other GET is a page load - including a refresh on any path.
  app.get(/.*/, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(shell);
  });
}
