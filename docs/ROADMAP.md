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
- Bots neither drive nor use defences.
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
3. **Minimal hardening** - next: per-IP connection cap, total room cap, origin
   check. Confirm Render's `X-Forwarded-For` chain first.
4. **Deploy to Render** - the user creates the account and applies the
   Blueprint. Region: Frankfurt, the closest to players in Tel Aviv.
5. **Live check** - load test against the real URL, then a match with friends
   while watching `/api/health`.

Measured locally: a full match (8 clients plus 2 bots) used 6.7% of one Apple
Silicon core. Cloud cores are slower, so the free tier's 0.1 CPU may be
borderline; if `keepingUp` turns false, move to a paid instance or a VPS.

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
