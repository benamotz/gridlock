# GRIDLOCK — working notes for Claude

Original top-down multiplayer urban combat game, *inspired by* late-90s
top-down action games. It must stay an original product: no names, maps,
characters, art, audio or branding from any existing game.

Read `docs/ARCHITECTURE.md` for the why, `docs/ROADMAP.md` for what is next.

## Stack and layout

TypeScript npm workspaces. Node + `ws` authoritative server, React + Canvas2D
client (Canvas2D instead of Phaser is a deliberate, documented decision), Vitest.

```
packages/shared   everything both sides must agree on
  config/         gameplay.ts, weapons.ts, vehicles.ts - ALL tunables
  types.ts        domain types, Btn bitmask, DEPLOYABLES table
  protocol.ts     wire messages + parseClientMessage (clamps every field)
  sim/            collision grid, player movement (+jump), vehicle physics
                  (body = row of circles), deploy geometry - run on BOTH sides
  maps/           procedural map builders + registry; pruneBlockedSpawns
packages/server
  sim/            World (tick), combat, pickups (+pouch), vehicles,
                  deployables (barricade/turret/mine), spawn, loadout
  rooms/          Room lifecycle + tick loop, RoomManager, room codes
  net/            Connection (per socket), snapshot (per-viewer filtering)
  bots/           BotController - produces InputCommands like a human
  tests/          rules, security and end-to-end WebSocket tests
packages/client
  game/           GameClient (loop, prediction, reconciliation, interpolation),
                  input.ts (binding table -> InputSnapshot), placement.ts,
                  collection.ts (predicted pickups)
  render/         Renderer, chunked StaticLayer, sprites, weaponIcons, minimap
  ui/             React screens and HUD; store.ts (zustand)
```

## Commands (run from `gridlock/`)

```
npm run dev          # builds shared, starts server :2567 + client :5173
npm test             # full suite (server + client tests)
npm run build        # shared + server + client production build
npm start            # production: one port serves client/dist + /api + /ws
npm run typecheck
npm run loadtest     # 8 WebSocket clients vs a running server
npm run soak         # 2-minute in-process room soak; watch heap stay flat
```

After editing `packages/shared`, rebuild it before typechecking the others:
`./node_modules/.bin/tsc -b packages/shared`.

## Invariants - do not break these

- **Server authority.** Clients send intent only: `InputCommand` (seq, dtMs,
  buttons, aim, slot) plus discrete requests (`deploy`, chat...). Never add a
  message that lets a client state health, ammo, position, score or results.
- **Shared simulation is deterministic in `dt`.** Movement, jump and vehicle
  physics are replayed by client prediction. Timers advance by `dt`, never by
  wall clock. Gameplay physics changes belong in `packages/shared/src/sim`.
- **Tunables live in config**, not in simulation code.
- **Snapshots are per viewer.** Interest radius, enemy health hidden, enemy
  mines hidden until close, `hitmark` / `damage` / `deploy_result` private.
- **Every inbound field is clamped** in `parseClientMessage`.
- **New input actions** need a `DEFAULT_BINDINGS` entry. Saved settings merge
  bindings per action, so old saves do not unbind new keys.
- **Iterate a snapshot** (`[...map.values()]`) whenever the loop body can add
  to or delete from the collection. Mutating the live pickup Map once caused an
  infinite swap loop and an out-of-memory crash.

## Gotchas learned the hard way

- `tsx watch` restarts the game server whenever shared/server code changes.
  Rooms are in memory, so any live match is dropped and clients return to the
  menu. Multi-file edits can crash it briefly mid-edit; it recovers.
- The dev harness injects `PORT` for Vite; the server takes `--port 2567`.
- The preview launch config lives at the workspace root `.claude/launch.json`
  (name `gridlock`, `cwd: gridlock`).
- React StrictMode double-mounts the socket in dev: one harmless
  "WebSocket is closed before the connection is established" warning per load.
- Fixed test coordinates on depot-yard: use **(1100, 200)** for clear ground.
  (960, 300) sits beside the armored car spawn and inside a map armor pickup's
  60-unit radius.
- Production is one Node process on one port. The server hosts
  `packages/client/dist` whenever it contains `index.html` - so after a local
  `npm run build`, the dev server on :2567 serves that (possibly stale) build
  too; use Vite on :5173 for development. Deploy config is `render.yaml`;
  hosting notes are in `docs/DEPLOY.md`.
- `/api/health` is public: per-match tick stats and process load only. Never
  add room codes or player names to it - a code is enough to join a private room.
- The repo is public on GitHub (`benamotz/gridlock`). No secrets in code, and
  commit or push only when the user asks. Every push to `main` redeploys once
  Render is connected, which ends live matches.
- The Docker daemon is usually not running on this machine; do not rely on it
  for verification.
- Browser pane automation: coordinate clicks on menu buttons are unreliable -
  click via `javascript_tool` on the DOM element, and dispatch key events on
  `document`. **The user often playtests in the same preview tab while work is
  in progress**, so do not drive that tab with synthetic input while they play;
  verify with tests, headless scripts and read-only screenshots instead.

## How to verify a change

1. `npm test` and `npm run build` green.
2. For simulation changes, a small headless script (World + stepVehicle /
   stepPlayerMovement) that measures the actual behaviour, then a regression
   test that names the bug it prevents.
3. For networking changes, `npm run loadtest` against `npm run dev`.
4. For visuals, a read-only screenshot of the preview.

## Conventions

- Comments explain *why*, not what. Match the surrounding density.
- Tests are named for behaviour; regression tests say what used to go wrong.
- Keep files focused; extract a module (as placement and collection were)
  rather than growing `GameClient.ts` or `Renderer.ts` further.
