import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/**
 * Collects many small, vertex-coloured primitives and merges them into one
 * geometry. Static furniture ends up as a handful of draw calls instead of
 * hundreds, which matters most on integrated GPUs.
 */
export class GeometryBatch {
  private parts: THREE.BufferGeometry[] = [];
  private tmpColor = new THREE.Color();
  constructor(private keepUv = false) {}

  get size() { return this.parts.length; }

  add(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, matrix: THREE.Matrix4) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (g !== geometry) geometry.dispose();
    g.applyMatrix4(matrix);
    if (!this.keepUv) g.deleteAttribute("uv");
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) g.deleteAttribute(name);
    const count = g.attributes.position.count;
    if (!g.attributes.color) {
      const c = this.tmpColor.set(color);
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    }
    this.parts.push(g);
    return g;
  }

  build(): THREE.BufferGeometry | null {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  }
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const v = new THREE.Vector3();
const s = new THREE.Vector3();

export function matrix(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return m4.compose(v.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s.set(sx, sy, sz)).clone();
}

/** A tiny scene-graph helper: positions are local to (ox, oz, ry). */
export class Placer {
  private base: THREE.Matrix4;
  constructor(public batch: GeometryBatch, ox = 0, oy = 0, oz = 0, ry = 0) {
    this.base = matrix(ox, oy, oz, ry);
  }
  at(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    return this.batch.add(g, color, this.base.clone().multiply(matrix(x, y, z, ry, rx, rz)));
  }
  box(w: number, h: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, ry = 0) {
    return this.at(new THREE.BoxGeometry(w, h, d), color, x, y, z, ry);
  }
  rbox(w: number, h: number, d: number, r: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, ry = 0, rx = 0) {
    return this.at(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), color, x, y, z, ry, rx);
  }
  cyl(rTop: number, rBottom: number, h: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, seg = 12, rx = 0, rz = 0) {
    return this.at(new THREE.CylinderGeometry(rTop, rBottom, h, seg), color, x, y, z, 0, rx, rz);
  }
  ico(r: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, sy = 1) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1, sy, 1);
    return this.at(g, color, x, y, z);
  }
  child(ox: number, oz: number, ry = 0, oy = 0) {
    const p = new Placer(this.batch);
    p.base = this.base.clone().multiply(matrix(ox, oy, oz, ry));
    return p;
  }
}
