import type { LegCall, Route, RoutesData, Shift, ShiftLeg } from "../types";

/**
 * Default minutes to change ends / prepare the train between legs. Not a game
 * rule — SCR has no enforced turnaround (drivers terminate and take up the next
 * service near-instantly) — so this is realism flavor and is user-configurable.
 */
export const TURNAROUND_MIN = 4;
/** hard cap so a pathological duration target can never loop forever */
const MAX_LEGS = 40;

export interface ShiftOptions {
  operator: string;
  mode: "legs" | "minutes";
  target: number;
  /** layover added to the clock at each terminus; defaults to TURNAROUND_MIN */
  turnaroundMin?: number;
  /** force the shift to sign on at this station; null/undefined = anywhere */
  startStation?: string | null;
  /** require every leg to be legal for this train (Train.name); null = any */
  train?: string | null;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function intersect(set: Set<string>, list: string[]): Set<string> {
  const other = new Set(list);
  return new Set([...set].filter((x) => other.has(x)));
}

/** net rise of a (possibly sparse) time column from its first to last value */
function trend(times: (number | null)[]): number {
  const known = times.filter((v): v is number => v != null);
  return known.length < 2 ? -Infinity : known[known.length - 1] - known[0];
}

/**
 * Which interior wiki times to trust. The scraped cumulative minutes are
 * noisy — a station sometimes carries a value that jumps out of order (e.g. a
 * bogus late minute on a stop that's actually early in the run). Trusting them
 * verbatim makes the monotonic clamp collapse a whole run onto one minute. So
 * keep the longest non-decreasing subset of the interior values (those within
 * the endpoint range) and treat the rest as gaps to re-interpolate. Endpoints
 * are always kept. Returns a boolean "keep" mask, one per call.
 */
function trustedTimes(times: (number | null)[]): boolean[] {
  const n = times.length;
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const end = times[n - 1]!;
  // interior anchors that at least sit within [0, end]
  const cand: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = times[i];
    if (v != null && v >= 0 && v <= end) cand.push(i);
  }
  if (cand.length === 0) return keep;
  // longest non-decreasing subsequence over the candidate values (O(n²) DP;
  // n is a handful of calls). Since every candidate lies in [0, end], the
  // endpoints prepend/append cleanly to whatever subsequence we keep.
  const len = cand.map(() => 1);
  const prev = cand.map(() => -1);
  let best = 0;
  for (let a = 0; a < cand.length; a++) {
    for (let b = 0; b < a; b++) {
      if (times[cand[b]]! <= times[cand[a]]! && len[b] + 1 > len[a]) {
        len[a] = len[b] + 1;
        prev[a] = b;
      }
    }
    if (len[a] > len[best]) best = a;
  }
  for (let a = best; a >= 0; a = prev[a]) keep[cand[a]] = true;
  return keep;
}

/**
 * Calling points in driving order with minutes into the leg. Trusted wiki
 * cumulative times anchor the run; out-of-order values and gaps are filled by
 * linear interpolation between the surrounding anchors.
 */
function buildLegCalls(route: Route, reversed: boolean): LegCall[] {
  const ordered = reversed ? [...route.calls].reverse() : route.calls;
  // stations the wiki marks "Service does not stop" in this direction are not
  // calling points of the leg at all (termini always stay)
  const seq = ordered.filter(
    (c, i) =>
      i === 0 ||
      i === ordered.length - 1 ||
      !(reversed ? c.skipReversed : c.skipForward),
  );
  const n = seq.length;
  // A leg's times should climb 0 → duration in driving order. Normally that's
  // fromOrigin (forward) / fromDestination (reversed), but some routes are
  // scraped with those columns swapped or the whole calling list inverted, so
  // the "expected" column runs downhill. Fall back to the other column when it
  // trends more strongly upward, keeping well-formed routes untouched.
  const primary = seq.map((c) => (reversed ? c.fromDestination : c.fromOrigin));
  const alt = seq.map((c) => (reversed ? c.fromOrigin : c.fromDestination));
  const times: (number | null)[] = trend(alt) > trend(primary) ? alt : primary;
  const fallbackDuration = Math.round((route.timeMin + route.timeMax) / 2);
  // anchor the endpoints: the leg leaves at 0 and arrives at the terminus time
  times[0] = 0;
  if (times[n - 1] == null || times[n - 1]! <= 0) times[n - 1] = fallbackDuration;

  // drop interior anchors the wiki got out of order, then fill every gap
  const keep = trustedTimes(times);
  for (let i = 1; i < n - 1; i++) if (!keep[i]) times[i] = null;
  for (let i = 1; i < n - 1; i++) {
    if (times[i] != null) continue;
    let hi = i + 1;
    while (times[hi] == null) hi++;
    const lo = i - 1;
    const vLo = times[lo]!;
    const vHi = times[hi]!;
    // interpolate the whole null run from the fixed anchors (not step-by-step,
    // so rounding can't drift a run onto one minute)
    for (let j = i; j < hi; j++) {
      times[j] = Math.round(vLo + ((vHi - vLo) * (j - lo)) / (hi - lo));
    }
    i = hi - 1;
  }
  // safety net: a rounding tie must never place a call before the previous one
  for (let i = 1; i < n; i++) times[i] = Math.max(times[i]!, times[i - 1]!);

  return seq.map((c, i) => ({ name: c.name, minutesIntoLeg: times[i]! }));
}

