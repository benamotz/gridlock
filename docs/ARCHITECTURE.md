# Architecture

## The shape of it

```
  Browser                                    Node server
  ┌──────────────────────────┐               ┌───────────────────────────┐
  │ React UI  (menu, lobby,  │               │  Connection               │
  │           HUD, results)  │               │   parse + clamp + rate    │
  │        ▲ store (zustand) │               │   limit every message     │
  │        │                 │               │        │                  │
  │ GameClient               │  input cmds   │        ▼                  │
  │  predict → send  ────────┼──────────────▶│  Room                     │
  │  reconcile ◀─────────────┼───────────────┤   lobby, phases, bots,    │
  │  interpolate   snapshots │               │   30Hz tick, 15Hz snaps   │
  │        │                 │               │        │                  │
  │        ▼                 │               │        ▼                  │
  │ Renderer (canvas)        │               │  World  ← GameMode        │
  └──────────────────────────┘               │   authoritative sim       │
                                             └───────────────────────────┘
                    ▲                                     ▲
                    └──────── @gridlock/shared ───────────┘
                       types, protocol, config, maps,
                       collision, movement, vehicle physics
```

The shared package is the important part. Movement, vehicle handling and
collision live there and are imported by **both** sides, so the client's
prediction runs the identical code the server runs. That is what keeps
prediction from fighting the server around building corners: given the same
input and the same starting state, both produce the same position.

## Authority

The server decides everything that affects an outcome:

- movement validation, firing, fire-rate, ammunition
- damage, armour, elimination, respawn, spawn protection
- pickup ownership and weapon swaps
- vehicle position, seats, damage and destruction
- objectives, scoring, timers, victory

The client sends **intent only** — a stream of `InputCommand` values carrying a
sequence number, a duration, a button bitmask, an aim angle and a requested
slot. There is no message in the protocol that lets a client assert its health,
ammunition, position or score, so those cannot be forged; the closest thing is
the aim angle, which is the player's genuine intent and is validated against
fire-rate and line of sight when it matters.

### Anti-cheat measures worth naming

| Attack | Defence |
| --- | --- |
| Speed hack (flood input) | At most 3 commands consumed per tick; `dtMs` clamped to 60 ms; buffer bounded at 90 |
| Rapid fire | Server owns `nextFireAt` per weapon, with a 25 ms jitter allowance |
| Ammo duplication | Magazine and reserve only ever move between each other, server-side |
| Pickup duplication | Claims resolved server-side; a pickup is marked consumed before anything is granted |
| Wallhack via protocol | Interest management omits distant entities entirely; enemy health is never sent |
| Impossible movement | All movement runs through the shared collision grid |
| Malformed input | `parseClientMessage` clamps every numeric field; NaN/Infinity cannot reach the simulation |
| Message flooding | Token-bucket limiter plus a violation counter that disconnects repeat offenders |
| Name spoofing | Normalised, length-capped, invisible characters stripped, reserved names rejected |
| Room enumeration | Codes drawn from a CSPRNG over an unambiguous alphabet |

## The tick

The room runs a fixed 30 Hz step with an accumulator, so a late timer callback
catches up rather than making the world run slow. Snapshots go out every second
tick (15 Hz), built per player.

```
tick:  drive bots → world.step() → mode.update() → mode.checkEnd()
world.step(): players (input → movement → combat → pickups)
              → vehicles → projectiles → pickup timers
```

## Prediction, reconciliation, interpolation

Three separate mechanisms, often conflated:

1. **Prediction** — the local player's input is applied immediately, before the
   server has seen it. Applies to on-foot movement and to the vehicle you are
   driving.
2. **Reconciliation** — each snapshot carries `self.ack`, the highest input
   sequence the server consumed. The client snaps to the authoritative state and
   replays every command after `ack`. The pre-correction visual position is kept
   as an error offset that decays exponentially, so a correction never
   teleports the player. Corrections larger than 220 units (a respawn, a vehicle
   exit) are shown immediately, because those *are* teleports.
