import type { Shift, Train } from "../types";

/**
 * Client + pure logic for real-time mode. The dev server hosts a companion
 * (scripts/realtime/) that keeps a Chrome session logged into the SCR Hub
 * site and reads the tracked player's CurrentActivity page. This module talks
 * to it and folds the live data into a generated shift, one leg at a time.
 *
 * All clock arithmetic here is in UK time (the SCR site's timezone): live
 * times arrive as site strings, and estimates are anchored to UK "now" so the
 * two never disagree.
 */

// ---------- companion API types ----------

export interface RtUser {
  id: number;
  name: string;
  displayName: string;
}

export type RtPhase =
  | "stopped"
  | "launching"
  | "authorizing"
  | "need-login"
  | "booting"
  | "ready"
  | "error";

export interface RtStatus {
  mode: "local" | "hosted";
  phase: RtPhase;
  user: RtUser | null;
  trackedId: number | null;
  headed: boolean;
  error: string | null;
}

export interface SiteCall {
  station: string;
  platform: string | null;
  /** planned "HH:MM" (struck through on the site when running late) */
  scheduled: string | null;
  /** site's live estimate "HH:MM" when delayed */
  estimated: string | null;
  arrived: string | null; // "HH:MM:SS"
  departed: string | null;
  delayMin: number;
  dispatcher: string | null;
  notes: string[];
  state: "passed" | "current" | "future";
}

export interface SiteService {
  headcode: string | null;
  operator: string | null;
  routeCode: string | null;
  origin: string | null;
  destination: string | null;
  train: string | null;
  unit: string | null;
  speedMph: number | null;
  status: string | null;
  nextStation: string | null;
  notices: string[];
  enRouteTo: string | null;
  calls: SiteCall[];
}

export type Activity = {
  player: string | null;
  ukClock: string | null;
  playerId: number;
  capturedAt: string;
} & (
  | { state: "offline" | "unknown" }
  | { state: "other-role"; role: string; description: string }
  | { state: "driving"; service: SiteService }
);

// ---------- companion API client ----------

/**
 * Where the real-time service lives. Same origin under `npm run dev` (Vite
 * plugin); production points at the persistent hosted service with
 * VITE_RT_API_BASE. The frontend itself can remain a static Vercel deploy.
 */
// optional chain: the test runner imports this file in plain Node, no Vite env
const RT_CONFIGURED = (import.meta.env?.VITE_RT_API_BASE ?? "").replace(/\/+$/, "");

/** True in a production build configured to use the hosted real-time service. */
export const RT_REMOTE_CONFIGURED = RT_CONFIGURED.length > 0;

let rtBase = RT_CONFIGURED; // switched by rtAvailable() to whichever base answered

async function rtFetch(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${rtBase}/api/rt${path}`, init);
}

async function probe(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/rt/status`, {
      signal: AbortSignal.timeout(3000),
    });
    // content-type check: an SPA catch-all rewrite (Vercel) would 200 with HTML
    return res.ok && (res.headers.get("content-type") ?? "").includes("json");
  } catch {
    return false;
  }
}

/**
 * Find the service; false on a static deployment with no hosted API configured.
 * Local development still uses the same-origin Vite plugin.
 */
export async function rtAvailable(): Promise<boolean> {
  const bases = [...(RT_CONFIGURED ? [RT_CONFIGURED] : []), ""];
  for (const base of bases) {
    if (await probe(base)) {
      rtBase = base;
      return true;
    }
  }
  return false;
}

export async function rtStatus(): Promise<RtStatus> {
  const res = await rtFetch("/status");
  if (!res.ok) throw new Error(`status ${res.status}`);
  return await res.json();
}

export async function rtStart(): Promise<void> {
  await rtFetch("/start", { method: "POST" });
}

export async function rtStop(): Promise<void> {
  await rtFetch("/stop", { method: "POST" });
}

/**
 * Log the companion out (Roblox + SCR cookies wiped) and reopen Chrome for a
 * fresh sign-in; whoever logs in next becomes the tracked account.
 */
export async function rtChangeAccount(): Promise<void> {
  const res = await rtFetch("/change-account", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `change-account ${res.status}`);
  }
}

