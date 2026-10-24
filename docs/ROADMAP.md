# Roadmap

Status as of 2026-09-13. Features in detail: `../README.md`. Design reasoning:
`ARCHITECTURE.md`. Hosting: `DEPLOY.md`.

## Where things stand

Playable Team Deathmatch for up to 8 humans plus bots, on two maps, with an
authoritative server, client prediction and reconnection. On top of the original
vertical slice:

- **Combat feel** - predicted shot feedback, hit markers and damage numbers,
  optional aim assist, bodies that stay down, jumping (bullets pass beneath you
  mid-jump).
- **City art** - chunked static renderer: roads, crossings, lighting, extruded
  buildings with rooftop detail; category-specific vehicle sprites; weapon icons
  shared between world and HUD.
- **Vehicles** - six categories with real trade-offs (Motorcycle, Car, Sports
  Car, Van, Truck, Armored); shared rides; passengers can shoot; whole-body
  collision; HUD card with ratings.
- **Base defences** - barricades (rotatable), sentry guns and proximity mines,
  with a placement preview and a server answer for every placement.
- **Pickups** - wide radius with instant predicted grab animation; health and
  armour carried in a pouch and used on demand.
- **Quality** - 246 tests (rules, security, end-to-end WebSocket, production
  hosting), load test, in-process soak test, production build.

## Free Roam: the always-on city (in progress, started 2026-10-24)

A persistent open-world mode on Harbor Reach: one shared world that never
ends, free-for-all, with crime, a per-player wanted level and police who chase
only the offender. All content stays original. Scope agreed: no persistence
between sessions yet, about 32 players on one server.

1. **Always-on world** - done: `RoomManager.freeRoam()` opens one persistent
   room (live from construction, never concludes, never closes when empty);
   players join as `NO_TEAM` from "Enter the City", spawn on any open street,
   leave after the reconnect grace instead of becoming bots; quick play never
   picks it; clients cannot create another; defences are disabled.
2. **Crime and wanted level** - done: `sim/wanted.ts`. Assault (once per
   victim per 3 s), murder and wrecking a vehicle add heat; heat maps to 0-5
   stars (`GAMEPLAY.wanted`). After 12 s without a crime the level drops a star
   every 8 s; dying clears it. Attacking someone already wanted is not a crime.
   Stars show in the HUD (blinking while cooling), above wanted players' names
   and as red minimap dots; the crime callout is private to the offender.
   M3 should reset the cool-off whenever police can see the offender.
3. **Police** - done: `npc/CityDirector.ts`. Officers are dispatched per
   wanted player (`GAMEPLAY.police.unitsByStars`), on foot or from 3 stars by
   squad car (two officers, light bar), and chase only their suspect along the
   road grid. They arrest a slow suspect on contact (any star level, also a
   suspect who stops their car beside them) and shoot from 3 stars. While an
   officer can see the suspect, the wanted level cannot cool (`markSeen`).
   Arrest = `busted` event, level cleared, respawn. Officers stand down and
   leave once nobody is wanted. In a crowded city they may spawn closer to
   other players rather than not at all.
