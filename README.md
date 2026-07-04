# SCR Virtual Shift Generator

Fan-made web app for [Stepford County Railway](https://www.roblox.com/games/698448796/) on Roblox. It builds a realistic driver **shift**: a random first route, then at each terminus the train reverses and continues on a real route that departs from that station, and so on. Route data (100 active routes, calling points, timings, operator colors) is scraped from the [SCR Unofficial Wiki](https://scr.fandom.com/wiki/List_of_Routes).

Built with React + Vite + TypeScript + Material UI.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the app at http://localhost:5173 |
| `npm run build` | Type-check and build for production (`dist/`) |
| `npm run scrape` | Refresh `src/data/routes.json` from the wiki (run after game updates) |
| `npm test` | Simulate 1000 shifts and assert the chaining logic holds |

## How shifts work

- A shift stays within **one operator** (like the real game); pick one or hit Random.
- Length is a target **duration** or a number of **legs**.
- Optionally pin the **sign-on station**; otherwise the shift starts anywhere on the operator's network.
- Next leg must depart from the terminus where the previous leg ended. The same route is only run back when nothing else leaves the station (dead-end termini).
- **One train for the whole shift**: every leg is restricted to routes the running train is allowed on (parsed from each route's `rolling_stock` — some routes are exclusive to certain classes or bar longer/double variants). The driver signs off if no onward route fits the train.
- **Turnaround** between legs is an adjustable layover (0–10 min). It's realism flavor, not a game rule — SCR has no enforced turnaround; drivers terminate and take up the next service almost immediately.
- Each leg shows every calling point with clock times, taken from the wiki's per-station cumulative timings. The start time can be re-timed on the result without regenerating the route.

## Project layout

- [`scripts/scrape.mjs`](scripts/scrape.mjs) — wiki scraper (MediaWiki API, parses the route list + each route's page)
- [`src/data/routes.json`](src/data/routes.json) — bundled route snapshot (generated; date shown in the app footer)
- [`src/lib/generator.ts`](src/lib/generator.ts) — shift-chaining logic
- [`src/App.tsx`](src/App.tsx) — the whole UI
- [`scripts/test-generator.mts`](scripts/test-generator.mts) — invariant tests

Not affiliated with SCR or Roblox.
