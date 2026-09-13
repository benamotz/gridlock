/**
 * Token-bucket rate limiter, one per connection.
 *
 * Input messages arrive many times a second, so the limit is generous; its job
 * is to stop a runaway or hostile client from making the server do unbounded
 * work, not to police normal play.
 */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly perSecond: number,
    private readonly burst = perSecond,
  ) {
    this.tokens = burst;
  }

  /** True when the message is allowed; false when it should be dropped. */
  allow(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond,
    );
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Counts violations so repeat offenders can be disconnected. */
export class ViolationCounter {
  private count = 0;
  private windowStart = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  record(): boolean {
    const now = Date.now();
    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    return ++this.count > this.limit;
  }
}
