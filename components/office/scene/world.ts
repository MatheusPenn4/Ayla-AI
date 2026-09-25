import * as THREE from "three";
import { GeometryBatch, Placer, matrix } from "./batch";
import { MONITOR_CELLS, WallScreen, floorTexture, monitorAtlas, radialTexture, skylineTexture, type FloorKind } from "./textures";
import { DEV_CLUSTERS, FLOOR, MEETING_SPOTS, MEETING_TABLE, QA_CLUSTER, QA_PAIR, STATIONS, ZONES, type Rect } from "@/lib/office/layout";
import type { Station, WorkZoneId } from "@/lib/office/types";

export const C = {
  wall: "#2a2d48", wallTrim: "#3c4270", podWall: "#343a5e", podWallTop: "#454c7a",
  deskTop: "#c89c6c", deskTopDark: "#6e4a34", deskLeg: "#1d2034", bezel: "#141726", keyboard: "#262a40",
  chair: "#262a42", metal: "#7b83a6", white: "#e8e4da", book: ["#e96f5b", "#f2c35b", "#5fb7d9", "#8b7bd8", "#63c49a", "#d97ab0"],
  plant: ["#3f9b6b", "#4fb07a", "#2f7f59"], pot: "#d8c3a5", potDark: "#8b6a55", sofa: "#3b3f6b", rug: "#2e2749",
};

const ZONE_CHAIR: Record<WorkZoneId, string> = { director: "#b88a3a", dev: "#2f9c90", qa: "#c9654a" };

export type World = {
  root: THREE.Group;
  stationHits: THREE.Mesh[];
  wallScreens: WallScreen[];
  inbox: THREE.Group;
  screenMaterial: THREE.MeshBasicMaterial;
  glowMaterial: THREE.MeshBasicMaterial;
  freeMarkers: Map<string, THREE.Object3D>;
  dispose: () => void;
};

type Batches = { solid: Placer; glow: Placer; glass: Placer; screens: GeometryBatch };

function monitorQuad(batch: GeometryBatch, parent: THREE.Matrix4, cell: number, w: number, h: number, x: number, y: number, z: number, ry: number, tilt = -0.08) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const col = cell % MONITOR_CELLS.cols, row = Math.floor(cell / MONITOR_CELLS.cols) % MONITOR_CELLS.rows;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (col + uv.getX(i)) / MONITOR_CELLS.cols, 1 - (row + 1) / MONITOR_CELLS.rows + uv.getY(i) / MONITOR_CELLS.rows);
  }
  batch.add(g, "#ffffff", parent.clone().multiply(matrix(x, y, z, ry, tilt)));
}

function plant(p: Placer, x: number, z: number, scale = 1, seed = 0) {
  const s = scale;
  p.cyl(0.2 * s, 0.15 * s, 0.34 * s, seed % 2 ? C.pot : C.potDark, x, 0.17 * s, z, 10);
  p.cyl(0.19 * s, 0.19 * s, 0.02, "#3a2a22", x, 0.34 * s, z, 10);
  const leaves = [[0, 0.62, 0, 0.3], [0.13, 0.5, 0.08, 0.22], [-0.12, 0.52, -0.06, 0.22], [0.02, 0.82, 0.03, 0.2]];
  leaves.forEach(([lx, ly, lz, r], i) => p.ico(r * s, C.plant[(i + seed) % 3], x + lx * s, ly * s, z + lz * s, 1.25));
}

function tallPlant(p: Placer, x: number, z: number, seed = 0) {
  p.cyl(0.26, 0.2, 0.5, C.pot, x, 0.25, z, 10);
  p.cyl(0.03, 0.03, 0.8, "#5b4632", x, 0.8, z, 6);
  [[0, 1.35, 0, 0.36], [0.2, 1.05, 0.1, 0.28], [-0.2, 1.15, -0.05, 0.28], [0.05, 1.62, -0.05, 0.24], [-0.1, 0.8, 0.15, 0.22]].forEach(([lx, ly, lz, r], i) =>
    p.ico(r, C.plant[(i + seed) % 3], x + lx, ly, z + lz, 1.2));
}

function officeChair(p: Placer, accent: string) {
  p.cyl(0.26, 0.26, 0.03, C.deskLeg, 0, 0.04, 0, 5);
  p.cyl(0.035, 0.035, 0.3, C.metal, 0, 0.2, 0, 6);
  p.rbox(0.52, 0.08, 0.5, 0.03, C.chair, 0, 0.37, -0.02);
  p.rbox(0.46, 0.04, 0.44, 0.02, accent, 0, 0.415, -0.02);
  p.rbox(0.5, 0.52, 0.08, 0.04, C.chair, 0, 0.72, -0.3);
  p.rbox(0.42, 0.4, 0.02, 0.01, accent, 0, 0.72, -0.255);
}

