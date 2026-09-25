import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GeometryBatch, Placer, matrix } from "./batch";
import { MONITOR_CELLS, SCREEN_CELL, GLOW_UV } from "./textures";
import type { Station, WorkZoneId } from "@/lib/office/types";

// Workstations are generated from Station data (lib/office/layout.ts): every desk,
// occupied or free, gets either two 24" monitors on a dual arm or one curved 34"
// ultrawide. Everything is merged into the shared batches, so the 16 stations add
// no draw calls. Local frame: the seated worker is at the origin facing +Z.

export type Batches = { solid: Placer; glow: Placer; glass: Placer; screens: GeometryBatch; light: GeometryBatch };

export const W = {
  frame: "#16181f", frameLight: "#3a4152", deskDark: "#262a34", deskEdge: "#5d6782", deskLab: "#c3c8d2", deskLabEdge: "#8b93a8",
  bezel: "#0c0e13", housing: "#1b1e27", mat: "#11131a", keycap: "#343a4a", keyboard: "#191c24", chair: "#15171e", chairPad: "#232733",
};

/** Accent per area: electric blue/cyan family, warm brass for the executive area. */
export const AREA_ACCENT: Record<WorkZoneId, string> = { director: "#e0b36a", dev: "#35d0ff", qa: "#5b8cff" };

// --- geometry helpers ---------------------------------------------------------

/** Bends a geometry built around z = 0 into an arc of radius R whose centre is at +z (the viewer). */
function bend(g: THREE.BufferGeometry, R: number) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const a = x / R, rr = R - z;
    pos.setXYZ(i, rr * Math.sin(a), pos.getY(i), R - rr * Math.cos(a));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Rewrites plane UVs to a sub-rectangle of a monitor atlas cell (crop keeps the aspect honest). */
function cellUv(g: THREE.BufferGeometry, cell: number, vCrop = 1) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const col = cell % MONITOR_CELLS.cols, row = Math.floor(cell / MONITOR_CELLS.cols) % MONITOR_CELLS.rows;
  const v0 = (1 - vCrop) / 2;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (col + uv.getX(i)) / MONITOR_CELLS.cols, 1 - (row + 1) / MONITOR_CELLS.rows + (v0 + uv.getY(i) * vCrop) / MONITOR_CELLS.rows);
  }
  return g;
}

/** A quad in the soft-light batch, mapped to one region of glowAtlas(). */
export function lightQuad(batch: GeometryBatch, region: keyof typeof GLOW_UV, color: THREE.ColorRepresentation, m: THREE.Matrix4, w: number, h: number) {
  const g = new THREE.PlaneGeometry(w, h);
  const [u0, v0, u1, v1] = GLOW_UV[region];
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  batch.add(g, color, m);
}

// --- monitors -------------------------------------------------------------------

/** Curved 34" ultrawide (21:9). Monitor frame: screen faces +z, origin = screen centre, deskY = desk top (local). */
function ultrawide(b: Batches, base: THREE.Matrix4, deskY: number, cell: number, accent: string) {
  const Wd = 1.02, H = 0.42, R = 1.15, seg = 24;
  const solid = Placer.fromMatrix(b.solid.batch, base);
  // Curved front bezel and back shell, bent on the same radius as the panel.
  solid.at(bend(new THREE.BoxGeometry(Wd + 0.035, H + 0.035, 0.02, seg, 1, 1).translate(0, 0, -0.01), R), W.bezel, 0, 0, 0);
  solid.at(bend(new THREE.BoxGeometry(Wd - 0.04, H - 0.04, 0.03, seg, 1, 1).translate(0, 0, -0.035), R), W.housing, 0, 0, 0);
  solid.rbox(0.36, 0.2, 0.06, 0.02, W.housing, 0, -0.02, -0.07);
  // Stand: slim neck and a wide, low foot on the desk.
  const neckTop = -0.04;
  solid.box(0.07, neckTop - deskY, 0.035, W.frameLight, 0, (neckTop + deskY) / 2, -0.1);
  solid.rbox(0.42, 0.018, 0.19, 0.008, W.frameLight, 0, deskY + 0.009, -0.06);
  // Screen bar on the top edge (emissive underside only, no real light).
  solid.rbox(0.42, 0.028, 0.05, 0.01, W.housing, 0, H / 2 + 0.045, -0.005);
  b.glow.batch.add(new THREE.BoxGeometry(0.38, 0.005, 0.016), "#cfe0ff", base.clone().multiply(matrix(0, H / 2 + 0.03, 0.012)));
  b.glow.batch.add(new THREE.BoxGeometry(0.3, 0.008, 0.01), accent, base.clone().multiply(matrix(0, -0.13, -0.101)));
  // Panel.
  b.screens.add(cellUv(bend(new THREE.PlaneGeometry(Wd, H, seg, 1).translate(0, 0, 0.003), R), cell, 0.72), "#ffffff", base);
}

