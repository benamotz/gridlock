import { create } from 'zustand';
import {
  DEFAULT_MATCH_CONFIG,
  type DeployStatusWire,
  type DeployableKind,
  type VehicleTypeId,
  type LobbyMember,
  type MatchConfig,
  type MatchPhase,
  type MapSummaryWire,
  type MatchEndMsg,
  type ScoreEntry,
  type WeaponId,
} from '@gridlock/shared';
import { DEFAULT_BINDINGS, type ActionId } from './game/input.js';
import type { ConnectionStatus } from './net/ClientSocket.js';

export type Screen =
  | 'connecting'
  | 'menu'
  | 'lobby'
  | 'match'
  | 'results';

export interface Settings {
  masterVolume: number;
  musicVolume: number;
  effectsVolume: number;
  sensitivity: number;
  /**
   * Aim assist strength, 0 (off) to 1. A client-side pull of the crosshair
   * toward a nearby enemy; the server still receives only the resulting aim
   * angle and validates every shot as normal.
   */
  aimAssist: number;
  screenShake: boolean;
  colorblind: boolean;
  reduceFlashing: boolean;
  quality: 'low' | 'medium' | 'high';
  showLatency: boolean;
  bindings: Record<ActionId, string[]>;
}

export const DEFAULT_SETTINGS: Settings = {
  masterVolume: 0.7,
  musicVolume: 0.4,
  effectsVolume: 0.8,
  sensitivity: 1,
  aimAssist: 0.55,
  screenShake: true,
  colorblind: false,
  reduceFlashing: false,
  quality: 'high',
  showLatency: true,
  bindings: DEFAULT_BINDINGS,
};

const SETTINGS_KEY = 'gridlock.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    // Merge over defaults so a settings file from an older build still loads.
    // Bindings merge per action: a saved table from before an action existed
    // must not leave that action unbound.
    const saved = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      bindings: { ...DEFAULT_SETTINGS.bindings, ...(saved.bindings ?? {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Private browsing can refuse storage; settings simply do not persist.
  }
}

export interface HudSlot {
  index: number;
  name: string;
  /** Null for an empty slot; drives the slot's weapon icon. */
  weapon: WeaponId | null;
  active: boolean;
  ammo: number;
}

export interface KillFeedEntry {
  killer: string;
  victim: string;
  weapon: WeaponId;
  killerTeam: number;
  victimTeam: number;
}

export interface HudState {
  hp: number;
  armor: number;
  stamina: number;
  life: string;
  respawnInMs: number;
  weaponName: string;
  /** Currently held weapon, for the HUD icon. */
  weaponId: WeaponId | null;
  ammo: number;
  reserve: number;
  slots: HudSlot[];
  team: number;
  teamScores: number[];
  timeLeftMs: number;
  phase: MatchPhase;
  prompt: string | null;
  reloading: boolean;
  protectedUntilMs: number;
  /** Timestamp of the most recent confirmed hit, for the crosshair marker. */
  lastHitAt: number;
  lastHitLethal: boolean;
  inVehicle: boolean;
  vehicleHp: number;
  /** -1 on foot, 0 driving, 1+ riding as a passenger. */
  seat: number;
  /** Occupants of the vehicle the player is in. */
  vehicleOccupants: number;
  vehicleSeats: number;
  vehicleName: string;
  /** Base defences this player can place right now. */
  deployables: DeployStatusWire[];
  /** Carried consumables. */
  medkits: number;
  armorPlates: number;
  pouchCooldownMs: number;
  /** 0 when a jump is available, rising toward 1 just after one. */
  jumpCooldownFrac: number;
  /** The defence being placed, and whether it can go where it is. */
  placing: { kind: DeployableKind; valid: boolean; reason: string | null } | null;
  /** The vehicle the player is in, or the nearest one they could board. */
  nearbyVehicle: VehicleTypeId | null;
  /** Most recent confirmed pickup, for the collection toast. */
  lastCollect: {
    label: string;
    kind: string;
    weapon: WeaponId | null;
    stored: boolean;
    at: number;
  } | null;
  killFeed: KillFeedEntry[];
  objective: string;
  rtt: number;
}

export const EMPTY_HUD: HudState = {
  hp: 100, armor: 0, stamina: 100, life: 'alive', respawnInMs: 0,
  weaponName: '-', weaponId: null, ammo: -1, reserve: 0, slots: [], team: 0,
  teamScores: [0, 0], timeLeftMs: 0, phase: 'lobby', prompt: null,
  reloading: false, protectedUntilMs: 0, lastHitAt: 0, lastHitLethal: false,
  inVehicle: false, vehicleHp: 1, seat: -1,
  vehicleOccupants: 0, vehicleSeats: 0, vehicleName: '',
  deployables: [],
  medkits: 0, armorPlates: 0, pouchCooldownMs: 0, jumpCooldownFrac: 0,
  placing: null, nearbyVehicle: null, lastCollect: null,
  killFeed: [], objective: '', rtt: 0,
};

export interface ChatLine {
  from: string;
  team: number;
  text: string;
  at: number;
}

interface GameStore {
  screen: Screen;
  status: ConnectionStatus;
  statusDetail: string;
  playerId: string | null;
  displayName: string;
  maps: MapSummaryWire[];
  error: string | null;

  roomCode: string | null;
  hostId: string | null;
  isPrivate: boolean;
  phase: MatchPhase;
  config: MatchConfig;
  members: LobbyMember[];
  countdownEndsAt: number | null;

  hud: HudState;
  /** Persisted kill feed, trimmed by age rather than per-snapshot. */
  killFeed: (KillFeedEntry & { at: number })[];
  scoreboard: ScoreEntry[];
  showScoreboard: boolean;
  chat: ChatLine[];
  results: MatchEndMsg | null;
  settings: Settings;
  settingsOpen: boolean;

  set: (patch: Partial<GameStore>) => void;
  pushKills: (entries: KillFeedEntry[]) => void;
  pushChat: (line: ChatLine) => void;
  updateSettings: (patch: Partial<Settings>) => void;
}

export const useStore = create<GameStore>((set) => ({
  screen: 'connecting',
  status: 'connecting',
  statusDetail: '',
  playerId: null,
  displayName: localStorage.getItem('gridlock.displayName') ?? '',
  maps: [],
  error: null,

  roomCode: null,
  hostId: null,
  isPrivate: true,
  phase: 'lobby',
  config: { ...DEFAULT_MATCH_CONFIG },
  members: [],
  countdownEndsAt: null,

  hud: EMPTY_HUD,
  killFeed: [],
  scoreboard: [],
  showScoreboard: false,
  chat: [],
  results: null,
  settings: loadSettings(),
  settingsOpen: false,

  set: (patch) => set(patch),

  pushKills: (entries) =>
    set((s) => {
      if (entries.length === 0) return s;
      const now = Date.now();
      const merged = [...s.killFeed, ...entries.map((e) => ({ ...e, at: now }))];
      // Keep the last few seconds, capped, so the feed cannot grow unbounded.
      return { killFeed: merged.filter((e) => now - e.at < 7000).slice(-6) };
    }),

  pushChat: (line) =>
    set((s) => ({ chat: [...s.chat, line].slice(-40) })),

  updateSettings: (patch) =>
    set((s) => {
      const next = { ...s.settings, ...patch };
      saveSettings(next);
      return { settings: next };
    }),
}));
