/**
 * How far behind the server to draw other players and vehicles.
 *
 * A fixed 120 ms delay left under two snapshot intervals of slack at 15 Hz.
 * Phone Wi-Fi naps in power-save mode and then delivers packets in bursts, so
 * a gap longer than the delay drained the buffer: everyone froze on their last
 * position and then jumped - "laggy at times" even with a 12 ms ping, because
 * a ping is answered while the radio is awake.
 *
 * This measures how unevenly snapshots actually arrive (the spread of
 * arrival-time minus server-time over the last few seconds) and sizes the
 * delay to cover it, settling back down once the connection is steady.
 */
export class SnapshotClock {
  /** Recent (local arrival - server time) offsets, oldest first. */
  private readonly offsets: number[] = [];
  private delay: number;
  /** Frames the renderer ran past the newest snapshot, for the perf readout. */
  starvedFrames = 0;

  constructor(
    private readonly baseDelayMs: number,
    private readonly intervalMs: number,
    private readonly maxDelayMs = 350,
    private readonly window = 60,
  ) {
    this.delay = baseDelayMs;
  }

  /** Records a snapshot's arrival; returns the delay to aim for now. */
  arrive(serverTime: number, localNow: number): number {
    this.offsets.push(localNow - serverTime);
    if (this.offsets.length > this.window) this.offsets.shift();
    this.delay = this.targetDelay();
    return this.delay;
  }

  get delayMs(): number {
    return this.delay;
  }

  /** The worst arrival spread seen recently, in milliseconds. */
  get jitterMs(): number {
    if (this.offsets.length < 2) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const o of this.offsets) {
      if (o < lo) lo = o;
      if (o > hi) hi = o;
    }
    return hi - lo;
  }

  /**
   * One interval to have the next snapshot in hand, plus the worst recent
   * lateness, plus a small margin; never below the base delay.
   */
  private targetDelay(): number {
    const want = this.intervalMs + this.jitterMs + 20;
    return Math.max(this.baseDelayMs, Math.min(this.maxDelayMs, want));
  }
}

/**
 * How far past the newest snapshot an entity may be carried along its last
 * motion when the buffer runs dry, instead of freezing and then jumping.
 */
export const EXTRAPOLATE_MAX_MS = 100;

/**
 * Interpolation fraction between two snapshots, allowed to run a little past
 * the newer one (extrapolation) when the render clock overtakes it.
 */
export function interpAlpha(aTime: number, bTime: number, renderTime: number): number {
  const span = bTime - aTime;
  if (span <= 0) return 1;
  const max = 1 + EXTRAPOLATE_MAX_MS / span;
  return Math.max(0, Math.min(max, (renderTime - aTime) / span));
}

/**
 * A move this large between two snapshots is a teleport (respawn, entering a
 * car), not motion: it must never be extrapolated.
 */
export const TELEPORT_DIST = 220;
