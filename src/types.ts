export interface Call {
  name: string;
  /** cumulative minutes from the route's origin, if the wiki lists it */
  fromOrigin: number | null;
  /** cumulative minutes from the route's destination, if the wiki lists it */
  fromDestination: number | null;
}

export interface Route {
  code: string;
  operator: string;
  origin: string;
  destination: string;
  timeMin: number;
  timeMax: number;
  cost: string;
  points: number;
  xp: number;
  calls: Call[];
  /** human-readable rolling-stock requirement from the wiki, "" if unknown */
  rollingStock: string;
  /** train ids (see Train.name) allowed to run this route */
  allowedTrains: string[];
}

export interface OperatorInfo {
  name: string;
  color: string;
}

export interface Train {
  /** identity, e.g. "Class 350 (single)" or "Class 398" */
  name: string;
  class: string;
  /** "single" | "double" for classes with two formations, else null */
  variant: "single" | "double" | null;
  operators: string[];
  traction: "diesel" | "electric" | "bimode";
}

export interface RoutesData {
  scrapedAt: string;
  source: string;
  operators: OperatorInfo[];
  trains: Train[];
  routes: Route[];
}

export interface LegCall {
  name: string;
  minutesIntoLeg: number;
}

export interface ShiftLeg {
  route: Route;
  /** true when driving destination -> origin */
  reversed: boolean;
  from: string;
  to: string;
  departOffsetMin: number;
  durationMin: number;
  calls: LegCall[];
}

export interface Shift {
  operator: string;
  /** the single train driven for the whole shift (legal on every leg), or null */
  train: string | null;
  /** how many trains were legal across the whole shift */
  trainOptions: number;
  legs: ShiftLeg[];
  /** layover minutes used between legs (shown in the reverse marker) */
  turnaroundMin: number;
  totalMin: number;
  totalPoints: number;
  totalXp: number;
}
