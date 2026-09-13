import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { GAMEPLAY, PROTOCOL_VERSION, mapSummaries } from '@gridlock/shared';
import { MemoryStore, type Store } from './persistence/index.js';
import { RoomManager } from './rooms/RoomManager.js';
import { Connection, SessionRegistry } from './net/Connection.js';

export type LogFn = (
  level: 'info' | 'warn',
  msg: string,
  meta?: Record<string, unknown>,
) => void;

export interface GameServerOptions {
  store?: Store;
  log?: LogFn;
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
  const rooms = new RoomManager(store);
  const sessions = new SessionRegistry();

  const app = express();

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      protocol: PROTOCOL_VERSION,
      rooms: rooms.count,
      tickHz: GAMEPLAY.tickHz,
      uptimeSec: Math.round(process.uptime()),
    });
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

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

  wss.on('connection', (ws, req) => {
    const client = ws as typeof ws & { isAlive?: boolean };
    client.isAlive = true;
    ws.on('pong', () => {
      client.isAlive = true;
    });
    new Connection(ws, { rooms, sessions, store, log }, req.socket.remoteAddress ?? 'unknown');
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
        rooms.shutdown();
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}
