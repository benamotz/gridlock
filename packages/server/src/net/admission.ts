import type { IncomingMessage } from 'node:http';
import { GAMEPLAY } from '@gridlock/shared';

export interface AdmissionLimits {
  /** Open sockets allowed from one address. */
  maxPerAddress: number;
  /** New connections one address may open back to back. */
  burst: number;
  /** How quickly that allowance refills. */
  refillPerSec: number;
}

export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {
  maxPerAddress: GAMEPLAY.net.maxConnectionsPerAddress,
  burst: GAMEPLAY.net.connectBurstPerAddress,
  refillPerSec: GAMEPLAY.net.connectRefillPerSec,
};

/** Close code for a connection refused by these limits (after it is told why). */
export const CLOSE_REFUSED = 4008;

export type Refusal = 'too_many_connections' | 'connecting_too_fast';

/** What a refused player is told; the client shows it on the main menu. */
export const REFUSAL_MESSAGES: Record<Refusal, string> = {
  too_many_connections:
    'Too many game connections from your network right now. ' +
    'Close extra game tabs, or try again in a minute.',
  connecting_too_fast:
    'Too many players on your network are connecting at once. Retrying in a moment.',
};

export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; reason: Refusal };

/**
 * Per-address connection limits.
 *
 * Addresses are shared far more often than it seems: a household or an office
 * sits behind one router, and mobile carriers put many unrelated customers
 * behind one address. Both limits are therefore sized for a whole group playing
 * from one network. They exist to stop a single source opening hundreds of
 * sockets or reconnecting in a tight loop, not to police normal play.
 */
export class ConnectionAdmission {
  private readonly open = new Map<string, number>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly limits: AdmissionLimits = DEFAULT_ADMISSION_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  admit(address: string): Admission {
    const openNow = this.open.get(address) ?? 0;
    if (openNow >= this.limits.maxPerAddress) {
      return { ok: false, reason: 'too_many_connections' };
    }

    const t = this.now();
    const bucket = this.buckets.get(address) ?? { tokens: this.limits.burst, at: t };
    bucket.tokens = Math.min(
      this.limits.burst,
      bucket.tokens + ((t - bucket.at) / 1000) * this.limits.refillPerSec,
    );
    bucket.at = t;
    this.buckets.set(address, bucket);
    if (bucket.tokens < 1) return { ok: false, reason: 'connecting_too_fast' };
    bucket.tokens -= 1;

    this.open.set(address, openNow + 1);
    let released = false;
    return {
      ok: true,
      // Idempotent: a socket's close and error events can both report the end.
      release: () => {
        if (released) return;
        released = true;
        const left = (this.open.get(address) ?? 1) - 1;
        if (left <= 0) this.open.delete(address);
        else this.open.set(address, left);
      },
    };
  }

  /** Addresses currently remembered, for tests and diagnostics. */
  get trackedAddresses(): number {
    return this.buckets.size;
  }

  /**
   * Forgets addresses with no open sockets whose allowance has fully refilled,
   * so the maps stay bounded however many addresses pass through.
   */
  sweep(): void {
    const t = this.now();
    for (const [address, bucket] of [...this.buckets]) {
      if (this.open.has(address)) continue;
      const refilled = bucket.tokens + ((t - bucket.at) / 1000) * this.limits.refillPerSec;
      if (refilled >= this.limits.burst) this.buckets.delete(address);
    }
  }
}

/**
 * Whether a WebSocket handshake may proceed, judged by its Origin header.
 *
 * Browsers always send Origin, so this stops other websites from opening game
 * connections from their own pages. Scripts can forge the header, so it is not
 * authentication - only a refusal to be driven from elsewhere. Clients that are
 * not browsers (the load test, the integration tests) send no Origin at all.
 *
 * The page and its socket are served from the same host, so an origin on the
 * request's own host is always the game's own page and needs no configuration.
 */
export function originAllowed(
  req: Pick<IncomingMessage, 'headers'>,
  allowed: readonly string[],
  trustedProxyHops: number,
): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowed.includes('*')) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (allowed.includes(url.origin)) return true;

  const hosts: string[] = [];
  if (req.headers.host) hosts.push(req.headers.host);
  // A proxy may rewrite Host; only a trusted one's forwarded host counts.
  if (trustedProxyHops > 0) {
    const forwarded = req.headers['x-forwarded-host'];
    const list = Array.isArray(forwarded) ? forwarded : forwarded ? forwarded.split(',') : [];
    hosts.push(...list.map((h) => h.trim()));
  }
  const originHost = url.host.toLowerCase();
  return hosts.some((h) => h.toLowerCase() === originHost);
}
