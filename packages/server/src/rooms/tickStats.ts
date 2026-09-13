/** How a room's tick loop kept up with real time over the last full window. */
export interface TickReport {
  /** Simulation steps completed per wall-clock second; healthy is the tick rate. */
  ticksPerSec: number;
  /** Milliseconds of work per timer callback (simulation plus snapshots). */
  avgWorkMs: number;
  maxWorkMs: number;
  /** Timer callbacks that fired more than two steps late: the process was starved of CPU. */
  lateCallbacks: number;
  /** Simulated time thrown away because the loop fell too far behind to catch up. */
  droppedMs: number;
  windowSec: number;
}

/** Measurements are summarised over windows this long. */
const WINDOW_MS = 10_000;

/**
 * How much lateness the room's accumulator will catch up on. Anything beyond it
 * is discarded rather than simulated in one burst, so it is reported as dropped.
 */
export const CATCH_UP_CAP_MS = 250;

const round = (v: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/**
 * Rolling measurement of whether a match keeps real time.
 *
 * On a small cloud instance with a CPU quota, running out of quota does not
 * crash anything - the tick loop just falls behind, and players see it as lag
 * and rubber-banding. This makes that visible on the health endpoint instead.
 */
export class TickStats {
  private windowStart = 0;
  private steps = 0;
  private callbacks = 0;
  private workMs = 0;
  private maxWorkMs = 0;
  private late = 0;
  private droppedMs = 0;
  private last: TickReport | null = null;

  /** Starts a fresh window, e.g. when a new match begins after a pause. */
  reset(now: number): void {
    this.windowStart = now;
    this.steps = 0;
    this.callbacks = 0;
    this.workMs = 0;
    this.maxWorkMs = 0;
    this.late = 0;
    this.droppedMs = 0;
  }

  record(now: number, steps: number, workMs: number, elapsedMs: number, stepMs: number): void {
    this.steps += steps;
    this.callbacks++;
    this.workMs += workMs;
    this.maxWorkMs = Math.max(this.maxWorkMs, workMs);
    if (elapsedMs > stepMs * 2) this.late++;
    if (elapsedMs > CATCH_UP_CAP_MS) this.droppedMs += elapsedMs - CATCH_UP_CAP_MS;

    const span = now - this.windowStart;
    if (span < WINDOW_MS) return;
    this.last = {
      ticksPerSec: round(this.steps / (span / 1000), 1),
      avgWorkMs: round(this.workMs / this.callbacks, 2),
      maxWorkMs: round(this.maxWorkMs, 2),
      lateCallbacks: this.late,
      droppedMs: Math.round(this.droppedMs),
      windowSec: round(span / 1000, 1),
    };
    this.reset(now);
  }

  /** The last complete window, or null before one has finished. */
  report(): TickReport | null {
    return this.last;
  }
}