/** Two 24" (16:9) monitors angled inwards on a dual arm clamped to the back edge. */
function dualMonitors(b: Batches, base: THREE.Matrix4, deskY: number, cells: [number, number], accent: string) {
  const Wd = 0.6, H = 0.35, ang = 0.24;
  const cx = 0.012 + (Wd / 2) * Math.cos(ang), cz = (Wd / 2) * Math.sin(ang);
  const solid = Placer.fromMatrix(b.solid.batch, base);
  const postZ = -0.14, postTop = 0.03;
  solid.cyl(0.02, 0.02, postTop - deskY, W.frameLight, 0, (postTop + deskY) / 2, postZ, 10);
  solid.box(0.08, 0.03, 0.05, W.frame, 0, deskY + 0.015, postZ);
  solid.box(2 * cx - 0.06, 0.028, 0.028, W.frameLight, 0, 0, postZ + 0.01);
  b.glow.batch.add(new THREE.BoxGeometry(0.3, 0.005, 0.005), accent, base.clone().multiply(matrix(0, 0.016, postZ + 0.026)));
  ([-1, 1] as const).forEach((side, i) => {
    const m = base.clone().multiply(matrix(side * cx, 0, cz, side * -ang));
    const mon = Placer.fromMatrix(b.solid.batch, m);
    mon.at(new RoundedBoxGeometry(Wd + 0.024, H + 0.024, 0.022, 2, 0.008), W.bezel, 0, 0, -0.011);
    mon.rbox(Wd * 0.7, H * 0.7, 0.03, 0.01, W.housing, 0, 0, -0.035);
    mon.box(0.1, 0.1, 0.03, W.frame, 0, 0, -0.06);
    // Elbow from the crossbar end to the VESA plate.
    const z0 = postZ + 0.01, z1 = cz - 0.06;
    solid.box(0.035, 0.035, z1 - z0, W.frameLight, side * cx * 0.92, 0, (z0 + z1) / 2);
    b.screens.add(cellUv(new THREE.PlaneGeometry(Wd, H), cells[i]), "#ffffff", m.clone().multiply(matrix(0, 0, 0.002)));
  });
}

// --- desks ----------------------------------------------------------------------

export function officeChair(p: Placer, accent: string) {
  // Ergonomic gaming chair: five-star base, contoured seat, tall back with headrest.
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    p.at(new THREE.BoxGeometry(0.05, 0.035, 0.28), W.frame, Math.sin(a) * 0.13, 0.05, Math.cos(a) * 0.13, a);
    p.cyl(0.03, 0.03, 0.04, "#0b0c10", Math.sin(a) * 0.27, 0.02, Math.cos(a) * 0.27, 8);
  }
  p.cyl(0.035, 0.04, 0.28, W.frameLight, 0, 0.2, 0, 8);
  p.rbox(0.54, 0.09, 0.5, 0.04, W.chair, 0, 0.37, -0.02);
  p.rbox(0.44, 0.03, 0.4, 0.015, W.chairPad, 0, 0.418, -0.02);
  p.rbox(0.07, 0.07, 0.46, 0.03, accent, -0.24, 0.41, -0.02);
  p.rbox(0.07, 0.07, 0.46, 0.03, accent, 0.24, 0.41, -0.02);
  p.rbox(0.52, 0.66, 0.09, 0.05, W.chair, 0, 0.8, -0.33);
  p.rbox(0.06, 0.6, 0.02, 0.01, accent, -0.2, 0.8, -0.28);
  p.rbox(0.06, 0.6, 0.02, 0.01, accent, 0.2, 0.8, -0.28);
  p.rbox(0.34, 0.16, 0.08, 0.04, W.chair, 0, 1.2, -0.34);
  for (const x of [-0.29, 0.29]) {
    p.box(0.035, 0.2, 0.035, W.frameLight, x, 0.5, -0.05);
    p.rbox(0.07, 0.035, 0.26, 0.015, W.chair, x, 0.61, -0.04);
  }
}

