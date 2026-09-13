/**
 * Bot-driven load test.
 *
 * Spins up N headless websocket clients that join one match, then move, aim,
 * fire, sprint, collect items and press the interact key at random. Some of
 * them disconnect and reconnect part-way through, which exercises the grace
 * period and the "reconnect must not duplicate a player" rule under load.
 *
 *   npm run loadtest -w @gridlock/server -- --clients 8 --seconds 30
 */
import WebSocket from 'ws';
import {
  Btn,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SnapshotMsg,
} from '@gridlock/shared';

interface Options {
  url: string;
  clients: number;
  seconds: number;
  churn: number;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    url: get('url', 'ws://localhost:2567/ws'),
    clients: Number(get('clients', '8')),
    seconds: Number(get('seconds', '25')),
    churn: Number(get('churn', '2')),
  };
}

interface Stats {
  connects: number;
  reconnects: number;
  snapshots: number;
  errors: string[];
  kills: number;
  maxSeenPlayers: number;
  duplicateIds: number;
}

class FakeClient {
  private ws: WebSocket | null = null;
  private seq = 1;
  private aim = Math.random() * Math.PI * 2;
  private buttons = 0;
  private timer: NodeJS.Timeout | null = null;
  private nextChange = 0;
  resumeToken: string | undefined;
  playerId: string | null = null;
  roomCode: string | null = null;
  inMatch = false;

  constructor(
    readonly name: string,
    private readonly opts: Options,
    private readonly stats: Stats,
    private readonly onWelcome: (c: FakeClient) => void,
  ) {}

  connect(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.on('open', () => {
      this.stats.connects++;
      if (this.resumeToken) this.stats.reconnects++;
      this.sendRaw({
        t: 'hello', name: this.name, resumeToken: this.resumeToken,
        protocol: PROTOCOL_VERSION,
      });
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('error', (e) => this.stats.errors.push(`${this.name}: ${e.message}`));
  }

  private onMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      this.stats.errors.push(`${this.name}: unparseable server message`);
      return;
    }
    switch (msg.t) {
      case 'welcome': {
        // A resumed session is put back into its room by the server, so asking
        // to join again would be a redundant round trip.
        const resuming = this.resumeToken !== undefined;
        this.playerId = msg.playerId;
        this.resumeToken = msg.resumeToken;
        if (!resuming) this.onWelcome(this);
        break;
      }
      case 'room_state':
        this.roomCode = msg.code;
        // Every id in the lobby must be unique - a duplicated slot after a
        // reconnect is the specific failure this test is watching for.
        {
          const ids = msg.members.map((m) => m.playerId);
          if (new Set(ids).size !== ids.length) this.stats.duplicateIds++;
          this.stats.maxSeenPlayers = Math.max(this.stats.maxSeenPlayers, ids.length);
        }
        break;
      case 'match_start':
        this.inMatch = true;
        this.startInput();
        break;
      case 'snap':
        this.stats.snapshots++;
        this.onSnapshot(msg);
        break;
      case 'match_end':
        this.inMatch = false;
        break;
      case 'error':
        this.stats.errors.push(`${this.name}: ${msg.code} ${msg.message}`);
        break;
      case 'kicked':
        this.stats.errors.push(`${this.name}: kicked - ${msg.reason}`);
        break;
    }
  }

  private onSnapshot(snap: SnapshotMsg): void {
    for (const e of snap.events) if (e.e === 'kill') this.stats.kills++;
    // Steer roughly toward the nearest visible player, so clients actually meet.
    const target = snap.players[0];
    if (target) this.aim = Math.atan2(target.y - snap.self.y, target.x - snap.self.x);
  }

  private startInput(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now >= this.nextChange) {
        this.nextChange = now + 400 + Math.random() * 900;
        this.buttons = 0;
        if (Math.random() < 0.8) {
          this.buttons |= [Btn.Up, Btn.Down, Btn.Left, Btn.Right][
            Math.floor(Math.random() * 4)
          ];
        }
        if (Math.random() < 0.5) this.buttons |= Btn.Fire;
        if (Math.random() < 0.3) this.buttons |= Btn.Sprint;
        if (Math.random() < 0.1) this.buttons |= Btn.Interact;
        if (Math.random() < 0.1) this.buttons |= Btn.Swap;
        if (Math.random() < 0.08) this.buttons |= Btn.Reload;
      }
      this.aim += (Math.random() - 0.5) * 0.3;
      this.sendRaw({
        t: 'input',
        cmds: [{ seq: this.seq++, dtMs: 33, buttons: this.buttons, aim: this.aim, slot: -1 }],
      });
    }, 33);
  }

  sendRaw(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Simulates a dropped connection followed by a reconnect after `afterMs`. */
  bounce(afterMs: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    setTimeout(() => this.connect(), afterMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws?.close();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const stats: Stats = {
    connects: 0, reconnects: 0, snapshots: 0, errors: [],
    kills: 0, maxSeenPlayers: 0, duplicateIds: 0,
  };

  console.log(
    `load test: ${opts.clients} clients against ${opts.url} for ${opts.seconds}s`,
  );

  const clients: FakeClient[] = [];
  let hostCode: string | null = null;

  const host = new FakeClient('LoadHost', opts, stats, (c) => {
    // The first client opens a public room; the rest quick-play into it.
    c.sendRaw({
      t: 'create_room',
      isPrivate: false,
      config: { mapId: 'depot-yard', mode: 'tdm', teamCount: 2, teamSize: 5, scoreTarget: 999, matchDurationSec: 900 },
    });
    setTimeout(() => {
      hostCode = c.roomCode;
      c.sendRaw({ t: 'start_match' });
    }, 600);
  });
  clients.push(host);
  host.connect();

  await new Promise((r) => setTimeout(r, 1200));

  for (let i = 1; i < opts.clients; i++) {
    const c = new FakeClient(`Load${i}`, opts, stats, (cc) => {
      if (hostCode) cc.sendRaw({ t: 'join_room', code: hostCode });
      else cc.sendRaw({ t: 'quick_play' });
    });
    clients.push(c);
    c.connect();
    await new Promise((r) => setTimeout(r, 120));
  }

  // Churn: repeatedly drop and restore a few clients mid-match.
  const churnTimer = setInterval(() => {
    for (let i = 0; i < opts.churn; i++) {
      const c = clients[1 + Math.floor(Math.random() * (clients.length - 1))];
      if (c) c.bounce(800 + Math.random() * 1500);
    }
  }, 6000);

  await new Promise((r) => setTimeout(r, opts.seconds * 1000));
  clearInterval(churnTimer);
  for (const c of clients) c.stop();
  await new Promise((r) => setTimeout(r, 400));

  const snapsPerClientPerSec = stats.snapshots / opts.clients / opts.seconds;
  console.log('\n--- load test results ---');
  console.log(`connects:            ${stats.connects}`);
  console.log(`reconnects:          ${stats.reconnects}`);
  console.log(`snapshots received:  ${stats.snapshots} (${snapsPerClientPerSec.toFixed(1)}/client/s)`);
  console.log(`kill events seen:    ${stats.kills}`);
  console.log(`max lobby size seen: ${stats.maxSeenPlayers}`);
  console.log(`duplicate player ids: ${stats.duplicateIds}`);
  console.log(`errors:              ${stats.errors.length}`);
  for (const e of stats.errors.slice(0, 10)) console.log(`  ${e}`);

  const failed =
    stats.duplicateIds > 0 || stats.errors.length > 0 || stats.snapshots === 0;
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed ? 1 : 0);
}

void main();
