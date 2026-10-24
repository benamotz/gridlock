import {
  type ConnectionState,
  type DeployableKind,
  type SolidDef,
  type InputCommand,
  type JobWire,
  type PhoneOfferWire,
  type NpcKind,
  type PickupKind,
  type PlayerLifeState,
  type PlayerStats,
  type VehicleTypeId,
  type WeaponId,
  type WeaponState,
  emptyStats,
} from '@gridlock/shared';
import { SLOT_COUNT, SLOT_MELEE } from './loadout.js';

/** Damage credited to one attacker, used for kill assists. */
export interface DamageRecord {
  amount: number;
  at: number;
}

export interface PlayerEntity {
  id: string;
  name: string;
  team: number;
  isBot: boolean;

  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  stamina: number;
  sprinting: boolean;
  /** Seconds of airtime remaining; advanced by the shared movement step. */
  air: number;
  jumpCd: number;
  jumpHeld: boolean;

  hp: number;
  armor: number;
  life: PlayerLifeState;
  respawnAt: number;
  /** While `life` is 'dead', the time the body stops being drawn. */
  corpseUntil: number;
  /** Facing frozen at the moment of death, so the body does not spin. */
  corpseAim: number;
  spawnProtectedUntil: number;

  slots: (WeaponState | null)[];
  slot: number;
  spread: number;
  nextFireAt: number;
  reloadEndsAt: number;
  reloadingSlot: number;
  /** True while the fire button is held, so semi-auto weapons need a re-press. */
  firePressed: boolean;
  interactPressed: boolean;
  swapPressed: boolean;

  vehicleId: number | null;

  stats: PlayerStats;
  damageTakenFrom: Map<string, DamageRecord>;

  connection: ConnectionState;
  disconnectedAt: number;
  lastProcessedSeq: number;
  pending: InputCommand[];
  /** Simulated milliseconds this player's queued commands may still consume. */
  inputBudgetMs: number;
  /** World time the last real command was applied, to tell jitter from a stall. */
  lastInputAt: number;
  /** Buttons from the most recently consumed command, for driving continuity. */
  lastButtons: number;
  /** Interaction hint surfaced in this player's next snapshot. */
  prompt: string | null;
  /** Set when a pickup is in range but needs an explicit swap keypress. */
  swapCandidate: string | null;
  /** Per-kind cooldown timestamps for placing base defences. */
  deployCooldowns: Partial<Record<DeployableKind, number>>;
  /** Carried consumables, used with their own keys rather than on contact. */
  medkits: number;
  armorPlates: number;
  /** Earliest time another consumable may be used. */
  pouchReadyAt: number;
  medkitHeld: boolean;
  armorHeld: boolean;

  /** Free-roam wanted heat; stars derive from it (see `wanted.ts`). */
  heat: number;
  /** Sim time the wanted level next drops a star, while heat > 0. */
  nextCoolAt: number;
  /** Sim time of the last crime; cooling starts `coolDelaySec` after it. */
  lastCrimeAt: number;
  /** Victim id -> sim time of the last assault on them that counted. */
  assaultedAt: Map<string, number>;

  /** Set for computer-controlled city residents; null for real players. */
  npc: NpcKind | null;
  /** Resident clothing variant. */
  look: number;
  /** Sim time a police officer last saw this suspect. */
  lastSeenAt: number;
  /** Town whose police want this player (map `towns` index), -1 when none. */
  heatTown: number;
  /**
   * Where the police last knew this suspect to be: the crime scene, then each
   * sighting. Officers who lose sight search here rather than following the
   * suspect for free.
   */
  lkpX: number;
  lkpY: number;
  /** Sim time units may be sent: a crime nobody saw is reported late. */
  reportAt: number;
  /** The vehicle officers last saw this suspect in, -1 for none. */
  knownVehicleId: number;
  /** Sim time of the last unseen car swap that cost a star. */
  lastSwapAt: number;

  /** Free-roam money: a player's cash, a resident's wallet. */
  cash: number;
  /** A pedestrian who has already been robbed has nothing left to hand over. */
  mugged: boolean;
  /** Earliest time this player may sell another car to a chop shop. */
  chopReadyAt: number;
  /** Store hold-up in progress: which store, and for how long. */
  holdupStore: string | null;
  holdupMs: number;
  /** Set on a resident who is some player's hit-job target. */
  markedFor: string | null;
  /** The phone-booth job this player is on, as the HUD shows it. */
  job: JobWire | null;
  /** Bought a cellphone this visit: job offers ring in anywhere. */
  hasPhone: boolean;
  /** The call ringing right now, as the HUD shows it. */
  phoneOffer: PhoneOfferWire | null;
  /** Sim time the cellphone may ring with the next offer. */
  nextOfferAt: number;
}

