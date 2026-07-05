import type { Shift } from "../types";
import {
  clockDelta,
  ukFormat,
  type LegLiveStatus,
  type SiteCall,
  type SiteService,
} from "./realtime.ts";

/**
 * Simulate mode: replays a generated shift against the real clock with no
 * companion app — for players not on Windows, or when the SCR Hub is down.
 * Nothing is read from the game, so upcoming times stay grey; a station shows
 * as "arrived" during its scheduled minute and becomes passed (blue) once
 * that minute is over.
 *
 * Delay is event-sourced: every +/− click is stored with the wall-clock
 * minute it happened, and a click only moves calls strictly in the future at
 * that moment. Stations already passed — or currently in their "arrived"
 * minute — keep their times. Because clicks arrive in wall-clock order, any
 * call a later minus reaches has already received every earlier plus, so
 * with the total clamped at zero no call can end up before its schedule.
 *
 * All clocks here are local time, matching the planner's Start field.
 */

export interface SimEvent {
  /** wall-clock minutes since local midnight when the click happened */
  atMin: number;
  /** +1 / −1 from the buttons, or a larger jump from the reset chip */
  delta: number;
}

export const simTotalDelay = (events: SimEvent[]): number =>
  events.reduce((sum, e) => sum + e.delta, 0);

/** current minutes since local midnight (the simulation's clock) */
export function localNowMin(now = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * Effective offset from shift start for a call scheduled at `schedOffset`,
 * after replaying the delay events. Each event only shifts the call if the
 * call was still strictly in the future when the click happened.
 */
export function simEffOffset(
  schedOffset: number,
  startMin: number,
  events: SimEvent[],
): number {
  let eff = schedOffset;
  for (const e of events) {
    if (eff > clockDelta(startMin, e.atMin)) eff += e.delta;
  }
  return eff;
}

export interface SimLeg {
  status: LegLiveStatus;
  /** synthesized site-shaped snapshot so the live timeline UI can render it */
  service: SiteService;
  /** effective departure, minutes on the 24h clock (for header fallbacks) */
  startMin: number;
}

/**
 * Snapshot of the whole shift at `nowMin`: per-leg status plus a synthesized
 * SiteService whose calls carry sim states — passed calls freeze their
 * effective time as "arrived", the call whose minute is now shows "current",
 * future calls keep scheduled (plus an orange estimate when delayed).
 */
export function simulateShift(
  shift: Shift,
  startMin: number,
  nowMin: number,
  events: SimEvent[],
  /** seconds past `nowMin` (0–59); only refines the live activity wording */
  nowSec = 0,
): SimLeg[] {
  const nowOffset = clockDelta(startMin, nowMin);

  return shift.legs.map((leg) => {
    const built = leg.calls.map((call) => {
      const schedOffset = leg.departOffsetMin + call.minutesIntoLeg;
      const effOffset = simEffOffset(schedOffset, startMin, events);
      const delay = effOffset - schedOffset;
      const state: SiteCall["state"] =
        nowOffset > effOffset ? "passed" : nowOffset === effOffset ? "current" : "future";
      const effClock = ukFormat(startMin + effOffset);
      const site: SiteCall = {
        station: call.name,
        platform: null,
        scheduled: ukFormat(startMin + schedOffset),
        estimated: state === "future" && delay > 0 ? effClock : null,
        arrived: state !== "future" ? effClock : null,
        departed: null,
        delayMin: Math.max(0, delay),
        dispatcher: null,
        notes: [],
        state,
      };
      return { site, effOffset };
    });
    const calls: SiteCall[] = built.map((b) => b.site);

    const last = calls[calls.length - 1];
    const status: LegLiveStatus =
      last.state !== "future" ? "done" : calls[0].state !== "future" ? "live" : "pending";
    const next = calls.find((c) => c.state === "future");

    // parallel to real-time's site activity line ("Driving to…", "Loading
    // at…"), but worded as schedule expectation — the sim can't see the game,
    // so it only knows where the timetable puts the train. Wording keys off the
    // continuous time to the next call: within the last 30s it's "Approaching",
    // otherwise "At" the current stop (dwelling) or "Next stop" (running).
    const current = calls.find((c) => c.state === "current");
    const nextEta = built.find((b) => b.site.state === "future");
    const minsToNext = nextEta ? nextEta.effOffset - nowOffset - nowSec / 60 : Infinity;
    let liveStatus: string | null = null;
    if (status === "live") {
      if (nextEta && minsToNext <= 0.5) liveStatus = `Approaching ${nextEta.site.station}`;
      else if (current) liveStatus = `At ${current.station}`;
      else if (nextEta) liveStatus = `Next stop ${nextEta.site.station}`;
    }

    const service: SiteService = {
      headcode: null,
      operator: shift.operator,
      routeCode: leg.route.code,
      origin: leg.from,
      destination: leg.to,
      train: null,
      unit: null,
      speedMph: null,
      status: liveStatus,
      nextStation: status === "live" ? (next?.station ?? null) : null,
      notices: [],
      enRouteTo: null,
      calls,
    };

    const startEff = simEffOffset(leg.departOffsetMin, startMin, events);
    return { status, service, startMin: startMin + startEff };
  });
}
