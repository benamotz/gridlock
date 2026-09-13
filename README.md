# GRIDLOCK

An original online multiplayer game inspired by the fast-paced, top-down urban
action games of the late 1990s: arcade driving, weapon pickups, and team combat
across a large city, with an authoritative server.

Everything in this repository is original. No maps, characters, names, missions,
artwork, audio, dialogue, UI or branding are taken from any existing game. All
placeholder art is generated procedurally from the palettes in
`packages/client/src/render/assets.ts`, and every sound is synthesised at
runtime in `packages/client/src/audio/Audio.ts`, so there are no asset files to
license and both are swappable from one place.

---

## Quick start

Requirements: **Node.js 22+** and npm 10+. Nothing else — the
MVP runs entirely in memory, with no database or Redis.

```bash
npm install
npm run dev
```

Then open **http://localhost:5173**.

`npm run dev` builds the shared package and starts both processes:

| Process     | Port | Notes                                                     |
| ----------- | ---- | --------------------------------------------------------- |
| Game server | 2567 | Authoritative simulation, WebSocket at `/ws`               |
| Web client  | 5173 | Vite dev server; proxies `/ws` and `/api` to the game server |

Because Vite proxies the WebSocket, the browser only ever talks to one origin
and no CORS or environment configuration is needed locally.

### Playing with two clients

1. Click **Create Private Match** and copy the five-letter room code.
2. Open a second browser tab (or a different browser) at the same URL.
3. Click **Join by Code**, enter the code, and press **Start Match** in the
   first tab.

Each tab is its own player: the session token lives in `sessionStorage`, so it
survives a reload of that tab (which is what reconnection needs) without being
shared between tabs.

Empty slots fill with bots, so a single player can start a match immediately via
**Single-Player Practice**.

### Controls

| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` (or arrows) |
| Aim / Fire | Mouse / Left click |
| Sprint | `Shift` (consumes stamina) |
| Reload | `R` |
| Enter / exit vehicle | `E` |
| Swap for a weapon on the ground | `F` |
| Weapon slots | `1`–`4`, or mouse wheel |
| Jump (bullets pass beneath you mid-jump) | `Space` |
| Use a medkit / an armour plate | `H` / `G` |
| Barricade / sentry gun / proximity mine | `Q` / `T` / `X` |
| While placing: rotate / place / cancel | Wheel / Click (or the key again) / Right-click or `Esc` |
| Scoreboard | `Tab` (hold) |
| Expand map | `M` |
| Settings / pause | `Esc` |

---

## Commands

```bash
npm run dev          # shared build + server + client, watch mode
npm run build        # production build of all three packages
npm start            # run the built server: game page, API and WebSocket on one port
npm test             # run the full test suite once
npm run test:watch   # tests in watch mode
npm run typecheck    # type-check every package
npm run loadtest     # bot-driven load test (server must be running)
npm run soak         # 2-minute in-process room soak (heap should stay flat)
```

The load test drives real WebSocket clients against a running server:

```bash
npm run loadtest -w @gridlock/server -- --clients 8 --seconds 30
```

It reports connects, reconnects, snapshot rate, kill events and — the thing it
exists to catch — whether any reconnect ever duplicated a player.

---

## Deploying

In production one Node process serves the game page, the API and the WebSocket
on a single port, and `/api/health` reports whether each live match keeps its
tick rate. `render.yaml` deploys it as a Render web service; the steps, what
the free tier means for a real-time game, and how to read the health report are
in [docs/DEPLOY.md](docs/DEPLOY.md).

---

## Project layout

```
packages/
  shared/     Types, protocol, tunable config, maps, and the physics that both
              the server and the client's prediction run
    src/config/     gameplay.ts, weapons.ts, vehicles.ts  (all tunables)
    src/maps/       map registry + two procedurally assembled maps
    src/sim/        collision grid, player movement, vehicle handling
    src/protocol.ts message shapes + inbound validation
  server/     Authoritative simulation, rooms, matchmaking, bots, persistence
    src/sim/        world, combat, pickups, vehicles, spawning, loadouts
    src/modes/      GameMode interface + Team Deathmatch
    src/rooms/      Room lifecycle, RoomManager, room codes
    src/net/        connection handling, rate limiting, snapshot building
    src/bots/       bot AI
    tests/          server rules, security and end-to-end multiplayer tests
  client/     Browser client
    src/game/       prediction, reconciliation, interpolation, input
    src/render/     canvas renderer, chunked static layer, sprites, minimap
    src/ui/         React menu, lobby, HUD, scoreboard, results, settings
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together and
why.

