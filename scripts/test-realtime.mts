// Unit tests for the real-time tracking logic (matching, freezing,
// off-plan detection, estimation). Run with `npm run test:rt`.

import {
  advanceLiveShift,
  estimateLegStarts,
  initialLiveShift,
  ukFormat,
  ukParse,
  RT_SIGNON_LEAD_MIN,
  RT_TURNAROUND_MIN,
  type Activity,
  type SiteCall,
  type SiteService,
} from "../src/lib/realtime.ts";
import type { Route, Shift, ShiftLeg } from "../src/types.ts";

let fails = 0;
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    fails++;
    console.log("FAIL:", msg);
  }
};
const eq = (a: unknown, b: unknown, msg: string) =>
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,
  );

// ---- fixtures ----

function mkRoute(code: string, origin: string, destination: string): Route {
  return {
    code,
    operator: "Stepford Connect",
    origin,
    destination,
    timeMin: 10,
    timeMax: 12,
    cost: "",
    points: 100,
    xp: 200,
    calls: [],
    rollingStock: "",
    allowedTrains: ["Class 360"],
  };
}

function mkLeg(
  code: string,
  from: string,
  to: string,
  departOffsetMin: number,
  durationMin: number,
): ShiftLeg {
  const route = mkRoute(code, from, to);
  return {
    route,
    reversed: false,
    from,
    to,
    departOffsetMin,
    durationMin,
    calls: [
      { name: from, minutesIntoLeg: 0 },
      { name: "Midpoint", minutesIntoLeg: Math.round(durationMin / 2) },
      { name: to, minutesIntoLeg: durationMin },
    ],
  };
}

const shift: Shift = {
  operator: "Stepford Connect",
  train: "Class 360",
  trainOptions: 1,
  trainRoster: ["Class 360"],
  legs: [
    mkLeg("R035", "Westwyvern", "Willowfield", 0, 40),
    mkLeg("R036", "Willowfield", "Llyn-by-the-Sea", 41, 30),
  ],
  turnaroundMin: RT_TURNAROUND_MIN,
  totalMin: 71,
  totalPoints: 200,
  totalXp: 400,
};

function mkCall(station: string, partial: Partial<SiteCall> = {}): SiteCall {
  return {
    station,
    platform: null,
    scheduled: null,
    estimated: null,
    arrived: null,
    departed: null,
    delayMin: 0,
    dispatcher: null,
    notes: [],
    state: "future",
    ...partial,
  };
}

function mkService(
  code: string,
  origin: string,
  destination: string,
  calls: SiteCall[],
): SiteService {
  return {
    headcode: "1D69",
    operator: "Connect",
    routeCode: code,
    origin,
    destination,
    train: "Class 360 with 4 coaches",
    unit: "360081",
    speedMph: 100,
    status: "The next stop is X.",
    nextStation: null,
    notices: [],
    enRouteTo: null,
    calls,
  };
}

const driving = (service: SiteService): Activity => ({
  state: "driving",
  service,
  player: "MaksimTs",
  ukClock: "12:00:00",
  playerId: 1,
  capturedAt: "",
});
const offline: Activity = {
  state: "offline",
  player: null,
  ukClock: "12:00:00",
  playerId: 1,
  capturedAt: "",
};

// ---- matching ----