3. **Interpolation** — every other entity is rendered 120 ms behind the newest
   snapshot, between the two snapshots straddling that time. Fast, short-lived
   projectiles are not interpolated; showing their newest known position looks
   better than extrapolating them.

Shot feedback is predicted too: the muzzle flash, tracer, casing and sound
happen on the frame the trigger is pulled, and the server's echo of your own
shot is discarded by id so nothing is drawn twice. The server still decides
whether the shot hit; a hit is confirmed back to the shooter alone as a
`hitmark` event, which drives the crosshair marker and the damage number.

## Maps

Maps are **data, not art**. A map is a list of zones (ground painting), solids
(collision plus buildings) and spawn points, assembled procedurally from a
compact description with a seeded PRNG. That makes the 5120×4096 city a few
hundred rectangles instead of a megabyte of tile data, and generation is
deterministic, so every client builds byte-identical geometry from the map id
alone — the geometry never has to cross the network.

A Tiled importer would slot in here without touching anything else: it only has
to emit the same three lists.

Collision is a uniform grid (128-unit cells) over the solids, supporting
circle-vs-world queries, swept movement with axis-separated sliding, raycasts
and penetration recovery.

## Base defences and dynamic collision

Deployed barricades and sentry guns are real obstacles, not decoration: each one
registers a rect with the collision grid, so it blocks movement and stops
bullets, and unregisters when destroyed. That made the collision grid the one
piece of shared state that has to change during a match, so it grew
`addSolid`/`removeSolid` alongside the static index built at load.

The client mirrors the same solids into its own grid from each snapshot, adding
and removing them by deployable id. Without that, predicted movement would walk
straight through a barricade the server had already placed and be yanked back on
the next correction.

Everything about placement is decided server-side: the player must be alive, on
foot, inside their own team's deploy zone (their spawn zone grown by a radius),
under the team limit, off their personal cooldown, and standing somewhere clear
of geometry, players and vehicles. A client can ask as often as it likes.

A sentry gun is itself a solid, which means a line of sight cast from its centre
hits its own housing first — so both target acquisition and firing start from a
point just outside the body. Turrets traverse at a finite rate, which is what
makes them flankable rather than instant.

## Vehicles: seats, sharing and firing

Occupants are parked at their own seat rather than the body centre. That is what
lets a passenger's shots leave from where they are actually sitting, and keeps
the occupancy pips honest. Seat 0 is the driver; leaving that seat promotes the
first passenger, so a full van is not stranded when the driver bails.

Passengers may fire, the driver may not (`GAMEPLAY.vehicleCombat.driverCanFire`).
A shot from a vehicle starts at the shooter's seat pushed clear of the bodywork
and excludes its own vehicle from the trace, so you cannot shoot your own ride.
Occupants remain untargetable by bullets — incoming fire hits the car — which
keeps a full vehicle a real tactical choice rather than a rolling coffin.

Only the driver predicts vehicle motion on the client. A passenger predicts
nothing and simply rides the interpolated car, because the vehicle is not theirs
to steer and predicting it would only invent disagreement to correct.

## Vehicle bodies

A vehicle collides as a row of equal circles along its length, each with a
radius of half its width, overlapping, with the end circles reaching exactly
the nose and tail. One circle cannot describe a long, narrow body: with a single
`width / 2` circle a truck's nose went 38 units into a wall and a motorcycle's
15. The row is used everywhere a body matters - movement, turning (a turn that
would swing the body into a wall is refused), recovery when embedded, and
contact with players, other vehicles, defences and mines - and by the client's
prediction, because it lives in the shared physics.

What happens around a wreck is data per vehicle: `crashDamageMult` (a
motorcycle is fragile to gunfire but not to kerbs), `wreckBlast` (a motorcycle
breaks apart instead of exploding) and `topplesWhenRiderless`. A rider killed
aboard falls where they were rather than being moved as if stepping out. Kills
caused by a wreck are credited to the enemy who damaged the vehicle, not to the
crew's own final crash.