function desk(b: Batches, st: Station, index: number) {
  const p = b.solid.child(st.x, st.z, st.facing);
  const top = st.zone === "qa" ? "#d9d2c3" : C.deskTop;
  p.rbox(1.7, 0.06, 0.9, 0.02, top, 0, 0.68, 0.72);
  p.box(0.05, 0.65, 0.78, C.deskLeg, -0.8, 0.33, 0.72);
  p.box(0.05, 0.65, 0.78, C.deskLeg, 0.8, 0.33, 0.72);
  p.box(1.56, 0.3, 0.03, C.deskLeg, 0, 0.5, 1.1);
  // Monitor(s)
  p.cyl(0.12, 0.14, 0.02, C.bezel, 0, 0.72, 0.98, 10);
  p.box(0.05, 0.2, 0.04, C.bezel, 0, 0.82, 1.0);
  p.rbox(0.74, 0.44, 0.04, 0.02, C.bezel, 0, 1.0, 1.0);
  const base = matrix(st.x, 0, st.z, st.facing);
  monitorQuad(b.screens, base, index, 0.68, 0.38, 0, 1.0, 0.977, Math.PI, 0);
  if (index % 3 === 0) {
    p.rbox(0.5, 0.3, 0.03, 0.015, C.bezel, 0.62, 0.95, 0.9, -0.5);
    monitorQuad(b.screens, base, index + 3, 0.45, 0.26, 0.628, 0.95, 0.885, Math.PI - 0.5, 0);
  }
  p.box(0.5, 0.02, 0.16, C.keyboard, 0, 0.72, 0.5);
  p.rbox(0.06, 0.03, 0.1, 0.01, C.keyboard, 0.36, 0.72, 0.52);
  // Personal props vary per desk so rows don't look cloned.
  const kind = index % 4;
  if (kind === 0) { p.cyl(0.045, 0.04, 0.1, C.book[index % 6], -0.6, 0.76, 0.55, 8); }
  if (kind === 1) plant(p, -0.62, 0.9, 0.55, index);
  if (kind === 2) { p.box(0.24, 0.03, 0.3, C.white, -0.52, 0.72, 0.62, 0.2); p.box(0.24, 0.03, 0.3, "#f5e6b0", -0.5, 0.745, 0.6, -0.1); }
  if (kind === 3) { p.cyl(0.08, 0.1, 0.02, C.deskLeg, -0.62, 0.72, 0.95, 8); p.box(0.02, 0.36, 0.02, C.metal, -0.62, 0.9, 0.95); p.rbox(0.18, 0.06, 0.1, 0.02, C.deskLeg, -0.56, 1.08, 0.9); b.glow.child(st.x, st.z, st.facing).box(0.14, 0.01, 0.07, "#ffe2a6", -0.56, 1.05, 0.9); }
  officeChair(p, ZONE_CHAIR[st.zone]);
}

function executiveDesk(b: Batches, st: Station) {
  const p = b.solid.child(st.x, st.z, st.facing);
  p.rbox(2.5, 0.08, 1.1, 0.03, C.deskTopDark, 0, 0.72, 0.78);
  p.rbox(0.6, 0.66, 1.0, 0.03, "#4f3526", -0.9, 0.34, 0.78);
  p.rbox(0.6, 0.66, 1.0, 0.03, "#4f3526", 0.9, 0.34, 0.78);
  p.box(1.2, 0.4, 0.04, "#4f3526", 0, 0.5, 1.28);
  const gp = b.glow.child(st.x, st.z, st.facing);
  const base = matrix(st.x, 0, st.z, st.facing);
  for (const [dx, ry] of [[-0.42, 0.18], [0.42, -0.18]] as const) {
    p.cyl(0.12, 0.14, 0.02, C.bezel, dx, 0.77, 1.1, 10);
    p.box(0.05, 0.22, 0.04, C.bezel, dx, 0.88, 1.12);
    p.rbox(0.76, 0.46, 0.04, 0.02, C.bezel, dx, 1.07, 1.12, ry);
    monitorQuad(b.screens, base, dx < 0 ? 3 : 0, 0.7, 0.4, dx - Math.sin(ry) * 0.023, 1.07, 1.12 - 0.023, Math.PI + ry, 0);
  }
  p.box(0.55, 0.02, 0.18, C.keyboard, 0, 0.77, 0.52);
  // Brass desk lamp, globe and name plate
  p.cyl(0.1, 0.12, 0.03, "#c9a25a", 1.0, 0.78, 0.95, 10);
  p.box(0.03, 0.42, 0.03, "#c9a25a", 1.0, 0.98, 0.95);
  p.rbox(0.28, 0.1, 0.16, 0.04, "#2f5a45", 0.92, 1.2, 0.92);
  gp.box(0.22, 0.01, 0.1, "#ffe4a8", 0.92, 1.15, 0.92);
  gp.box(2.3, 0.015, 0.02, ZONES.director.accent, 0, 0.66, 1.33);
  p.box(0.36, 0.08, 0.05, "#c9a25a", -0.7, 0.8, 0.35, 0);
  // Executive chair
  p.cyl(0.3, 0.3, 0.03, C.deskLeg, 0, 0.04, 0, 5);
  p.cyl(0.04, 0.04, 0.3, C.metal, 0, 0.2, 0, 6);
  p.rbox(0.62, 0.1, 0.56, 0.04, "#3a2a24", 0, 0.38, -0.02);
  p.rbox(0.6, 0.8, 0.12, 0.05, "#3a2a24", 0, 0.82, -0.32);
  p.rbox(0.08, 0.2, 0.44, 0.03, "#3a2a24", -0.33, 0.52, 0);
  p.rbox(0.08, 0.2, 0.44, 0.03, "#3a2a24", 0.33, 0.52, 0);
}

