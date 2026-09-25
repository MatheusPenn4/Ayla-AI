import * as THREE from "three";
import { GeometryBatch, Placer } from "./batch";
import type { Appearance } from "@/lib/office/types";

export type CharacterSpec = { id: string; name: string; color: string; look: Appearance };

/** Characters are slightly larger than furniture scale so they read as the stars of the scene. */
export const CHAR_SCALE = 1.18;
const HIP_STAND = 0.64 * CHAR_SCALE;
const HIP_SEAT = 0.5;
const SHOULDER_Y = 0.5;
const NECK_Y = 0.55;

const shade = (hex: string, amount: number) => {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + amount, 0, 1));
  return `#${c.getHexString()}`;
};
const mix = (a: string, b: string, t: number) => `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;

/** Shared resources for all characters (one outline material, one blob texture...). */
export class CharacterKit {
  readonly outline: THREE.MeshBasicMaterial;
  readonly blobMat: THREE.MeshBasicMaterial;
  readonly blobGeo = new THREE.PlaneGeometry(1.1, 1.1);
  readonly ringGeo = new THREE.RingGeometry(0.56, 0.68, 40);
  readonly markerGeo: THREE.BufferGeometry;
  readonly beamGeo = new THREE.CylinderGeometry(0.55, 0.55, 3, 20, 1, true);
  readonly hitGeo = new THREE.BoxGeometry(0.95, 2.0, 0.95);
  readonly hitMat = new THREE.MeshBasicMaterial({ visible: false });
  private outlineUniform = { value: 0.03 };
  constructor(blobTexture: THREE.Texture) {
    this.blobMat = new THREE.MeshBasicMaterial({ map: blobTexture, transparent: true, depthWrite: false });
    this.outline = this.makeOutline("#ffffff");
    const top = new THREE.ConeGeometry(0.13, 0.16, 4);
    top.translate(0, 0.08, 0);
    const bottom = new THREE.ConeGeometry(0.13, 0.26, 4);
    bottom.rotateX(Math.PI);
    bottom.translate(0, -0.13, 0);
    const merged = new GeometryBatch();
    merged.add(top, "#ffffff", new THREE.Matrix4());
    merged.add(bottom, "#ffffff", new THREE.Matrix4());
    this.markerGeo = merged.build()!;
  }
  makeOutline(color: string) {
    const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, toneMapped: false });
    const thickness = this.outlineUniform;
    m.onBeforeCompile = shader => {
      shader.uniforms.outlineThickness = thickness;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float outlineThickness;")
        .replace("#include <begin_vertex>", "vec3 transformed = vec3(position) + normalize(normal) * outlineThickness;");
    };
    m.customProgramCacheKey = () => "outline";
    return m;
  }
  dispose() {
    this.outline.dispose(); this.blobMat.dispose(); this.blobGeo.dispose(); this.ringGeo.dispose();
    this.markerGeo.dispose(); this.beamGeo.dispose(); this.hitGeo.dispose(); this.hitMat.dispose();
  }
}

type Rig = {
  body: THREE.Group; torso: THREE.Group; head: THREE.Group;
  hipL: THREE.Group; hipR: THREE.Group; kneeL: THREE.Group; kneeR: THREE.Group;
  armL: THREE.Group; armR: THREE.Group;
};

function buildParts(spec: CharacterSpec) {
  const { look, color } = spec;
  const skin = look.skin, hair = look.hairColor;
  const outfitMain = look.outfit === "labcoat" ? "#eef0f4" : color;
  const sleeve = look.outfit === "vest" ? "#eef0f4" : outfitMain;
  const dark = "#1d1b26";

  const torso = new GeometryBatch(), head = new GeometryBatch(), thigh = new GeometryBatch(), shin = new GeometryBatch(), arm = new GeometryBatch();
  const T = new Placer(torso), H = new Placer(head), TH = new Placer(thigh), SH = new Placer(shin), A = new Placer(arm);

  // Torso (pivot at hips)
  T.rbox(0.42, 0.18, 0.27, 0.06, look.pants, 0, 0.03, 0);
  const torsoColor = look.outfit === "vest" ? "#eef0f4" : outfitMain;
  T.rbox(0.46, 0.46, 0.29, 0.09, torsoColor, 0, 0.3, 0);
  T.rbox(0.18, 0.08, 0.16, 0.03, skin, 0, NECK_Y - 0.02, 0);
  switch (look.outfit) {
    case "blazer":
      T.box(0.13, 0.22, 0.01, "#f3f1ea", 0, 0.42, 0.146);
      T.box(0.055, 0.22, 0.012, "#b8324a", 0, 0.36, 0.152);
      T.box(0.07, 0.3, 0.012, shade(color, -0.12), -0.1, 0.36, 0.148);
      T.box(0.07, 0.3, 0.012, shade(color, -0.12), 0.1, 0.36, 0.148);
      T.box(0.04, 0.04, 0.012, "#f0bd5e", 0.14, 0.44, 0.153);
      break;
    case "hoodie":
      T.rbox(0.38, 0.14, 0.16, 0.06, shade(color, -0.08), 0, 0.5, -0.12);
      T.box(0.26, 0.1, 0.012, shade(color, -0.1), 0, 0.17, 0.146);
      T.box(0.015, 0.1, 0.012, "#f3f1ea", -0.04, 0.44, 0.15);
      T.box(0.015, 0.1, 0.012, "#f3f1ea", 0.04, 0.44, 0.15);
      break;
    case "sweater":
      T.cyl(0.11, 0.12, 0.09, shade(color, -0.06), 0, 0.53, 0, 12);
      for (let i = 0; i < 4; i++) T.box(0.46, 0.012, 0.296, shade(color, -0.06), 0, 0.12 + i * 0.03, 0);
      break;
    case "vest":
      T.box(0.19, 0.4, 0.02, color, -0.12, 0.3, 0.14);
      T.box(0.19, 0.4, 0.02, color, 0.12, 0.3, 0.14);
      T.box(0.46, 0.4, 0.02, color, 0, 0.3, -0.14);
      T.box(0.07, 0.05, 0.012, "#1d1b26", 0.13, 0.4, 0.152);
      break;
    case "tee":
      T.rbox(0.14, 0.14, 0.01, 0.02, shade(color, 0.22), 0, 0.33, 0.147);
      T.box(0.2, 0.03, 0.012, shade(color, -0.1), 0, 0.53, 0.14);
      break;
    case "labcoat":
      T.rbox(0.48, 0.3, 0.3, 0.06, "#eef0f4", 0, 0.02, 0);
      T.box(0.1, 0.24, 0.01, color, 0, 0.42, 0.147);
      T.box(0.1, 0.08, 0.012, "#d7dae3", 0.12, 0.26, 0.15);
      T.box(0.012, 0.07, 0.014, "#5fb7d9", 0.1, 0.3, 0.155);
      T.box(0.012, 0.07, 0.014, "#e96f5b", 0.13, 0.3, 0.155);
      break;
  }

  // Head (pivot at neck)
  H.rbox(0.46, 0.42, 0.41, 0.1, skin, 0, 0.24, 0);
  H.rbox(0.07, 0.1, 0.07, 0.02, skin, -0.24, 0.22, 0);
  H.rbox(0.07, 0.1, 0.07, 0.02, skin, 0.24, 0.22, 0);
  H.box(0.06, 0.085, 0.02, dark, -0.1, 0.25, 0.2);
  H.box(0.06, 0.085, 0.02, dark, 0.1, 0.25, 0.2);
  H.box(0.022, 0.022, 0.01, "#ffffff", -0.085, 0.27, 0.212);
  H.box(0.022, 0.022, 0.01, "#ffffff", 0.115, 0.27, 0.212);
  H.box(0.09, 0.022, 0.02, shade(hair, -0.05), -0.1, 0.325, 0.2);
  H.box(0.09, 0.022, 0.02, shade(hair, -0.05), 0.1, 0.325, 0.2);
  H.box(0.04, 0.05, 0.03, shade(skin, -0.06), 0, 0.2, 0.21);
  H.box(0.09, 0.022, 0.02, "#8a4a45", 0, 0.125, 0.2);
  H.box(0.06, 0.03, 0.015, mix(skin, "#ff7a8a", 0.45), -0.16, 0.17, 0.2);
  H.box(0.06, 0.03, 0.015, mix(skin, "#ff7a8a", 0.45), 0.16, 0.17, 0.2);

  const cap = (h = 0.14) => {
    H.rbox(0.5, h, 0.45, 0.06, hair, 0, 0.44 + (h - 0.14) / 2, -0.005);
    H.rbox(0.5, 0.26, 0.14, 0.05, hair, 0, 0.33, -0.17);
    H.rbox(0.06, 0.16, 0.3, 0.02, hair, -0.235, 0.38, -0.04);
    H.rbox(0.06, 0.16, 0.3, 0.02, hair, 0.235, 0.38, -0.04);
  };
  switch (look.hair) {
    case "short": cap(); H.rbox(0.44, 0.06, 0.06, 0.02, hair, 0, 0.41, 0.19); break;
    case "slick": cap(0.12); H.rbox(0.34, 0.09, 0.24, 0.04, hair, 0.05, 0.52, 0.08); H.rbox(0.28, 0.05, 0.06, 0.02, hair, 0.08, 0.43, 0.2); break;
    case "spiky":
      cap(0.12);
      for (const [x, z, rx, rz] of [[0, 0.08, 0.5, 0], [-0.13, 0, 0.1, 0.45], [0.13, 0, 0.1, -0.45], [0, -0.12, -0.45, 0], [-0.08, 0.14, 0.7, 0.3], [0.09, 0.14, 0.7, -0.3]])
        H.at(new THREE.ConeGeometry(0.08, 0.2, 4), hair, x, 0.56, z, 0, rx, rz);
      break;
    case "curly":
      for (const [x, y, z, r] of [[0, 0.5, 0, 0.14], [-0.16, 0.46, 0.06, 0.12], [0.16, 0.46, 0.06, 0.12], [-0.18, 0.42, -0.12, 0.13], [0.18, 0.42, -0.12, 0.13], [0, 0.44, -0.18, 0.14], [-0.08, 0.52, 0.14, 0.1], [0.08, 0.52, 0.14, 0.1], [0, 0.3, -0.2, 0.13], [-0.22, 0.3, -0.06, 0.1], [0.22, 0.3, -0.06, 0.1]])
        H.ico(r, hair, x, y, z);
      break;
    case "bun": cap(0.12); H.ico(0.13, hair, 0, 0.6, -0.08); H.rbox(0.44, 0.05, 0.06, 0.02, hair, 0, 0.41, 0.19); break;
    case "long": cap(0.13); H.rbox(0.5, 0.52, 0.12, 0.05, hair, 0, 0.16, -0.18); H.rbox(0.08, 0.4, 0.26, 0.03, hair, -0.25, 0.2, -0.04); H.rbox(0.08, 0.4, 0.26, 0.03, hair, 0.25, 0.2, -0.04); H.rbox(0.44, 0.07, 0.06, 0.02, hair, 0, 0.41, 0.19); break;
    case "ponytail": cap(0.12); H.rbox(0.13, 0.34, 0.13, 0.05, hair, 0, 0.26, -0.3, 0, 0.35); H.ico(0.05, "#e96f5b", 0, 0.42, -0.25); break;
    case "mohawk": H.rbox(0.1, 0.2, 0.44, 0.04, hair, 0, 0.5, -0.02); break;
    case "bald": H.rbox(0.47, 0.04, 0.3, 0.02, shade(skin, 0.05), 0, 0.45, 0); break;
  }
  switch (look.accessory) {
    case "glasses":
      for (const x of [-0.1, 0.1]) { H.box(0.13, 0.1, 0.012, "#20202c", x, 0.255, 0.212); H.box(0.1, 0.07, 0.01, "#bfe6ff", x, 0.255, 0.22); }
      H.box(0.08, 0.018, 0.012, "#20202c", 0, 0.27, 0.215);
      H.box(0.012, 0.018, 0.22, "#20202c", -0.235, 0.27, 0.1);
      H.box(0.012, 0.018, 0.22, "#20202c", 0.235, 0.27, 0.1);
      break;
    case "headphones":
      H.rbox(0.56, 0.06, 0.08, 0.03, "#20202c", 0, 0.56, 0);
      H.rbox(0.05, 0.24, 0.07, 0.02, "#20202c", -0.28, 0.43, 0);
      H.rbox(0.05, 0.24, 0.07, 0.02, "#20202c", 0.28, 0.43, 0);
      H.rbox(0.1, 0.18, 0.16, 0.04, shade(color, 0.1), -0.28, 0.24, 0);
      H.rbox(0.1, 0.18, 0.16, 0.04, shade(color, 0.1), 0.28, 0.24, 0);
      break;
    case "headset":
      H.rbox(0.52, 0.04, 0.06, 0.02, "#20202c", 0, 0.5, 0);
      H.rbox(0.04, 0.24, 0.05, 0.02, "#20202c", 0.26, 0.38, 0);
      H.rbox(0.08, 0.14, 0.13, 0.03, "#20202c", 0.265, 0.23, 0);
      H.at(new THREE.BoxGeometry(0.02, 0.02, 0.26), "#20202c", 0.2, 0.15, 0.12, -0.5);
      H.box(0.05, 0.035, 0.035, "#ff7a76", 0.1, 0.14, 0.23);
      break;
    case "cap":
      H.rbox(0.5, 0.17, 0.46, 0.08, color, 0, 0.47, 0);
      H.box(0.44, 0.03, 0.22, shade(color, -0.12), 0, 0.41, 0.29);
      H.box(0.08, 0.04, 0.08, shade(color, -0.12), 0, 0.56, 0);
      break;
    case "beanie":
      H.rbox(0.5, 0.2, 0.46, 0.09, color, 0, 0.47, 0);
      H.rbox(0.52, 0.07, 0.48, 0.03, shade(color, -0.12), 0, 0.39, 0);
      H.ico(0.07, "#f3f1ea", 0, 0.6, 0);
      break;
    case "beard":
      H.rbox(0.44, 0.15, 0.1, 0.05, hair, 0, 0.08, 0.17);
      H.rbox(0.07, 0.18, 0.2, 0.03, hair, -0.22, 0.15, 0.08);
      H.rbox(0.07, 0.18, 0.2, 0.03, hair, 0.22, 0.15, 0.08);
      H.box(0.16, 0.035, 0.03, hair, 0, 0.155, 0.215);
      H.box(0.09, 0.022, 0.02, "#8a4a45", 0, 0.12, 0.225);
      break;
  }

  // Legs (thigh pivot at hip, shin pivot at knee)
  TH.rbox(0.17, 0.32, 0.19, 0.06, look.pants, 0, -0.13, 0);
  if (look.outfit === "labcoat") TH.rbox(0.19, 0.12, 0.21, 0.04, "#eef0f4", 0, -0.02, 0);
  SH.rbox(0.15, 0.28, 0.17, 0.05, look.pants, 0, -0.13, 0);
  SH.rbox(0.18, 0.1, 0.27, 0.04, "#23232f", 0, -0.31, 0.04);
  SH.box(0.185, 0.02, 0.275, "#e8e4da", 0, -0.35, 0.04);

  // Arm (pivot at shoulder)
  A.rbox(0.13, 0.36, 0.15, 0.05, sleeve, 0, -0.16, 0);
  if (look.outfit === "labcoat" || look.outfit === "blazer") A.box(0.135, 0.04, 0.155, look.outfit === "blazer" ? "#f3f1ea" : color, 0, -0.33, 0);
  A.rbox(0.11, 0.11, 0.12, 0.04, skin, 0, -0.39, 0.01);

  return { torso: torso.build()!, head: head.build()!, thigh: thigh.build()!, shin: shin.build()!, arm: arm.build()! };
}

type Pose = "seated" | "standing" | "walking";

export class Character {
  readonly root = new THREE.Group();
  readonly hit: THREE.Mesh;
  readonly spec: CharacterSpec;
  private rig: Rig;
  private material: THREE.MeshStandardMaterial;
  private geos: THREE.BufferGeometry[] = [];
  private hulls: THREE.Mesh[] = [];
  private hullMat: THREE.MeshBasicMaterial;
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private marker: THREE.Mesh;
  private markerMat: THREE.MeshBasicMaterial;
  private beam: THREE.Mesh | null = null;
  private beamMat: THREE.MeshBasicMaterial | null = null;
  private phase: number;
  private sit = 1;
  private walk = 0;
  private walkCycle = 0;
  private path: THREE.Vector3[] = [];
  private arrive: { facing: number; seated: boolean } | null = null;
  private targetPose: Pose = "seated";
  private heading = 0;
  private waveT = -1;
  private spawnT = -1;
  private hovered = false;
  private selected = false;
  typing = true;
  private tmp = new THREE.Vector3();

  constructor(spec: CharacterSpec, private kit: CharacterKit, spawn = false) {
    this.spec = spec;
    this.phase = (spec.id.charCodeAt(0) * 13 + spec.id.length * 7) % 100 / 10;
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.02 });
    this.hullMat = kit.makeOutline(spec.color);
    const parts = buildParts(spec);
    this.geos = Object.values(parts);
    const mesh = (g: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(g, this.material);
      m.castShadow = true;
      const hull = new THREE.Mesh(g, this.hullMat);
      hull.visible = false;
      hull.raycast = () => {};
      m.add(hull);
      this.hulls.push(hull);
      return m;
    };
    const body = new THREE.Group();
    body.scale.setScalar(CHAR_SCALE);
    const torso = new THREE.Group();
    torso.add(mesh(parts.torso));
    const head = new THREE.Group();
    head.position.y = NECK_Y;
    head.add(mesh(parts.head));
    torso.add(head);
    const limb = (x: number) => {
      const hip = new THREE.Group(); hip.position.set(x, 0, 0);
      hip.add(mesh(parts.thigh));
      const knee = new THREE.Group(); knee.position.y = -0.28;
      knee.add(mesh(parts.shin));
      hip.add(knee);
      body.add(hip);
      return { hip, knee };
    };
    const L = limb(-0.105), R = limb(0.105);
    const armAt = (x: number) => { const g = new THREE.Group(); g.position.set(x, SHOULDER_Y, 0); g.add(mesh(parts.arm)); torso.add(g); return g; };
    const armL = armAt(-0.3), armR = armAt(0.3);
    body.add(torso);
    this.root.add(body);
    this.rig = { body, torso, head, hipL: L.hip, hipR: R.hip, kneeL: L.knee, kneeR: R.knee, armL, armR };

    const blob = new THREE.Mesh(kit.blobGeo, kit.blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    blob.renderOrder = 1;
    this.root.add(blob);
    this.ringMat = new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(kit.ringGeo, this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.ring.visible = false;
    this.root.add(this.ring);
    this.markerMat = new THREE.MeshBasicMaterial({ color: spec.color, toneMapped: false });
    this.marker = new THREE.Mesh(kit.markerGeo, this.markerMat);
    this.marker.visible = false;
    this.root.add(this.marker);
    this.hit = new THREE.Mesh(kit.hitGeo, kit.hitMat);
    this.hit.position.y = 1.0;
    this.hit.userData.workerId = spec.id;
    this.root.add(this.hit);
    if (spawn) {
      this.spawnT = 0;
      this.beamMat = new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
      this.beam = new THREE.Mesh(kit.beamGeo, this.beamMat);
      this.beam.position.y = 1.5;
      this.root.add(this.beam);
      this.root.scale.setScalar(0.001);
    }
  }

  /** Teleport to a pose (used for stations and reduced motion). */
  place(x: number, z: number, facing: number, seated: boolean) {
    this.path = [];
    this.arrive = null;
    this.root.position.set(x, 0, z);
    this.heading = facing;
    this.root.rotation.y = facing;
    this.sit = seated ? 1 : 0;
    this.walk = 0;
    this.targetPose = seated ? "seated" : "standing";
  }

  walkTo(points: [number, number][], facing: number, seated: boolean, delay = 0) {
    this.path = points.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.arrive = { facing, seated };
    this.targetPose = "walking";
    this.startDelay = delay;
  }
  private startDelay = 0;

  get isMoving() { return this.targetPose === "walking"; }

  setHover(on: boolean) { this.hovered = on; this.refreshHighlight(); }
  setSelected(on: boolean, wave: boolean) {
    if (on && !this.selected && wave) this.waveT = 0;
    this.selected = on;
    this.refreshHighlight();
  }
  private refreshHighlight() {
    const outline = this.selected || this.hovered;
    for (const h of this.hulls) h.visible = outline;
    this.hullMat.color.set(this.selected ? this.spec.color : "#ffffff");
    this.material.emissive.set(this.selected ? this.spec.color : "#ffffff");
    this.material.emissiveIntensity = this.selected ? 0.12 : this.hovered ? 0.08 : 0;
    this.ring.visible = this.selected;
    this.marker.visible = this.selected;
  }

  /** World position just above the head, used by DOM labels. */
  labelAnchor(out: THREE.Vector3) {
    const hipY = THREE.MathUtils.lerp(HIP_STAND, HIP_SEAT, this.sit);
    return this.root.localToWorld(out.set(0, hipY + (NECK_Y + 0.66) * CHAR_SCALE, 0));
  }

  update(dt: number, t: number, reduced: boolean, camera: THREE.Camera) {
    const r = this.rig;
    // Spawn pop-in
    if (this.spawnT >= 0) {
      this.spawnT += dt;
      const k = Math.min(1, this.spawnT / 0.75);
      const s = reduced ? 1 : 1 + Math.sin(k * Math.PI) * 0.18 * (1 - k);
      this.root.scale.setScalar(Math.max(0.001, reduced ? 1 : k < 1 ? THREE.MathUtils.smootherstep(k, 0, 1) * s : 1));
      if (this.beamMat) this.beamMat.opacity = 0.55 * (1 - Math.min(1, this.spawnT / 1.6));
      if (this.spawnT > 1.6) {
        this.spawnT = -1;
        if (this.beam) { this.root.remove(this.beam); this.beamMat?.dispose(); this.beam = null; this.beamMat = null; }
        this.root.scale.setScalar(1);
      }
    }

    // Path following
    let moving = false;
    if (this.targetPose === "walking" && this.path.length) {
      if (this.startDelay > 0) this.startDelay -= dt;
      else {
        // Stand up before walking
        if (this.sit > 0.01) this.sit = Math.max(0, this.sit - dt * 3.2);
        else {
          const target = this.path[0];
          const pos = this.root.position;
          const dx = target.x - pos.x, dz = target.z - pos.z;
          const dist = Math.hypot(dx, dz);
          const speed = 3.3;
          if (dist < 0.05) this.path.shift();
          else {
            const step = Math.min(dist, speed * dt);
            pos.x += (dx / dist) * step; pos.z += (dz / dist) * step;
            const desired = Math.atan2(dx, dz);
            this.heading = turnTowards(this.heading, desired, dt * 10);
            moving = true;
            this.walkCycle += step * 5.2;
          }
        }
      }
      if (!this.path.length && this.arrive) this.targetPose = this.arrive.seated ? "seated" : "standing";
    }
    if (this.targetPose !== "walking" && this.arrive) {
      this.heading = turnTowards(this.heading, this.arrive.facing, dt * 8);
      if (Math.abs(angleDiff(this.heading, this.arrive.facing)) < 0.02) this.heading = this.arrive.facing;
      if (this.targetPose === "seated") this.sit = Math.min(1, this.sit + dt * 3);
    }
    this.root.rotation.y = this.heading;
    this.walk = THREE.MathUtils.damp(this.walk, moving ? 1 : 0, 10, dt);

    const amp = reduced ? 0 : 1;
    const breathe = Math.sin(t * 1.6 + this.phase) * 0.012 * amp;
    const stride = Math.sin(this.walkCycle) * this.walk;
    const hipY = THREE.MathUtils.lerp(HIP_STAND, HIP_SEAT, this.sit) + Math.abs(Math.cos(this.walkCycle)) * 0.035 * this.walk;
    r.body.position.y = hipY + breathe * (1 - this.sit);
    r.torso.position.y = breathe * this.sit;
    r.torso.rotation.x = this.sit * 0.06 + this.walk * 0.05;

    // Legs: seated thighs forward + shins down, walking swing.
    const seatHip = -Math.PI / 2 * this.sit;
    r.hipL.rotation.x = seatHip + stride * 0.55;
    r.hipR.rotation.x = seatHip - stride * 0.55;
    r.kneeL.rotation.x = (Math.PI / 2) * this.sit + Math.max(0, -stride) * 0.7;
    r.kneeR.rotation.x = (Math.PI / 2) * this.sit + Math.max(0, stride) * 0.7;

    // Arms: typing when seated at a desk, swinging when walking.
    const typing = this.typing && this.targetPose === "seated" ? this.sit : 0;
    const tap = reduced ? 0 : Math.sin(t * 11 + this.phase) * 0.05;
    r.armL.rotation.x = -0.92 * typing + tap * typing - stride * 0.5;
    r.armR.rotation.x = -0.92 * typing - tap * typing + stride * 0.5;
    r.armL.rotation.z = -0.07 * (1 - typing) - 0.12 * typing;
    r.armR.rotation.z = 0.07 * (1 - typing) + 0.12 * typing;

    // Wave on selection
    if (this.waveT >= 0) {
      this.waveT += dt;
      const k = this.waveT / 1.4;
      if (k >= 1 || reduced) this.waveT = -1;
      else {
        const env = Math.sin(Math.min(1, k * 1.2) * Math.PI);
        r.armR.rotation.z = THREE.MathUtils.lerp(r.armR.rotation.z, 2.7, env);
        r.armR.rotation.x = THREE.MathUtils.lerp(r.armR.rotation.x, 0, env);
        r.armR.rotation.z += Math.sin(this.waveT * 16) * 0.25 * env;
      }
    }

    // Head: idle glances; selected characters look toward the camera.
    let yaw = reduced ? 0 : Math.sin(t * 0.35 + this.phase * 2) * 0.28 * Math.max(0, Math.sin(t * 0.21 + this.phase));
    let pitch = typing * 0.12;
    if (this.selected || this.hovered) {
      this.root.worldToLocal(this.tmp.copy(camera.position));
      yaw = THREE.MathUtils.clamp(Math.atan2(this.tmp.x, this.tmp.z), -1.0, 1.0);
      pitch = -0.12;
    }
    r.head.rotation.y = THREE.MathUtils.damp(r.head.rotation.y, yaw, 6, dt);
    r.head.rotation.x = THREE.MathUtils.damp(r.head.rotation.x, pitch, 6, dt);

    if (this.selected) {
      this.marker.position.y = hipY + (NECK_Y + 0.95) * CHAR_SCALE + (reduced ? 0 : Math.sin(t * 3) * 0.06);
      this.marker.rotation.y = t * 1.5 * amp;
      this.ringMat.opacity = 0.6 + 0.25 * Math.sin(t * 3.2) * amp;
      const s = 1 + 0.06 * Math.sin(t * 3.2) * amp;
      this.ring.scale.set(s, s, 1);
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    this.material.dispose(); this.hullMat.dispose(); this.ringMat.dispose(); this.markerMat.dispose(); this.beamMat?.dispose();
  }
}

function angleDiff(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function turnTowards(a: number, b: number, rate: number) {
  const d = angleDiff(a, b);
  return a + d * Math.min(1, rate * 0.1 + 0.08);
}
