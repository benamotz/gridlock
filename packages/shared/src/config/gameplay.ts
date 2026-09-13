/**
 * Central tunables. Everything the designers are likely to touch lives here so
 * gameplay balance never requires hunting through simulation code.
 */
export const GAMEPLAY = {
  /** Server simulation rate. Client prediction uses the same fixed step. */
  tickHz: 30,
  /** Snapshots per second sent to each client. */
  snapshotHz: 15,
  /** Client render delay for interpolating remote entities. */
  interpDelayMs: 120,
  /** Hard cap on the dt a single input command may claim (anti speed-hack). */
  maxCommandDtMs: 60,
  /** Max buffered unacked input commands per client. */
  maxCommandBuffer: 90,

  player: {
    radius: 13,
    maxHealth: 100,
    maxArmor: 100,
    /** Fraction of incoming damage absorbed by armor while armor remains. */
    armorAbsorb: 0.5,
    walkSpeed: 205,
    sprintSpeed: 320,
    acceleration: 1900,
    friction: 12,
    staminaMax: 100,
    staminaDrainPerSec: 26,
    staminaRegenPerSec: 18,
    /** Sprint cannot restart until stamina recovers past this value. */
    staminaRestartAt: 22,
    spawnProtectionSec: 3,
    /** Spawn protection ends early once the player fires. */
    interactRange: 46,
    /** Generous on purpose: collecting should never need a precise approach. */
    pickupRadius: 60,

    /** Jump: a short hop that lets a player slip under incoming fire. */
    jumpDuration: 0.5,
    jumpCooldown: 1.1,
    jumpStamina: 16,
    /** Speed added in the direction of travel at take-off. */
    jumpBoost: 110,
    /** Fraction of normal steering available while airborne. */
    airControl: 0.3,
    /**
     * The window, in seconds since take-off, during which bullets pass beneath
     * the player. Take-off and landing are catchable, so the timing matters.
     */
    evadeStart: 0.06,
    evadeEnd: 0.42,
  },

  /** Health and armour carried for later, rather than used on contact. */
  pouch: {
    maxMedkits: 3,
    maxArmorPlates: 3,
    medkitHeal: 50,
    armorPlateAmount: 50,
    /** Minimum gap between uses, so a double-tap cannot waste two. */
    useCooldownSec: 0.6,
    startMedkits: 1,
    startArmorPlates: 0,
  },

  combat: {
    /** Assist credit window and minimum damage share. */
    assistWindowSec: 8,
    assistMinDamage: 20,
    /** Spread decay per second while not firing. */
    spreadDecay: 2.6,
    /** Extra spread multiplier while sprinting. */
    sprintSpreadMult: 2.2,
    /** Extra spread multiplier while moving at full speed. */
    moveSpreadMult: 1.5,
    meleeArc: 1.1,
    /** Server tolerance on fire-rate, in ms, to absorb network jitter. */
    fireRateGraceMs: 25,
    /** Seconds a body stays visible before the player fades to respawning. */
    corpseSec: 3.5,
    killScore: 100,
    assistScore: 40,
    /** Damage dealt to a vehicle scales bullets down - cars are tanky. */
    vehicleDamageMult: 0.55,
  },

  vehicle: {
    /** Impact speed below which collisions do no damage. */
    minImpactSpeed: 130,
    /** Player knockback impulse per unit of impact speed. */
    knockback: 2.2,
    /** Damage a vehicle takes from its own impacts, per unit of impact speed.
     *  Kept low: clipping a kerb during a chase should scuff the car, not end
     *  the chase. */
    selfDamage: 0.09,
    exitOffset: 34,
    /** Seconds a destroyed vehicle wreck stays before despawning. */
    wreckSec: 6,
  },

  defences: {
    /**
     * How far outside the team's spawn zone a defence may be placed. Enough to
     * fortify the approaches to a base, not enough to build out across the map.
     */
    deployRadius: 340,
    /** Clearance required around a placement, so nothing is dropped on a player. */
    placeClearance: 26,
    /** Damage a deployable takes from vehicle impacts, per unit of speed. */
    ramDamage: 0.45,
    /** Deployables decay if the match runs long; 0 disables. */
    lifetimeSec: 0,
  },

  vehicleCombat: {
    /** Passengers can shoot; the driver has both hands on the wheel. */
    driverCanFire: false,
    /** Accuracy penalty applied to a passenger firing from a moving vehicle. */
    passengerSpread: 0.05,
    /** Extra spread per unit of vehicle speed. */
    passengerSpreadPerSpeed: 0.00022,
  },

  spawn: {
    /** Candidate spawn points are scored; enemies closer than this are heavily penalised. */
    enemyAvoidRadius: 520,
    /** Bonus for spawning near a living teammate. */
    allyBonusRadius: 380,
    candidates: 12,
  },

  pickups: {
    weaponRespawnSec: 16,
    ammoRespawnSec: 10,
    healthRespawnSec: 18,
    armorRespawnSec: 26,
    healthAmount: 55,
    armorAmount: 50,
    /** Ammo left in a weapon dropped after a swap, as a fraction of what was held. */
    dropRetainFraction: 1,
    /** Seconds a world-dropped weapon survives before despawning. */
    dropLifetimeSec: 45,
    /** Distance a dropped weapon is tossed from its owner. */
    dropDistance: 34,
    /** Seconds before a fresh drop can be picked up, preventing swap thrash. */
    dropArmingSec: 0.45,
  },

  match: {
    countdownSec: 5,
    resultsSec: 20,
    /** Seconds a disconnected player's slot is held open for reconnection. */
    reconnectGraceSec: 45,
    /** Room is destroyed if it has no human connections for this long. */
    emptyRoomTimeoutSec: 60,
  },

  net: {
    /** Entities outside this radius are omitted from a player's snapshot. */
    interestRadius: 1700,
    /** Messages/second a single connection may send before being throttled. */
    messageRateLimit: 120,
    maxMessageBytes: 4096,
    maxNameLength: 18,
    /**
     * Open game connections allowed from one network address. Generous on
     * purpose: a household, an office or a mobile carrier can put many real
     * players behind a single address.
     */
    maxConnectionsPerAddress: 32,
    /**
     * New connections one address may open in a burst, then per second after
     * that. The burst lets a whole group reconnect at once when their Wi-Fi
     * drops; the refill stops a reconnect loop from hammering the server.
     */
    connectBurstPerAddress: 24,
    connectRefillPerSec: 2,
    /** Rooms the server holds at once, so no single source can exhaust a small instance. */
    maxRooms: 20,
  },
} as const;

export type GameplayConfig = typeof GAMEPLAY;
