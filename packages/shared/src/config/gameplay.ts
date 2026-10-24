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
  /**
   * Simulated time a player may bank while their input is late, so a burst of
   * delayed commands is caught up at once instead of queueing behind real time.
   * Bounds how far ahead of real time any client can ever get.
   */
  inputBankMs: 200,
  /**
   * How long a connected player may send nothing before the server moves them
   * on its own (coasting to a stop). Shorter than this is ordinary network
   * jitter, and moving the player then would contradict their own prediction.
   */
  inputStallMs: 250,

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
     * Share of each team limit bots may fill, so human teammates always have
     * defences left to place.
     */
    botShare: 0.5,
    /** Chance a bot fortifies its base on the way out after (re)spawning. */
    botFortifyChance: 0.5,
    /** Minimum seconds between one bot's placements. */
    botFortifyCooldownSec: 20,
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

  freeRoam: {
    /** Players the always-on city holds at once. */
    maxPlayers: 32,
    /**
     * Spawn samples across the whole city. Far more than a team zone needs,
     * because most random points land inside buildings or water.
     */
    spawnCandidates: 64,
    /** A newcomer arrives this far from a random player already in the world. */
    spawnNearPlayer: { min: 500, max: 1400 },
  },

  /**
   * Free-roam crime. Each crime adds heat; heat maps to 0-5 stars through
   * `starHeat` (the heat at which each star is reached). After `coolDelaySec`
   * without a new crime the level drops one star every `coolStepSec`.
   */
  wanted: {
    maxStars: 5,
    starHeat: [1, 4, 10, 20, 35],
    maxHeat: 50,
    crimeHeat: { assault: 1, murder: 4, vandalism: 2, carjack: 2, robbery: 4 },
    /**
     * One assault per victim per window: a shotgun blast or a burst is one
     * attack, not a dozen crimes.
     */
    assaultRepeatSec: 3,
    coolDelaySec: 10,
    coolStepSec: 7,
    /**
     * Swapping to another vehicle while no officer is watching costs the police
     * your description: one star, at most once per this many seconds.
     */
    carSwapCooldownSec: 20,
    /** Seconds without a sighting before a swap counts as unseen. */
    carSwapUnseenSec: 2,
    /**
     * Outside the town whose police want you, the level cools this many times
     * faster - getting to the next town is how a getaway pays off.
     */
    outsideCoolRate: 2,
  },

  /**
   * Free-roam residents. Populations are kept per human player inside a ring
   * around them and recycled once nobody is near, so the cost follows the
   * players rather than the size of the city.
   */
  city: {
    pedsPerPlayer: 10,
    trafficPerPlayer: 5,
    maxPeds: 90,
    maxTraffic: 36,
    /** Residents appear between these distances from a player: off screen, but close. */
    spawnMinDist: 760,
    spawnMaxDist: 1450,
    /** No resident appears this close to any player. */
    spawnClearDist: 650,
    despawnDist: 1900,
    /** How often (ms) the population is topped up and recycled. */
    populateMs: 400,
    pedHealth: 60,
    /** Fraction of walking speed a calm pedestrian strolls at. */
    pedStroll: 0.42,
    /** Seconds a frightened pedestrian keeps running. */
    panicSec: 7,
    /** Shots and blasts within this distance frighten pedestrians. */
    panicRadius: 420,
    /** Centre-line offsets: pedestrians walk the kerb, traffic keeps right. */
    kerbOffset: 56,
    laneOffset: 28,
    trafficThrottle: 0.55,
    /** Traffic eases off this close to an intersection, to make the turn. */
    turnSlowDist: 140,
    /** Seconds traffic waits for an obstruction before nudging through. */
    trafficPatienceSec: 3,
  },

  police: {
    /**
     * Officers sent after a player, by wanted stars (index = stars). They come
     * two to a squad car whenever at least two are needed, so even one star
     * brings a car.
     */
    unitsByStars: [0, 2, 3, 4, 6, 8],
    maxCops: 44,
    /** From this many stars, officers shoot instead of only trying to arrest. */
    shootFromStars: 3,
    /** From this many stars, an officer riding as passenger shoots from the car. */
    passengerShootFromStars: 4,
    /**
     * How far officers can see a suspect, by stars. Short at low levels so a
     * small crime can be walked away from; new units always arrive beyond it.
     */
    sightByStars: [0, 420, 480, 560, 640, 720],
    /**
     * Seconds before units are sent after an unwitnessed crime. A crime an
     * officer sees brings the police at once.
     */
    responseDelaySec: 4,
    /** Officers share a sighting by radio for this long. */
    radioSec: 1.5,
    /** Units that lose the suspect search this far around the last sighting. */
    searchRadius: 520,
    /** Ambient squad cars on patrol, per player in the area and in total. */
    patrolsPerPlayer: 1,
    maxPatrols: 8,
    /** Road blocks (two parked squad cars and two officers) from this many stars. */
    roadblockFromStars: 4,
    roadblocksPerSuspect: 2,
    roadblockEverySec: 10,
    roadblockMinDist: 900,
    roadblockMaxDist: 1700,
    shootRange: 460,
    /** Aim error in radians, so officers miss sometimes. */
    aimError: 0.11,
    /** A slow-moving suspect this close to an officer is arrested. */
    bustRange: 38,
    /** Suspects moving slower than this (units/s) can be arrested. */
    bustMaxSpeed: 140,
    dispatchMs: 1000,
    spawnMinDist: 650,
    spawnMaxDist: 1300,
    /** Officers stay this far from a suspect they are shooting at. */
    standoff: 230,
    officerHealth: 100,
    /** Seconds an officer with nobody to chase lingers before leaving. */
    standDownSec: 15,
    /** Share of the usual units still sent after a suspect who left town. */
    outsideUnits: 0.5,
  },

  /** Free-roam money. Nothing is saved: everyone starts each visit fresh. */
  money: {
    start: 250,
    /** Cash a pedestrian or officer carries (min, max). */
    pedWallet: [8, 70],
    copWallet: [20, 90],
    /** Share of a player's cash dropped where they die, for anyone to take. */
    deathDrop: 0.25,
    /** Share of a player's cash lost when arrested. */
    bail: 0.2,
    /** Paid to whoever kills a wanted player, by the victim's stars. */
    bountyByStars: [0, 150, 300, 600, 1200, 2500],
    pickupRadius: 36,
    dropLifetimeSec: 45,
    /** Chop shop prices; a damaged car fetches less. */
    chopValue: { motorcycle: 150, car: 220, sports: 650, van: 260, truck: 420, armored: 900 },
    policeCarValue: 450,
    chopCooldownSec: 20,
    /** Vehicle services only trigger for a car pulling in, not one flying past. */
    serviceMaxSpeed: 170,
    resprayPerStar: 120,
    /** Store hold-ups: seconds at gunpoint, takings, and a lock-out per store. */
    holdupSec: 4,
    holdupTake: [250, 600],
    storeCooldownSec: 150,
  },

  /**
   * Armed crews: hostile residents a job sets against one player. They use the
   * police's shooting rules, but only ever target that player.
   */
  crew: {
    health: 100,
    armor: 30,
    /** A crew spots its target this close (with a clear line of sight). */
    aggroRange: 480,
    shootRange: 440,
    standoff: 220,
    aimError: 0.2,
    /**
     * Crew shots hurt players this much less than the weapon's full damage, and
     * a member who has just spotted the target waits `reactionMs` before
     * firing. Measured: a whole hideout firing at a player in the open did
     * ~194 damage a second before these (dead in half a second); ~50 after.
     */
    damageScale: 0.4,
    reactionMs: 700,
    /** A hideout crew stops chasing this far from home and goes back. */
    leash: 760,
    /** Automatic weapons fire in bursts: on for this long, then off. */
    burstMs: 650,
    restMs: 450,
    weapons: ['smg', 'shotgun', 'pistol', 'smg'],
    wallet: [40, 120],
  },

  /** Phone-booth jobs. */
  jobs: {
    /** Courier pay: a base plus this much per unit of straight-line distance. */
    courierBase: 150,
    courierPerUnit: 0.05,
    /** Time allowed: distance at this speed, plus slack. */
    courierSpeed: 240,
    courierSlackSec: 25,
    courierRadius: 80,
    hitReward: [400, 700],
    hitTimeSec: 150,
    hitMinDist: 900,
    hitMaxDist: 1700,
    /**
     * Steal to order: what each kind of vehicle pays, delivered to the named
     * chop shop. Pay scales with the vehicle's condition.
     */
    boostReward: { sports: 900, truck: 700, van: 500, motorcycle: 450, policeCar: 1300 },
    boostTimeSec: 300,
    /** Armored truck: total cash in the van, split into bags when it is wrecked. */
    truckCash: 1600,
    truckBags: 8,
    truckTimeSec: 200,
    /** Decoy run: start at this many stars, get rid of them in time. */
    decoyStars: 3,
    decoyTimeSec: 100,
    decoyReward: 650,
    /** Bounty hunter: paid on top of the normal bounty; a fugitive if nobody is wanted. */
    bountyBonus: 350,
    fugitiveReward: 550,
    bountyTimeSec: 180,
    /** Armed guards riding behind the cash van. */
    escortCrew: 3,
    /** Crew hideout: gunmen holed up in town, and what clearing them pays. */
    hideoutCrew: 5,
    hideoutReward: 900,
    hideoutTimeSec: 240,
    /** Each contact's finale pays this much more than a normal job. */
    finaleMultiplier: 2,
    /** Jobs done for one contact before they offer their finale. */
    trustForFinale: 3,
    /** A cellphone rings with an offer this long after the last one ended (min, max s). */
    cellOfferEverySec: [30, 60],
    /** The first call comes soon after buying the phone. */
    cellFirstOfferSec: 12,
    /** An unanswered call rings off after this long. */
    cellRingSec: 15,
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
