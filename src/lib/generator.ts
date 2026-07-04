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
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function intersect(set: Set<string>, list: string[]): Set<string> {
  const other = new Set(list);
  return new Set([...set].filter((x) => other.has(x)));
}

/**
 * Calling points in driving order with minutes into the leg. Wiki cumulative
 * times are used when present; gaps are filled by linear interpolation.
 */
function buildLegCalls(route: Route, reversed: boolean): LegCall[] {
  const seq = reversed ? [...route.calls].reverse() : route.calls;
  const times: (number | null)[] = seq.map((c) =>
    reversed ? c.fromDestination : c.fromOrigin,
  );
  const fallbackDuration = Math.round((route.timeMin + route.timeMax) / 2);
  if (times[0] == null) times[0] = 0;
  if (times[times.length - 1] == null) times[times.length - 1] = fallbackDuration;
  for (let i = 1; i < times.length - 1; i++) {
    if (times[i] != null) continue;
    let next = i + 1;
    while (times[next] == null) next++;
    const prev = times[i - 1]!;
    times[i] = Math.round(prev + ((times[next]! - prev) * 1) / (next - i + 1));
  }
  for (let i = 1; i < times.length; i++) {
    times[i] = Math.max(times[i]!, times[i - 1]!);
  }
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
  const pool = data.routes.filter((r) => r.operator === opts.operator);
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
      // Keep the running train legal: only routes it can still work.
      const compat = here.filter((r) => intersect(trains, r.allowedTrains).size > 0);
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

  return {
    operator: opts.operator,
    train: trains.size > 0 ? pick([...trains]) : null,
    trainOptions: trains.size,
    legs,
    turnaroundMin,
    totalMin: clock,
    totalPoints: legs.reduce((s, l) => s + l.route.points, 0),
    totalXp: legs.reduce((s, l) => s + l.route.xp, 0),
  };
}
