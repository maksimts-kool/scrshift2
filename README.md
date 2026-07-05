# SCR Virtual Shift Generator

Fan-made web app for [Stepford County Railway](https://www.roblox.com/games/698448796/) on Roblox. It builds a realistic driver **shift**: a random first route, then at each terminus the train reverses and continues on a real route that departs from that station, and so on. Route data (100 active routes, calling points, timings, operator colors) is scraped from the [SCR Unofficial Wiki](https://scr.fandom.com/wiki/List_of_Routes).

Built with React + Vite + TypeScript + Material UI.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the app at http://localhost:5173 (includes the real-time companion) |
| `npm run rt` | Standalone real-time companion for the deployed site (see below) |
| `npm run package:companion` | Build the portable companion zip for non-dev users |
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

For anyone who can't run the real-time companion — not on Windows, or the Hub
is down — the **Simulate** mode replays the generated shift against the real
clock from the chosen start time, reading nothing from the game. A station
shows as *arrived* during its scheduled minute and turns *passed* once that
minute is over. Colours mirror real time except green: passed is blue,
running late is orange, but upcoming stays **grey**, because nothing is
actually live. The delay buttons are event-sourced
([src/lib/simulate.ts](src/lib/simulate.ts)): each click is stamped with the
minute it happened and only moves stations still in the future, so times
behind you never rewrite, and the total is clamped at on-time (a sim can fall
behind but never run early). Simulate runs on the player's local clock, same
as the planner's Start field.

## Real-time mode

The **Real time** switch follows your actual driving on the official
[SCR Hub site](https://stepfordcountyrailway.co.uk) and overlays it on the
generated shift: pending legs show chained estimates, and when you grab the
planned route in-game the leg goes **live** — platforms, delays and dispatchers
straight from the site (green = calls still to come, orange = running late,
blue = already passed) — then freezes as done at the terminus, one leg after
the next. Driving something other than the planned leg
raises an *off-plan* warning while the plan keeps its estimates (strict
matching by route code + direction). All real-time clocks are UK time, because
that's what SCR runs on.

How it works: the Hub site sits behind Roblox OAuth and its activity pages are
Blazor WebAssembly (no scrapeable HTML, live data arrives over SignalR), so a
**companion** process ([scripts/realtime/](scripts/realtime/)) keeps a real
Chrome (Playwright, persistent profile in `.scr-session/`, gitignored) logged
in and reads the rendered page DOM of `/Players/{id}/CurrentActivity` for the
logged-in account (auto-detected via Roblox whoami). First use opens a Chrome
window for a one-time Roblox login; afterwards the SCR session is re-established
silently (the site's cookie is session-scoped, but the saved Roblox session
lets the OAuth redirect be clicked through headlessly). The **Change account**
button on the connected banner wipes the saved login and reopens that Chrome
window, so someone else can sign in and be tracked instead.

The companion runs in two ways, sharing the same API ([scripts/realtime/api.mjs](scripts/realtime/api.mjs)):

- **`npm run dev`** mounts it on the Vite dev server itself (`/api/rt/*`, same
  origin, zero setup).
- **`npm run rt`** hosts it standalone on `http://127.0.0.1:8788` for the
  **deployed site** (Vercel). Flip the Real time switch on the site and it
  finds the local companion by itself (first time, Chrome may ask permission
  for the page to reach local devices — allow it). The companion binds to
  loopback only, so nothing is exposed to the network, and every player runs
  it with **their own** Roblox login on their own PC — the site being public
  costs you nothing. Cross-origin calls are only accepted from localhost and
  `*.vercel.app` (override with `RT_ALLOW_ORIGIN=https://your.domain`, e.g.
  when the site moves to a custom domain).

**For players (no dev tools):** the same standalone companion ships as a
portable zip — [SCR-Companion.zip](https://github.com/maksimts-kool/scrshift2/releases/latest/download/SCR-Companion.zip)
(Windows) — with `node.exe`, the realtime scripts and Playwright inside.
Download, unzip anywhere, double-click **Start Companion.bat**; the site's
Real time banner links to it. It uses installed Chrome, or falls back to
Edge (preinstalled on Windows), and keeps its profile in
`%LOCALAPPDATA%\scrshift2-companion` (`RT_PROFILE` overrides). Rebuild it
with `npm run package:companion` (output in `dist-companion/`) and upload it
as a release asset **keeping the file name** — the site links
`releases/latest/download/SCR-Companion.zip`.

To host the companion somewhere else entirely (a home server, Docker box, VPS
— anywhere Chrome can run), start it there with `RT_HOST=0.0.0.0` (plus
`RT_ALLOW_ORIGIN`) and build the frontend with
`VITE_RT_API_BASE=https://your-companion.example`. Note the first login needs
a visible Chrome window on that machine.

## Project layout

- [`scripts/scrape.mjs`](scripts/scrape.mjs) — wiki scraper (MediaWiki API, parses the route list + each route's page)
- [`scripts/realtime/`](scripts/realtime/) — real-time companion (Playwright SCR session + CurrentActivity DOM parser + shared API + Vite plugin + standalone server)
- [`src/data/routes.json`](src/data/routes.json) — bundled route snapshot (generated; date shown in the app footer)
- [`src/lib/generator.ts`](src/lib/generator.ts) — shift-chaining logic
- [`src/lib/realtime.ts`](src/lib/realtime.ts) — real-time client, leg matching + estimation
- [`src/lib/simulate.ts`](src/lib/simulate.ts) — simulate-mode clock states + event-sourced delay
- [`src/App.tsx`](src/App.tsx) — the whole UI
- [`scripts/test-generator.mts`](scripts/test-generator.mts), [`scripts/test-realtime.mts`](scripts/test-realtime.mts), [`scripts/test-simulate.mts`](scripts/test-simulate.mts) — tests

Not affiliated with SCR or Roblox.
