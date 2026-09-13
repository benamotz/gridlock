import type {
  BotDifficulty,
  DeployableKind,
  ConnectionState,
  GameModeId,
  InputCommand,
  LoadoutRule,
  MatchConfig,
  MatchPhase,
  PlayerId,
  PlayerLifeState,
  PlayerStats,
  VehicleTypeId,
  WeaponId,
  WeaponState,
} from './types.js';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface HelloMsg {
  t: 'hello';
  name: string;
  /** Returned by a previous `welcome`; lets a dropped player rejoin their match. */
  resumeToken?: string;
  protocol: number;
}

export interface CreateRoomMsg {
  t: 'create_room';
  config: Partial<MatchConfig>;
  /** Private rooms are only reachable by code and never matched into. */
  isPrivate: boolean;
}

export interface JoinRoomMsg { t: 'join_room'; code: string }
export interface QuickPlayMsg { t: 'quick_play' }
/** Single-player practice: a private room pre-filled with bots. */
export interface PracticeMsg { t: 'practice'; config: Partial<MatchConfig> }
export interface LeaveRoomMsg { t: 'leave_room' }
export interface SetTeamMsg { t: 'set_team'; team: number }
export interface SetReadyMsg { t: 'set_ready'; ready: boolean }
export interface UpdateConfigMsg { t: 'update_config'; config: Partial<MatchConfig> }
export interface StartMatchMsg { t: 'start_match' }
export interface RematchMsg { t: 'rematch' }
export interface InputMsg { t: 'input'; cmds: InputCommand[] }
export interface ChatMsg { t: 'chat'; text: string }
export interface PingMsg { t: 'ping'; id: number }
/** Asks for a fresh scoreboard; sent while the player holds Tab. */
export interface RequestScoreboardMsg { t: 'scoreboard' }
/** Changes the display name without dropping the session. */
export interface SetNameMsg { t: 'set_name'; name: string }
export interface ReportMsg { t: 'report'; targetId: PlayerId; reason: string }
/** Requests placement of a base defence in front of the player. */
export interface DeployMsg {
  t: 'deploy';
  kind: DeployableKind;
  /** Requested rotation in radians; snapped to 15 degree steps by the server. */
  rot: number;
  /**
   * The aim at the moment of the click. The server places along this rather
   * than its last received input, so the defence lands exactly where the
   * preview showed it. It only picks a direction: the distance from the player
   * is still fixed by the server.
   */
  aim: number;
}

export type ClientMessage =
  | HelloMsg | CreateRoomMsg | JoinRoomMsg | QuickPlayMsg | PracticeMsg
  | LeaveRoomMsg | SetTeamMsg | SetReadyMsg | UpdateConfigMsg | StartMatchMsg
  | RematchMsg | InputMsg | ChatMsg | PingMsg | ReportMsg
  | RequestScoreboardMsg | SetNameMsg | DeployMsg;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface MapSummaryWire {
  id: string;
  name: string;
  width: number;
  height: number;
  modes: GameModeId[];
  recommendedPlayers: number;
  maxTeams: number;
}

export interface WelcomeMsg {
  t: 'welcome';
  playerId: PlayerId;
  /** Opaque token used to reclaim this identity after a disconnect. */
  resumeToken: string;
  serverTime: number;
  maps: MapSummaryWire[];
  protocol: number;
}

export interface LobbyMember {
  playerId: PlayerId;
  name: string;
  team: number;
  ready: boolean;
  isBot: boolean;
  isHost: boolean;
  connection: ConnectionState;
}

export interface RoomStateMsg {
  t: 'room_state';
  code: string;
  hostId: PlayerId;
  phase: MatchPhase;
  config: MatchConfig;
  members: LobbyMember[];
  /** Server timestamp the countdown ends at, when phase is `countdown`. */
  countdownEndsAt?: number;
  isPrivate: boolean;
}

export interface MatchStartMsg {
  t: 'match_start';
  mapId: string;
  config: MatchConfig;
  yourTeam: number;
  serverTime: number;
  tickHz: number;
}

// --- snapshot payloads -----------------------------------------------------

