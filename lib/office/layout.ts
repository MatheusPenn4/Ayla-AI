// World layout shared by the 3D scene and the 2D fallback. Units are metres;
// the floor spans x ∈ [-14, 14] and z ∈ [-10, 10], back wall at z = -10.
import type { Station, WorkZoneId, ZoneId } from "./types";

export type Rect = { x0: number; x1: number; z0: number; z1: number };

export type ZoneInfo = {
  id: ZoneId;
  name: string;
  short: string;
  accent: string;
  rect: Rect;
  /** Point just inside the zone door and just outside it (in the corridor). */
  doorIn: [number, number];
  doorOut: [number, number];
  /** Where the camera looks when the user jumps to this zone. */
  focus: [number, number];
};

export const FLOOR: Rect = { x0: -14, x1: 14, z0: -10, z1: 10 };
export const CORRIDOR_Z = -2.2;

export const ZONES: Record<ZoneId, ZoneInfo> = {
  director: { id: "director", name: "Diretoria", short: "DIR", accent: "#e0b36a", rect: { x0: -13.4, x1: -5, z0: -9.4, z1: -3.2 }, doorIn: [-5.9, -4], doorOut: [-5.9, CORRIDOR_Z], focus: [-9, -6.2] },
  lounge: { id: "lounge", name: "Copa & Fila", short: "COPA", accent: "#9fb8d8", rect: { x0: -4.4, x1: 3.2, z0: -9.4, z1: -3.2 }, doorIn: [-0.6, -3.8], doorOut: [-0.6, CORRIDOR_Z], focus: [-0.6, -6.4] },
  meeting: { id: "meeting", name: "Sala de reunião", short: "REUNIÃO", accent: "#8f9dff", rect: { x0: 4, x1: 13.4, z0: -9.4, z1: -3 }, doorIn: [5.1, -3.8], doorOut: [5.1, CORRIDOR_Z], focus: [8.8, -6.2] },
  dev: { id: "dev", name: "Desenvolvimento", short: "DEV", accent: "#35d0ff", rect: { x0: -13.4, x1: 1.4, z0: -1.4, z1: 9.4 }, doorIn: [0.1, -0.6], doorOut: [0.1, CORRIDOR_Z], focus: [-6, 3.6] },
  qa: { id: "qa", name: "QA & Revisão", short: "QA", accent: "#5b8cff", rect: { x0: 3, x1: 13.4, z0: -1.4, z1: 9.4 }, doorIn: [4.1, -0.6], doorOut: [4.1, CORRIDOR_Z], focus: [8.4, 3.6] },
};

export const WORK_ZONES: WorkZoneId[] = ["director", "dev", "qa"];

/** Four desks around a shared divider: two facing +Z, two facing -Z. */
type Monitors = Station["monitors"];

function cluster(prefix: string, zone: WorkZoneId, cx: number, cz: number, sideX: number, monitors: Monitors): Station[] {
  const back = cz - 2.2, front = cz + 2.2;
  return [
    { id: `${prefix}-a`, zone, x: cx - 0.95, z: cz - 1.2, facing: 0, kind: "desk", monitors, exit: [[cx - 0.95, back]] },
    { id: `${prefix}-b`, zone, x: cx + 0.95, z: cz - 1.2, facing: 0, kind: "desk", monitors, exit: [[cx + 0.95, back]] },
    { id: `${prefix}-c`, zone, x: cx - 0.95, z: cz + 1.2, facing: Math.PI, kind: "desk", monitors, exit: [[cx - 0.95, front], [sideX, front], [sideX, back]] },
    { id: `${prefix}-d`, zone, x: cx + 0.95, z: cz + 1.2, facing: Math.PI, kind: "desk", monitors, exit: [[cx + 0.95, front], [sideX, front], [sideX, back]] },
  ];
}

function pair(prefix: string, zone: WorkZoneId, cx: number, cz: number, sideX: number, monitors: Monitors): Station[] {
  const back = cz - 2.2, front = cz + 2.2;
  return [
    { id: `${prefix}-a`, zone, x: cx, z: cz - 1.2, facing: 0, kind: "desk", monitors, exit: [[cx, back]] },
    { id: `${prefix}-c`, zone, x: cx, z: cz + 1.2, facing: Math.PI, kind: "desk", monitors, exit: [[cx, front], [sideX, front], [sideX, back]] },
  ];
}

