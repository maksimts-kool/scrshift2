import type { Call, Route, RoutesData } from "../types";

/**
 * Hand-maintained corrections layered on top of the scraped route data.
 *
 * The SCR wiki is community-maintained and drifts from the live game — a
 * route's timing points can be a minute stale, a rolling-stock note can lag a
 * game update, etc. Re-scraping doesn't help when the wiki page itself is the
 * thing that's wrong. So corrections live here, in a small reviewed file, and
 * `applyRouteOverrides` merges them over `routes.json` at load time. Because
 * the merge runs every load, corrections survive `npm run scrape` (which only
 * ever rewrites routes.json) with no re-editing.
 *
 * Keep each entry's `note` filled in with what the game actually shows and why
 * the wiki disagrees, so a later re-scrape reviewer knows whether it's still
 * needed.
 */

/** Fields of a single call the wiki can get wrong; merged over the scraped call. */
export type CallOverride = Partial<
  Pick<Call, "fromOrigin" | "fromDestination" | "skipForward" | "skipReversed">
>;

/** Corrections for one route, keyed by route code in {@link RouteOverrides}. */
export interface RouteOverride {
  /** why this correction exists — for maintainers; ignored at runtime */
  note?: string;
  timeMin?: number;
  timeMax?: number;
  points?: number;
  xp?: number;
  /** per-station timing patches, keyed by Call.name (station identity) */
  calls?: Record<string, CallOverride>;
}

export type RouteOverrides = Record<string, RouteOverride>;

/**
 * Return a copy of `data` with `overrides` merged in. Route-level scalars
 * replace the scraped value; `calls` entries are shallow-merged onto the
 * matching station by name (only the listed fields change). Unknown route
 * codes or station names are warned about and skipped, so a typo in the
 * corrections file surfaces instead of silently doing nothing.
 */
export function applyRouteOverrides(
  data: RoutesData,
  overrides: RouteOverrides,
): RoutesData {
  const codes = new Set(data.routes.map((r) => r.code));
  for (const code of Object.keys(overrides)) {
    if (!codes.has(code)) console.warn(`route override for unknown route ${code} ignored`);
  }
  return {
    ...data,
    routes: data.routes.map((route) => {
      const ov = overrides[route.code];
      if (!ov) return route;
      const { note: _note, calls: callPatches, ...scalar } = ov;
      const merged: Route = { ...route, ...scalar };
      if (callPatches) {
        const names = new Set(merged.calls.map((c) => c.name));
        for (const name of Object.keys(callPatches)) {
          if (!names.has(name))
            console.warn(`route override ${route.code}: unknown station "${name}" ignored`);
        }
        merged.calls = merged.calls.map((c) =>
          callPatches[c.name] ? { ...c, ...callPatches[c.name] } : c,
        );
      }
      return merged;
    }),
  };
}