export async function rtActivity(username?: string): Promise<Activity> {
  const query = username ? `?username=${encodeURIComponent(username)}` : "";
  const res = await rtFetch(`/activity${query}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `activity ${res.status}`);
  return body.activity;
}

// ---------- UK clock helpers ----------

/** minutes since UK midnight for "HH:MM" or "HH:MM:SS" (rounded to minutes) */
export function ukParse(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function ukFormat(min: number): string {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** current minutes since midnight in Europe/London */
export function ukNow(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return ukParse(parts);
}

/** shortest signed distance a→b on the 24h clock (handles midnight wrap) */
export function clockDelta(a: number, b: number): number {
  return ((b - a + 720 + 1440) % 1440) - 720;
}

// ---------- live shift tracking ----------

export type LegLiveStatus = "pending" | "live" | "done";

export interface LegLive {
  status: LegLiveStatus;
  /** last site snapshot for this leg (live keeps updating, done is frozen) */
  service: SiteService | null;
}

export interface LiveShift {
  legs: LegLive[];
  /** service being driven that matches no expected leg (strict mode warning) */
  offPlan: SiteService | null;
  /** activity state when not driving, for the status banner */
  idleState: "offline" | "unknown" | "other-role" | null;
  idleDescription: string | null;
}

export function initialLiveShift(shift: Shift): LiveShift {
  return {
    legs: shift.legs.map(() => ({ status: "pending", service: null })),
    offPlan: null,
    idleState: null,
    idleDescription: null,
  };
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function serviceKey(s: SiteService): string {
  return `${s.routeCode}|${norm(s.origin)}|${norm(s.destination)}`;
}

function matchesLeg(s: SiteService, shift: Shift, i: number): boolean {
  const leg = shift.legs[i];
  return (
    s.routeCode === leg.route.code &&
    norm(s.origin) === norm(leg.from) &&
    norm(s.destination) === norm(leg.to)
  );
}

/** the terminus has been reached (arrived at the final call) */
function serviceFinished(s: SiteService): boolean {
  const last = s.calls[s.calls.length - 1];
  return !!last && (!!last.arrived || last.state !== "future");
}

/**
 * Fold a fresh activity snapshot into the tracked shift state (strict
 * matching: a leg only goes live when the driven service is exactly the
 * planned route in the planned direction; anything else raises off-plan).
 */
export function advanceLiveShift(
  prev: LiveShift,
  shift: Shift,
  activity: Activity,
): LiveShift {
  const legs = prev.legs.map((l) => ({ ...l }));
  let offPlan: SiteService | null = null;
  let idleState: LiveShift["idleState"] = null;
  let idleDescription: string | null = null;

  const liveIdx = legs.findIndex((l) => l.status === "live");

  if (activity.state !== "driving") {
    // not driving: freeze any live leg (service over or player bailed)
    if (liveIdx >= 0) legs[liveIdx].status = "done";
    if (activity.state === "other-role") {
      idleState = "other-role";
      idleDescription = activity.description;
    } else {
      idleState = activity.state;
    }
    return { legs, offPlan, idleState, idleDescription };
  }

  const s = activity.service;
  const key = serviceKey(s);

  if (liveIdx >= 0 && legs[liveIdx].service && serviceKey(legs[liveIdx].service) === key) {
    // still on the live leg — refresh its snapshot
    legs[liveIdx].service = s;
    if (serviceFinished(s)) legs[liveIdx].status = "done";
    return { legs, offPlan, idleState, idleDescription };
  }

  // driving something new: close out the previous live leg first
  if (liveIdx >= 0) legs[liveIdx].status = "done";

  // stale rebroadcast of an already-recorded service? ignore silently
  if (legs.some((l) => l.status === "done" && l.service && serviceKey(l.service) === key)) {
    return { legs, offPlan, idleState, idleDescription };
  }

  const curIdx = legs.findIndex((l) => l.status !== "done");
  if (curIdx >= 0 && matchesLeg(s, shift, curIdx)) {
    legs[curIdx].status = serviceFinished(s) ? "done" : "live";
    legs[curIdx].service = s;
  } else {
    offPlan = s; // strict mode: warn, keep the plan
  }
  return { legs, offPlan, idleState, idleDescription };
}

/**
 * Raw SCR-site rolling-stock text for the stock the player is currently (or
 * was most recently) driving — the live leg first, then an off-plan service,
 * then the last leg that recorded one. Null when nothing has been driven yet.
 * The caller matches this against the shift roster to lock the train chip.
 */
export function liveTrainText(live: LiveShift): string | null {
  const liveLeg = live.legs.find((l) => l.status === "live");
  if (liveLeg?.service?.train) return liveLeg.service.train;
  if (live.offPlan?.train) return live.offPlan.train;
  for (let i = live.legs.length - 1; i >= 0; i--) {
    const t = live.legs[i].service?.train;
    if (t) return t;
  }
  return null;
}

const classDigits = (s: string): string | null => s.match(/\d+/)?.[0] ?? null;

/**
 * Match the SCR-site rolling-stock text (e.g. "Class 350") to a roster
 * Train.name so real-time mode can lock the chip to the train being driven.
 * Prefers an exact name, then the class number; single/double variants only
 * resolve when the site text names one — otherwise there's nothing to pin, so
 * null (the roster stays tappable rather than guessing the wrong variant).
 */
export function matchRosterTrain(siteTrain: string | null, roster: Train[]): string | null {
  if (!siteTrain) return null;
  const lower = siteTrain.toLowerCase();
  const exact = roster.find((t) => t.name.toLowerCase() === lower);
  if (exact) return exact.name;
  const num = classDigits(siteTrain);
  if (!num) return null;
  const sameClass = roster.filter((t) => classDigits(t.class) === num);
  if (sameClass.length === 1) return sameClass[0].name;
  if (sameClass.length > 1) {
    if (/\b(double|2x|two)\b/i.test(siteTrain))
      return sameClass.find((t) => t.variant === "double")?.name ?? null;
    if (/\b(single|1x|one)\b/i.test(siteTrain))
      return sameClass.find((t) => t.variant === "single")?.name ?? null;
  }
  return null;
}

// ---------- estimation for pending legs ----------

/** minutes between legs assumed in real-time mode (SCR has no turnaround) */
export const RT_TURNAROUND_MIN = 1;
/** lead time before the first leg while waiting for the player to sign on */
export const RT_SIGNON_LEAD_MIN = 3;

/** best known "minutes since UK midnight" when a live/done leg ended */
function knownEnd(service: SiteService): number | null {
  for (let i = service.calls.length - 1; i >= 0; i--) {
    const c = service.calls[i];
    const t = c.arrived ?? c.departed ?? c.estimated ?? c.scheduled;
    if (t) return ukParse(t);
  }
  return null;
}

/**
 * Estimated departure time (minutes since UK midnight) for every leg, given
 * what actually happened so far. Live/done legs report their real times;
 * pending legs chain estimates from the last known point (or from "now"
 * while waiting to start).
 */
export function estimateLegStarts(
  shift: Shift,
  live: LiveShift,
  nowUkMin = ukNow(),
): number[] {
  const starts: number[] = new Array(shift.legs.length).fill(0);
  let anchor: number | null = null; // end of the previous leg

  for (let i = 0; i < shift.legs.length; i++) {
    const l = live.legs[i];
    const first = l.service?.calls[0];
    const realStart = first
      ? (first.departed ?? first.arrived ?? first.estimated ?? first.scheduled)
      : null;

    if (l.status !== "pending" && l.service && realStart != null) {
      starts[i] = ukParse(realStart);
      anchor = knownEnd(l.service) ?? starts[i] + shift.legs[i].durationMin;
    } else {
      let est: number =
        anchor == null ? nowUkMin + RT_SIGNON_LEAD_MIN : anchor + RT_TURNAROUND_MIN;
      // never estimate a departure in the past
      if (clockDelta(est, nowUkMin) > 0) est = nowUkMin;
      starts[i] = est;
      anchor = est + shift.legs[i].durationMin;
    }
  }
  return starts;
}