/** What the HUD needs to show the deploy panel. */
export interface DeployStatusWire {
  kind: DeployableKind;
  /** How many more this team may place right now. */
  remaining: number;
  /** Milliseconds until this player may deploy this kind again. */
  cooldownMs: number;
  /** False when the player is out of their base, in a vehicle, or dead. */
  canDeploy: boolean;
}

export interface SelfState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  armor: number;
  stamina: number;
  life: PlayerLifeState;
  /** Highest input sequence the server has consumed. */
  ack: number;
  slot: number;
  weapons: WeaponState[];
  reloadEndsAt: number;
  spawnProtectedUntil: number;
  respawnAt: number;
  vehicleId: number | null;
  /** Accumulated aim spread in radians, for the crosshair. */
  spread: number;
  team: number;
  /** -1 on foot, 0 driving, 1+ riding as a passenger. */
  seat: number;
  /** Base defences this player could place, and why they cannot. */
  deployables: DeployStatusWire[];
  /** Jump state, so prediction resumes from the server's timers. */
  air: number;
  jumpCd: number;
  /** Carried consumables. */
  medkits: number;
  armorPlates: number;
  /** Milliseconds until another consumable may be used. */
  pouchCooldownMs: number;
}

export interface PlayerWire {
  id: PlayerId;
  /** Display name, drawn as a label so team membership is readable at a glance. */
  name: string;
  x: number;
  y: number;
  aim: number;
  team: number;
  life: PlayerLifeState;
  weapon: WeaponId;
  /** 0-100, only sent for teammates. -1 when hidden. */
  hp: number;
  vehicleId: number | null;
  sprinting: boolean;
  protected: boolean;
  carryingFlag: number;
  /** Seconds of airtime remaining, 0 on the ground; drives the jump arc. */
  air: number;
}

export interface VehicleWire {
  id: number;
  x: number;
  y: number;
  rot: number;
  vx: number;
  vy: number;
  type: VehicleTypeId;
  hp: number;
  maxHp: number;
  driver: PlayerId | null;
  /** Riders other than the driver, in seat order. */
  passengers: PlayerId[];
  seats: number;
  destroyed: boolean;
}

export interface DeployableWire {
  id: number;
  kind: DeployableKind;
  team: number;
  x: number;
  y: number;
  rot: number;
  hp: number;
  maxHp: number;
  /** Turret barrel angle; equals `rot` for a barricade. */
  aim: number;
  /** True once a turret has finished arming. */
  active: boolean;
}

export interface ProjectileWire {
  id: number;
  x: number;
  y: number;
  rot: number;
  weapon: WeaponId;
}

export interface PickupWire {
  id: string;
  x: number;
  y: number;
  kind: 'weapon' | 'ammo' | 'health' | 'armor';
  weapon?: WeaponId;
  ammo?: number;
}

export type GameEvent =
  | { e: 'shot'; by: PlayerId; x: number; y: number; a: number; w: WeaponId; len: number }
  | { e: 'hit'; x: number; y: number; onPlayer: boolean }
  /** Confirmation sent only to the shooter, so the HUD can mark the hit. */
  | { e: 'hitmark'; by: PlayerId; x: number; y: number; amount: number; lethal: boolean }
  | { e: 'damage'; to: string; amount: number; fromX: number; fromY: number }
  | { e: 'kill'; killer: string; victim: string; weapon: WeaponId; killerTeam: number; victimTeam: number }
  | { e: 'explosion'; x: number; y: number; r: number }
  | {
      e: 'pickup';
      /** Pickup id, so a client that already animated the grab can skip it. */
      id: string;
      by: PlayerId;
      x: number;
      y: number;
      kind: string;
      label: string;
      weapon?: WeaponId;
      /** True when a health or armour item went into the pouch. */
      stored?: boolean;
    }
  | { e: 'useItem'; by: PlayerId; x: number; y: number; kind: 'health' | 'armor'; amount: number }
  | { e: 'jump'; by: PlayerId; x: number; y: number }
  | { e: 'reload'; x: number; y: number }
  | { e: 'vehicleHit'; x: number; y: number; force: number }
  | { e: 'deploy'; x: number; y: number; kind: DeployableKind; team: number }
  | { e: 'deployDown'; x: number; y: number; kind: DeployableKind; team: number }
  | { e: 'flag'; action: 'taken' | 'dropped' | 'returned' | 'captured'; team: number; by: string };

