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
 * Nothing is read from the game, so upcoming times stay grey.
 *
 * Each call's time is treated as a *departure*: the train runs the last stretch
 * into the station, dwells, then leaves at the listed minute. So a call lights
 * up (glows "current") during the final minute leading up to its time and
 * becomes passed (blue) the moment that time arrives — at which point the next
 * call becomes the target. The activity line tracks the same window: "Next
 * stop" (>1 min out) → "Approaching" (30s–1 min out) → "At" (≤30s out).
 *
 * Delay is event-sourced: every +/− click is stored with the wall-clock
 * minute it happened, and a click only moves calls strictly in the future at
 * that moment. Stations already passed keep their times. Because clicks arrive
 * in wall-clock order, any call a later minus reaches has already received
 * every earlier plus, so with the total clamped at zero no call can end up
 * before its schedule.
 *
 * All clocks here are local time, matching the planner's Start field.
 */

/** minutes before a call's time when it starts glowing / shows "Approaching" */
const APPROACH_MIN = 1;
/** minutes before a call's time when the activity line switches to "At" */
const AT_MIN = 0.5;

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
 * Snapshot of the whole shift at `nowMin` (+`nowSec`): per-leg status plus a
 * synthesized SiteService whose calls carry sim states. Times are departures,
 * so a call is passed (arrived time frozen) once its minute arrives, glows
 * "current" during the ~90s approach before it, and is otherwise future
 * (scheduled, plus an orange estimate when delayed).
 */
export function simulateShift(
  shift: Shift,
  startMin: number,
  nowMin: number,
  events: SimEvent[],
  /** seconds past `nowMin` (0–59); refines the approach window to 1s */
  nowSec = 0,
): SimLeg[] {
  // continuous minutes since shift start, so the approach glances forward smoothly
  const now = clockDelta(startMin, nowMin) + nowSec / 60;

  return shift.legs.map((leg) => {
    const built = leg.calls.map((call) => {
      const schedOffset = leg.departOffsetMin + call.minutesIntoLeg;
      const effOffset = simEffOffset(schedOffset, startMin, events);
      const delay = effOffset - schedOffset;
      const toCall = effOffset - now; // minutes until this call departs
      const state: SiteCall["state"] =
        toCall <= 0 ? "passed" : toCall <= APPROACH_MIN ? "current" : "future";
      const effClock = ukFormat(startMin + effOffset);
      const site: SiteCall = {
        station: call.name,
        platform: null,
        scheduled: ukFormat(startMin + schedOffset),
        estimated: state !== "passed" && delay > 0 ? effClock : null,
        arrived: state === "passed" ? effClock : null,
        departed: null,
        delayMin: Math.max(0, delay),
        dispatcher: null,
        notes: [],
        state,
      };
      return { site, effOffset };
    });
    const calls: SiteCall[] = built.map((b) => b.site);

    // leg span is first call's departure → last call's arrival; live in between
    const firstEff = built[0].effOffset;
    const lastEff = built[built.length - 1].effOffset;
    const status: LegLiveStatus =
      now >= lastEff ? "done" : now >= firstEff ? "live" : "pending";

    // the call we're heading into: first one not yet departed. On a live leg it
    // always exists (now < lastEff means the terminus is still ahead).
    const target = built.find((b) => b.effOffset - now > 0);

    // parallel to real-time's site activity line ("Driving to…", "Loading
    // at…"), but worded as schedule expectation — the sim can't see the game,
    // so it only knows where the timetable puts the train. Keys off the
    // continuous time to the target: "At" in the final 30s, "Approaching" in the
    // 30s before that, "Next stop" while still more than a minute out.
    let liveStatus: string | null = null;
    if (status === "live" && target) {
      const toTarget = target.effOffset - now;
      if (toTarget <= AT_MIN) liveStatus = `At ${target.site.station}`;
      else if (toTarget <= APPROACH_MIN) liveStatus = `Approaching ${target.site.station}`;
      else liveStatus = `Next stop ${target.site.station}`;
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
      nextStation: status === "live" ? (target?.site.station ?? null) : null,
      notices: [],
      enRouteTo: null,
      calls,
    };

    const startEff = simEffOffset(leg.departOffsetMin, startMin, events);
    return { status, service, startMin: startMin + startEff };
  });
}
