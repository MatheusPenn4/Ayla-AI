import * as THREE from "three";
import { GeometryBatch, Placer, matrix } from "./batch";
import { MONITOR_CELLS, SCREEN_CELL, WallScreen, floorTexture, glowAtlas, monitorAtlas, radialTexture, skylineTexture, type FloorKind } from "./textures";
import { buildWallSign } from "./sign";
import { AREA_ACCENT, W, desk, executiveDesk, lightQuad, type Batches } from "./workstation";
import { DEV_CLUSTERS, FLOOR, MEETING_SPOTS, MEETING_TABLE, QA_CLUSTER, QA_PAIR, STATIONS, ZONES, type Rect } from "@/lib/office/layout";

// Art direction: contemporary tech studio. Graphite and black surfaces,
// electric-blue/cyan details, indirect light (emissive lines + additive washes,
// no extra real lights), and one identity per room.
export const C = {
  wall: "#191b23", wallPanel: "#20232d", wallTrim: "#2a2f3c", podWall: "#1f222c", podWallTop: "#343a4b",
  metal: "#7c86a3", white: "#e4e7ee", blue: "#2f7dff", cyan: "#39c6ff",
  book: ["#8a4e45", "#9c8347", "#3f6b93", "#5a5390", "#3f7d68", "#7d566a", "#4a5064"],
  plant: ["#3a8a62", "#4a9e70", "#2c7353"], pot: "#2b2f3a", potLight: "#8e929c", sofa: "#262a37", rug: "#1b1f2b",
  walnut: "#33231a", walnutDark: "#22170f", brass: "#c9a25a",
};

export type World = {
  root: THREE.Group;
  stationHits: THREE.Mesh[];
  wallScreens: WallScreen[];
  inbox: THREE.Group;
  screenMaterial: THREE.MeshBasicMaterial;
  glowMaterial: THREE.MeshBasicMaterial;
  freeMarkers: Map<string, THREE.Object3D>;
  /** Redraws canvas textures that use web fonts (call after document.fonts is ready). */
  refreshFonts: () => void;
  dispose: () => void;
};

/** Small device screens (QA bench and device wall) that use a whole atlas cell. */
function deviceQuad(batch: GeometryBatch, parent: THREE.Matrix4, cell: number, w: number, h: number, x: number, y: number, z: number, ry = 0) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const col = cell % MONITOR_CELLS.cols, row = Math.floor(cell / MONITOR_CELLS.cols) % MONITOR_CELLS.rows;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (col + uv.getX(i)) / MONITOR_CELLS.cols, 1 - (row + 1) / MONITOR_CELLS.rows + uv.getY(i) / MONITOR_CELLS.rows);
  batch.add(g, "#ffffff", parent.clone().multiply(matrix(x, y, z, ry)));
}

function plant(p: Placer, x: number, z: number, scale = 1, seed = 0) {
  const s = scale;
  p.cyl(0.2 * s, 0.16 * s, 0.34 * s, seed % 2 ? C.pot : C.potLight, x, 0.17 * s, z, 12);
  p.cyl(0.19 * s, 0.19 * s, 0.02, "#241c16", x, 0.34 * s, z, 12);
  const leaves = [[0, 0.62, 0, 0.3], [0.13, 0.5, 0.08, 0.22], [-0.12, 0.52, -0.06, 0.22], [0.02, 0.82, 0.03, 0.2]];
  leaves.forEach(([lx, ly, lz, r], i) => p.ico(r * s, C.plant[(i + seed) % 3], x + lx * s, ly * s, z + lz * s, 1.25));
}

function tallPlant(p: Placer, x: number, z: number, seed = 0) {
  p.cyl(0.25, 0.21, 0.52, seed % 2 ? C.pot : C.potLight, x, 0.26, z, 12);
  p.cyl(0.03, 0.03, 0.8, "#3b2e22", x, 0.8, z, 6);
  [[0, 1.35, 0, 0.36], [0.2, 1.05, 0.1, 0.28], [-0.2, 1.15, -0.05, 0.28], [0.05, 1.62, -0.05, 0.24], [-0.1, 0.8, 0.15, 0.22]].forEach(([lx, ly, lz, r], i) =>
    p.ico(r, C.plant[(i + seed) % 3], x + lx, ly, z + lz, 1.2));
}

type Side = "back" | "front" | "left" | "right";