## Defence placement round trip

Placement is client-previewed and server-decided. The client draws a ghost from
the same shared geometry the server uses; on the click it recomputes the ghost
from the aim at that instant and sends the aim with the request, so the server
places exactly what was shown rather than using its last received input. The
server answers every request with `deploy_result`. Placement mode stays open
until that answer arrives, and a refusal is shown in the banner, so a declined
placement is never a silent click.

## Predicted collection

When the local player reaches an item they can take, the client hides it and
plays the grab immediately, mirroring the server's rules. The server's
`pickup` event, addressed with the pickup id and collector, confirms it. A grab
the server never confirms simply reappears, and that item is not predicted again
for a moment - which also stops prediction running before the round starts.

## Rendering

The static world is drawn once per 512×512 chunk into an offscreen canvas and
then blitted, with least-recently-used eviction. This is what makes the detail
affordable: road markings, kerbs, crossings, street lighting, extruded buildings
with lit windows and rooftop plant all cost nothing per frame. Only actors,
pickups, projectiles and effects are drawn each frame, and every layer culls
against the camera rect — so the city costs about what the small test map costs.

Weapon icons are authored once as SVG paths and consumed two ways: React renders
them in the HUD, and the canvas renderer draws the same paths with `Path2D` for
world pickups. One definition, so a weapon on the ground and the same weapon in
your loadout can never look different.

## Trade-offs, and why

**Canvas2D instead of Phaser 3.** The brief suggested Phaser. Because the server
is authoritative and owns all physics and collision, Phaser's main contribution —
its arcade physics — would have gone unused, leaving it as a sprite renderer
plus an asset pipeline for a game that ships no image assets. A direct Canvas2D
renderer gave exact control over the interpolation and prediction paths, the
chunked static-layer caching, and the fake-height building extrusion, with no
dependency risk. The cost is that sprite batching and WebGL are not free later.
Rendering is confined behind `client/src/render/`, so swapping in Phaser or
PixiJS means replacing `Renderer.ts` and `StaticLayer.ts`, not the game.

**Raw `ws` + JSON instead of Colyseus.** Colyseus brings room lifecycle and
state sync, both of which are the parts most worth owning here — the state we
send is interest-filtered per player, which is not the shape a general state-sync
library optimises for. JSON is the compromise: it is larger than a binary
encoding, but at 15 Hz for ≤8 players it is not close to a bottleneck, and it
kept the protocol debuggable. `protocol.ts` is the only file that would change.

**In-memory persistence instead of PostgreSQL and Redis.** Guest identities are
enough for the MVP, and standing up two services to store nothing that survives
a match would be cost without benefit. Everything goes through the `Store`
interface, so the Postgres implementation is a new class and one line in
`app.ts`. Redis becomes relevant when there is more than one server process;
today, room state lives in the process that owns the room, which is correct for
a single node.

**Eight players, not twenty.** Networking, vehicles and authoritative combat are
the hard parts, and they are proven at eight. Nothing in the room, the snapshot
builder or interest management assumes eight — `MVP_MAX_HUMANS` is one constant.

**Client-side aim assist.** It adjusts the angle the player is already pointing,
before that angle is sent; the server still decides every hit. It is capped,
requires line of sight, falls off with angular distance and range, and is a
slider the player can set to zero.

## Extending it

- **A new weapon** — add a record to `config/weapons.ts` and an icon to
  `render/weaponIcons.ts`. No simulation changes.
- **A new vehicle** — add a record to `config/vehicles.ts` and place it in a map.
- **A new map** — add a builder and register it in `maps/index.ts`.
- **A new game mode** — implement `GameMode` and register it in `modes/index.ts`.
  The room drives the simulation; the mode only observes it and decides scoring,
  respawn policy and the end condition.
- **Persistent accounts** — implement `Store`.
