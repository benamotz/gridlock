import { monitorEventLoopDelay } from 'node:perf_hooks';
import { GAMEPLAY, PROTOCOL_VERSION } from '@gridlock/shared';
import type { TickReport } from './rooms/tickStats.js';

export interface LoadSample {
  /** Process CPU time as a percentage of one core, over the last sample. */
  cpuPct: number;
  /** 99th percentile event-loop delay; rises before ticks start arriving late. */
  eventLoopP99Ms: number;
  rssMB: number;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Samples process CPU and event-loop delay every few seconds.
 *
 * Hosting quotas are expressed as a fraction of a core, so CPU is reported the
 * same way: 10 here means a tenth of a core, the whole of a 0.1 CPU instance.
 */
export class ProcessLoad {
  private readonly delay = monitorEventLoopDelay({ resolution: 10 });
  private readonly timer: NodeJS.Timeout;
  private sampledAt = performance.now();
  private usage = process.cpuUsage();
  private last = { cpuPct: 0, eventLoopP99Ms: 0 };

  constructor(intervalMs = 10_000) {
    this.delay.enable();
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref();
  }

  private sample(): void {
    const now = performance.now();
    const used = process.cpuUsage(this.usage);
    const cpuMs = (used.user + used.system) / 1000;
    this.last = {
      cpuPct: round1((cpuMs / Math.max(1, now - this.sampledAt)) * 100),
      eventLoopP99Ms: round1(this.delay.percentile(99) / 1e6),
    };
    this.delay.reset();
    this.sampledAt = now;
    this.usage = process.cpuUsage();
  }

  current(): LoadSample {
    return { ...this.last, rssMB: Math.round(process.memoryUsage().rss / 1048576) };
  }

  stop(): void {
    clearInterval(this.timer);
    this.delay.disable();
  }
}

/** The slice of a room the health report reads. */
export interface HealthRoom {
  phase: string;
  humanCount: number;
  members: { size: number };
  tickStats: { report(): TickReport | null };
}

/**
 * The public health document.
 *
 * It deliberately carries no room codes or player names: anyone can fetch it,
 * and a code is all it takes to walk into a private room.
 */
export function healthReport(
  rooms: { count: number; list(): HealthRoom[] },
  load: LoadSample,
  uptimeSec: number,
): Record<string, unknown> & { keepingUp: boolean } {
  const matches = rooms
    .list()
    .filter((r) => r.phase === 'active')
    .map((r) => ({
      humans: r.humanCount,
      bots: r.members.size - r.humanCount,
      tick: r.tickStats.report(),
    }));
  // A match keeps up when it simulates at least 90% of the tick rate. One too
  // new to have finished a measurement window has nothing against it yet.
  const keepingUp = matches.every(
    (m) => m.tick === null || m.tick.ticksPerSec >= GAMEPLAY.tickHz * 0.9,
  );
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    uptimeSec,
    rooms: rooms.count,
    tickHz: GAMEPLAY.tickHz,
    keepingUp,
    load,
    matches,
  };
}
