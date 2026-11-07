import type { WebSocket } from 'ws';

/**
 * Round-trip time and send backlog for each open connection, measured by the
 * server itself, so a slow link shows up in /api/health without anyone having
 * to read a number off their phone. Only anonymous aggregates are reported.
 *
 * - rtt: a WebSocket-level ping every couple of seconds (answered by the
 *   browser automatically, no game code involved).
 * - backlog: bytes queued in the socket but not yet sent. Growing backlog means
 *   the link cannot keep up and every update arrives later than the last.
 */
const PING_MS = 2000;

interface Link {
  rttMs: number;
  backlogBytes: number;
}

const links = new Map<object, Link>();

/** Starts measuring a connection; returns the function that stops it. */
export function trackLink(key: object, ws: WebSocket): () => void {
  const link: Link = { rttMs: -1, backlogBytes: 0 };
  links.set(key, link);
  let sentAt = 0;
  const onPong = (): void => {
    if (sentAt > 0) link.rttMs = Date.now() - sentAt;
    sentAt = 0;
  };
  ws.on('pong', onPong);
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    link.backlogBytes = ws.bufferedAmount;
    // One ping in flight at a time: an unanswered one just keeps its start.
    if (sentAt === 0) {
      sentAt = Date.now();
      try {
        ws.ping();
      } catch {
        sentAt = 0;
      }
    }
  }, PING_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    ws.off('pong', onPong);
    links.delete(key);
  };
}

export interface LinkReport {
  connections: number;
  rttMedianMs: number | null;
  rttMaxMs: number | null;
  backlogMaxKB: number;
}

export function linkReport(): LinkReport {
  const rtts = [...links.values()].map((l) => l.rttMs).filter((r) => r >= 0).sort((a, b) => a - b);
  let backlog = 0;
  for (const l of links.values()) backlog = Math.max(backlog, l.backlogBytes);
  return {
    connections: links.size,
    rttMedianMs: rtts.length > 0 ? rtts[Math.floor(rtts.length / 2)] : null,
    rttMaxMs: rtts.length > 0 ? rtts[rtts.length - 1] : null,
    backlogMaxKB: Math.round(backlog / 102.4) / 10,
  };
}
