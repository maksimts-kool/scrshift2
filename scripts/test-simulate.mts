// Unit tests for simulate mode (clock states, event-sourced delay,
// midnight wrap). Run with `npm run test:sim`.

import {
  localNowMin,
  simEffOffset,
  simTotalDelay,
  simulateShift,
  type SimEvent,
} from "../src/lib/simulate.ts";
import { ukFormat } from "../src/lib/realtime.ts";
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
  turnaroundMin: 1,
  totalMin: 71,
  totalPoints: 200,
  totalXp: 400,
};

const START = 600; // 10:00

// ---- before the start: everything pending and future ----
{
  const legs = simulateShift(shift, START, START - 10, []);
  eq(legs.map((l) => l.status), ["pending", "pending"], "all pending before start");
  assert(
    legs[0].service.calls.every((c) => c.state === "future"),
    "all calls future before start",
  );
  eq(legs[0].service.calls[0].scheduled, "10:00", "first call scheduled 10:00");
  eq(legs[0].service.calls[0].arrived, null, "no arrival before start");
  eq(ukFormat(legs[0].startMin), "10:00", "leg 1 departs 10:00");
  eq(ukFormat(legs[1].startMin), "10:41", "leg 2 departs 10:41");
}

// ---- the departure minute: passed once its time arrives ----
{
  let legs = simulateShift(shift, START, START, []);
  eq(legs[0].status, "live", "leg goes live on its first minute");
  eq(legs[0].service.calls[0].state, "passed", "origin departed once its minute arrives");
  eq(legs[0].service.calls[0].arrived, "10:00", "origin arrival time frozen");
  eq(legs[0].service.nextStation, "Midpoint", "next station is the midpoint");

  legs = simulateShift(shift, START, START + 1, []);
  eq(legs[0].service.calls[0].state, "passed", "origin stays passed after its minute");
  eq(legs[0].service.calls[1].state, "future", "midpoint still future");
}

// ---- approach window: next stop → approaching → at → passed ----
{
  // midpoint departs 10:20; probe the minutes leading up to it (leg is live)
  const at = (min: number, sec: number) => {
    const legs = simulateShift(shift, START, START + min, [], sec);
    return { status: legs[0].service.status, state: legs[0].service.calls[1].state };
  };
  eq(at(18, 50), { status: "Next stop Midpoint", state: "future" }, "10:18:50 (>1 min) → next stop");
  eq(at(19, 0), { status: "Approaching Midpoint", state: "current" }, "10:19:00 (1 min) → approaching");
  eq(at(19, 30), { status: "At Midpoint", state: "current" }, "10:19:30 (30s) → at");
  eq(at(20, 0), { status: "Next stop Willowfield", state: "passed" }, "10:20:00 → departed, next target");
}

// ---- delay only moves calls still in the future when clicked ----
{
  // +2 clicked at 10:01: origin (10:00) already happened, everything after moves
  const events: SimEvent[] = [{ atMin: START + 1, delta: 2 }];
  const legs = simulateShift(shift, START, START + 1, events);
  eq(simTotalDelay(events), 2, "total delay is 2");
  eq(legs[0].service.calls[0].arrived, "10:00", "passed origin keeps its time");
  eq(legs[0].service.calls[0].delayMin, 0, "passed origin carries no delay");
  eq(legs[0].service.calls[1].estimated, "10:22", "midpoint pushed to 10:22");
  eq(legs[0].service.calls[1].scheduled, "10:20", "midpoint schedule unchanged");
  eq(legs[0].service.calls[1].delayMin, 2, "midpoint shows +2");
  eq(legs[1].service.calls[0].estimated, "10:43", "next leg pushed too");
  eq(ukFormat(legs[1].startMin), "10:43", "leg 2 header departure pushed");
}

// ---- a click at a station's departure minute leaves that station alone ----
{
  // midpoint due 10:20; +3 clicked at exactly 10:20 as it departs
  const events: SimEvent[] = [{ atMin: START + 20, delta: 3 }];
  const legs = simulateShift(shift, START, START + 20, events);
  eq(legs[0].service.calls[1].state, "passed", "midpoint departed at its minute");
  eq(legs[0].service.calls[1].arrived, "10:20", "midpoint keeps 10:20");
  eq(legs[0].service.calls[2].estimated, "10:43", "terminus pushed to 10:43");
}

// ---- minus reverts only what plus added; passed stations stay frozen ----
{
  const events: SimEvent[] = [
    { atMin: START + 1, delta: 2 }, // everything after the origin +2
    { atMin: START + 23, delta: -2 }, // midpoint (10:22) already passed by now
  ];
  eq(simEffOffset(20, START, events), 22, "midpoint stays at its pushed time");
  eq(simEffOffset(40, START, events), 40, "terminus recovers to schedule");
  const legs = simulateShift(shift, START, START + 23, events);
  eq(legs[0].service.calls[1].arrived, "10:22", "midpoint frozen at 10:22");
  eq(legs[0].service.calls[2].estimated, null, "terminus back on time, no estimate");
  eq(legs[0].service.calls[2].delayMin, 0, "terminus delay cleared");
}

// ---- leg completion: done when the terminus minute starts ----
{
  let legs = simulateShift(shift, START, START + 40, []);
  eq(legs[0].status, "done", "leg 1 done at terminus arrival minute");
  eq(legs[0].service.calls[2].state, "passed", "terminus reached");
  eq(legs[1].status, "pending", "leg 2 not started at 10:40");

  legs = simulateShift(shift, START, START + 41, []);
  eq(legs[1].status, "live", "leg 2 live at 10:41");

  legs = simulateShift(shift, START, START + 71, []);
  eq(legs.map((l) => l.status), ["done", "done"], "whole shift done at the end");
}

// ---- midnight wrap: a shift straddling 00:00 keeps working ----
{
  const startLate = 23 * 60 + 50; // 23:50
  const legs = simulateShift(shift, startLate, 5, []); // now 00:05
  eq(legs[0].status, "live", "leg live across midnight");
  eq(legs[0].service.calls[0].state, "passed", "23:50 call passed at 00:05");
  eq(legs[0].service.calls[0].arrived, "23:50", "pre-midnight time formats");
  eq(legs[0].service.calls[1].state, "future", "00:10 midpoint still future");
  eq(legs[0].service.calls[1].scheduled, "00:10", "post-midnight schedule formats");
}

// ---- localNowMin uses the local clock ----
{
  const d = new Date(2026, 6, 5, 14, 30, 59);
  eq(localNowMin(d), 14 * 60 + 30, "localNowMin floors to the minute");
}

if (fails === 0) console.log("test-simulate: all tests passed");
else {
  console.log(`test-simulate: ${fails} failure(s)`);
  process.exit(1);
}