/**
 * Build a shift: sign on at a chosen (or random) station, then repeatedly
 * reverse at the terminus and continue with a route that departs from it.
 * A route back the way we came is only chosen when nothing else leaves the
 * station (dead-end termini like Hampton Hargate on Connect).
 *
 * A driver keeps ONE train for the whole shift, so every leg is restricted to
 * routes whose allowed rolling stock still shares a train with the legs so far.
 * When no connecting route can be run by the running train, the driver signs
 * off (the shift ends) even if the leg/duration target isn't reached.
 */
export function generateShift(data: RoutesData, opts: ShiftOptions): Shift | null {
  const wantTrain = opts.train ?? null;
  const pool = data.routes.filter(
    (r) =>
      r.operator === opts.operator &&
      (wantTrain == null || r.allowedTrains.includes(wantTrain)),
  );
  if (pool.length === 0) return null;

  const turnaroundMin = opts.turnaroundMin ?? TURNAROUND_MIN;
  const legs: ShiftLeg[] = [];
  let clock = 0;
  let station: string | null = null;
  let prevCode: string | null = null;
  // Trains still legal on every leg driven so far (running intersection).
  let trains: Set<string> = new Set();

  const done = () =>
    opts.mode === "legs" ? legs.length >= opts.target : clock >= opts.target;

  while (!done() && legs.length < MAX_LEGS) {
    let route: Route;
    let reversed: boolean;
    if (station === null) {
      let starters = pool;
      if (opts.startStation) {
        starters = pool.filter(
          (r) => r.origin === opts.startStation || r.destination === opts.startStation,
        );
        if (starters.length === 0) return null; // nothing signs on here
      }
      route = pick(starters);
      reversed =
        route.origin === route.destination || !opts.startStation
          ? Math.random() < 0.5
          : route.destination === opts.startStation;
      trains = new Set(route.allowedTrains);
    } else {
      const here = pool.filter(
        (r) => r.origin === station || r.destination === station,
      );
      // Keep the running train legal: only routes it can still work. With a
      // requested train, insist every onward route allows it specifically, so
      // it survives in the intersection (the roster stays the full common set).
      const compat = here.filter((r) =>
        wantTrain != null
          ? r.allowedTrains.includes(wantTrain)
          : intersect(trains, r.allowedTrains).size > 0,
      );
      if (compat.length === 0) break; // sign off — no onward route for this train
      const fresh = compat.filter((r) => r.code !== prevCode);
      route = pick(fresh.length > 0 ? fresh : compat);
      reversed =
        route.origin === route.destination
          ? Math.random() < 0.5
          : route.destination === station;
      trains = intersect(trains, route.allowedTrains);
    }

    const calls = buildLegCalls(route, reversed);
    const durationMin = calls[calls.length - 1].minutesIntoLeg;
    if (legs.length > 0) clock += turnaroundMin;
    legs.push({
      route,
      reversed,
      from: reversed ? route.destination : route.origin,
      to: reversed ? route.origin : route.destination,
      departOffsetMin: clock,
      durationMin,
      calls,
    });
    clock += durationMin;
    station = reversed ? route.origin : route.destination;
    prevCode = route.code;
  }

  if (legs.length === 0) return null;

  const roster = [...trains];
  return {
    operator: opts.operator,
    // the picked train if one was requested, else any that works every leg
    train: wantTrain ?? (roster.length > 0 ? pick(roster) : null),
    trainOptions: roster.length,
    trainRoster: roster,
    legs,
    turnaroundMin,
    totalMin: clock,
    totalPoints: legs.reduce((s, l) => s + l.route.points, 0),
    totalXp: legs.reduce((s, l) => s + l.route.xp, 0),
  };
}