function podWalls(b: Batches, r: Rect, accent: string, backHeight: number, gaps: { side: "back" | "front" | "left" | "right"; from: number; to: number }[] = [], skip: ("back" | "front" | "left" | "right")[] = []) {
  const t = 0.14, low = 0.46;
  const seg = (side: "back" | "front" | "left" | "right", a: number, bnd: number) => {
    const h = side === "back" ? backHeight : low;
    const len = bnd - a;
    if (len <= 0.05) return;
    const mid = (a + bnd) / 2;
    if (side === "back" || side === "front") {
      const z = side === "back" ? r.z0 : r.z1;
      b.solid.box(len, h, t, C.podWall, mid, h / 2, z);
      b.solid.box(len + 0.02, 0.05, t + 0.06, C.podWallTop, mid, h + 0.025, z);
      b.glow.box(len, 0.025, 0.03, accent, mid, h + 0.055, z + (side === "back" ? 0.05 : -0.05));
    } else {
      const x = side === "left" ? r.x0 : r.x1;
      b.solid.box(t, h, len, C.podWall, x, h / 2, mid);
      b.solid.box(t + 0.06, 0.05, len + 0.02, C.podWallTop, x, h + 0.025, mid);
      b.glow.box(0.03, 0.025, len, accent, x + (side === "left" ? 0.05 : -0.05), h + 0.055, mid);
    }
  };
  for (const side of ["back", "front", "left", "right"] as const) {
    if (skip.includes(side)) continue;
    const [a, bnd] = side === "back" || side === "front" ? [r.x0, r.x1] : [r.z0, r.z1];
    const g = gaps.filter(x => x.side === side).sort((x, y) => x.from - y.from);
    let cur = a;
    for (const gap of g) { seg(side, cur, gap.from); cur = gap.to; }
    seg(side, cur, bnd);
  }
}

function board(b: Batches, x: number, z: number, w: number, kind: "kanban" | "bugs" | "white", y = 0.62) {
  const p = b.solid.child(x, z);
  p.box(w, 0.9, 0.04, kind === "bugs" ? "#9c7650" : "#e9e7f2", 0, y + 0.45, 0.06);
  p.box(w + 0.06, 0.05, 0.07, C.deskLeg, 0, y + 0.92, 0.06);
  const colors = ["#ffd166", "#7ee0c8", "#ff9fb2", "#9cc2ff", "#ffb37a"];
  const cols = kind === "kanban" ? 3 : 4;
  for (let c = 0; c < cols; c++) {
    if (kind === "kanban") p.box(0.02, 0.8, 0.01, "#b7b4c8", -w / 2 + ((c + 1) * w) / cols, y + 0.45, 0.085);
    for (let k = 0; k < 3; k++) {
      if ((c * 7 + k * 3) % 5 === 4) continue;
      p.box(0.16, 0.14, 0.012, colors[(c + k * 2) % colors.length], -w / 2 + (c + 0.5) * (w / cols) + ((k % 2) - 0.5) * 0.12, y + 0.72 - k * 0.22, 0.09);
    }
  }
}

function sofa(p: Placer, x: number, z: number, ry: number, w = 1.9, color = C.sofa) {
  const s = p.child(x, z, ry);
  s.rbox(w, 0.34, 0.8, 0.08, color, 0, 0.22, 0);
  s.rbox(w, 0.5, 0.22, 0.08, color, 0, 0.55, -0.32);
  s.rbox(0.2, 0.44, 0.8, 0.08, color, -w / 2 + 0.1, 0.36, 0);
  s.rbox(0.2, 0.44, 0.8, 0.08, color, w / 2 - 0.1, 0.36, 0);
  s.rbox(w / 2 - 0.24, 0.1, 0.56, 0.05, "#4d5286", -w / 4 + 0.03, 0.42, 0.06);
  s.rbox(w / 2 - 0.24, 0.1, 0.56, 0.05, "#4d5286", w / 4 - 0.03, 0.42, 0.06);
}