export const DEV_CLUSTERS: [number, number][] = [[-8.8, 3.6], [-3.4, 3.6]];
export const QA_CLUSTER: [number, number] = [6.4, 3.6];
export const QA_PAIR: [number, number] = [10.9, 3.6];

// Monitor plan (intentional, per area):
//  - Diretoria: executive desk with a curved 34" ultrawide; staff desk with dual monitors.
//  - Desenvolvimento: cluster 1 (studio/creation) curved ultrawides; cluster 2 (engineering) dual monitors.
//  - QA & Revisão: 4-desk test cluster with dual monitors (app + test tooling); review pair with ultrawides (side-by-side diffs).
export const STATIONS: Station[] = [
  { id: "dir-main", zone: "director", x: -9.6, z: -7.5, facing: 0, kind: "executive", monitors: "ultrawide", exit: [[-8, -7.5], [-8, -4.4]] },
  { id: "dir-staff", zone: "director", x: -12.0, z: -4.1, facing: Math.PI, kind: "desk", monitors: "dual", exit: [[-12.0, -3.75], [-8, -3.75]] },
  ...cluster("dev1", "dev", DEV_CLUSTERS[0][0], DEV_CLUSTERS[0][1], -6.1, "ultrawide"),
  ...cluster("dev2", "dev", DEV_CLUSTERS[1][0], DEV_CLUSTERS[1][1], -0.7, "dual"),
  ...cluster("qa1", "qa", QA_CLUSTER[0], QA_CLUSTER[1], 9.1, "dual"),
  ...pair("qa2", "qa", QA_PAIR[0], QA_PAIR[1], 9.1, "ultrawide"),
];

export const STATION_BY_ID = new Map(STATIONS.map(s => [s.id, s]));
export const CAPACITY = STATIONS.length;
export const zoneCapacity = (zone: WorkZoneId) => STATIONS.filter(s => s.zone === zone).length;

/** Preferred station order per zone, so the first hires fill the most visible desks. */
const PREFERRED: Record<WorkZoneId, string[]> = {
  director: ["dir-main", "dir-staff"],
  dev: ["dev2-a", "dev1-a", "dev2-b", "dev1-b", "dev2-c", "dev1-c", "dev2-d", "dev1-d"],
  qa: ["qa1-a", "qa1-b", "qa2-a", "qa1-c", "qa1-d", "qa2-c"],
};

export function freeStation(zone: WorkZoneId, taken: Iterable<string>): string | null {
  const used = new Set(taken);
  return PREFERRED[zone].find(id => !used.has(id)) ?? null;
}

// Meeting room: table centred at (8.9, -6.2), seats around it and standing spots.
export const MEETING_TABLE = { x: 8.9, z: -6.2, w: 4.4, d: 1.7 };
export type Spot = { x: number; z: number; facing: number; seated: boolean; approach: [number, number][] };
const farZ = -7.5, nearZ = -4.9;
export const MEETING_SPOTS: Spot[] = [
  ...[7.4, 8.9, 10.4].map(x => ({ x, z: nearZ, facing: Math.PI, seated: true, approach: [[x, -4.1]] as [number, number][] })),
  { x: 5.95, z: -6.2, facing: Math.PI / 2, seated: true, approach: [[5.2, -6.2]] },
  ...[7.4, 8.9, 10.4].map(x => ({ x, z: farZ, facing: 0, seated: true, approach: [[5.2, -8.4], [x, -8.4]] as [number, number][] })),
  { x: 11.85, z: -6.2, facing: -Math.PI / 2, seated: true, approach: [[12.7, -4.1], [12.7, -6.2]] },
  ...[6.6, 8, 9.4, 10.8, 12.2].map(x => ({ x, z: -3.65, facing: Math.PI, seated: false, approach: [] as [number, number][] })),
  ...[-5, -7.2, -8.6].map(z => ({ x: 12.9, z, facing: -Math.PI / 2, seated: false, approach: [[12.9, -4.1]] as [number, number][] })),
];

/** Walking route from a station to a meeting spot (corridor-based, avoids walls). */
export function routeToMeeting(station: Station, spot: Spot): [number, number][] {
  const zone = ZONES[station.zone], meet = ZONES.meeting;
  return [...station.exit, zone.doorIn, zone.doorOut, meet.doorOut, meet.doorIn, ...spot.approach, [spot.x, spot.z]];
}