export function createPlayer(
  id: string,
  name: string,
  team: number,
  isBot: boolean,
): PlayerEntity {
  return {
    id, name, team, isBot,
    x: 0, y: 0, vx: 0, vy: 0, aim: 0,
    stamina: 100, sprinting: false, air: 0, jumpCd: 0, jumpHeld: false,
    hp: 0, armor: 0, life: 'respawning', respawnAt: 0,
    corpseUntil: 0, corpseAim: 0, spawnProtectedUntil: 0,
    slots: new Array(SLOT_COUNT).fill(null),
    slot: SLOT_MELEE,
    spread: 0, nextFireAt: 0, reloadEndsAt: 0, reloadingSlot: -1,
    firePressed: false, interactPressed: false, swapPressed: false,
    vehicleId: null,
    stats: emptyStats(),
    damageTakenFrom: new Map(),
    connection: 'connected', disconnectedAt: 0,
    lastProcessedSeq: 0, pending: [], inputBudgetMs: 0, lastInputAt: 0, lastButtons: 0,
    prompt: null, swapCandidate: null, deployCooldowns: {},
    medkits: 0, armorPlates: 0, pouchReadyAt: 0, medkitHeld: false, armorHeld: false,
    heat: 0, nextCoolAt: 0, lastCrimeAt: 0, assaultedAt: new Map(),
    npc: null, look: 0, lastSeenAt: 0, heatTown: -1,
    lkpX: 0, lkpY: 0, reportAt: 0, knownVehicleId: -1, lastSwapAt: -Infinity,
    cash: 0, mugged: false, chopReadyAt: 0, holdupStore: null, holdupMs: 0, markedFor: null,
    job: null, hasPhone: false, phoneOffer: null, nextOfferAt: 0,
  };
}

/**
 * A placed base defence.
 *
 * Deployables are full obstacles: their `solid` is registered in the collision
 * grid so they block movement and bullets, and it is removed again when they
 * are destroyed. A turret additionally tracks and fires on its own.
 */
export interface DeployableEntity {
  id: number;
  kind: DeployableKind;
  team: number;
  ownerId: string;
  x: number;
  y: number;
  /** Facing at placement time. */
  rot: number;
  /** Turret barrel angle, which traverses toward its target. */
  aim: number;
  hp: number;
  maxHp: number;
  /** Time the deployable becomes active (turret arming delay). */
  activeAt: number;
  /** 0 when the deployable never expires. */
  expiresAt: number;
  nextFireAt: number;
  targetId: string | null;
  /**
   * Rects registered with the collision grid, kept so they can be removed.
   * One for most defences, a chain for an angled barricade, none for a mine.
   */
  solids: SolidDef[];
}

export interface VehicleEntity {
  id: number;
  type: VehicleTypeId;
  x: number;
  y: number;
  rot: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  driverId: string | null;
  /** Riders other than the driver, in seat order. */
  passengers: string[];
  destroyed: boolean;
  /** Wall-clock time the wreck despawns and the spawn point re-arms. */
  despawnAt: number;
  respawnAt: number;
  /** Index into the map's vehicleSpawns, so wrecks return to their home. */
  spawnIndex: number;
  lastDamagedBy: string | null;
  /** When `lastDamagedBy` last hurt it, so stale credit expires. */
  lastDamagedAt: number;
  /** Squad car livery. */
  police?: boolean;
  /** Security van livery: the cash truck in an armored-truck job. */
  security?: boolean;
  /** Kept around (not recycled) while this player's job needs it. */
  protectedFor?: string;
}

export interface ProjectileEntity {
  id: number;
  weapon: WeaponId;
  ownerId: string;
  ownerTeam: number;
  /** Vehicle it was fired from, which it cannot immediately strike. */
  fromVehicleId: number | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  expiresAt: number;
}

/**
 * A pickup instance. `spawnId` links back to the map definition for fixed
 * spawns; world drops (from a swap or a death) have no spawn point and expire.
 */
export interface PickupEntity {
  id: string;
  spawnId: string | null;
  kind: PickupKind;
  x: number;
  y: number;
  weapon?: WeaponId;
  /** Ammo carried by a dropped weapon, or granted by an ammo crate. */
  ammo: number;
  reserve: number;
  active: boolean;
  /** When an inactive fixed spawn becomes active again. */
  respawnAt: number;
  /** When a world drop disappears; 0 for fixed spawns. */
  expiresAt: number;
  /**
   * Earliest time this pickup may be claimed. Dropped weapons are armed a
   * moment after they land, which stops the dropper instantly re-collecting
   * what they just swapped away.
   */
  availableAt: number;
  /**
   * Guards against two players claiming the same pickup in one tick.
   * Set the instant a claim is accepted, before any state is granted.
   */
  claimedBy: string | null;
}

/** Cash lying in the street, from a wallet, a body or a dropped bag. */
export interface MoneyDrop {
  id: number;
  x: number;
  y: number;
  amount: number;
  expiresAt: number;
  /** A moment's delay, so the person it fell from cannot grab it straight back. */
  availableAt: number;
}

/**
 * Free-roam rules the generic simulation calls into without depending on
 * them: hurting someone, pressing interact, and the HUD prompt.
 */
export interface CityHooks {
  onHurt(target: PlayerEntity, attacker: PlayerEntity | null, weapon: WeaponId): void;
  /** True when the interact press was used (so it does not also board a vehicle). */
  interact(p: PlayerEntity): boolean;
  prompt(p: PlayerEntity): string | null;
  /** The cellphone was answered: take the job on offer, or turn it down. */
  answerPhone(p: PlayerEntity, accept: boolean): void;
}
