import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '@gridlock/shared';

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface SocketHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: ConnectionStatus, detail?: string): void;
}

const RESUME_KEY = 'gridlock.resumeToken';
const NAME_KEY = 'gridlock.displayName';

/**
 * The resume token lives in `sessionStorage`, not `localStorage`.
 *
 * It survives a reload of this tab - which is what reconnection needs - but is
 * not shared with other tabs, so opening a second tab joins as a second player
 * rather than stealing the first tab's identity. That is both correct (two
 * windows are two players) and what makes local two-client testing possible.
 * The display name stays in localStorage, since it is a shared preference.
 */
const resumeStore = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

function serverUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL;
  if (configured) return configured;
  // In dev, Vite proxies /ws to the game server, so same-origin always works.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * Websocket transport with automatic reconnection.
 *
 * The resume token is persisted, so a refresh or a dropped link rejoins the
 * same match as the same player rather than creating a second identity.
 */
export class ClientSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUser = false;
  /** Round-trip time in ms, exposed to the HUD's latency display. */
  rtt = 0;
  private pingSeq = 1;
  private pingSentAt = new Map<number, number>();
  /** Server clock minus local clock, for aligning snapshot timestamps. */
  clockOffset = 0;

  constructor(private readonly handlers: SocketHandlers) {}

  get displayName(): string {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  }

  setDisplayName(name: string): void {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // Private browsing can refuse storage; the name just will not persist.
    }
  }

  connect(name: string): void {
    this.closedByUser = false;
    this.setDisplayName(name);
    this.open();
  }

  private open(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.handlers.onStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(serverUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.send({
        t: 'hello',
        name: this.displayName || 'Guest',
        resumeToken: resumeStore()?.getItem(RESUME_KEY) ?? undefined,
        protocol: PROTOCOL_VERSION,
      });
      this.handlers.onStatus('connected');
      this.startPing();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        resumeStore()?.setItem(RESUME_KEY, msg.resumeToken);
        this.clockOffset = msg.serverTime - Date.now();
      }
      if (msg.t === 'pong') {
        const sentAt = this.pingSentAt.get(msg.id);
        if (sentAt !== undefined) {
          this.rtt = Date.now() - sentAt;
          this.pingSentAt.delete(msg.id);
        }
        return;
      }
      this.handlers.onMessage(msg);
    };

    ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      if (this.closedByUser) {
        this.handlers.onStatus('disconnected');
        return;
      }
      this.scheduleRetry();
    };

    ws.onerror = () => {
      // `onclose` always follows, so retry scheduling lives there only.
    };
  }

  private scheduleRetry(): void {
    this.attempts++;
    if (this.attempts > 12) {
      this.handlers.onStatus('failed', 'Could not reach the server');
      return;
    }
    // Exponential backoff with a ceiling, so a server restart is picked up
    // quickly but a hard outage does not hammer it.
    const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempts, 5));
    this.handlers.onStatus('reconnecting', `Retrying in ${Math.round(delay / 1000)}s`);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      const id = this.pingSeq++;
      this.pingSentAt.set(id, Date.now());
      // Drop stale entries so a flaky link cannot grow this map forever.
      if (this.pingSentAt.size > 20) {
        const oldest = this.pingSentAt.keys().next().value;
        if (oldest !== undefined) this.pingSentAt.delete(oldest);
      }
      this.send({ t: 'ping', id });
    }, 2000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  /** Forgets the stored identity; the next connect starts a fresh guest. */
  forgetIdentity(): void {
    resumeStore()?.removeItem(RESUME_KEY);
  }
}