export interface ScoreEntry {
  playerId: PlayerId;
  name: string;
  team: number;
  isBot: boolean;
  connection: ConnectionState;
  stats: PlayerStats;
}

export interface SnapshotMsg {
  t: 'snap';
  tick: number;
  serverTime: number;
  self: SelfState;
  players: PlayerWire[];
  vehicles: VehicleWire[];
  deployables: DeployableWire[];
  projectiles: ProjectileWire[];
  pickups: PickupWire[];
  events: GameEvent[];
  teamScores: number[];
  timeLeftMs: number;
  phase: MatchPhase;
  /** Interaction hint the HUD renders, e.g. "E - Enter Corvid Sedan". */
  prompt: string | null;
}

export interface ScoreboardMsg {
  t: 'scoreboard';
  entries: ScoreEntry[];
  teamScores: number[];
}

export interface MatchEndMsg {
  t: 'match_end';
  winningTeam: number | null;
  teamScores: number[];
  entries: ScoreEntry[];
  reason: 'score' | 'time' | 'lastStanding' | 'aborted';
}

export interface ChatOutMsg {
  t: 'chat';
  from: string;
  team: number;
  text: string;
}

export interface ErrorMsg { t: 'error'; code: string; message: string }

/** Answer to a deploy request, sent only to the player who asked. */
export interface DeployResultMsg {
  t: 'deploy_result';
  kind: DeployableKind;
  ok: boolean;
  /** Why it was refused, e.g. 'blocked' or 'out-of-base'. Null on success. */
  reason: string | null;
}
export interface PongMsg { t: 'pong'; id: number; serverTime: number }
export interface KickedMsg { t: 'kicked'; reason: string }

export type ServerMessage =
  | WelcomeMsg | RoomStateMsg | MatchStartMsg | SnapshotMsg | ScoreboardMsg
  | MatchEndMsg | ChatOutMsg | ErrorMsg | PongMsg | KickedMsg | DeployResultMsg;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
};

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : '';

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

const MODES: GameModeId[] = ['tdm', 'ctf', 'br'];
const LOADOUTS: LoadoutRule[] = ['fixed', 'random-tier', 'team-pool', 'none', 'chaos'];
const DIFFICULTIES: BotDifficulty[] = ['easy', 'normal', 'hard'];

/**
 * Coerces a client-supplied config fragment into a safe partial. Anything
 * missing, malformed or out of range is dropped rather than trusted - the room
 * merges the result over its own defaults.
 */
export function sanitizeConfig(raw: unknown): Partial<MatchConfig> {
  if (!isObj(raw)) return {};
  const out: Partial<MatchConfig> = {};
  if (typeof raw.mapId === 'string') out.mapId = raw.mapId.slice(0, 40);
  if (MODES.includes(raw.mode as GameModeId)) out.mode = raw.mode as GameModeId;
  if (raw.teamCount !== undefined) out.teamCount = Math.round(num(raw.teamCount, 2, 4, 2));
  if (raw.teamSize !== undefined) out.teamSize = Math.round(num(raw.teamSize, 1, 5, 4));
  if (raw.scoreTarget !== undefined) out.scoreTarget = Math.round(num(raw.scoreTarget, 1, 200, 30));
  if (raw.matchDurationSec !== undefined) {
    out.matchDurationSec = Math.round(num(raw.matchDurationSec, 60, 1800, 600));
  }
  if (raw.respawnDelaySec !== undefined) {
    out.respawnDelaySec = num(raw.respawnDelaySec, 0, 20, 5);
  }
  if (LOADOUTS.includes(raw.loadoutRule as LoadoutRule)) {
    out.loadoutRule = raw.loadoutRule as LoadoutRule;
  }
  if (raw.botsEnabled !== undefined) out.botsEnabled = bool(raw.botsEnabled, true);
  if (DIFFICULTIES.includes(raw.botDifficulty as BotDifficulty)) {
    out.botDifficulty = raw.botDifficulty as BotDifficulty;
  }
  if (raw.friendlyFire !== undefined) out.friendlyFire = bool(raw.friendlyFire, false);
  if (raw.vehiclesEnabled !== undefined) out.vehiclesEnabled = bool(raw.vehiclesEnabled, true);
  return out;
}

