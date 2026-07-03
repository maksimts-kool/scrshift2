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
}

export interface OperatorInfo {
  name: string;
  color: string;
}

export interface RoutesData {
  scrapedAt: string;
  source: string;
  operators: OperatorInfo[];
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
  legs: ShiftLeg[];
  totalMin: number;
  totalPoints: number;
  totalXp: number;
}