/** Pod walls: graphite panels, metal cap, thin accent line (the only "neon" in the pods). */
function podWalls(b: Batches, r: Rect, accent: string, backHeight: number, gaps: { side: Side; from: number; to: number }[] = [], skip: Side[] = []) {
  const t = 0.14, low = 0.5;
  const seg = (side: Side, a: number, bnd: number) => {
    const h = side === "back" ? backHeight : low;
    const len = bnd - a;
    if (len <= 0.05) return;
    const mid = (a + bnd) / 2;
    if (side === "back" || side === "front") {
      const z = side === "back" ? r.z0 : r.z1;
      b.solid.box(len, h, t, C.podWall, mid, h / 2, z);
      b.solid.box(len + 0.02, 0.04, t + 0.05, C.podWallTop, mid, h + 0.02, z);
      b.solid.box(len, 0.06, t + 0.01, "#101218", mid, 0.03, z);
      b.glow.box(len - 0.1, 0.012, 0.03, accent, mid, h + 0.042, z);
    } else {
      const x = side === "left" ? r.x0 : r.x1;
      b.solid.box(t, h, len, C.podWall, x, h / 2, mid);
      b.solid.box(t + 0.05, 0.04, len + 0.02, C.podWallTop, x, h + 0.02, mid);
      b.solid.box(t + 0.01, 0.06, len, "#101218", x, 0.03, mid);
      b.glow.box(0.03, 0.012, len - 0.1, accent, x, h + 0.042, mid);
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

/** Thin brushed-metal inlay around a zone floor; helps read the room layout from above. */
function floorInlay(b: Batches, r: Rect, color = "#3a4254") {
  const y = 0.014, t = 0.05;
  b.solid.box(r.x1 - r.x0, 0.008, t, color, (r.x0 + r.x1) / 2, y, r.z0 + t / 2);
  b.solid.box(r.x1 - r.x0, 0.008, t, color, (r.x0 + r.x1) / 2, y, r.z1 - t / 2);
  b.solid.box(t, 0.008, r.z1 - r.z0, color, r.x0 + t / 2, y, (r.z0 + r.z1) / 2);
  b.solid.box(t, 0.008, r.z1 - r.z0, color, r.x1 - t / 2, y, (r.z0 + r.z1) / 2);
}

/** Development: storyboard wall of wireframe frames (creative studio, no task list). */
function storyboard(b: Batches, x: number, z: number, w: number) {
  const p = b.solid.child(x, z);
  p.box(w, 0.92, 0.035, "#12141a", 0, 1.08, 0.07);
  const cols = 4, rows = 2, fw = (w - 0.2) / cols;
  for (let c = 0; c < cols; c++) for (let rr = 0; rr < rows; rr++) {
    const fx = -w / 2 + 0.1 + fw * (c + 0.5), fy = 0.86 + rr * 0.42;
    p.box(fw - 0.08, 0.34, 0.012, "#e9edf5", fx, fy, 0.094);
    p.box(fw - 0.2, 0.07, 0.006, "#c7cfdf", fx, fy + 0.09, 0.102);
    p.box((fw - 0.2) * 0.55, 0.04, 0.006, (c + rr) % 3 ? "#9aa6be" : C.blue, fx - (fw - 0.2) * 0.2, fy - 0.07, 0.102);
  }
  b.glow.box(w, 0.01, 0.02, AREA_ACCENT.dev, x, 1.56, z + 0.09);
}

/** Whiteboard with an abstract architecture diagram (boxes + connectors). */
function diagramBoard(b: Batches, x: number, z: number, w: number) {
  const p = b.solid.child(x, z);
  p.box(w, 0.86, 0.035, "#eef1f6", 0, 1.06, 0.07);
  p.box(w + 0.04, 0.03, 0.05, "#2a2f3c", 0, 0.62, 0.08);
  const boxes: [number, number][] = [[-0.7, 1.26], [0, 1.26], [0.7, 1.26], [-0.35, 0.9], [0.35, 0.9]];
  for (const [bx, by] of boxes) { p.box(0.36, 0.16, 0.008, "#ffffff", bx * (w / 2.2), by, 0.09); p.box(0.36, 0.02, 0.009, C.blue, bx * (w / 2.2), by + 0.07, 0.092); }
  p.box(w * 0.66, 0.012, 0.006, "#8c96ad", 0, 1.26, 0.095);
  p.box(0.012, 0.3, 0.006, "#8c96ad", -0.16 * w, 1.08, 0.095);
  p.box(0.012, 0.3, 0.006, "#8c96ad", 0.16 * w, 1.08, 0.095);
}

/** QA: wall of mounted test devices showing lock screens (nothing "running"). */
function deviceWall(b: Batches, x: number, z: number, w: number) {
  const p = b.solid.child(x, z);
  const base = matrix(x, 0, z, 0);
  p.box(w, 0.9, 0.035, "#12151c", 0, 1.07, 0.07);
  const items: [number, number, number, number][] = [[-1.0, 1.2, 0.18, 0.3], [-0.62, 1.2, 0.18, 0.3], [-0.2, 1.17, 0.42, 0.28], [0.3, 1.2, 0.18, 0.3], [0.72, 1.17, 0.42, 0.28], [-0.8, 0.84, 0.42, 0.26], [0, 0.82, 0.3, 0.2], [0.62, 0.84, 0.42, 0.26]];
  items.forEach(([ix, iy, iw, ih], i) => {
    p.rbox(iw + 0.035, ih + 0.035, 0.018, 0.012, W.bezel, ix * (w / 2.6), iy, 0.098);
    deviceQuad(b.screens, base, i % 2 ? SCREEN_CELL.lock : SCREEN_CELL.wallpaper, iw, ih, ix * (w / 2.6), iy, 0.108);
  });
  b.glow.box(w, 0.01, 0.02, AREA_ACCENT.qa, x, 1.54, z + 0.09);
}

function sofa(p: Placer, x: number, z: number, ry: number, w = 1.9, color = C.sofa, cushion = "#353b4d") {
  const s = p.child(x, z, ry);
  s.rbox(w, 0.34, 0.8, 0.06, color, 0, 0.24, 0);
  s.rbox(w, 0.46, 0.2, 0.06, color, 0, 0.56, -0.32);
  s.rbox(0.16, 0.42, 0.8, 0.05, color, -w / 2 + 0.08, 0.37, 0);
  s.rbox(0.16, 0.42, 0.8, 0.05, color, w / 2 - 0.08, 0.37, 0);
  s.rbox(w / 2 - 0.2, 0.09, 0.56, 0.04, cushion, -w / 4 + 0.02, 0.44, 0.06);
  s.rbox(w / 2 - 0.2, 0.09, 0.56, 0.04, cushion, w / 4 - 0.02, 0.44, 0.06);
  for (const lx of [-w / 2 + 0.12, w / 2 - 0.12]) { s.box(0.04, 0.07, 0.04, "#0c0d11", lx, 0.035, 0.3); s.box(0.04, 0.07, 0.04, "#0c0d11", lx, 0.035, -0.3); }
}

export function buildWorld(anisotropy: number): World {
  const root = new THREE.Group();
  root.name = "world";
  const disposables: { dispose: () => void }[] = [];
  const solidBatch = new GeometryBatch(), glowBatch = new GeometryBatch(), glassBatch = new GeometryBatch();
  const b: Batches = { solid: new Placer(solidBatch), glow: new Placer(glowBatch), glass: new Placer(glassBatch), screens: new GeometryBatch(true), light: new GeometryBatch(true) };
  const S = b.solid;
  const wallZ = FLOOR.z0; // inner face of the back wall
  const wallX = FLOOR.x0; // inner face of the left wall

  // --- Floors (textured, receive shadows only) -------------------------------
  const floorMeshes: [Rect, FloorKind, number, number][] = [
    [FLOOR, "concrete", 0, 4],
    [ZONES.director.rect, "walnut", 0.01, 3],
    [ZONES.lounge.rect, "stone", 0.008, 2.5],
    [ZONES.meeting.rect, "charcoalCarpet", 0.01, 2.5],
    [ZONES.dev.rect, "graphiteCarpet", 0.01, 2.5],
    [ZONES.qa.rect, "epoxy", 0.01, 3],
  ];
  for (const [r, kind, h, rep] of floorMeshes) {
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    const tex = floorTexture(kind, [w / rep, d / rep]);
    tex.anisotropy = anisotropy;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: kind === "walnut" ? 0.5 : kind === "epoxy" || kind === "concrete" ? 0.62 : 0.92, metalness: kind === "epoxy" ? 0.08 : 0 });
    const geo = new THREE.PlaneGeometry(w, d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((r.x0 + r.x1) / 2, h, (r.z0 + r.z1) / 2);
    mesh.receiveShadow = true;
    root.add(mesh);
    disposables.push(tex, mat, geo);
    if (r !== FLOOR) floorInlay(b, r);
  }
  S.box(FLOOR.x1 - FLOOR.x0 + 0.4, 0.5, FLOOR.z1 - FLOOR.z0 + 0.4, "#0e0f14", 0, -0.26, 0);
  // Corridor guide lines (recessed, electric blue, low intensity).
  b.glow.box(FLOOR.x1 - FLOOR.x0 - 1.2, 0.004, 0.035, "#1f4fae", 0, 0.004, -2.2 + 0.62);
  b.glow.box(FLOOR.x1 - FLOOR.x0 - 1.2, 0.004, 0.035, "#1f4fae", 0, 0.004, -2.2 - 0.62);
  b.glow.box(0.035, 0.004, 10.4, "#1f4fae", 2.2, 0.004, 4.1);

  // --- Building shell --------------------------------------------------------
  const wallH = 4.4;
  S.box(FLOOR.x1 - FLOOR.x0 + 0.3, wallH, 0.3, C.wall, 0, wallH / 2, wallZ - 0.15);
  S.box(0.3, wallH, FLOOR.z1 - FLOOR.z0, C.wall, wallX - 0.15, wallH / 2, 0);
  S.box(FLOOR.x1 - FLOOR.x0 + 0.5, 0.1, 0.44, "#0f1116", 0, wallH + 0.05, wallZ - 0.15);
  S.box(0.44, 0.1, FLOOR.z1 - FLOOR.z0, "#0f1116", wallX - 0.15, wallH + 0.05, 0);
  // Recessed black skirting with an indirect electric-blue line and wash.
  S.box(FLOOR.x1 - FLOOR.x0, 0.12, 0.05, "#0b0c10", 0, 0.06, wallZ + 0.02);
  S.box(0.05, 0.12, FLOOR.z1 - FLOOR.z0, "#0b0c10", wallX + 0.02, 0.06, 0);
  b.glow.box(FLOOR.x1 - FLOOR.x0 - 0.2, 0.01, 0.01, C.blue, 0, 0.125, wallZ + 0.05);
  b.glow.box(0.01, 0.01, FLOOR.z1 - FLOOR.z0 - 0.2, C.blue, wallX + 0.05, 0.125, 0);
  lightQuad(b.light, "wash", "#1d4fbf", matrix(0, 0.5, wallZ + 0.03), FLOOR.x1 - FLOOR.x0, 0.8);
  lightQuad(b.light, "wash", "#1d4fbf", matrix(wallX + 0.03, 0.5, 0, Math.PI / 2), FLOOR.z1 - FLOOR.z0, 0.8);
  // Top cove line on the back wall (uplight feel without a ceiling).
  b.glow.box(FLOOR.x1 - FLOOR.x0 - 0.2, 0.012, 0.012, "#5aa9ff", 0, wallH - 0.08, wallZ + 0.03);
  lightQuad(b.light, "wash", "#173a80", matrix(0, wallH - 0.5, wallZ + 0.025, 0, 0, Math.PI), FLOOR.x1 - FLOOR.x0, 0.85);

  // Left wall: tall windows with a night skyline between graphite piers.
  const sky = skylineTexture();
  sky.anisotropy = anisotropy;
  const skyMat = new THREE.MeshBasicMaterial({ map: sky, toneMapped: false, color: "#aebbd8" });
  disposables.push(sky, skyMat);
  for (const [z0, z1] of [[-8.6, -3.8], [-1, 3.6], [4.6, 9.2]]) {
    const len = z1 - z0, mid = (z0 + z1) / 2;
    const g = new THREE.PlaneGeometry(len, 2.4);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, (mid + 10 + (uv.getX(i) - 0.5) * len) / 20);
    const win = new THREE.Mesh(g, skyMat);
    win.position.set(wallX + 0.02, 2.5, mid);
    win.rotation.y = Math.PI / 2;
    root.add(win);
    disposables.push(g);
    S.box(0.14, 0.08, len + 0.14, "#0f1116", wallX + 0.06, 1.28, mid);
    S.box(0.14, 0.08, len + 0.14, "#0f1116", wallX + 0.06, 3.72, mid);
    const n = Math.round(len / 1.15);
    for (let k = 0; k <= n; k++) S.box(0.1, 2.5, 0.045, "#0f1116", wallX + 0.06, 2.5, z0 + (k * len) / n);
  }

  // --- Back wall: rooms with their own finish -------------------------------
  // Director: vertical walnut slats.
  for (let k = 0; k < 62; k++) S.box(0.06, 3.9, 0.05, k % 2 ? C.walnut : "#2b1d15", -13.25 + k * 0.13, 2.15, wallZ + 0.03);
  b.glow.box(8.2, 0.01, 0.02, "#ffcf8a", -9.25, 4.14, wallZ + 0.06);
  lightQuad(b.light, "wash", "#6b4a22", matrix(-9.25, 3.75, wallZ + 0.06, 0, 0, Math.PI), 8.2, 0.9);
  // Meeting: acoustic felt panels.
  for (let c = 0; c < 4; c++) for (let r = 0; r < 2; r++) S.box(1.42, 1.72, 0.05, r ? "#222635" : "#1e2230", 7.95 + c * 1.5, 1.05 + r * 1.8, wallZ + 0.03);
  // Brand wall for PENSEI ALTO: dark recessed panel with a lower cove.
  const signX = 4.3, signY = 3.3;
  S.box(5.8, 1.9, 0.04, "#0c0e13", signX, signY, wallZ + 0.02);
  S.box(5.8, 0.03, 0.06, "#3a4152", signX, signY + 0.96, wallZ + 0.04);
  S.box(5.8, 0.03, 0.06, "#3a4152", signX, signY - 0.96, wallZ + 0.04);
  b.glow.box(5.7, 0.008, 0.012, C.cyan, signX, signY - 0.93, wallZ + 0.075);
  lightQuad(b.light, "wash", "#1c5fd6", matrix(signX, signY - 0.5, wallZ + 0.05), 5.8, 0.9);
  const sign = buildWallSign("PENSEI ALTO", 0.6, anisotropy);
  sign.group.position.set(signX, signY + 0.05, wallZ + 0.1);
  root.add(sign.group);
  disposables.push(sign);

  // --- Wall screens (live local data) ----------------------------------------
  const wallScreens: WallScreen[] = [];
  const screenSpots: [WallScreen["kind"], number, number, number][] = [["team", -9.2, 4.4, 2.95], ["queue", -1.2, 4.4, 2.95], ["meeting", 9.7, 3.6, 2.75]];
  for (const [kind, x, w, y] of screenSpots) {
    const ws = new WallScreen(kind);
    ws.texture.anisotropy = anisotropy;
    wallScreens.push(ws);
    const h = w / 2;
    S.rbox(w + 0.16, h + 0.16, 0.1, 0.03, "#07080c", x, y, wallZ + 0.1);
    S.box(w * 0.4, 0.05, 0.06, "#1a1d26", x, y - h / 2 - 0.1, wallZ + 0.12);
    const mat = new THREE.MeshBasicMaterial({ map: ws.texture, toneMapped: false });
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, wallZ + 0.152);
    root.add(mesh);
    disposables.push(mat, geo, ws);
    lightQuad(b.light, "pool", "#2a6be0", matrix(x, y, wallZ + 0.035), w + 1.4, h + 1.0);
  }
  // Meeting room video bar under the TV.
  S.rbox(0.9, 0.07, 0.08, 0.02, "#0b0c10", 9.7, 2.75 - 0.9 - 0.12, wallZ + 0.14);
  b.glow.box(0.05, 0.02, 0.005, "#6fd2ff", 9.7, 2.75 - 0.9 - 0.12, wallZ + 0.182);

  // --- Diretoria ------------------------------------------------------------------
  const dr = ZONES.director.rect;
  podWalls(b, dr, AREA_ACCENT.director, 0.5, [{ side: "front", from: -6.7, to: -5.1 }], ["back", "left"]);
  const shelf = S.child(-9.6, -9.62);
  shelf.box(3.6, 1.42, 0.42, C.walnutDark, 0, 0.71, 0);
  for (let row = 0; row < 3; row++) {
    shelf.box(3.44, 0.03, 0.38, C.walnut, 0, 0.3 + row * 0.42, 0.03);
    let x = -1.6, i = row * 5;
    while (x < 1.5) {
      const w = 0.06 + ((i * 37) % 5) * 0.018, h = 0.22 + ((i * 13) % 4) * 0.03;
      if (i % 6 !== 3) shelf.box(w, h, 0.26, C.book[i % C.book.length], x + w / 2, 0.315 + row * 0.42 + h / 2, 0.06);
      x += w + (i % 6 === 3 ? 0.42 : 0.008);
      i++;
    }
  }
  b.glow.box(3.4, 0.006, 0.01, "#ffd79a", -9.6, 1.33, -9.62 + 0.2);
  shelf.cyl(0.12, 0.12, 0.24, C.brass, 1.2, 1.54, 0.02, 12);
  shelf.ico(0.16, "#3f6b93", -1.2, 1.6, 0.02);
  executiveDesk(b, STATIONS[0]);
  for (const x of [-10.3, -8.9]) {
    const c = S.child(x, -5.55, Math.PI);
    c.rbox(0.56, 0.1, 0.52, 0.04, "#2a1c16", 0, 0.42, 0);
    c.rbox(0.56, 0.46, 0.1, 0.04, "#2a1c16", 0, 0.68, -0.24);
    for (const [lx, lz] of [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2]]) c.box(0.03, 0.38, 0.03, C.brass, lx, 0.19, lz);
  }
  S.cyl(1.75, 1.75, 0.012, C.rug, -9.4, 0.02, -6.2, 32);
  b.glow.cyl(1.77, 1.77, 0.003, "#5a4526", -9.4, 0.019, -6.2, 32);
  tallPlant(S, -12.9, -9.1, 1);
  tallPlant(S, -5.6, -8.9, 2);
  sofa(S, -13.0, -7.2, Math.PI / 2, 1.8, "#2a1c16", "#3a2a22");

  // --- Copa -------------------------------------------------------------------------
  const lr = ZONES.lounge.rect;
  const bar = S.child(-2.2, -9.5);
  bar.box(3.6, 0.9, 0.62, "#1b1e27", 0, 0.45, 0);
  bar.box(3.7, 0.05, 0.7, "#c9ccd4", 0, 0.925, 0.02);
  b.glow.box(3.5, 0.008, 0.01, C.cyan, -2.2, 0.06, -9.5 + 0.315);
  bar.rbox(0.42, 0.5, 0.36, 0.04, "#0d0e12", -1.1, 1.2, -0.04);
  b.glow.box(0.12, 0.03, 0.005, "#6fd2ff", -2.2 - 1.1, 1.3, -9.5 + 0.143);
  bar.cyl(0.05, 0.045, 0.1, C.white, -0.95, 1.0, 0.12, 10);
  bar.cyl(0.05, 0.045, 0.1, "#2b2f3a", -0.8, 1.0, 0.18, 10);
  bar.rbox(0.62, 1.5, 0.58, 0.03, "#23262f", 1.35, 0.75, 0);
  bar.box(0.5, 1.2, 0.01, "#10131a", 1.35, 0.85, 0.295);
  b.glow.box(0.01, 1.1, 0.008, "#6fd2ff", -2.2 + 1.62, 0.85, -9.5 + 0.3);
  const arcade = S.child(2.3, -8.95, -0.3);
  arcade.rbox(0.8, 1.7, 0.7, 0.03, "#15171e", 0, 0.85, 0);
  arcade.box(0.72, 0.1, 0.35, "#0b0c10", 0, 1.05, 0.3);
  arcade.box(0.6, 0.45, 0.03, "#06070a", 0, 1.42, 0.34);
  const ag = b.glow.child(2.3, -8.95, -0.3);
  ag.box(0.54, 0.38, 0.01, "#1b4fc4", 0, 1.42, 0.357);
  ag.box(0.74, 0.1, 0.01, "#9fd8ff", 0, 1.64, 0.357);
  ag.box(0.01, 1.6, 0.01, C.cyan, -0.405, 0.85, 0.3);
  ag.box(0.01, 1.6, 0.01, C.cyan, 0.405, 0.85, 0.3);
  sofa(S, -2.6, -4.6, Math.PI, 2.2);
  S.cyl(0.5, 0.5, 0.04, "#c9ccd4", -2.6, 0.42, -5.9, 24);
  S.cyl(0.05, 0.05, 0.4, "#0c0d11", -2.6, 0.2, -5.9, 8);
  S.cyl(0.06, 0.05, 0.1, C.white, -2.45, 0.49, -5.8, 10);
  S.cyl(0.4, 0.4, 0.04, "#c9ccd4", 1.3, 1.02, -6.1, 20);
  S.cyl(0.05, 0.05, 1.0, "#0c0d11", 1.3, 0.5, -6.1, 8);
  for (const [sx, sz] of [[0.75, -6.1], [1.85, -6.1], [1.3, -5.5]]) { S.cyl(0.18, 0.18, 0.06, "#2e3444", sx, 0.72, sz, 14); S.cyl(0.03, 0.03, 0.7, C.metal, sx, 0.36, sz, 6); }
  tallPlant(S, lr.x0 + 0.5, -3.8, 3);
  plant(S, 3.0, -3.7, 1.1, 1);

  // --- Sala de reunião --------------------------------------------------------------
  const mr = ZONES.meeting.rect;
  const glassH = 2.3;
  const glassRun = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(x1 - x0, z1 - z0);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    b.glass.child(cx, cz, ang).box(0.03, glassH - 0.12, len, "#9fc4ff", 0, glassH / 2 + 0.02, 0);
    const f = S.child(cx, cz, ang);
    f.box(0.07, 0.07, len, "#0f1116", 0, glassH, 0);
    f.box(0.09, 0.09, len, "#0f1116", 0, 0.05, 0);
    const n = Math.max(1, Math.round(len / 1.6));
    for (let k = 0; k <= n; k++) f.box(0.05, glassH, 0.05, "#0f1116", 0, glassH / 2, -len / 2 + (k * len) / n);
    // Frosted privacy band (reads as glass at a glance) + a thin blue line.
    b.glass.child(cx, cz, ang).box(0.035, 0.22, len, "#dfe8ff", 0, 1.05, 0);
    b.glow.child(cx, cz, ang).box(0.012, 0.012, len, ZONES.meeting.accent, 0, glassH - 0.05, 0);
  };
  glassRun(mr.x0, mr.z0, mr.x0, mr.z1);
  glassRun(5.8, mr.z1, mr.x1, mr.z1);
  glassRun(mr.x1, mr.z1, mr.x1, mr.z0);
  S.box(1.8, 0.07, 0.07, "#0f1116", 4.9, glassH, mr.z1);
  const T = MEETING_TABLE;
  S.rbox(T.w, 0.07, T.d, 0.03, "#20232c", T.x, 0.7, T.z);
  S.rbox(T.w - 0.3, 0.004, T.d - 0.3, 0.002, "#2b303d", T.x, 0.737, T.z);
  b.glow.box(T.w - 0.6, 0.004, 0.012, C.cyan, T.x, 0.74, T.z);
  S.box(0.1, 0.66, 0.9, "#0f1116", T.x - 1.4, 0.33, T.z);
  S.box(0.1, 0.66, 0.9, "#0f1116", T.x + 1.4, 0.33, T.z);
  for (let i = 0; i < 3; i++) { S.box(0.24, 0.015, 0.18, C.white, T.x - 1.3 + i * 1.3, 0.742, T.z + 0.55); S.cyl(0.035, 0.03, 0.09, "#2b2f3a", T.x - 1.0 + i * 1.3, 0.78, T.z - 0.55, 8); }
  for (const spot of MEETING_SPOTS.filter(s => s.seated)) {
    const c = S.child(spot.x, spot.z, spot.facing);
    c.cyl(0.24, 0.24, 0.03, "#0f1116", 0, 0.04, 0, 5);
    c.cyl(0.035, 0.035, 0.3, C.metal, 0, 0.2, 0, 6);
    c.rbox(0.5, 0.08, 0.48, 0.03, "#262b39", 0, 0.37, -0.02);
    c.rbox(0.48, 0.5, 0.07, 0.03, "#262b39", 0, 0.7, -0.28);
  }
  S.box(3.0, 0.62, 0.45, "#15171e", 9.7, 0.31, wallZ + 0.3);
  S.box(3.0, 0.02, 0.47, "#3a4152", 9.7, 0.63, wallZ + 0.3);
  tallPlant(S, mr.x1 - 0.5, mr.z0 + 0.5, 4);
  tallPlant(S, mr.x0 + 0.5, mr.z0 + 0.5, 5);

  // --- Desenvolvimento (creative studio) ---------------------------------------------
  const dv = ZONES.dev.rect;
  podWalls(b, dv, AREA_ACCENT.dev, 1.25, [{ side: "back", from: -0.6, to: 0.8 }]);
  storyboard(b, -9.4, dv.z0, 3.0);
  diagramBoard(b, -4.2, dv.z0, 2.4);
  for (const [cx, cz] of DEV_CLUSTERS) {
    S.box(3.5, 0.36, 0.04, "#151820", cx, 0.89, cz);
    S.box(3.5, 0.02, 0.05, "#3a4152", cx, 1.075, cz);
  }
  const rack = S.child(-12.8, 8.5);
  rack.rbox(0.8, 2, 0.8, 0.02, "#0d0e12", 0, 1, 0);
  for (let i = 0; i < 7; i++) {
    rack.box(0.7, 0.2, 0.02, "#171a22", 0, 0.35 + i * 0.24, 0.405);
    b.glow.box(0.03, 0.02, 0.005, "#39c6ff", -12.8 + 0.25, 0.35 + i * 0.24, 8.5 + 0.418);
  }
  b.glow.box(0.01, 1.9, 0.01, "#1f4fae", -12.8 + 0.41, 1.0, 8.5 + 0.41);
  // Pairing corner: two lounge chairs and a low table.
  for (const [x, z, ry] of [[-1.5, 8.2, 0.5], [0.3, 7.7, -0.7]] as const) {
    const c = S.child(x, z, ry);
    c.rbox(0.72, 0.3, 0.7, 0.1, "#262b3a", 0, 0.2, 0);
    c.rbox(0.72, 0.42, 0.16, 0.08, "#262b3a", 0, 0.48, -0.28);
  }
  S.cyl(0.35, 0.35, 0.03, "#c9ccd4", -0.6, 0.32, 8.5, 20);
  S.cyl(0.04, 0.04, 0.3, "#0c0d11", -0.6, 0.15, 8.5, 8);
  tallPlant(S, dv.x0 + 0.5, dv.z0 + 0.6, 6);
  tallPlant(S, dv.x1 - 0.5, dv.z1 - 0.5, 7);
  plant(S, -6.1, 8.8, 1.2, 2);

  // --- QA & Revisão (test lab) --------------------------------------------------------
  const qr = ZONES.qa.rect;
  podWalls(b, qr, AREA_ACCENT.qa, 1.25, [{ side: "back", from: 3.4, to: 4.8 }]);
  deviceWall(b, 8.3, qr.z0, 2.8);
  S.box(3.5, 0.36, 0.04, "#151820", QA_CLUSTER[0], 0.89, QA_CLUSTER[1]);
  S.box(3.5, 0.02, 0.05, "#3a4152", QA_CLUSTER[0], 1.075, QA_CLUSTER[1]);
  S.box(1.6, 0.36, 0.04, "#151820", QA_PAIR[0], 0.89, QA_PAIR[1]);
  S.box(1.6, 0.02, 0.05, "#3a4152", QA_PAIR[0], 1.075, QA_PAIR[1]);
  // Device test bench (phones/tablets on stands, lock screens only).
  const bench = S.child(10.4, 8.3);
  bench.rbox(3.2, 0.05, 0.9, 0.015, "#c3c8d2", 0, 0.7, 0);
  for (const x of [-1.45, 1.45]) { bench.box(0.07, 0.66, 0.07, W.frame, x, 0.34, 0); bench.box(0.08, 0.03, 0.8, W.frame, x, 0.015, 0); }
  const benchBase = matrix(10.4, 0, 8.3, 0);
  [[-1.1, 0.16, 0.3], [-0.6, 0.18, 0.34], [0, 0.34, 0.24], [0.6, 0.16, 0.3], [1.1, 0.18, 0.34]].forEach(([x, w, h], i) => {
    bench.rbox(w + 0.03, h + 0.03, 0.02, 0.012, W.bezel, x, 0.73 + (h + 0.03) / 2 + 0.02, -0.15, 0);
    bench.box(0.08, 0.04, 0.08, W.frameLight, x, 0.745, -0.13);
    deviceQuad(b.screens, benchBase, i % 2 ? SCREEN_CELL.wallpaper : SCREEN_CELL.lock, w, h, x, 0.73 + (h + 0.03) / 2 + 0.02, -0.138);
  });
  lightQuad(b.light, "pool", AREA_ACCENT.qa, matrix(10.4, 0.735, 8.2, 0, -Math.PI / 2), 3.2, 1.0);
  tallPlant(S, qr.x1 - 0.5, qr.z0 + 0.6, 8);
  plant(S, qr.x0 + 0.6, qr.z1 - 0.6, 1.2, 3);
  plant(S, 6.4, 8.6, 1, 4);

  for (const [x, z] of [[-12.8, -2.2], [13.3, -2.2], [2.2, 9.3]]) plant(S, x, z, 1.1, Math.round(x));

  // Soft light pools under each desk cluster (screen bounce, area colour).
  for (const [cx, cz] of DEV_CLUSTERS) lightQuad(b.light, "pool", "#1b6f9a", matrix(cx, 0.02, cz, 0, -Math.PI / 2), 6.2, 5.4);
  lightQuad(b.light, "pool", "#23449e", matrix(QA_CLUSTER[0], 0.02, QA_CLUSTER[1], 0, -Math.PI / 2), 6.2, 5.4);
  lightQuad(b.light, "pool", "#23449e", matrix(QA_PAIR[0], 0.02, QA_PAIR[1], 0, -Math.PI / 2), 3.4, 5.4);
  lightQuad(b.light, "pool", "#5c3f1c", matrix(-9.4, 0.025, -6.4, 0, -Math.PI / 2), 5.4, 4.2);
  lightQuad(b.light, "pool", "#2c3576", matrix(T.x, 0.02, T.z, 0, -Math.PI / 2), 6.8, 4.4);

  // --- Stations (all 16, occupied or free) ------------------------------------------
  STATIONS.forEach((st, i) => { if (st.kind === "desk") desk(b, st, i); });

  // --- Build materials -----------------------------------------------------------------
  const solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.06 });
  const solidGeo = solidBatch.build()!;
  const solid = new THREE.Mesh(solidGeo, solidMat);
  solid.castShadow = true;
  solid.receiveShadow = true;
  solid.name = "static-solid";
  root.add(solid);
  const glowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const glowGeo = glowBatch.build()!;
  root.add(new THREE.Mesh(glowGeo, glowMaterial));
  const glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.14, roughness: 0.08, metalness: 0.4, depthWrite: false });
  const glassGeo = glassBatch.build()!;
  const glass = new THREE.Mesh(glassGeo, glassMat);
  glass.renderOrder = 2;
  root.add(glass);
  const atlas = monitorAtlas();
  atlas.texture.anisotropy = anisotropy;
  const screenMaterial = new THREE.MeshBasicMaterial({ map: atlas.texture, toneMapped: false, color: "#ffffff" });
  const screenGeo = b.screens.build()!;
  root.add(new THREE.Mesh(screenGeo, screenMaterial));
  // Indirect light: one additive mesh for every wash/pool (no real lights added).
  const lightTex = glowAtlas();
  const lightMat = new THREE.MeshBasicMaterial({ map: lightTex, vertexColors: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const lightGeo = b.light.build()!;
  const lights = new THREE.Mesh(lightGeo, lightMat);
  lights.renderOrder = 1;
  root.add(lights);
  disposables.push(solidMat, solidGeo, glowMaterial, glowGeo, glassMat, glassGeo, atlas.texture, screenMaterial, screenGeo, lightTex, lightMat, lightGeo);

  // Soft contact shadows under furniture clusters (cheap and shadow-map independent).
  const blobTex = radialTexture("rgba(3,4,8,0.6)");
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false });
  const blobGeo = new THREE.PlaneGeometry(1, 1);
  disposables.push(blobTex, blobMat, blobGeo);
  const blob = (x: number, z: number, w: number, d: number, y = 0.03) => {
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
  blob(STATIONS[1].x, STATIONS[1].z - 0.7, 2.4, 2.0);
  blob(T.x, T.z, 6.4, 3.8);

  // --- Station hit areas and "free desk" markers --------------------------------------
  const hitGeo = new THREE.BoxGeometry(1.9, 1.5, 1.9);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  disposables.push(hitGeo, hitMat);
  const stationHits: THREE.Mesh[] = [];
  const freeMarkers = new Map<string, THREE.Object3D>();
  const markerGeo = new THREE.RingGeometry(0.34, 0.4, 36);
  const plusGeo = new THREE.PlaneGeometry(0.3, 0.05);
  const markerMat = new THREE.MeshBasicMaterial({ color: "#6fb8ff", transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
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
  inbox.position.set(st0.x - 0.95, 0.775, st0.z + 0.62);
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.3), new THREE.MeshStandardMaterial({ color: C.brass, roughness: 0.35, metalness: 0.6 }));
  tray.castShadow = true;
  inbox.add(tray);
  root.add(inbox);

  return {
    root, stationHits, wallScreens, inbox, screenMaterial, glowMaterial, freeMarkers,
    refreshFonts: () => atlas.redraw(),
    dispose: () => {
      for (const d of disposables) d.dispose();
      inbox.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
    },
  };
}