/**
 * Parses and clamps an inbound client message.
 *
 * Every numeric field is range-limited here so the simulation never sees a NaN,
 * an Infinity, or a command claiming to cover ten seconds of movement.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;

  switch (raw.t) {
    case 'hello':
      return {
        t: 'hello',
        name: str(raw.name, 32),
        resumeToken: typeof raw.resumeToken === 'string' ? raw.resumeToken.slice(0, 64) : undefined,
        protocol: num(raw.protocol, 0, 999, 0),
      };
    case 'create_room':
      return { t: 'create_room', config: sanitizeConfig(raw.config), isPrivate: bool(raw.isPrivate, true) };
    case 'join_room':
      return { t: 'join_room', code: str(raw.code, 8).toUpperCase() };
    case 'quick_play':
      return { t: 'quick_play' };
    case 'practice':
      return { t: 'practice', config: sanitizeConfig(raw.config) };
    case 'leave_room':
      return { t: 'leave_room' };
    case 'set_team':
      return { t: 'set_team', team: Math.round(num(raw.team, -1, 3, -1)) };
    case 'set_ready':
      return { t: 'set_ready', ready: bool(raw.ready, false) };
    case 'update_config':
      return { t: 'update_config', config: sanitizeConfig(raw.config) };
    case 'start_match':
      return { t: 'start_match' };
    case 'rematch':
      return { t: 'rematch' };
    case 'chat':
      return { t: 'chat', text: str(raw.text, 160) };
    case 'ping':
      return { t: 'ping', id: num(raw.id, 0, Number.MAX_SAFE_INTEGER, 0) };
    case 'scoreboard':
      return { t: 'scoreboard' };
    case 'set_name':
      return { t: 'set_name', name: str(raw.name, 32) };
    case 'deploy':
      return raw.kind === 'barricade' || raw.kind === 'turret' || raw.kind === 'mine'
        ? {
          t: 'deploy',
          kind: raw.kind,
          rot: num(raw.rot, -Math.PI * 4, Math.PI * 4, 0),
          aim: num(raw.aim, -Math.PI * 4, Math.PI * 4, 0),
        }
        : null;
    case 'report':
      return { t: 'report', targetId: str(raw.targetId, 40), reason: str(raw.reason, 200) };
    case 'input': {
      if (!Array.isArray(raw.cmds)) return null;
      const cmds: InputCommand[] = [];
      // Cap the batch so a single packet cannot make the server simulate a
      // long stretch of movement in one go.
      for (const c of raw.cmds.slice(0, 20)) {
        if (!isObj(c)) continue;
        const cmd: InputCommand = {
          seq: Math.round(num(c.seq, 0, Number.MAX_SAFE_INTEGER, 0)),
          dtMs: num(c.dtMs, 1, 100, 16),
          buttons: Math.round(num(c.buttons, 0, 0xffff, 0)) | 0,
          aim: num(c.aim, -Math.PI * 4, Math.PI * 4, 0),
          slot: Math.round(num(c.slot, -1, 3, -1)),
        };
        // Analog axes are optional; a malformed pair is dropped rather than
        // defaulted, so it can never turn into movement the player did not ask for.
        if (typeof c.ax === 'number' && typeof c.ay === 'number' &&
            Number.isFinite(c.ax) && Number.isFinite(c.ay)) {
          const ax = Math.max(-1, Math.min(1, c.ax));
          const ay = Math.max(-1, Math.min(1, c.ay));
          const len = Math.hypot(ax, ay);
          cmd.ax = len > 1 ? ax / len : ax;
          cmd.ay = len > 1 ? ay / len : ay;
        }
        cmds.push(cmd);
      }
      if (cmds.length === 0) return null;
      return { t: 'input', cmds };
    }
    default:
      return null;
  }
}
