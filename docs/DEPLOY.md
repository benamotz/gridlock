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

### Right after the first deploy: check player addresses

Open `https://<your-service>/api/whoami` from your own browser. `address`
should be your public IP (compare with any "what is my IP" site). If it shows a
private address such as `10.x.x.x` instead, Render has more proxies in front
than `TRUST_PROXY` says: look at `forwardedFor`, set `TRUST_PROXY` to the
number of entries after your own IP plus one, and redeploy. Per-address limits
count the wrong thing until this is right.

Measured on the live service (2026-09-13): `forwardedFor` arrives as
`client, Cloudflare edge, Render load balancer (10.x)` and the socket peer is
a local proxy, so `TRUST_PROXY` is 3. The first deploy used 1, which made every
player look like the load balancer - one shared address for the whole server.

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
ticks per second.

**Measured on the live Render free service (2026-09-13, Frankfurt):** the same
8-client load test from Tel Aviv passed with no errors. Ticks held at 29.9-30.1
per second with no dropped time; CPU was 5.8-8.2% of a core, just inside the
0.1 CPU allowance; average work was about 1 ms per tick, with occasional spikes
of 50-67 ms (0-8 late callbacks per 10 s). Game ping from Tel Aviv was 67-79 ms.

That is enough for one full match, with little headroom. If players see lag
and `keepingUp` goes `false`, move to a paid Render instance or a small VPS;
nothing in the code changes.

## Limits and shared networks

Friends often play from one network - a house, an office, a phone carrier -
and all of them then share a single public address. The limits are sized for
that, and exist only to stop one source flooding the server:

| Limit | Value | Why this size |
| --- | --- | --- |
| Open connections per address | 32 | A full match is 8 players; a whole office with extra tabs still fits. |
| New connections per address | burst of 24, then 2/s | A group whose Wi-Fi drops reconnects at once; a reconnect loop is slowed. |
| Rooms on the server | 20 (`MAX_ROOMS`) | Protects a small instance's CPU. Existing rooms stay joinable by code. |
| WebSocket origin | the game's own host | Other websites cannot open game connections from their pages. |

A refused player sees why on the main menu ("Too many game connections from
your network...") rather than a silent failure. The values live in
`GAMEPLAY.net` (`packages/shared/src/config/gameplay.ts`). The load test runs
every client from one address, so it doubles as the check that a group on one
network is never turned away.

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
| `TRUST_PROXY` | 0 | Proxies in front of the server whose `X-Forwarded-For` entries are trusted. `render.yaml` sets 3 (measured); re-check with `/api/whoami` after deploying. |
| `ALLOWED_ORIGINS` | - | Extra page origins allowed to open game connections, comma-separated (`*` allows any). The server's own host is always allowed. |
| `MAX_ROOMS` | 20 | Most rooms the server holds at once. |
| `NODE_VERSION` | - | Read by Render to pick the Node.js version (22). |

## Not done yet

- A Dockerfile for hosts other than Render.