/** Common desk: steel frame, graphite top (light lab top in QA), mat, peripherals, tower, cable spine. */
export function desk(b: Batches, st: Station, index: number) {
  const p = b.solid.child(st.x, st.z, st.facing);
  const base = matrix(st.x, 0, st.z, st.facing);
  const accent = AREA_ACCENT[st.zone];
  const lab = st.zone === "qa";
  const topY = 0.71;
  p.rbox(1.7, 0.045, 0.9, 0.015, lab ? W.deskLab : W.deskDark, 0, topY - 0.0225, 0.72);
  p.box(1.66, 0.012, 0.018, lab ? W.deskLabEdge : W.deskEdge, 0, topY - 0.02, 0.27);
  // Height-adjustable steel frame: two columns, feet and a crossbar.
  for (const x of [-0.7, 0.7]) {
    p.box(0.07, 0.62, 0.07, W.frame, x, 0.34, 0.74);
    p.box(0.08, 0.03, 0.74, W.frame, x, 0.015, 0.74);
    p.box(0.06, 0.04, 0.62, W.frame, x, topY - 0.07, 0.74);
  }
  p.box(1.34, 0.05, 0.05, W.frame, 0, topY - 0.08, 0.95);
  // Cable tray under the top and a cable spine to the floor.
  p.box(1.1, 0.06, 0.12, W.frame, 0, topY - 0.12, 1.02);
  p.box(0.05, topY - 0.2, 0.05, W.frame, 0.6, (topY - 0.2) / 2, 1.1);
  // Desk mat, keyboard, mouse.
  p.rbox(1.02, 0.006, 0.38, 0.003, W.mat, 0.05, topY + 0.003, 0.52);
  p.box(1.0, 0.002, 0.01, accent, 0.05, topY + 0.0065, 0.33);
  p.rbox(0.46, 0.024, 0.15, 0.008, W.keyboard, -0.05, topY + 0.018, 0.5);
  p.box(0.43, 0.012, 0.12, W.keycap, -0.05, topY + 0.034, 0.5);
  p.rbox(0.065, 0.032, 0.105, 0.02, W.keyboard, 0.33, topY + 0.02, 0.52);
  // Compact tower under the right side, with a subtle front light line.
  p.rbox(0.22, 0.46, 0.44, 0.015, "#101217", 0.47, 0.25, 0.82);
  b.glow.child(st.x, st.z, st.facing).box(0.006, 0.34, 0.004, accent, 0.4, 0.26, 0.597);
  // Soft glow of the screens on the desk top (fake bounce light).
  lightQuad(b.light, "pool", accent, base.clone().multiply(matrix(0, topY + 0.008, 0.72, 0, -Math.PI / 2)), 1.4, 0.8);
  // Monitors, placed at the back of the desk (z ≈ 1.0), facing the worker.
  const screenY = 1.02;
  const mBase = base.clone().multiply(matrix(0, screenY, 1.0, Math.PI));
  if (st.monitors === "ultrawide") ultrawide(b, mBase, topY - screenY, [SCREEN_CELL.editor, SCREEN_CELL.design, SCREEN_CELL.review, SCREEN_CELL.editorAlt][index % 4], accent);
  else dualMonitors(b, mBase.clone().multiply(matrix(0, -0.02, 0)), topY - screenY + 0.02, [[SCREEN_CELL.editor, SCREEN_CELL.docs], [SCREEN_CELL.editorAlt, SCREEN_CELL.terminal], [SCREEN_CELL.review, SCREEN_CELL.wallpaper], [SCREEN_CELL.design, SCREEN_CELL.editor]][index % 4] as [number, number], accent);
  // One personal item per desk, kept small and to the side.
  const kind = index % 3;
  if (kind === 0) p.cyl(0.04, 0.036, 0.1, "#dfe4ee", -0.68, topY + 0.05, 0.42, 10);
  if (kind === 1) { p.rbox(0.16, 0.02, 0.22, 0.005, "#2b3142", -0.64, topY + 0.01, 0.5); p.rbox(0.14, 0.012, 0.2, 0.004, "#e8ecf4", -0.64, topY + 0.026, 0.5); }
  if (kind === 2) { p.cyl(0.07, 0.06, 0.1, "#2c3140", -0.68, topY + 0.05, 0.9, 10); p.ico(0.1, "#3f9b6b", -0.68, topY + 0.16, 0.9, 1.2); }
  officeChair(p, accent);
}

