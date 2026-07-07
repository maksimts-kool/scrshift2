import type { RouteOverrides } from "../lib/overrides";

/**
 * Corrections merged over routes.json (see lib/overrides.ts). Add an entry when
 * the live game disagrees with the scraped wiki data; keep `note` describing
 * what the game shows so a future re-scrape reviewer can tell if it's stale.
 */
export const routeOverrides: RouteOverrides = {
  R141: {
    // Wiki lists the Stepford Bay <> Willowfield run as 8 min, but the live
    // game's schedule board runs it in 7: the Cadoxton <> Beechley segment is
    // 2 min in-game, not the wiki's 3. That single minute cascades to every
    // later stop. Corrected symmetrically (both directions lose the minute),
    // which matches the game in the SB -> WFD direction we observed.
    timeMin: 7,
    timeMax: 7,
    calls: {
      Willowfield: { fromDestination: 7 }, // was 8
      "Hemdon Park": { fromDestination: 5 }, // was 6
      Beechley: { fromDestination: 3 }, // was 4
      Cadoxton: { fromOrigin: 6 }, // was 7
      "Stepford Bay": { fromOrigin: 7 }, // was 8
    },
  },
};