export function buildWorld(anisotropy: number): World {
  const root = new THREE.Group();
  root.name = "world";
  const disposables: { dispose: () => void }[] = [];
  const solidBatch = new GeometryBatch(), glowBatch = new GeometryBatch(), glassBatch = new GeometryBatch();
  const b: Batches = { solid: new Placer(solidBatch), glow: new Placer(glowBatch), glass: new Placer(glassBatch), screens: new GeometryBatch(true) };
  const S = b.solid;

  // --- Floors (textured, receive shadows only) -------------------------------
  const floorMeshes: [Rect, FloorKind, number][] = [
    [FLOOR, "concrete", 0],
    [ZONES.director.rect, "wood", 0.01],
    [ZONES.lounge.rect, "tiles", 0.008],
    [ZONES.meeting.rect, "carpetViolet", 0.01],
    [ZONES.dev.rect, "carpetTeal", 0.01],
    [ZONES.qa.rect, "carpetCoral", 0.01],
  ];
  for (const [r, kind, h] of floorMeshes) {
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    const tex = floorTexture(kind, kind === "wood" ? [w / 3, d / 3] : kind === "concrete" ? [w / 4, d / 4] : [w / 2.5, d / 2.5]);
    tex.anisotropy = anisotropy;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: kind === "wood" ? 0.55 : 0.92, metalness: 0 });
    const geo = new THREE.PlaneGeometry(w, d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((r.x0 + r.x1) / 2, h, (r.z0 + r.z1) / 2);
    mesh.receiveShadow = true;
    root.add(mesh);
    disposables.push(tex, mat, geo);
  }
  // Floor slab edge + corridor guide lines
  S.box(FLOOR.x1 - FLOOR.x0 + 0.4, 0.5, FLOOR.z1 - FLOOR.z0 + 0.4, "#15172a", 0, -0.26, 0);
  b.glow.box(FLOOR.x1 - FLOOR.x0 - 1.2, 0.005, 0.05, "#3d4a8a", 0, 0.004, -2.2 + 0.62);
  b.glow.box(FLOOR.x1 - FLOOR.x0 - 1.2, 0.005, 0.05, "#3d4a8a", 0, 0.004, -2.2 - 0.62);
  b.glow.box(0.05, 0.005, 10.4, "#3d4a8a", 2.2, 0.004, 4.1);

  // --- Building shell --------------------------------------------------------
  const wallH = 4.4;
  S.box(FLOOR.x1 - FLOOR.x0 + 0.3, wallH, 0.3, C.wall, 0, wallH / 2, FLOOR.z0 - 0.15);
  S.box(0.3, wallH, FLOOR.z1 - FLOOR.z0, C.wall, FLOOR.x0 - 0.15, wallH / 2, 0);
  S.box(FLOOR.x1 - FLOOR.x0 + 0.5, 0.12, 0.44, C.wallTrim, 0, wallH + 0.06, FLOOR.z0 - 0.15);
  S.box(0.44, 0.12, FLOOR.z1 - FLOOR.z0, C.wallTrim, FLOOR.x0 - 0.15, wallH + 0.06, 0);
  S.box(FLOOR.x1 - FLOOR.x0, 0.16, 0.06, "#1c1f33", 0, 0.08, FLOOR.z0 + 0.02);
  S.box(0.06, 0.16, FLOOR.z1 - FLOOR.z0, "#1c1f33", FLOOR.x0 + 0.02, 0.08, 0);
  // Windows with a night skyline on the left wall.
  const sky = skylineTexture();
  sky.anisotropy = anisotropy;
  const skyMat = new THREE.MeshBasicMaterial({ map: sky, toneMapped: false, color: "#b9b4d8" });
  disposables.push(sky, skyMat);
  for (const [z0, z1] of [[-8.6, -3.8], [-1, 3.6], [4.6, 9.2]]) {
    const len = z1 - z0, mid = (z0 + z1) / 2;
    const g = new THREE.PlaneGeometry(len, 2.1);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, (mid + 10 + (uv.getX(i) - 0.5) * len) / 20);
    const win = new THREE.Mesh(g, skyMat);
    win.position.set(FLOOR.x0 + 0.02, 2.55, mid);
    win.rotation.y = Math.PI / 2;
    root.add(win);
    disposables.push(g);
    S.box(0.12, 0.1, len + 0.12, C.wallTrim, FLOOR.x0 + 0.05, 1.45, mid);
    S.box(0.12, 0.1, len + 0.12, C.wallTrim, FLOOR.x0 + 0.05, 3.65, mid);
    for (let k = 0; k <= Math.round(len / 1.2); k++) S.box(0.1, 2.2, 0.06, C.wallTrim, FLOOR.x0 + 0.05, 2.55, z0 + (k * len) / Math.round(len / 1.2));
  }

  // --- Wall screens (live local data) ----------------------------------------
  const wallScreens: WallScreen[] = [];
  const screenSpots: [WallScreen["kind"], number, number][] = [["team", -9.2, 4.4], ["queue", -0.6, 4.8], ["meeting", 8.9, 4]];
  for (const [kind, x, w] of screenSpots) {
    const ws = new WallScreen(kind);
    ws.texture.anisotropy = anisotropy;
    wallScreens.push(ws);
    const h = w / 2;
    S.rbox(w + 0.24, h + 0.24, 0.12, 0.04, "#0d0f1c", x, 3.0, FLOOR.z0 + 0.08);
    const mat = new THREE.MeshBasicMaterial({ map: ws.texture, toneMapped: false });
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 3.0, FLOOR.z0 + 0.145);
    root.add(mesh);
    disposables.push(mat, geo, ws);
    b.glow.box(w + 0.1, 0.03, 0.03, kind === "queue" ? ZONES.lounge.accent : kind === "team" ? ZONES.director.accent : ZONES.meeting.accent, x, 3.0 - h / 2 - 0.16, FLOOR.z0 + 0.16);
  }

  // --- Zones -----------------------------------------------------------------
  const dr = ZONES.director.rect;
  podWalls(b, dr, ZONES.director.accent, 0.46, [{ side: "front", from: -6.7, to: -5.1 }], ["back", "left"]);
  // Bookshelf & credenza behind the director
  const shelf = S.child(-9.6, -9.55);
  shelf.box(3.4, 1.5, 0.5, "#3b2a22", 0, 0.75, 0);
  for (let row = 0; row < 3; row++) {
    shelf.box(3.2, 0.04, 0.44, "#5a4032", 0, 0.3 + row * 0.42, 0.04);
    let x = -1.5;
    let i = row * 5;
    while (x < 1.4) {
      const w = 0.07 + ((i * 37) % 5) * 0.02, h = 0.24 + ((i * 13) % 4) * 0.035;
      if (i % 7 !== 3) shelf.box(w, h, 0.28, C.book[i % 6], x + w / 2, 0.32 + row * 0.42 + h / 2, 0.08);
      x += w + (i % 7 === 3 ? 0.35 : 0.01);
      i++;
    }
  }
  shelf.cyl(0.14, 0.14, 0.26, "#c9a25a", 1.1, 1.63, 0.02, 10);
  shelf.ico(0.18, "#5fb7d9", -1.1, 1.7, 0.02);
  executiveDesk(b, STATIONS[0]);
  for (const x of [-10.3, -8.9]) {
    const c = S.child(x, -5.55, Math.PI);
    c.rbox(0.56, 0.1, 0.52, 0.04, "#7a5236", 0, 0.4, 0);
    c.rbox(0.56, 0.44, 0.1, 0.04, "#7a5236", 0, 0.66, -0.24);
    for (const [lx, lz] of [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2]]) c.box(0.04, 0.36, 0.04, C.deskLeg, lx, 0.18, lz);
  }
  S.cyl(1.7, 1.7, 0.012, C.rug, -9.4, 0.07, -6.2, 28);
  b.glow.cyl(1.72, 1.72, 0.004, "#5c4a86", -9.4, 0.068, -6.2, 28);
  tallPlant(S, -12.9, -9, 1);
  tallPlant(S, -5.6, -8.9, 2);
  sofa(S, -13.0, -7.2, Math.PI / 2, 1.8, "#6b4a3a");

  // Lounge: coffee bar, arcade, sofa, high table
  const lr = ZONES.lounge.rect;
  const bar = S.child(-2.2, -9.45);
  bar.box(3.6, 0.92, 0.66, "#2f3354", 0, 0.46, 0);
  bar.box(3.7, 0.05, 0.72, "#d9d2c3", 0, 0.94, 0.02);
  bar.rbox(0.42, 0.52, 0.36, 0.04, "#1c1d2c", -1.1, 1.22, -0.04);
  bar.box(0.3, 0.12, 0.02, "#e05d4f", -1.1, 1.3, 0.15);
  bar.cyl(0.05, 0.045, 0.1, C.white, -0.95, 1.02, 0.12, 8);
  bar.cyl(0.05, 0.045, 0.1, "#f2c35b", -0.8, 1.02, 0.18, 8);
  bar.rbox(0.62, 1.5, 0.6, 0.04, "#cfd3e6", 1.35, 0.75, 0);
  b.glow.box(0.02, 0.4, 0.02, "#8fd6ff", 1.62, 1.1, 0.31);
  for (let i = 0; i < 4; i++) bar.cyl(0.07, 0.07, 0.03, C.book[i], -0.2 + i * 0.22, 0.98, 0.1, 8);
  const arcade = S.child(2.5, -8.9, -0.35);
  arcade.rbox(0.8, 1.7, 0.7, 0.04, "#5a2d7a", 0, 0.85, 0);
  arcade.box(0.72, 0.1, 0.35, "#1b1b2a", 0, 1.05, 0.3);
  arcade.box(0.6, 0.45, 0.03, "#0b0b16", 0, 1.42, 0.34);
  b.glow.child(2.5, -8.9, -0.35).box(0.54, 0.38, 0.01, "#ff7ad9", 0, 1.42, 0.357);
  b.glow.child(2.5, -8.9, -0.35).box(0.74, 0.12, 0.01, "#ffd166", 0, 1.64, 0.357);
  sofa(S, -2.6, -4.6, Math.PI, 2.2);
  S.cyl(0.5, 0.5, 0.05, "#d9d2c3", -2.6, 0.42, -5.9, 18);
  S.cyl(0.05, 0.05, 0.4, C.deskLeg, -2.6, 0.2, -5.9, 8);
  S.cyl(0.08, 0.06, 0.12, "#e96f5b", -2.45, 0.5, -5.8, 8);
  S.cyl(0.4, 0.4, 0.05, "#d9d2c3", 1.3, 1.02, -6.1, 16);
  S.cyl(0.05, 0.05, 1.0, C.deskLeg, 1.3, 0.5, -6.1, 8);
  for (const [sx, sz] of [[0.75, -6.1], [1.85, -6.1], [1.3, -5.5]]) { S.cyl(0.18, 0.18, 0.06, "#8b7bd8", sx, 0.72, sz, 12); S.cyl(0.03, 0.03, 0.7, C.metal, sx, 0.36, sz, 6); }
  tallPlant(S, lr.x0 + 0.5, -3.8, 3);
  plant(S, 3.0, -3.7, 1.1, 1);

  // Meeting room: glass partitions, table, chairs, credenza
  const mr = ZONES.meeting.rect;
  const glassH = 2.3;
  const glassRun = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(x1 - x0, z1 - z0);
    const g = b.glass.child((x0 + x1) / 2, (z0 + z1) / 2, ang);
    g.box(0.03, glassH - 0.12, len, "#c7b8ff", 0, glassH / 2 + 0.02, 0);
    const f = S.child((x0 + x1) / 2, (z0 + z1) / 2, ang);
    f.box(0.08, 0.08, len, "#555c8a", 0, glassH, 0);
    f.box(0.1, 0.1, len, "#2b2f4d", 0, 0.1, 0);
    const n = Math.max(1, Math.round(len / 1.5));
    for (let k = 0; k <= n; k++) f.box(0.07, glassH, 0.07, "#555c8a", 0, glassH / 2, -len / 2 + (k * len) / n);
    b.glow.child((x0 + x1) / 2, (z0 + z1) / 2, ang).box(0.02, 0.02, len, ZONES.meeting.accent, 0, 0.9, 0);
  };
  glassRun(mr.x0, mr.z0, mr.x0, mr.z1);
  glassRun(5.8, mr.z1, mr.x1, mr.z1);
  glassRun(mr.x1, mr.z1, mr.x1, mr.z0);
  S.box(1.8, 0.08, 0.08, "#555c8a", 4.9, glassH, mr.z1);
  const T = MEETING_TABLE;
  S.rbox(T.w, 0.08, T.d, 0.04, "#e6dccb", T.x, 0.7, T.z);
  S.rbox(T.w - 0.5, 0.02, 0.35, 0.01, "#6d5ca8", T.x, 0.745, T.z);
  S.box(0.12, 0.66, 1.0, C.deskLeg, T.x - 1.4, 0.33, T.z);
  S.box(0.12, 0.66, 1.0, C.deskLeg, T.x + 1.4, 0.33, T.z);
  for (let i = 0; i < 3; i++) { S.box(0.26, 0.02, 0.2, C.white, T.x - 1.3 + i * 1.3, 0.75, T.z + 0.55); S.cyl(0.04, 0.035, 0.09, "#e96f5b", T.x - 1.0 + i * 1.3, 0.79, T.z - 0.55, 8); }
  for (const spot of MEETING_SPOTS.filter(s => s.seated)) {
    const c = S.child(spot.x, spot.z, spot.facing);
    c.cyl(0.24, 0.24, 0.03, C.deskLeg, 0, 0.04, 0, 5);
    c.cyl(0.035, 0.035, 0.3, C.metal, 0, 0.2, 0, 6);
    c.rbox(0.5, 0.08, 0.48, 0.03, "#453c73", 0, 0.37, -0.02);
    c.rbox(0.48, 0.46, 0.07, 0.03, "#453c73", 0, 0.68, -0.28);
  }
  S.box(3.2, 0.7, 0.5, "#2f3354", 8.9, 0.35, mr.z0 + 0.3);
  tallPlant(S, mr.x1 - 0.5, mr.z0 + 0.5, 4);
  tallPlant(S, mr.x0 + 0.5, mr.z0 + 0.5, 5);

  // Development pod
  const dv = ZONES.dev.rect;
  podWalls(b, dv, ZONES.dev.accent, 1.25, [{ side: "back", from: -0.6, to: 0.8 }]);
  board(b, -9.4, dv.z0, 2.6, "kanban");
  board(b, -4.2, dv.z0, 2.2, "white");
  for (const [cx, cz] of DEV_CLUSTERS) {
    S.box(3.5, 0.34, 0.05, "#3b4266", cx, 0.87, cz);
    b.glow.box(3.5, 0.02, 0.06, ZONES.dev.accent, cx, 1.05, cz);
  }
  // Server rack with status LEDs (decorative, not a live status)
  const rack = S.child(-12.8, 8.5);
  rack.rbox(0.8, 2, 0.8, 0.03, "#16182a", 0, 1, 0);
  for (let i = 0; i < 7; i++) {
    rack.box(0.7, 0.2, 0.02, "#22253c", 0, 0.35 + i * 0.24, 0.405);
    b.glow.box(0.04, 0.03, 0.01, i % 3 ? "#58e39a" : "#8fd6ff", -12.8 + 0.25, 0.35 + i * 0.24, 8.5 + 0.42);
    b.glow.box(0.04, 0.03, 0.01, "#58e39a", -12.8 + 0.17, 0.35 + i * 0.24, 8.5 + 0.42);
  }
  // Bean bags + low table (pairing corner)
  for (const [x, z, col] of [[-1.3, 8.2, "#e96f5b"], [0.2, 7.6, "#f2c35b"]] as const) S.ico(0.42, col, x, 0.3, z, 0.7);
  S.cyl(0.35, 0.35, 0.04, "#d9d2c3", -0.6, 0.3, 8.5, 16);
  S.cyl(0.05, 0.05, 0.28, C.deskLeg, -0.6, 0.14, 8.5, 8);
  tallPlant(S, dv.x0 + 0.5, dv.z0 + 0.6, 6);
  tallPlant(S, dv.x1 - 0.5, dv.z1 - 0.5, 7);
  plant(S, -6.1, 8.8, 1.2, 2);

  // QA pod
  const qr = ZONES.qa.rect;
  podWalls(b, qr, ZONES.qa.accent, 1.25, [{ side: "back", from: 3.4, to: 4.8 }]);
  board(b, 8.3, qr.z0, 2.6, "bugs");
  S.box(3.5, 0.34, 0.05, "#3b4266", QA_CLUSTER[0], 0.87, QA_CLUSTER[1]);
  b.glow.box(3.5, 0.02, 0.06, ZONES.qa.accent, QA_CLUSTER[0], 1.05, QA_CLUSTER[1]);
  S.box(1.6, 0.34, 0.05, "#3b4266", QA_PAIR[0], 0.87, QA_PAIR[1]);
  b.glow.box(1.6, 0.02, 0.06, ZONES.qa.accent, QA_PAIR[0], 1.05, QA_PAIR[1]);
  // Device test bench with phones and tablets
  const bench = S.child(10.4, 8.3);
  bench.rbox(3.2, 0.06, 0.9, 0.02, "#d9d2c3", 0, 0.7, 0);
  bench.box(0.06, 0.68, 0.8, C.deskLeg, -1.5, 0.34, 0);
  bench.box(0.06, 0.68, 0.8, C.deskLeg, 1.5, 0.34, 0);
  const benchBase = matrix(10.4, 0, 8.3, 0);
  [[-1.1, 0.16, 0.3, 4], [-0.6, 0.18, 0.34, 5], [0, 0.34, 0.24, 6], [0.6, 0.16, 0.3, 1], [1.1, 0.18, 0.34, 2]].forEach(([x, w, h, cell]) => {
    bench.rbox(w + 0.04, h + 0.04, 0.03, 0.015, C.bezel, x, 0.73 + (h + 0.04) / 2 + 0.02, -0.15, 0);
    monitorQuad(b.screens, benchBase, cell, w, h, x, 0.73 + (h + 0.04) / 2 + 0.02, -0.132, 0, 0);
  });
  tallPlant(S, qr.x1 - 0.5, qr.z0 + 0.6, 8);
  plant(S, qr.x0 + 0.6, qr.z1 - 0.6, 1.2, 3);
  plant(S, 6.4, 8.6, 1, 4);

  // Corridor plants
  for (const [x, z] of [[-12.8, -2.2], [13.3, -2.2], [2.2, 9.3]]) plant(S, x, z, 1.1, Math.round(x));

  // --- Stations ----------------------------------------------------------------
  STATIONS.forEach((st, i) => { if (st.kind === "desk") desk(b, st, i); });

  // --- Build materials -----------------------------------------------------------
  const solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.02 });
  const solidGeo = solidBatch.build()!;
  const solid = new THREE.Mesh(solidGeo, solidMat);
  solid.castShadow = true;
  solid.receiveShadow = true;
  solid.name = "static-solid";
  root.add(solid);
  const glowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const glowGeo = glowBatch.build()!;
  root.add(new THREE.Mesh(glowGeo, glowMaterial));
  const glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.16, roughness: 0.1, metalness: 0.3, depthWrite: false });
  const glassGeo = glassBatch.build()!;
  const glass = new THREE.Mesh(glassGeo, glassMat);
  glass.renderOrder = 2;
  root.add(glass);
  const atlas = monitorAtlas();
  atlas.anisotropy = anisotropy;
  const screenMaterial = new THREE.MeshBasicMaterial({ map: atlas, toneMapped: false, color: "#dfe8ff" });
  const screenGeo = b.screens.build()!;
  root.add(new THREE.Mesh(screenGeo, screenMaterial));
  disposables.push(solidMat, solidGeo, glowMaterial, glowGeo, glassMat, glassGeo, atlas, screenMaterial, screenGeo);

  // Soft contact shadows under furniture clusters (cheap and shadow-map independent).
  const blobTex = radialTexture("rgba(5,6,18,0.55)");
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false });
  const blobGeo = new THREE.PlaneGeometry(1, 1);
  disposables.push(blobTex, blobMat, blobGeo);
  const blob = (x: number, z: number, w: number, d: number, y = 0.065) => {
    const m = new THREE.Mesh(blobGeo, blobMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.scale.set(w, d, 1);
    m.renderOrder = 1;
    root.add(m);
  };
  for (const [cx, cz] of [...DEV_CLUSTERS, QA_CLUSTER]) blob(cx, cz, 5.2, 4.4);
  blob(QA_PAIR[0], QA_PAIR[1], 2.8, 4.4);
  blob(-9.6, -6.8, 3.6, 2.4);
  blob(T.x, T.z, 6.4, 3.8);

  // --- Station hit areas and "free desk" markers --------------------------------
  const hitGeo = new THREE.BoxGeometry(1.9, 1.5, 1.9);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  disposables.push(hitGeo, hitMat);
  const stationHits: THREE.Mesh[] = [];
  const freeMarkers = new Map<string, THREE.Object3D>();
  const markerGeo = new THREE.RingGeometry(0.34, 0.42, 32);
  const plusGeo = new THREE.PlaneGeometry(0.34, 0.07);
  const markerMat = new THREE.MeshBasicMaterial({ color: "#9fb4ff", transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  disposables.push(markerGeo, plusGeo, markerMat);
  for (const st of STATIONS) {
    const hit = new THREE.Mesh(hitGeo, hitMat);
    const fwd = st.kind === "executive" ? 0.5 : 0.35;
    hit.position.set(st.x + Math.sin(st.facing) * fwd, 0.75, st.z + Math.cos(st.facing) * fwd);
    hit.rotation.y = st.facing;
    hit.userData.stationId = st.id;
    root.add(hit);
    stationHits.push(hit);
    const marker = new THREE.Group();
    const ring = new THREE.Mesh(markerGeo, markerMat);
    ring.rotation.x = -Math.PI / 2;
    const p1 = new THREE.Mesh(plusGeo, markerMat), p2 = new THREE.Mesh(plusGeo, markerMat);
    p1.rotation.x = p2.rotation.x = -Math.PI / 2;
    p2.rotation.z = Math.PI / 2;
    marker.add(ring, p1, p2);
    marker.position.set(st.x, 0.09, st.z);
    marker.visible = false;
    root.add(marker);
    freeMarkers.set(st.id, marker);
  }

  // Director's inbox tray: its paper stack mirrors the real local queue size.
  const inbox = new THREE.Group();
  const st0 = STATIONS[0];
  inbox.position.set(st0.x - 0.95, 0.77, st0.z + 0.62);
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.3), new THREE.MeshStandardMaterial({ color: "#c9a25a", roughness: 0.4, metalness: 0.5 }));
  tray.castShadow = true;
  inbox.add(tray);
  root.add(inbox);

  return {
    root, stationHits, wallScreens, inbox, screenMaterial, glowMaterial, freeMarkers,
    dispose: () => {
      for (const d of disposables) d.dispose();
      inbox.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
    },
  };
}