---

## What is implemented

**Gameplay**

- Top-down combat with directional aiming independent of movement
- Eight weapons plus fists, all defined purely as data: pistol, SMG, shotgun,
  assault rifle, marksman rifle, steel pipe, frag charge, rocket launcher
- Hitscan and projectile weapons, pellet spread, damage falloff, per-shot
  spread bloom, movement and sprint accuracy penalties
- Health, armour, stamina, damage, elimination, respawn, spawn protection
  (which is forfeited the moment you fire, so it cannot be abused)
- Bodies stay on the ground for a few seconds after a kill, then the player
  joins the respawn queue
- **Jumping.** A short hop with a stamina cost and a cooldown: bullets pass
  beneath you in the middle of the jump, mines do not trigger, explosions still
  hurt. Bots use it too when they are under fire
- Kill, assist, death, streak and damage tracking
- Class-based weapon slots with pickup, swap-on-request and drop-on-swap
- Ammo, health, armour and weapon pickups with per-type respawn timers, a
  60-unit collection radius, and a grab animation that starts the instant you
  reach an item (predicted locally, confirmed by the server)
- **A pouch for health and armour.** Medkits and armour plates are carried
  (up to three each) and used when you choose; a full pouch applies a pickup
  on the spot instead. Carried medkits spill when you die
- **Six vehicle categories, each a real trade-off.** Motorcycle (fastest off
  the line, riders exposed to gunfire), Car (the all-rounder), Sports Car
  (highest top speed, slides and breaks easily), Van (six seats, slow), Truck
  (smashes barricades, sluggish) and Armored (nearly bulletproof, rare, still
  hurt by explosives). Each has its own sprite, handling, bullet and explosive
  resistance, crash toughness, demolition power and wreck blast, and a HUD card
  shows its ratings, strengths and weaknesses as you approach
- Vehicle collision follows the whole body - a row of circles along its length -
  so noses no longer clip into walls, cars or defences, and a long vehicle
  cannot turn its tail through a building
- Vehicles: enter, drive, collide, ram pedestrians and barricades, take damage,
  explode, eject occupants, and respawn at their map spawn point
- **Shared rides.** Several players can board the same vehicle, each in their
  own seat. The first aboard drives; leaving the driver's seat promotes a
  passenger rather than stranding the car
- **Firing from a vehicle.** Passengers can shoot out — the driver cannot,
  because they have both hands on the wheel. Shots leave from the shooter's
  actual seat and never strike their own vehicle. Occupants are shielded by the
  bodywork: incoming bullets damage the car, not the people inside
- **Base defences, with a placement preview.** Inside your team's base area,
  place **barricades** (cover that blocks bullets and movement, rotatable in 15°
  steps), **sentry guns** (track and fire on enemies in line of sight, kills
  credited to whoever placed them) and **proximity mines** (hidden from enemies
  until they are close, devastating to vehicles, cleared by jumping over).
  Pressing a defence key shows a green or red ghost where it will land; the
  server answers every placement and the banner says why one was refused.
  Defences are capped per team, on a per-player cooldown, and destructible

**Match flow**

- Main menu, quick match, private rooms with codes, join by code,
  single-player practice
- Lobby with team selection, host-only settings and automatic balancing
- Countdown, live match, results screen with a full scoreboard, rematch
- Team Deathmatch with score target, match timer, draw handling

**Networking**

