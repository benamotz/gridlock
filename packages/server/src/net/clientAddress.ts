import type { IncomingMessage } from 'node:http';

/**
 * The address a connection really came from.
 *
 * Behind a hosting proxy every socket appears to come from the proxy, so the
 * client's address has to be read from X-Forwarded-For. Whoever sends a request
 * can write that header, so only the entries appended by proxies we trust mean
 * anything: with `trustedHops` proxies in front, the client is that many
 * entries from the right, and anything further left may be forged.
 */
export function clientAddress(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  trustedHops: number,
): string {
  const socketAddress = req.socket.remoteAddress ?? 'unknown';
  if (trustedHops <= 0) return socketAddress;

  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return socketAddress;

  const hops = raw.split(',').map((h) => h.trim()).filter(Boolean);
  if (hops.length === 0) return socketAddress;
  return hops[Math.max(0, hops.length - trustedHops)];
}