4. **City life** - done: pedestrians walk kerb corner to corner and flee
   gunfire; traffic follows right-hand lanes, brakes for anything in its path
   and nudges through after 3 s. Residents are world players flagged `npc`,
   driven by input commands, so shooting, running over, carjacking (E beside a
   resident's car; a crime) and wrecking all use the normal simulation. They
   spawn 760-1450 units from a player, out of view, and are recycled beyond
   1900; an empty city has none. Killing one is murder but never scores or
   reaches the kill feed. Road graph lives on the map (`roads`), pruned
   against collision geometry by `npc/roadNet.ts`. Cost measured headless:
   ~0.2 ms/tick with 1 player, ~1 ms with 8 or 32.
4b. **Kestrel Region** - done: free roam moved to its own map,
   `maps/region.ts` (16384x12288, ~9x Harbor Reach, free roam only): Harborside
   (dense hub), Ironvale (industrial) and Sandmere (low-rise, straddles the
   river, beach and bay) joined by four highways across open country and the
   Kestrel River. Highway road points every 512 units are `rural` (traffic and
   police, no pedestrians). Each town is a police jurisdiction: a crime belongs
   to the town it happened in (or the nearest); outside it the level cools 2x
   faster and only half the reinforcements come (`wanted.outsideCoolRate`,
   `police.outsideUnits`). Newcomers spawn 500-1400 units from a random player,
   or in Harborside when the world is empty. Only towns are paved; minimap
   cache is sharper (<= 2048 px). Measured: ~1 ms/tick at 8 players, ~2.3 ms at
   32 with 100+ residents.
4c. **Police rework** - done (playtest: "very hard to get rid of the cops"):
   officers only know what they have seen. A crime is reported from the scene
   (at once if an officer saw it, after `police.responseDelaySec` otherwise);
   sightings update the last known position (`lkpX/lkpY`) and are shared by
   radio for `radioSec`; lost suspects are searched for around that spot.
   Sight range grows with stars (`sightByStars`) and new units spawn beyond
   it. Two officers to a squad car whenever two or more are needed; ambient
   patrol cars (`patrolsPerPlayer`, `maxPatrols`) take nearby calls; road
   blocks from 4 stars; passengers shoot from 4 stars; squad cars ram a
   suspect who is driving. A car swap nobody saw drops a star. Code split:
   `npc/CityDirector.ts` (residents), `npc/police.ts`, `npc/brains.ts`.
   Residents route with `CityDirector.route` (heading-aware, cached) and a
   wedged driver reverses out.
5. **Money and jobs** - done, nothing saved between visits: `economy/`
   (`Economy`, `cash.ts`, `services.ts`, `jobs.ts`). Start $250; wallets drop
   from residents (a punch drops half, once); bounties for wanted players;
   death drops 25%, bail costs 20%. Map `services` per town: chop shops and
   respray garages (drive in), stores (hold a gun for 4 s: cash + robbery),
   gun counters (E to buy), phone booths (E: courier or hit job). HUD cash,
   job panel and edge arrow, hold-up bar, notices; scoreboard ranks by cash.
   Cellphone ($300 at any gun counter): job offers ring in every 30-60 s
   anywhere (Y take, N pass, rings off after 15 s); booths still work.
   Money feedback: rolling HUD counter (bounce on gain, gold burst for $300+,
   red shake on loss; settles by timer when animation frames are paused),
   floating world "+$X" pops with sparks, money sounds; death screen shows the
   25% dropped, arrest screen the bail.
   Jobs built on the city's systems (`economy/jobs.ts`): steal to order (a
   given vehicle type or a squad car to a named chop shop; pay by condition),
   armored truck (a security van on its rounds; wreck it and its cash spills
   as money drops), decoy (start at 3 stars, lose them in time), bounty (the
   most wanted player, else an armed fugitive who shoots back), plus courier
   and hit. Story layer (`economy/story.ts`): three original contacts, one
   per town (Vera Lowe - Harborside, Otto Kessel - Ironvale, Nell Price -
   Sandmere), one short line when they call and one when the job ends; per
   visit, after 3 jobs a contact offers a finale at 2x pay. Booths connect to
   the local contact, the cellphone to any. Settings "Story text" hides it all.
   Armed crews (`npc/crews.ts`, resident kind `thug`): a group set against one
   player by a job; guards until it spots its target or is attacked, then
   fights with police shooting rules (bursts, standoff, aim error), chases the
   last sighting, hideout crews leashed to home. Crew bullets pass through and
   never hurt crew; crews only ever target their player; killing one is an
   assault (noise), never murder; they drop guns and wallets. Balance measured
   headless: a whole hideout on an exposed player was ~194 dps (dead in 0.5 s),
   now ~50 dps via `crew.damageScale` 0.4, looser aim and a 0.7 s reaction
   beat. Jobs: the cash van now has a 3-guard escort car that bails out and
   fights when the van is attacked; new crew hideout job (5 gunmen, $900) is
   Vera's finale (7 gunmen, 2x pay). Still to do: courier ambushes and hit
   targets with bodyguards (same crews).

