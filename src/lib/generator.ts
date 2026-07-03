import type { LegCall, Route, RoutesData, Shift, ShiftLeg } from "../types";

/** minutes to change ends / prepare the train between legs */
export const TURNAROUND_MIN = 4;
/** hard cap so a pathological duration target can never loop forever */
const MAX_LEGS = 40;

export interface ShiftOptions {
  operator: string;
  mode: "legs" | "minutes";
  target: number;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
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
 * Build a shift: start on a random route of the operator, then repeatedly
 * reverse at the terminus and continue with a route that departs from it.
 * A route back the way we came is only chosen when nothing else leaves the
 * station (dead-end termini like Hampton Hargate on Connect).
 */
export function generateShift(data: RoutesData, opts: ShiftOptions): Shift | null {
  const pool = data.routes.filter((r) => r.operator === opts.operator);
  if (pool.length === 0) return null;

  const legs: ShiftLeg[] = [];
  let clock = 0;
  let station: string | null = null;
  let prevCode: string | null = null;

  const done = () =>
    opts.mode === "legs" ? legs.length >= opts.target : clock >= opts.target;

  while (!done() && legs.length < MAX_LEGS) {
    let route: Route;
    let reversed: boolean;
    if (station === null) {
      route = pick(pool);
      reversed = Math.random() < 0.5;
    } else {
      const here = pool.filter(
        (r) => r.origin === station || r.destination === station,
      );
      const fresh = here.filter((r) => r.code !== prevCode);
      route = pick(fresh.length > 0 ? fresh : here);
      reversed =
        route.origin === route.destination
          ? Math.random() < 0.5
          : route.destination === station;
    }

    const calls = buildLegCalls(route, reversed);
    const durationMin = calls[calls.length - 1].minutesIntoLeg;
    if (legs.length > 0) clock += TURNAROUND_MIN;
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

  return {
    operator: opts.operator,
    legs,
    totalMin: clock,
    totalPoints: legs.reduce((s, l) => s + l.route.points, 0),
    totalXp: legs.reduce((s, l) => s + l.route.xp, 0),
  };
}