{
  // waiting: not driving yet
  let live = initialLiveShift(shift);
  live = advanceLiveShift(live, shift, offline);
  eq(live.legs.map((l) => l.status), ["pending", "pending"], "offline keeps legs pending");
  eq(live.idleState, "offline", "offline reported as idle state");

  // grabs the planned first service -> leg 1 live
  const s1 = mkService("R035", "Westwyvern", "Willowfield", [
    mkCall("Westwyvern", { scheduled: "12:00", departed: "12:00:30", state: "passed" }),
    mkCall("Midpoint", { scheduled: "12:20" }),
    mkCall("Willowfield", { scheduled: "12:40" }),
  ]);
  live = advanceLiveShift(live, shift, driving(s1));
  eq(live.legs.map((l) => l.status), ["live", "pending"], "matching service goes live");
  assert(live.offPlan === null, "no off-plan for matching service");

  // same service, terminus reached -> leg 1 done
  const s1done = mkService("R035", "Westwyvern", "Willowfield", [
    mkCall("Westwyvern", { scheduled: "12:00", departed: "12:00:30", state: "passed" }),
    mkCall("Midpoint", { scheduled: "12:20", arrived: "12:19:00", departed: "12:20:10", state: "passed" }),
    mkCall("Willowfield", { scheduled: "12:40", arrived: "12:41:20", state: "current" }),
  ]);
  live = advanceLiveShift(live, shift, driving(s1done));
  eq(live.legs.map((l) => l.status), ["done", "pending"], "arrival at terminus completes the leg");

  // stale rebroadcast of the finished service must not trigger off-plan
  live = advanceLiveShift(live, shift, driving(s1done));
  assert(live.offPlan === null, "stale finished service is not off-plan");
  eq(live.legs.map((l) => l.status), ["done", "pending"], "stale service leaves state alone");

  // grabs the planned second service -> leg 2 live
  const s2 = mkService("R036", "Willowfield", "Llyn-by-the-Sea", [
    mkCall("Willowfield", { scheduled: "12:45", departed: "12:45:30", state: "passed" }),
    mkCall("Llyn-by-the-Sea", { scheduled: "13:15" }),
  ]);
  live = advanceLiveShift(live, shift, driving(s2));
  eq(live.legs.map((l) => l.status), ["done", "live"], "second leg goes live");

  // player leaves mid-service -> leg frozen done
  live = advanceLiveShift(live, shift, offline);
  eq(live.legs.map((l) => l.status), ["done", "done"], "going offline freezes the live leg");
}

{
  // off-plan: wrong route code
  let live = initialLiveShift(shift);
  const wrong = mkService("R099", "Westwyvern", "Willowfield", [mkCall("Westwyvern")]);
  live = advanceLiveShift(live, shift, driving(wrong));
  eq(live.legs.map((l) => l.status), ["pending", "pending"], "wrong route stays pending");
  assert(live.offPlan?.routeCode === "R099", "wrong route flagged off-plan");

  // off-plan: right route, wrong direction
  const backwards = mkService("R035", "Willowfield", "Westwyvern", [mkCall("Willowfield")]);
  live = advanceLiveShift(live, shift, driving(backwards));
  assert(live.offPlan?.origin === "Willowfield", "wrong direction flagged off-plan");

  // name normalization tolerates punctuation/case differences
  const spaced = mkService("R035", "WESTWYVERN", "willow field", [mkCall("Westwyvern")]);
  live = advanceLiveShift(live, shift, driving(spaced));
  eq(live.legs.map((l) => l.status), ["live", "pending"], "normalized names still match");
}

// ---- estimation ----

{
  // nothing live yet: first leg anchored at now + lead, chained after
  const live = initialLiveShift(shift);
  const starts = estimateLegStarts(shift, live, ukParse("12:00"));
  eq(ukFormat(starts[0]), ukFormat(ukParse("12:00") + RT_SIGNON_LEAD_MIN), "first leg = now + lead");
  eq(
    ukFormat(starts[1]),
    ukFormat(starts[0] + 40 + RT_TURNAROUND_MIN),
    "second leg chains from first estimate",
  );

  // live leg: real departure + estimates chain from the last known time
  let live2 = initialLiveShift(shift);
  const s1 = mkService("R035", "Westwyvern", "Willowfield", [
    mkCall("Westwyvern", { scheduled: "12:05", departed: "12:05:30", state: "passed" }),
    mkCall("Midpoint", { scheduled: "12:25", arrived: "12:24:00", departed: "12:25:10", state: "passed" }),
    mkCall("Willowfield", { scheduled: "12:45" }),
  ]);
  live2 = advanceLiveShift(live2, shift, driving(s1));
  const starts2 = estimateLegStarts(shift, live2, ukParse("12:26"));
  eq(ukFormat(starts2[0]), "12:05", "live leg reports its real departure");
  eq(
    ukFormat(starts2[1]),
    ukFormat(ukParse("12:45") + RT_TURNAROUND_MIN),
    "pending leg chains from live leg's last known call time",
  );

  // estimates never sit in the past
  const starts3 = estimateLegStarts(shift, live2, ukParse("12:50"));
  eq(ukFormat(starts3[1]), "12:50", "past estimate clamps to now");

  // midnight wrap: estimate near 00:00 doesn't explode
  const live4 = initialLiveShift(shift);
  const starts4 = estimateLegStarts(shift, live4, ukParse("23:59"));
  eq(ukFormat(starts4[0]), ukFormat((23 * 60 + 59 + RT_SIGNON_LEAD_MIN) % 1440), "midnight wrap ok");
}

if (fails === 0) {
  console.log("test-realtime: all assertions passed");
} else {
  console.log(`test-realtime: ${fails} FAILURES`);
  process.exit(1);
}
