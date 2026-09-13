import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAMEPLAY } from '@gridlock/shared';
import { createGameServer, type GameServer } from '../src/app.js';
import { clientAddress } from '../src/net/clientAddress.js';
import { TickStats } from '../src/rooms/tickStats.js';
import { healthReport, type HealthRoom } from '../src/health.js';

describe('hosting the built client', () => {
  let game: GameServer;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gridlock-client-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>GRIDLOCK shell</title>');
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("ok")');
    game = createGameServer({ clientDir: dir });
    base = `http://127.0.0.1:${await game.listen(0, '127.0.0.1')}`;
  });

  afterAll(async () => {
    await game.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the game page at the site root without caching it', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('GRIDLOCK shell');
    expect(res.headers.get('cache-control')).toContain('no-cache');
  });

  it('answers other page paths with the game page, so a refresh still loads', async () => {
    const res = await fetch(`${base}/lobby/ABCD`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('GRIDLOCK shell');
  });

  it('caches fingerprinted assets for a year', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('returns 404 for a missing asset instead of the page', async () => {
    const res = await fetch(`${base}/assets/missing.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('GRIDLOCK shell');
  });

  it('keeps API routes as JSON and never falls through to the page', async () => {
    const health = await fetch(`${base}/api/health`);
    expect(health.headers.get('content-type')).toContain('application/json');
    const body = await health.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.keepingUp).toBe('boolean');
    expect(body.load).toHaveProperty('cpuPct');
    expect(Array.isArray(body.matches)).toBe(true);

    const missing = await fetch(`${base}/api/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('GRIDLOCK shell');
  });

  it('serves no page when no client build is configured', async () => {
    const bare = createGameServer();
    const port = await bare.listen(0, '127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(404);
    await bare.close();
  });
});

describe('client addresses behind a proxy', () => {
  const req = (forwarded?: string) => ({
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    socket: { remoteAddress: '10.0.0.5' },
  }) as unknown as Parameters<typeof clientAddress>[0];

  it('ignores X-Forwarded-For unless a proxy is trusted, so clients cannot spoof it', () => {
    expect(clientAddress(req('1.2.3.4'), 0)).toBe('10.0.0.5');
  });

  it('takes the entry the trusted proxy appended, not a forged one further left', () => {
    expect(clientAddress(req('6.6.6.6, 203.0.113.7'), 1)).toBe('203.0.113.7');
  });

  it('falls back to the socket address when the header is missing', () => {
    expect(clientAddress(req(), 1)).toBe('10.0.0.5');
  });
});

describe('tick loop health', () => {
  const step = 1000 / GAMEPLAY.tickHz;

  it('reports a steady loop at the tick rate', () => {
    const stats = new TickStats();
    stats.reset(0);
    for (let t = step; t <= 10_000 + step; t += step) stats.record(t, 1, 0.4, step, step);
    const report = stats.report()!;
    expect(report.ticksPerSec).toBeGreaterThan(GAMEPLAY.tickHz * 0.95);
    expect(report.lateCallbacks).toBe(0);
    expect(report.droppedMs).toBe(0);
  });

  it('counts starved callbacks and discarded time when the CPU runs out', () => {
    const stats = new TickStats();
    stats.reset(0);
    // Callbacks arrive 400ms apart; the room only catches up 250ms of that.
    for (let t = 400; t <= 12_000; t += 400) stats.record(t, 7, 30, 400, step);
    const report = stats.report()!;
    expect(report.lateCallbacks).toBeGreaterThan(0);
    expect(report.droppedMs).toBeGreaterThan(0);
    expect(report.ticksPerSec).toBeLessThan(GAMEPLAY.tickHz * 0.9);
  });

  it('flags a match that falls behind, without exposing room codes', () => {
    const room = (report: ReturnType<TickStats['report']>): HealthRoom & { code: string } => ({
      code: 'SECRET', phase: 'active', humanCount: 3, members: { size: 8 },
      tickStats: { report: () => report },
    });
    const slow = {
      ticksPerSec: 20, avgWorkMs: 30, maxWorkMs: 80, lateCallbacks: 50, droppedMs: 900, windowSec: 10,
    };
    const load = { cpuPct: 9, eventLoopP99Ms: 40, rssMB: 90 };

    const behind = healthReport({ count: 1, list: () => [room(slow)] }, load, 12);
    expect(behind.keepingUp).toBe(false);
    expect(behind.matches).toEqual([{ humans: 3, bots: 5, tick: slow }]);
    expect(JSON.stringify(behind)).not.toContain('SECRET');

    // A match too new to have a measurement has nothing against it yet.
    const fresh = healthReport({ count: 1, list: () => [room(null)] }, load, 12);
    expect(fresh.keepingUp).toBe(true);
  });
});