- Authoritative server on a fixed 30 Hz tick; 15 Hz snapshots
- Client-side prediction for on-foot movement and for the vehicle you drive
- Server reconciliation with smoothed error correction (no teleporting)
- Entity interpolation 120 ms behind the newest snapshot
- Interest management: entities beyond 1700 units are not sent at all
- Reconnection with a 45-second grace period, then bot replacement
- Rate limiting, message-size caps, name sanitisation, chat filtering,
  server-generated identities and room codes

**Client**

- Chunked, cached city renderer: roads, kerbs, crossings, lane markings,
  street lighting, extruded buildings with rooftop detail, water and districts
- Base defences drawn in the owning team's colour, with a live turret barrel,
  an arming pulse and damage bars; vehicle occupancy pips show who is aboard
- Character and vehicle sprites, muzzle flashes, tracers, impacts, explosions
- Locally predicted shot feedback, so firing responds on the same frame
- Hit confirmation: crosshair hit marker, floating damage numbers, a distinct
  tone for a hit and for a kill, and heavier blood spray on a body shot
- Optional aim assist (a slider, off at 0) that gently pulls the crosshair
  toward a visible enemy
- Weapon icons authored once and drawn both on ground pickups and in the
  loadout bar, so a weapon in the street matches the one in your slots
- Friend/foe identification: team-coloured rings for allies, dashed hostile
  rings for enemies, name tags with team badges, and a persistent team banner
- HUD, kill feed, minimap, expandable map, scoreboard, results
- Settings: volumes, sensitivity, screen shake, colourblind palette, reduced
  flashing, quality presets, fullscreen, latency display

---

## Known limitations

- **Team Deathmatch only.** Capture the Flag and Battle Royale have their data
  (flag bases, safe zones) in the map format and a `GameMode` interface to slot
  into, but no implementation yet.
- **Bots do not drive.** They fight on foot. After spawning they sometimes
  fortify their base (sentry gun, barricade or mine), but only ever fill half of
  each team limit, so human teammates always have defences left to place.
- **Guest identities only.** Accounts, stats, clans and match history run
  through a `Store` interface with an in-memory implementation; the PostgreSQL
  implementation is not written.
- **8 humans per match.** The cap is deliberate for this milestone; the room,
  interest management and snapshot code are not the limit.
- **Rendering is Canvas2D, not Phaser.** See the architecture notes for why.
- **Key rebinding is not exposed in the UI.** The input layer is fully
  binding-table driven; only the settings screen for it is missing.
- **Aim assist is client-side.** It only adjusts the angle before it is sent,
  and the server still decides every hit, but a modified client could apply a
  stronger pull. That is inherent to trusting the player's aim, and is the
  normal trade-off for the genre.
- **Desktop controls only, for now.** Mobile-first is the next milestone.
- **Restarts drop live matches.** Rooms are held in memory, so a redeploy ends
  the matches in progress, a production server runs as a single instance, and
  `tsx watch` restarts the dev server on every code change.
- **No music.** Sound effects are synthesised; the music volume slider is wired
  but there is no soundtrack.

## Next milestone

Mobile-first: touch controls that feed the same input pipeline as keyboard and
mouse (so desktop is unaffected), and a responsive HUD whose map and panels never
cover the screen. The phased plan, open questions and what follows are in
[docs/ROADMAP.md](docs/ROADMAP.md).

---

## Environment

Copy `.env.example` to `.env` if you want to override defaults. Every value has
a working default and no secrets are required to run the game.

```
PORT=2567          # game server port (also settable with --port)
HOST=0.0.0.0
CLIENT_DIST=       # built client to serve; defaults to packages/client/dist
TRUST_PROXY=0      # proxies in front of the server (3 on Render)
ALLOWED_ORIGINS=   # extra page origins allowed to connect; own host always is
MAX_ROOMS=20       # most rooms the server holds at once
```

The server also accepts `--port <n>`, which takes precedence over the
environment. That matters because some dev harnesses inject a `PORT` intended
for the web client.
