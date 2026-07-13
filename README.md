# SCR Virtual Shift Generator

Fan-made web app for [Stepford County Railway](https://www.roblox.com/games/698448796/) on Roblox. It builds a realistic driver **shift**: a random first route, then at each terminus the train reverses and continues on a real route that departs from that station, and so on. Route data (100 active routes, calling points, timings, operator colors) is scraped from the [SCR Unofficial Wiki](https://scr.fandom.com/wiki/List_of_Routes).

Built with React + Vite + TypeScript + Material UI.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the app at http://localhost:5173 (includes a local real-time service) |
| `npm run rt` | Start the persistent real-time service (see below) |
| `npm run build` | Type-check and build for production (`dist/`) |
| `npm run scrape` | Refresh `src/data/routes.json` from the wiki (run after game updates) |
| `npm test` | Simulate 1000 shifts + unit-test the real-time and simulate logic |
| `npm run test:rt` | Just the real-time matching/estimation tests |
| `npm run test:sim` | Just the simulate-mode clock/delay tests |

## How shifts work

- A shift stays within **one operator** (like the real game); pick one or hit Random.
- Length is a target **duration** or a number of **legs**.
- Optionally pin the **sign-on station**; otherwise the shift starts anywhere on the operator's network.
- Next leg must depart from the terminus where the previous leg ended. The same route is only run back when nothing else leaves the station (dead-end termini).
- **One train for the whole shift**: every leg is restricted to routes the running train is allowed on (parsed from each route's `rolling_stock` — some routes are exclusive to certain classes or bar longer/double variants). The driver signs off if no onward route fits the train.
- **Turnaround** between legs is an adjustable layover (0–10 min). It's realism flavor, not a game rule — SCR has no enforced turnaround; drivers terminate and take up the next service almost immediately.
- Each leg shows every calling point with clock times, taken from the wiki's per-station cumulative timings. The start time can be re-timed on the result without regenerating the route.

## Simulate mode

If the Hub or hosted real-time service is down, **Simulate** mode replays the
generated shift against the real clock from the chosen start time, reading
nothing from the game. A station shows as *arrived* during its scheduled minute
and turns *passed* once that minute is over. Colours mirror real time except
green: passed is blue, running late is orange, but upcoming stays **grey**,
because nothing is actually live. The delay buttons are event-sourced
([src/lib/simulate.ts](src/lib/simulate.ts)): each click is stamped with the
minute it happened and only moves stations still in the future, so times behind
you never rewrite, and the total is clamped at on-time (a sim can fall behind
but never run early). Simulate runs on the player's local clock, same as the
planner's Start field.

## Real-time mode

The **Real time** switch follows actual driving on the official
[SCR Hub site](https://stepfordcountyrailway.co.uk) and overlays it on the
generated shift. Enter a Roblox username—there is **nothing for the player to
download or install**. Pending legs show chained estimates, and when the
planned route is taken in-game the leg goes live with platforms, delays and
dispatchers from the Hub (green = calls still to come, orange = running late,
blue = already passed).

The Hub activity page is Blazor WebAssembly: its live data arrives over
SignalR and is not present in initial HTML. A persistent service in
[`scripts/realtime/`](scripts/realtime/) therefore keeps an authenticated
Playwright browser running and reads the rendered `/Players/{id}/CurrentActivity`
DOM. Hosted mode maintains one page per active player (bounded to 20 and evicted
after two idle minutes), so concurrent users do not navigate one another's page.

### Hosting architecture

The frontend can stay on **Vercel**, but the browser service must run on a
long-lived container/VPS (for example Render, Railway, Fly.io, or a small VM):

```text
Browser -> Vercel static React app -> HTTPS -> persistent Playwright service -> SCR Hub
```

A Vercel Function is not suitable for this part. The service needs a browser
and authenticated profile to survive between five-second polls and keeps the
Hub's SignalR connection open. Vercel Functions have finite execution duration
and an ephemeral writable filesystem; instance reuse is not guaranteed.

### Deploy the real-time service

1. Create a **dedicated Roblox account** for the service and sign it in to SCR
   Hub once. Do not use an owner's/player's primary account.
2. Put that account's `.ROBLOSECURITY` cookie in the host's secret manager as
   `RT_ROBLOSECURITY`. This is a password-equivalent server secret: never commit
   it, log it, send it to the frontend, or name it with a `VITE_` prefix.
3. Deploy the included [`Dockerfile`](Dockerfile) on a host that supports an
   always-running container. Configure:

   ```env
   RT_MODE=hosted
   RT_ALLOW_ORIGIN=https://your-site.vercel.app
   RT_ROBLOSECURITY=...secret...
   ```

   `PORT` is supported automatically. The container uses `/data/profile`; a
   persistent disk is recommended to reduce reauthorization after restarts.
   Use `/api/rt/health` for the host's HTTP health-check path.
4. Give the service an HTTPS URL, then set this Vercel **build-time** variable
   and redeploy the frontend:

   ```env
   VITE_RT_API_BASE=https://your-realtime-service.example
   ```

Hosted mode requires an explicit allowed frontend origin, rate-limits each
client, validates Roblox usernames server-side, and disables the stop,
change-account, and debug endpoints. The service account identity is omitted
from public status responses. Users provide only a username; they must never
enter a password or cookie in this app.

For local development, `npm run dev` still mounts the same API at `/api/rt/*`.
It uses `.scr-session/` and can open Chrome for the developer's one-time login.

## Project layout

- [`scripts/scrape.mjs`](scripts/scrape.mjs) — wiki scraper (MediaWiki API, parses the route list + each route's page)
- [`scripts/realtime/`](scripts/realtime/) — persistent real-time service (Playwright SCR session + multi-player CurrentActivity DOM parser + shared API + Vite plugin/server)
- [`src/data/routes.json`](src/data/routes.json) — bundled route snapshot (generated; date shown in the app footer)
- [`src/lib/generator.ts`](src/lib/generator.ts) — shift-chaining logic
- [`src/lib/realtime.ts`](src/lib/realtime.ts) — real-time client, leg matching + estimation
- [`src/lib/simulate.ts`](src/lib/simulate.ts) — simulate-mode clock states + event-sourced delay
- [`src/App.tsx`](src/App.tsx) — the whole UI
- [`scripts/test-generator.mts`](scripts/test-generator.mts), [`scripts/test-realtime.mts`](scripts/test-realtime.mts), [`scripts/test-rt-api.mjs`](scripts/test-rt-api.mjs), [`scripts/test-simulate.mts`](scripts/test-simulate.mts) — tests

Not affiliated with SCR or Roblox.