6. **Always-on hosting** - Render free sleeps when idle; needs a paid instance.

### Free Roam phase 2 (planned)

Phase 1 (everything above) is deployed. Next, agreed 2026-10-24:

1. **Join a friend** - a menu option that spawns you near a friend, by a short
   code shown in their HUD; today newcomers appear near a random player.
2. **In-game chat** - city-wide and nearby channels (the server already
   accepts `chat`; the match screen has no chat box).
3. **Crews (co-op)** - 2-4 friends: no damage to each other, shared jobs and
   split pay, the police chase the crew as one.
4. **Always-on hosting** - a paid instance (Render free sleeps when idle and
   every restart wipes the city), then a real session with friends watching
   `/api/health`.
5. **More cities** - open a second city when the first is full (32).
6. **More crew fights** - courier ambushes and hit targets with bodyguards.

## Open questions

- **"Vehicle's default driving direction seems the opposite way."** Measured:
  forward moves every vehicle toward its nose, and the sprites agree. Fixed one
  real contributor (Harbor Reach's eastern base vehicles parked facing the map
  edge). Still waiting on what exactly felt reversed. Likely candidate: players
  expect *screen-relative* driving (push toward where you want to go) rather than
  *car-relative* (forward follows the bonnet). Mobile controls make this
  decision necessary anyway - see below.

## Known gaps

- Team Deathmatch only; Capture the Flag and Battle Royale not implemented
  (map data and the `GameMode` interface are ready).
- Bots do not drive. They place defences (up to half of each team limit) but
  do not repair, rotate or reposition them.
- Guest identities only; the PostgreSQL `Store` is not written.
- No key-rebinding UI; no music.
- Live matches are dropped whenever the server restarts or redeploys.
- `GameClient.ts` (~1,100 lines) and `Renderer.ts` (~950) are due a split.

## Deployment: play with friends (in progress)

Going one step at a time, aiming for Render's free tier first (details and
trade-offs in `DEPLOY.md`).

1. **GitHub repository** - done: `github.com/benamotz/gridlock` (public).
2. **Production packaging** - done: the server hosts the built client on the
   same port as the API and WebSocket; `render.yaml`; Node 22 pinned;
   proxy-aware client addresses; `/api/health` reports per-match tick rate,
   late ticks, dropped time, CPU and event-loop delay.
3. **Minimal hardening** - done: per-address connection cap (32) and connect
   rate (burst 24, then 2/s), sized so a household, office or carrier sharing
   one address is never refused; server room cap (20); WebSocket origin check;
   refusals explained on the menu; `/api/whoami` to confirm Render's
   `X-Forwarded-For` chain after the first deploy.
4. **Deploy to Render** - done: `https://gridlock-w2tc.onrender.com`, free
   plan, Frankfurt (closest to players in Tel Aviv).
