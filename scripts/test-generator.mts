// Sanity-checks the shift generator against the scraped data: run with
// `npm test`. Simulates shifts for every operator in both modes and asserts
// the chaining invariants hold.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateShift, TURNAROUND_MIN } from "../src/lib/generator.ts";
import type { RoutesData } from "../src/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data: RoutesData = JSON.parse(
  readFileSync(join(root, "src", "data", "routes.json"), "utf8"),
);

let fails = 0;
let backtracks = 0;
let legsTotal = 0;
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    fails++;
    console.log("FAIL:", msg);
  }
};

for (let i = 0; i < 1000; i++) {
  const op = data.operators[i % data.operators.length].name;
  const mode = i % 2 ? ("legs" as const) : ("minutes" as const);
  const target = mode === "legs" ? 2 + (i % 10) : 30 + (i % 8) * 30;
  const s = generateShift(data, { operator: op, mode, target });
  assert(s !== null && s.legs.length > 0, `${op} empty shift`);
  if (!s) continue;
  legsTotal += s.legs.length;
  if (mode === "legs") {
    assert(s.legs.length === target, `${op} wanted ${target} legs got ${s.legs.length}`);
  } else {
    assert(s.totalMin >= target, `${op} wanted >=${target} min got ${s.totalMin}`);
  }
  let clock = 0;
  for (let j = 0; j < s.legs.length; j++) {
    const leg = s.legs[j];
    assert(leg.route.operator === op, `${op} leg ${j} wrong operator ${leg.route.operator}`);
    assert(
      leg.calls[0].name === leg.from && leg.calls.at(-1)!.name === leg.to,
      `${leg.route.code} calls don't match from/to`,
    );
    assert(
      leg.calls.every((c, k) => k === 0 || c.minutesIntoLeg >= leg.calls[k - 1].minutesIntoLeg),
      `${leg.route.code} non-monotonic call times`,
    );
    assert(leg.durationMin > 0, `${leg.route.code} zero duration`);
    if (j > 0) {
      assert(
        leg.from === s.legs[j - 1].to,
        `leg ${j} starts at ${leg.from} but previous ended at ${s.legs[j - 1].to}`,
      );
      clock += TURNAROUND_MIN;
      if (leg.route.code === s.legs[j - 1].route.code) backtracks++;
    }
    assert(leg.departOffsetMin === clock, `leg ${j} departs ${leg.departOffsetMin} expected ${clock}`);
    clock += leg.durationMin;
  }
  assert(clock === s.totalMin, `totalMin ${s.totalMin} != computed ${clock}`);
}

console.log(
  `1000 shifts, ${legsTotal} legs, ${fails} assertion failures, ${backtracks} same-route-back legs (dead ends)`,
);
if (fails > 0) process.exit(1);
