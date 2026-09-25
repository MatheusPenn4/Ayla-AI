import * as THREE from "three";

// "PENSEI ALTO" wall lettering. The glyphs are original geometric outlines
// (chamfered tech sans) drawn for this project: no font file or logo asset.
// Units: cap height = 1. Each glyph = outer contour + optional holes.

type Glyph = { w: number; outer: [number, number][]; holes?: [number, number][][] };

const GLYPHS: Record<string, Glyph> = {
  P: { w: 0.72, outer: [[0, 0], [0.2, 0], [0.2, 0.38], [0.6, 0.38], [0.72, 0.5], [0.72, 0.88], [0.6, 1], [0, 1]], holes: [[[0.2, 0.56], [0.5, 0.56], [0.52, 0.58], [0.52, 0.8], [0.5, 0.82], [0.2, 0.82]]] },
  E: { w: 0.66, outer: [[0, 0], [0.66, 0], [0.66, 0.18], [0.2, 0.18], [0.2, 0.41], [0.56, 0.41], [0.56, 0.59], [0.2, 0.59], [0.2, 0.82], [0.66, 0.82], [0.66, 1], [0, 1]] },
  N: { w: 0.74, outer: [[0, 0], [0.2, 0], [0.2, 0.6], [0.54, 0], [0.74, 0], [0.74, 1], [0.54, 1], [0.54, 0.4], [0.2, 1], [0, 1]] },
  S: { w: 0.72, outer: [[0.12, 0], [0.6, 0], [0.72, 0.12], [0.72, 0.47], [0.6, 0.59], [0.2, 0.59], [0.2, 0.82], [0.72, 0.82], [0.72, 1], [0.12, 1], [0, 0.88], [0, 0.53], [0.12, 0.41], [0.52, 0.41], [0.52, 0.18], [0, 0.18], [0, 0.12]] },
  I: { w: 0.2, outer: [[0, 0], [0.2, 0], [0.2, 1], [0, 1]] },
  A: { w: 0.74, outer: [[0, 0], [0.2, 0], [0.2, 0.34], [0.54, 0.34], [0.54, 0], [0.74, 0], [0.74, 0.8], [0.54, 1], [0.2, 1], [0, 0.8]], holes: [[[0.2, 0.52], [0.54, 0.52], [0.54, 0.74], [0.46, 0.82], [0.28, 0.82], [0.2, 0.74]]] },
  L: { w: 0.64, outer: [[0, 0], [0.64, 0], [0.64, 0.18], [0.2, 0.18], [0.2, 1], [0, 1]] },
  T: { w: 0.74, outer: [[0.27, 0], [0.47, 0], [0.47, 0.82], [0.74, 0.82], [0.74, 1], [0, 1], [0, 0.82], [0.27, 0.82]] },
  O: { w: 0.74, outer: [[0.14, 0], [0.6, 0], [0.74, 0.14], [0.74, 0.86], [0.6, 1], [0.14, 1], [0, 0.86], [0, 0.14]], holes: [[[0.27, 0.18], [0.47, 0.18], [0.54, 0.25], [0.54, 0.75], [0.47, 0.82], [0.27, 0.82], [0.2, 0.75], [0.2, 0.25]]] },
};
const TRACKING = 0.15;
const SPACE = 0.42;

/** Glyph layout for a string, in cap-height units, centred on x = 0. */
function layout(text: string) {
  const items: { g: Glyph; x: number }[] = [];
  let x = 0;
  for (const ch of text) {
    if (ch === " ") { x += SPACE - TRACKING; continue; }
    const g = GLYPHS[ch];
    items.push({ g, x });
    x += g.w + TRACKING;
  }
  const width = x - TRACKING;
  return { items: items.map(i => ({ ...i, x: i.x - width / 2 })), width };
}

export type WallSign = { group: THREE.Group; width: number; dispose: () => void };

/**
 * Extruded brushed-metal letters with a soft back-lit halo.
 * @param capHeight letter height in metres
 */
export function buildWallSign(text: string, capHeight: number, anisotropy: number): WallSign {
  const { items, width } = layout(text);
  const shapes: THREE.Shape[] = [];
  for (const { g, x } of items) {
    const shape = new THREE.Shape(g.outer.map(([px, py]) => new THREE.Vector2(x + px, py - 0.5)));
    for (const hole of g.holes ?? []) shape.holes.push(new THREE.Path(hole.map(([px, py]) => new THREE.Vector2(x + px, py - 0.5))));
    shapes.push(shape);
  }
  const depth = 0.12;
  const geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.018, bevelSegments: 1, curveSegments: 1 });
  geo.scale(capHeight, capHeight, capHeight);
  geo.computeVertexNormals();
  // Group 0 = front/back caps, group 1 = sides (see ExtrudeGeometry).
  const face = new THREE.MeshStandardMaterial({ color: "#dfe6f2", metalness: 0.55, roughness: 0.3, emissive: "#1b2a44", emissiveIntensity: 0.55 });
  const side = new THREE.MeshStandardMaterial({ color: "#2b3446", metalness: 0.65, roughness: 0.42 });
  const letters = new THREE.Mesh(geo, [face, side]);
  letters.name = "wall-sign";

  // Halo: the same outlines blurred in electric blue, drawn on the wall behind.
  const pxPerUnit = 110, pad = 0.9;
  const cw = Math.ceil((width + pad * 2) * pxPerUnit), chh = Math.ceil((1 + pad * 2) * pxPerUnit);
  const canvas = document.createElement("canvas");
  canvas.width = cw; canvas.height = chh;
  const ctx = canvas.getContext("2d")!;
  const toPx = (px: number, py: number): [number, number] => [(px + width / 2 + pad) * pxPerUnit, (1 + pad - py) * pxPerUnit];
  ctx.fillStyle = "rgba(60,150,255,0.9)";
  ctx.shadowColor = "rgba(50,140,255,1)";
  ctx.shadowBlur = 38;
  for (const { g, x } of items) {
    ctx.beginPath();
    g.outer.forEach(([px, py], i) => { const [cx, cy] = toPx(x + px, py); if (i) ctx.lineTo(cx, cy); else ctx.moveTo(cx, cy); });
    ctx.closePath();
    ctx.fill();
  }
  ctx.shadowBlur = 90;
  ctx.globalAlpha = 0.5;
  for (const { g, x } of items) {
    ctx.beginPath();
    g.outer.forEach(([px, py], i) => { const [cx, cy] = toPx(x + px, py); if (i) ctx.lineTo(cx, cy); else ctx.moveTo(cx, cy); });
    ctx.closePath();
    ctx.fill();
  }
  const haloTex = new THREE.CanvasTexture(canvas);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  haloTex.anisotropy = anisotropy;
  const haloMat = new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const haloGeo = new THREE.PlaneGeometry((width + pad * 2) * capHeight, (1 + pad * 2) * capHeight);
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.z = -0.045;
  halo.renderOrder = 3;

  const group = new THREE.Group();
  group.add(halo, letters);
  return {
    group,
    width: width * capHeight,
    dispose: () => { geo.dispose(); face.dispose(); side.dispose(); haloTex.dispose(); haloMat.dispose(); haloGeo.dispose(); },
  };
}
