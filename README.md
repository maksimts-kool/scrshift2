# SCR Virtual Shift Generator

Fan-made web app for [Stepford County Railway](https://www.roblox.com/games/698448796/) on Roblox. It builds a realistic driver **shift**: a random first route, then at each terminus the train reverses and continues on a real route that departs from that station, and so on. Route data (100 active routes, calling points, timings, operator colors) is scraped from the [SCR Unofficial Wiki](https://scr.fandom.com/wiki/List_of_Routes).

Built with React + Vite + TypeScript + Material UI.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the app at http://localhost:5173 (includes the real-time companion) |
| `npm run build` | Type-check and build for production (`dist/`) |
| `npm run scrape` | Refresh `src/data/routes.json` from the wiki (run after game updates) |
| `npm test` | Simulate 1000 shifts + unit-test the real-time tracking logic |
| `npm run test:rt` | Just the real-time matching/estimation tests |

## How shifts work

- A shift stays within **one operator** (like the real game); pick one or hit Random.
- Length is a target **duration** or a number of **legs**.
- Optionally pin the **sign-on station**; otherwise the shift starts anywhere on the operator's network.
- Next leg must depart from the terminus where the previous leg ended. The same route is only run back when nothing else leaves the station (dead-end termini).
- **One train for the whole shift**: every leg is restricted to routes the running train is allowed on (parsed from each route's `rolling_stock` — some routes are exclusive to certain classes or bar longer/double variants). The driver signs off if no onward route fits the train.
- **Turnaround** between legs is an adjustable layover (0–10 min). It's realism flavor, not a game rule — SCR has no enforced turnaround; drivers terminate and take up the next service almost immediately.
- Each leg shows every calling point with clock times, taken from the wiki's per-station cumulative timings. The start time can be re-timed on the result without regenerating the route.

## Real-time mode (dev server only)

The **Real time** switch follows your actual driving on the official
[SCR Hub site](https://stepfordcountyrailway.co.uk) and overlays it on the
generated shift: pending legs show chained estimates, and when you grab the
planned route in-game the leg goes **live** — green actual times, platforms,
delays and dispatchers straight from the site — then freezes as done at the
terminus, one leg after the next. Driving something other than the planned leg
raises an *off-plan* warning while the plan keeps its estimates (strict
matching by route code + direction). All real-time clocks are UK time, because
that's what SCR runs on.

How it works: the Hub site sits behind Roblox OAuth and its activity pages are
Blazor WebAssembly (no scrapeable HTML, live data arrives over SignalR), so a
Vite dev-server plugin ([scripts/realtime/](scripts/realtime/)) keeps a real
Chrome (Playwright, persistent profile in `.scr-session/`, gitignored) logged
in and reads the rendered page DOM of `/Players/{id}/CurrentActivity` for the
logged-in account (auto-detected via Roblox whoami). First use opens a Chrome
window for a one-time Roblox login; afterwards the SCR session is re-established
silently (the site's cookie is session-scoped, but the saved Roblox session
lets the OAuth redirect be clicked through headlessly). The switch only appears
when the companion endpoints (`/api/rt/*`) exist, i.e. under `npm run dev`.

## Project layout

- [`scripts/scrape.mjs`](scripts/scrape.mjs) — wiki scraper (MediaWiki API, parses the route list + each route's page)
- [`scripts/realtime/`](scripts/realtime/) — real-time companion (Playwright SCR session + CurrentActivity DOM parser + Vite plugin)
- [`src/data/routes.json`](src/data/routes.json) — bundled route snapshot (generated; date shown in the app footer)
- [`src/lib/generator.ts`](src/lib/generator.ts) — shift-chaining logic
- [`src/lib/realtime.ts`](src/lib/realtime.ts) — real-time client, leg matching + estimation
- [`src/App.tsx`](src/App.tsx) — the whole UI
- [`scripts/test-generator.mts`](scripts/test-generator.mts), [`scripts/test-realtime.mts`](scripts/test-realtime.mts) — tests

Not affiliated with SCR or Roblox.