/** Executive desk: dark walnut with brass details and a curved ultrawide. */
export function executiveDesk(b: Batches, st: Station) {
  const p = b.solid.child(st.x, st.z, st.facing);
  const base = matrix(st.x, 0, st.z, st.facing);
  const gp = b.glow.child(st.x, st.z, st.facing);
  const topY = 0.76;
  p.rbox(2.5, 0.07, 1.1, 0.025, "#3a2619", 0, topY - 0.035, 0.78);
  p.box(2.44, 0.014, 0.02, "#c9a25a", 0, topY - 0.03, 0.23);
  p.rbox(0.6, topY - 0.08, 1.0, 0.03, "#23170f", -0.9, (topY - 0.08) / 2, 0.78);
  p.rbox(0.6, topY - 0.08, 1.0, 0.03, "#23170f", 0.9, (topY - 0.08) / 2, 0.78);
  p.box(1.2, 0.42, 0.04, "#23170f", 0, 0.5, 1.28);
  gp.box(2.3, 0.012, 0.02, AREA_ACCENT.director, 0, 0.07, 1.33);
  p.rbox(1.2, 0.006, 0.42, 0.003, "#15100c", 0, topY + 0.003, 0.52);
  p.rbox(0.46, 0.022, 0.15, 0.008, W.keyboard, -0.05, topY + 0.016, 0.5);
  p.box(0.43, 0.01, 0.12, W.keycap, -0.05, topY + 0.031, 0.5);
  p.rbox(0.065, 0.03, 0.1, 0.02, W.keyboard, 0.33, topY + 0.02, 0.52);
  lightQuad(b.light, "pool", "#ffd79a", base.clone().multiply(matrix(0, topY + 0.008, 0.75, 0, -Math.PI / 2)), 1.8, 0.9);
  const screenY = 1.09;
  ultrawide(b, base.clone().multiply(matrix(0, screenY, 1.08, Math.PI)), topY - screenY, SCREEN_CELL.lock, AREA_ACCENT.director);
  // Brass desk lamp (warm, low) and name plate.
  p.cyl(0.09, 0.11, 0.025, "#c9a25a", 1.02, topY + 0.012, 0.98, 12);
  p.box(0.022, 0.4, 0.022, "#c9a25a", 1.02, topY + 0.2, 0.98);
  p.rbox(0.26, 0.08, 0.14, 0.03, "#1b2a22", 0.95, topY + 0.41, 0.95);
  gp.box(0.2, 0.008, 0.09, "#ffe0ae", 0.95, topY + 0.366, 0.95);
  lightQuad(b.light, "pool", "#ffcf8a", base.clone().multiply(matrix(0.95, topY + 0.01, 0.95, 0, -Math.PI / 2)), 0.7, 0.7);
  p.box(0.36, 0.08, 0.05, "#c9a25a", -0.7, topY + 0.04, 0.33);
  // Executive chair (leather, high back).
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    p.at(new THREE.BoxGeometry(0.05, 0.035, 0.3), "#b08a4a", Math.sin(a) * 0.14, 0.05, Math.cos(a) * 0.14, a);
  }
  p.cyl(0.04, 0.045, 0.3, "#b08a4a", 0, 0.2, 0, 8);
  p.rbox(0.62, 0.1, 0.56, 0.04, "#2a1c16", 0, 0.38, -0.02);
  p.rbox(0.6, 0.86, 0.12, 0.05, "#2a1c16", 0, 0.86, -0.33);
  p.rbox(0.08, 0.2, 0.44, 0.03, "#2a1c16", -0.33, 0.52, 0);
  p.rbox(0.08, 0.2, 0.44, 0.03, "#2a1c16", 0.33, 0.52, 0);
}
