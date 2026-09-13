import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMEPLAY } from '@gridlock/shared';
import { createGameServer, type LogFn } from './app.js';

/**
 * Port resolution order: an explicit `--port` argument, then GRIDLOCK_PORT,
 * then PORT, then the default. The argv flag comes first because some dev
 * harnesses inject a PORT for the web client, which would otherwise collide
 * with the game server.
 */
const argPort = (): number | null => {
  const i = process.argv.indexOf('--port');
  const raw = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : null;
};

const PORT = argPort() ?? Number(process.env.GRIDLOCK_PORT ?? process.env.PORT ?? 2567);
const HOST = process.env.HOST ?? '0.0.0.0';

const log: LogFn = (level, msg, meta) => {
  const line = { at: new Date().toISOString(), level, msg, ...meta };
  if (level === 'warn') console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
};

/**
 * The built client, hosted by this process in production. `CLIENT_DIST`
 * overrides the default of the client package's Vite output. In development
 * there is usually no build there, and Vite serves the page instead.
 */
const clientDir = ((): string | null => {
  const dir = process.env.CLIENT_DIST ||
    fileURLToPath(new URL('../../client/dist', import.meta.url));
  return existsSync(path.join(dir, 'index.html')) ? dir : null;
})();

/** Proxies in front of the server (1 on Render); 0 trusts no forwarded headers. */
const trustedProxyHops = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY ?? 0)) || 0);

/** Extra origins allowed to open game connections, comma-separated; "*" allows any. */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',').map((o) => o.trim()).filter(Boolean);

/** Overrides the room cap from config, e.g. to fit a bigger or smaller instance. */
const maxRooms = ((): number | undefined => {
  const n = Math.floor(Number(process.env.MAX_ROOMS));
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();

const game = createGameServer({ log, clientDir, trustedProxyHops, allowedOrigins, maxRooms });

void game.listen(PORT, HOST).then((port) => {
  log('info', 'gridlock server listening', {
    port, host: HOST, tickHz: GAMEPLAY.tickHz, servingClient: clientDir, trustedProxyHops,
    allowedOrigins, maxRooms: maxRooms ?? GAMEPLAY.net.maxRooms,
  });
});

const shutdown = (signal: string): void => {
  log('info', 'shutting down', { signal });
  void game.close().then(() => process.exit(0));
  // Do not hang forever if a socket refuses to close.
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
