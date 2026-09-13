# Deploying GRIDLOCK

Target for now: one **Render free web service**, so friends can play from a
single link. The same build runs anywhere that has Node.js 22.

## How production works

- `npm run build` builds the shared package, the server and the client.
- `npm start` runs the server, which serves **everything on one port**: the
  game page (`packages/client/dist`), the API (`/api/*`) and the WebSocket
  (`/ws`). The client finds the socket on the page's own origin, so no URL
  configuration is needed.
- Rooms live in memory. That means **exactly one instance**, and any restart or
  redeploy ends the matches in progress. Deploy when nobody is playing.

## First deploy on Render

1. Make sure `main` is pushed to GitHub (`github.com/benamotz/gridlock`).
2. Pick the region closest to your players in `render.yaml` (`region:`), then
   commit and push. The region cannot be changed after the service exists.
3. Sign in to [render.com](https://render.com) (signing in with GitHub is
   simplest), choose **New → Blueprint**, connect GitHub, select the
   `gridlock` repository and apply. Render reads `render.yaml`.
4. The first build takes a few minutes. The service URL looks like
   `https://gridlock-xxxx.onrender.com`.
5. Open it, create a private match and send friends the room code.

After that, every push to `main` redeploys automatically.

## What the free tier means in practice

- The service **sleeps after 15 minutes** without traffic. The next visitor
  sees a loading page for about a minute while it wakes.
- The instance has **0.1 CPU and 512 MB** of memory. Memory is not a concern
  (the server uses about 80 MB); CPU may be - see below.
- Free instance hours are limited per workspace per month; one service that
  sleeps when idle stays well inside them.

## Is the server keeping up?

Open `https://<your-service>/api/health` during a match.

| Field | Healthy | What it means |
| --- | --- | --- |
| `keepingUp` | `true` | Every live match simulates at least 90% of the tick rate. |
| `matches[].tick.ticksPerSec` | about 30 | Simulation steps per second over the last 10 s. |
| `matches[].tick.lateCallbacks` | 0 or close | Timer callbacks that fired more than two ticks late: the process was starved of CPU. |
| `matches[].tick.droppedMs` | 0 | Game time skipped because the loop fell too far behind. |
| `load.cpuPct` | under 10 on the free tier | CPU as a percentage of one core; the free instance gets 10. |
| `load.eventLoopP99Ms` | low tens | Event-loop delay; rises when the CPU quota runs out. |

The document never includes room codes or player names, because anyone can
fetch it.

**Measured locally (2026-09-13):** 8 load-test clients plus 2 bots on Depot
Yard used 6.7% of one Apple Silicon core, 1.05 ms of work per tick, at 30.1
ticks per second. Cloud cores are slower, so a full match may sit at or above
the free tier's 0.1 CPU. If players see lag and `keepingUp` goes `false`, move
to a paid Render instance or a small VPS; nothing in the code changes.

## Running a production build locally

```bash
npm run build
PORT=4100 TRUST_PROXY=1 npm start
```

Then open http://localhost:4100, and load-test it with:

```bash
npm run loadtest -w @gridlock/server -- --url ws://localhost:4100/ws --seconds 30
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 2567 | Port to listen on; hosting platforms set it. `--port` and `GRIDLOCK_PORT` take precedence. |
| `HOST` | 0.0.0.0 | Interface to bind. |
| `CLIENT_DIST` | `packages/client/dist` | Built client to serve. Nothing is served if it has no `index.html`. |
| `TRUST_PROXY` | 0 | Proxies in front of the server whose `X-Forwarded-For` entries are trusted. `render.yaml` sets 1; confirm Render's proxy chain before relying on client addresses for per-IP limits. |
| `NODE_VERSION` | - | Read by Render to pick the Node.js version (22). |

## Not done yet

- Per-IP connection limits, a cap on total rooms and an origin check (next
  step before sharing the link widely).
- A Dockerfile for hosts other than Render.