5. **Live check** - load test passed on the live service (8 clients, 30
   ticks/s, 5.8-8.2% CPU, 67-79 ms ping from Tel Aviv). Found and fixed
   `TRUST_PROXY` (Render's chain needs 3, not 1). Remaining: a real match with
   friends while watching `/api/health`.

The free tier's 0.1 CPU carries one full match with little headroom; if
`keepingUp` turns false, move to a paid instance or a VPS.

## Mobile-first (in progress)

### Decisions (agreed 2026-09-12)

- **Landscape only.** Portrait shows a "rotate your device" prompt.
- **Fire at any time, aimed or not: a hybrid fire stick** under the right thumb.
  Tap fires one shot at the nearest visible enemy ahead (or straight ahead);
  holding keeps firing and tracks that target; dragging aims by hand while
  firing. A marker shows who a tap will hit. When the stick is untouched the
  character faces its direction of travel. Settings offers a separate fire
  button instead.
- **Screen-relative driving** is the touch default: push toward where you want
  to go on screen and the vehicle turns and drives there. Keyboard players can
  opt in from Settings; the keyboard default stays car-relative.
- **Analog movement ships in the first mobile version.** Commands carry an
  optional analog axis pair, capped by the server so nobody outpaces a keyboard;
  keyboards keep sending digital directions, so desktop feel is unchanged.

Goal: first-class touch play on phones and tablets **without changing desktop
behaviour**, and a HUD that never covers the screen.

### Principle: touch is another input source, not another game

The keyboard/mouse layer already reduces everything to one `InputSnapshot`
(button bitmask, aim angle, slot) that feeds prediction and the server. A touch
layer produces the same snapshot and `InputManager` merges the two. The
protocol, server, prediction and bots do not change, and desktop keeps working
exactly as it does. Touch UI appears on `pointer: coarse` or on the first touch,
with a Settings override (Auto / On / Off).

### Phase 0 - groundwork

- Extract the input-sampling and HUD-data paths out of `GameClient.ts`.
- Introduce layout tokens (safe-area insets, `vmin`-based sizes) in the CSS.
- Device detection plus the Settings override.

### Phase 1 - touch controls

- **Twin sticks.** Left stick moves (converted to direction bits: no protocol
  change). Right stick aims, and fires once pushed past a threshold - the
  twin-stick convention - with aim assist defaulting higher on touch.
- **Contextual buttons** near the right thumb: Jump, Reload, and Interact / Swap
  shown only when the server offers a prompt.
- **Tappable HUD**: weapon slots, pouch (medkit / armour), defence chips.
- **Placement on touch**: the right stick positions the preview; on-screen
  rotate left/right, place and cancel buttons.
- **Menu, scoreboard and map** buttons replace Esc, Tab and M.
- **Driving**: offer *screen-relative* steering (push the stick where you want to
  go; the vehicle turns toward it and accelerates) as the touch default, with
  car-relative available. Worth offering on desktop too, given the open question.

### Phase 2 - responsive HUD and map

- Landscape first; a "rotate your device" hint in portrait.
- Thumb zones (bottom corners) kept clear of HUD; vitals and ammo move to the
  top edge on touch.
- Minimap as a small corner widget sized in `vmin`. The expanded map becomes a
  dismissible overlay capped at roughly 70% of the short side - never full screen.
- Vehicle card, kill feed and defence panel collapse into compact, tap-to-expand
  chips.

### Phase 3 - camera, performance and platform

- Zoom relative to the viewport, so a phone sees a comparable slice of the city.
- Mobile quality defaults: lower pixel-ratio cap, a smaller static-chunk cache
  (it can reach ~100 MB at desktop settings), lighter static detail, fewer
  effects.
- "Tap to play" overlay that unlocks audio and requests fullscreen and landscape
  orientation lock.
- `touch-action: none`, no pinch zoom or long-press menus, PWA manifest so it can
  be installed.

### Phase 4 - verification

- Unit tests for the stick-to-`InputSnapshot` mapping (pure functions).
- Browser-pane mobile emulation (the mobile preset emulates touch).
- A real phone on the local network (`vite --host`).

### Later, optional

- **Analog movement** for smoother touch feel: add a move vector to
  `InputCommand` and have shared movement consume it. This is the one protocol
  change worth considering; digital 8-way movement is fine to start with.

## After mobile

1. Capture the Flag.
2. Bots that drive and use defences.
3. Four teams and 20 players; larger-map interest tuning.
4. Battle Royale (single-player first, then online).
5. Accounts, stats and clans; cosmetics.
