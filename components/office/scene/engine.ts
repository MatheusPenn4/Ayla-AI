import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Character, CharacterKit, type CharacterSpec } from "./character";
import { buildWorld, type World } from "./world";
import { radialTexture, type DashboardData } from "./textures";
import { layoutLabels, type LabelIn, type LabelOut } from "./labels";
import { FrameBudget, TIERS, detectTier, lowerTier, type Tier } from "./quality";
import { FLOOR, MEETING_SPOTS, STATIONS, STATION_BY_ID, ZONES, routeToMeeting } from "@/lib/office/layout";
import type { ZoneId } from "@/lib/office/types";

export type EngineWorker = CharacterSpec & { stationId: string };
export type HoverTarget = { type: "worker"; id: string } | { type: "station"; id: string } | null;
export type QualityPref = "auto" | Tier;

export type EngineCallbacks = {
  onSelect: (id: string) => void;
  onStation: (stationId: string) => void;
  onHover: (target: HoverTarget, clientX: number, clientY: number) => void;
  onTier: (tier: Tier, auto: boolean) => void;
  onContextLost: () => void;
};

type Tween = { from: THREE.Vector3; to: THREE.Vector3; fromDist: number; toDist: number; t: number; dur: number };

const ZONE_LABEL_ANCHORS: Record<ZoneId, [number, number, number]> = {
  director: [-9.2, 0.75, -3.2],
  lounge: [-0.6, 0.75, -3.5],
  meeting: [8.9, 2.55, -3],
  dev: [-10.6, 1.6, -1.4],
  qa: [11.2, 1.6, -1.4],
};

const HOME_TARGET = new THREE.Vector3(-0.4, 0, 0.2);
const HOME_POLAR = 0.9;
const HOME_AZIMUTH = 0.6;

export class OfficeEngine {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.5, 260);
  private controls: OrbitControls;
  private world: World;
  private kit: CharacterKit;
  private blobTex: THREE.Texture;
  private envTex: THREE.Texture | null = null;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private points: THREE.PointLight[] = [];
  private chars = new Map<string, Character>();
  private workers = new Map<string, EngineWorker>();
  private selected: string | null = null;
  private hoverTarget: HoverTarget = null;
  private externalHover: string | null = null;
  private labels = new Map<string, { el: HTMLElement; kind: "worker" | "zone"; w: number; h: number; last: string; mode: string }>();
  private prevLayout = new Map<string, LabelOut>();
  private blocked: { l: number; t: number; r: number; b: number }[] = [];
  private insets = { right: 0, bottom: 0 };
  private insetNow = { right: 0, bottom: 0 };
  private size = { w: 1, h: 1 };
  private raf = 0;
  private active = true;
  private throttled = false;
  private lastRender = 0;
  private lastFrame = 0;
  private timer = new THREE.Timer();
  private tween: Tween | null = null;
  private pointer = { x: 0, y: 0, clientX: 0, clientY: 0, dirty: false, inside: false };
  private down: { x: number; y: number; t: number } | null = null;
  private raycaster = new THREE.Raycaster();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector2();
  private tier: Tier = "balanced";
  private pref: QualityPref = "auto";
  private budget = new FrameBudget();
  private meeting = false;
  private reduced: boolean;
  private initialized = false;
  private disposed = false;
  private observer: ResizeObserver;
  private inboxPapers: THREE.Mesh[] = [];
  private paperGeo = new THREE.BoxGeometry(0.3, 0.012, 0.22);
  private paperMat = new THREE.MeshStandardMaterial({ color: "#f3f1ea", roughness: 0.9 });

  constructor(private host: HTMLElement, private cb: EngineCallbacks, opts: { quality: QualityPref; reducedMotion: boolean }) {
    this.reduced = opts.reducedMotion;
    this.pref = opts.quality;
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 indisponível");
    const detected = detectTier(gl);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.tier = opts.quality === "auto" ? detected : opts.quality;
    const settings = TIERS[this.tier];

    this.renderer = new THREE.WebGLRenderer({ antialias: this.tier !== "low", alpha: true, powerPreference: "high-performance", stencil: false });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", "Escritório 3D. Arraste para girar, role para aproximar, setas para deslocar, Q e E para girar, + e − para zoom, R para recentralizar.");
    host.appendChild(canvas);

    this.scene.fog = new THREE.Fog("#07090f", 70, 170);
    const aniso = Math.min(settings.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
    this.world = buildWorld(aniso);
    this.scene.add(this.world.root);
    this.blobTex = radialTexture("rgba(6,6,20,0.6)");
    this.kit = new CharacterKit(this.blobTex);

    // Lighting: cool moonlight key + warm/cool pools per zone.
    this.hemi = new THREE.HemisphereLight("#b4c3ee", "#1b1f2b", 1.45);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight("#f2f5ff", 2.1);
    this.sun.position.set(-9, 20, 13);
    this.sun.target.position.set(0, 0, 0);
    const sc = this.sun.shadow.camera;
    sc.left = -17; sc.right = 17; sc.top = 14; sc.bottom = -14; sc.near = 4; sc.far = 50;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    const pools: [string, number, number, number, number][] = [
      ["#bfefff", -6, 3.4, 3.6, 30], ["#c9d8ff", 8.4, 3.4, 3.6, 28], ["#ffd49a", -9.4, 3.2, -6.2, 26], ["#c3cbff", 8.9, 3, -6.2, 22], ["#b8e6ff", -0.6, 3, -6.2, 18],
    ];
    for (const [color, x, y, z, intensity] of pools) {
      const l = new THREE.PointLight(color, intensity, 13, 1.6);
      l.position.set(x, y, z);
      this.points.push(l);
      this.scene.add(l);
    }

    // Camera + controls
    this.controls = new OrbitControls(this.camera, canvas);
    const c = this.controls;
    c.enableDamping = true; c.dampingFactor = 0.08;
    c.rotateSpeed = 0.55; c.zoomSpeed = 0.9; c.panSpeed = 0.9;
    c.screenSpacePanning = false;
    c.minDistance = 11; c.maxDistance = 95;
    c.minPolarAngle = 0.32; c.maxPolarAngle = 1.2;
    // Keeps the back wall (and the PENSEI ALTO sign) readable from every allowed angle.
    c.minAzimuthAngle = -0.5; c.maxAzimuthAngle = 1.3;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    c.keyPanSpeed = 22;
    c.listenToKeyEvents(canvas);
    c.addEventListener("change", this.clampTarget);
    this.applyTier(this.tier);
    this.resize();
    this.home(false);

    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("keydown", this.onKey);
    canvas.addEventListener("webglcontextlost", this.onLost);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.raf = requestAnimationFrame(this.loop);
    this.cb.onTier(this.tier, this.pref === "auto");
  }

  // ---------------------------------------------------------------- public API
  setWorkers(list: EngineWorker[]) {
    const seen = new Set<string>();
    list.forEach(w => {
      seen.add(w.id);
      const prev = this.workers.get(w.id);
      const same = prev && prev.name === w.name && prev.color === w.color && JSON.stringify(prev.look) === JSON.stringify(w.look);
      const st = STATION_BY_ID.get(w.stationId) ?? STATIONS[0];
      let ch = this.chars.get(w.id);
      if (!ch || !same) {
        const pos = ch ? { x: ch.root.position.x, z: ch.root.position.z, r: ch.root.rotation.y } : null;
        ch?.dispose();
        if (ch) this.scene.remove(ch.root);
        ch = new Character(w, this.kit, this.initialized && !prev);
        this.chars.set(w.id, ch);
        this.scene.add(ch.root);
        if (pos && prev?.stationId === w.stationId) ch.place(pos.x, pos.z, pos.r, !this.meeting);
        else ch.place(st.x, st.z, st.facing, true);
        ch.setSelected(this.selected === w.id, false);
      } else if (prev.stationId !== w.stationId && !this.meeting) {
        ch.place(st.x, st.z, st.facing, true);
      }
      this.workers.set(w.id, { ...w });
    });
    for (const [id, ch] of this.chars) if (!seen.has(id)) {
      this.scene.remove(ch.root);
      ch.dispose();
      this.chars.delete(id);
      this.workers.delete(id);
    }
    const used = new Set([...this.workers.values()].map(w => w.stationId));
    for (const [sid, marker] of this.world.freeMarkers) marker.visible = !used.has(sid);
    this.initialized = true;
    if (this.meeting) this.gather(true);
  }

  setSelected(id: string | null, focus: boolean) {
    const changed = id !== this.selected;
    if (this.selected) this.chars.get(this.selected)?.setSelected(false, false);
    this.selected = id;
    const ch = id ? this.chars.get(id) : null;
    ch?.setSelected(true, changed);
    if (ch && focus) this.focusOn(ch.root.position, Math.min(this.controls.getDistance(), this.size.w < 700 ? 40 : 30));
  }

  setExternalHover(id: string | null) {
    if (this.externalHover === id) return;
    if (this.externalHover && this.hoverTarget?.type !== "worker") this.chars.get(this.externalHover)?.setHover(false);
    this.externalHover = id;
    if (id) this.chars.get(id)?.setHover(true);
    else if (this.hoverTarget?.type === "worker") this.chars.get(this.hoverTarget.id)?.setHover(true);
  }

  setInsets(right: number, bottom: number) { this.insets = { right, bottom }; }
  setBlocked(rects: { l: number; t: number; r: number; b: number }[]) { this.blocked = rects; }
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (active) { this.lastFrame = performance.now(); this.budget.reset(); }
  }
  setThrottled(on: boolean) { this.throttled = on; }

  setDashboard(data: DashboardData) {
    for (const ws of this.world.wallScreens) ws.draw(data);
    this.world.refreshFonts();
    const n = Math.min(10, data.demandCount);
    while (this.inboxPapers.length > n) this.world.inbox.remove(this.inboxPapers.pop()!);
    while (this.inboxPapers.length < n) {
      const p = new THREE.Mesh(this.paperGeo, this.paperMat);
      const i = this.inboxPapers.length;
      p.position.set(Math.sin(i * 2.1) * 0.015, 0.035 + i * 0.014, Math.cos(i * 1.7) * 0.012);
      p.rotation.y = Math.sin(i * 3.3) * 0.12;
      p.castShadow = true;
      this.world.inbox.add(p);
      this.inboxPapers.push(p);
    }
  }

  setMeeting(on: boolean) {
    if (on === this.meeting) return;
    this.meeting = on;
    if (on) this.gather(false);
    else this.disperse();
  }

  focusZone(zone: ZoneId) {
    const f = ZONES[zone].focus;
    this.focusOn(new THREE.Vector3(f[0], 0, f[1]), this.size.w < 700 ? 42 : 30);
  }

  rotate(dir: 1 | -1) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const s = new THREE.Spherical().setFromVector3(offset);
    s.theta = THREE.MathUtils.clamp(s.theta + dir * 0.35, this.controls.minAzimuthAngle, this.controls.maxAzimuthAngle);
    offset.setFromSpherical(s);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  zoom(dir: 1 | -1) {
    const d = THREE.MathUtils.clamp(this.controls.getDistance() * (dir > 0 ? 0.8 : 1.25), this.controls.minDistance, this.controls.maxDistance);
    this.focusOn(this.controls.target.clone(), d, 0.3);
  }

  home(animate = true) {
    const dist = this.homeDistance();
    const portrait = this.size.w / Math.max(1, this.size.h) < 1;
    const azimuth = portrait ? 1.0 : HOME_AZIMUTH, polar = portrait ? 0.82 : HOME_POLAR;
    if (!animate || this.reduced) {
      const offset = new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, polar, azimuth));
      this.controls.target.copy(HOME_TARGET);
      this.camera.position.copy(HOME_TARGET).add(offset);
      this.controls.update();
      return;
    }
    const offset = new THREE.Vector3().setFromSpherical(new THREE.Spherical(dist, polar, azimuth));
    this.camera.position.copy(this.controls.target).add(offset);
    this.focusOn(HOME_TARGET.clone(), dist);
  }

  setQuality(pref: QualityPref) {
    this.pref = pref;
    this.budget = new FrameBudget();
    const tier = pref === "auto" ? this.tier : pref;
    this.applyTier(tier);
    this.cb.onTier(tier, pref === "auto");
  }

  registerLabel(id: string, el: HTMLElement | null, kind: "worker" | "zone") {
    if (!el) { this.labels.delete(id); this.prevLayout.delete(id); return; }
    const pill = el.querySelector<HTMLElement>(".pill") ?? el;
    this.labels.set(id, { el, kind, w: pill.offsetWidth, h: pill.offsetHeight, last: "", mode: "" });
  }
  measureLabels() {
    for (const l of this.labels.values()) {
      const pill = l.el.querySelector<HTMLElement>(".pill") ?? l.el;
      l.w = pill.offsetWidth; l.h = pill.offsetHeight;
    }
  }

  /** Screen position (relative to the canvas) of a worker's body — used by QA scripts. */
  project(id: string) {
    const ch = this.chars.get(id);
    if (!ch) return null;
    const v = ch.root.localToWorld(this.tmpV.set(0, 0.95, 0)).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.size.w, y: ((1 - v.y) / 2) * this.size.h };
  }
  projectStation(id: string) {
    const st = STATION_BY_ID.get(id);
    if (!st) return null;
    const v = this.tmpV.set(st.x + Math.sin(st.facing) * 0.75, 0.7, st.z + Math.cos(st.facing) * 0.75).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.size.w, y: ((1 - v.y) / 2) * this.size.h };
  }
  stats() {
    const i = this.renderer.info;
    return { tier: this.tier, pref: this.pref, dpr: this.renderer.getPixelRatio(), calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, workers: this.chars.size };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("keydown", this.onKey);
    canvas.removeEventListener("webglcontextlost", this.onLost);
    this.controls.removeEventListener("change", this.clampTarget);
    this.controls.dispose();
    for (const ch of this.chars.values()) ch.dispose();
    this.chars.clear();
    this.kit.dispose();
    this.blobTex.dispose();
    this.world.dispose();
    this.paperGeo.dispose();
    this.paperMat.dispose();
    this.envTex?.dispose();
    this.sun.shadow.map?.dispose();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
    this.labels.clear();
  }

  // ---------------------------------------------------------------- internals
  private homeDistance() {
    const aspect = this.size.w / Math.max(1, this.size.h);
    const base = 42;
    if (aspect < 1) return THREE.MathUtils.clamp(40 / Math.pow(aspect, 0.55), 42, 66);
    return THREE.MathUtils.clamp(aspect < 1.45 ? base * Math.pow(1.45 / aspect, 0.8) : base, 30, 82);
  }

  private applyTier(tier: Tier) {
    this.tier = tier;
    const s = TIERS[tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, s.maxDpr));
    const wasShadows = this.renderer.shadowMap.enabled;
    this.renderer.shadowMap.enabled = s.shadows;
    this.sun.castShadow = s.shadows;
    if (this.sun.shadow.mapSize.x !== s.shadowMap) {
      this.sun.shadow.mapSize.set(s.shadowMap, s.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.points.forEach((p, i) => (p.visible = i < s.pointLights));
    this.hemi.intensity = s.pointLights ? 1.45 : 1.95;
    if (tier !== "low" && !this.envTex) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.envTex = pmrem.fromScene(room, 0.04).texture;
      room.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      pmrem.dispose();
    }
    this.scene.environment = tier === "low" ? null : this.envTex;
    this.scene.environmentIntensity = 0.22;
    if (wasShadows !== s.shadows) this.scene.traverse(o => { if (o instanceof THREE.Mesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => (m.needsUpdate = true)); });
    this.resize();
  }

  private resize = () => {
    if (this.disposed) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    const changedAspect = Math.abs(w / h - this.size.w / this.size.h) > 0.01;
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyViewOffset();
    if (changedAspect && !this.initialized) this.home(false);
    this.measureLabels();
  };

  private applyViewOffset() {
    const { w, h } = this.size;
    const ox = this.insetNow.right / 2, oy = this.insetNow.bottom / 2;
    if (ox || oy) this.camera.setViewOffset(w, h, ox, oy, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  private clampTarget = () => {
    const t = this.controls.target;
    const cx = THREE.MathUtils.clamp(t.x, FLOOR.x0 + 1, FLOOR.x1 - 1), cz = THREE.MathUtils.clamp(t.z, FLOOR.z0 + 1, FLOOR.z1 - 1);
    if (cx !== t.x || cz !== t.z || t.y !== 0) {
      const dx = cx - t.x, dz = cz - t.z, dy = -t.y;
      t.set(cx, 0, cz);
      this.camera.position.x += dx; this.camera.position.z += dz; this.camera.position.y += dy;
    }
  };

  private focusOn(target: THREE.Vector3, dist: number, dur = 0.7) {
    const to = new THREE.Vector3(target.x, 0, target.z);
    if (this.reduced) {
      const off = this.camera.position.clone().sub(this.controls.target).setLength(dist);
      this.controls.target.copy(to);
      this.camera.position.copy(to).add(off);
      this.controls.update();
      return;
    }
    this.tween = { from: this.controls.target.clone(), to, fromDist: this.controls.getDistance(), toDist: dist, t: 0, dur };
  }

  private gather(instant: boolean) {
    const order = [...this.workers.values()].sort((a, b) => STATIONS.findIndex(s => s.id === a.stationId) - STATIONS.findIndex(s => s.id === b.stationId));
    order.forEach((w, i) => {
      const ch = this.chars.get(w.id);
      const st = STATION_BY_ID.get(w.stationId);
      const spot = MEETING_SPOTS[i % MEETING_SPOTS.length];
      if (!ch || !st) return;
      ch.typing = false;
      if (instant || this.reduced) ch.place(spot.x, spot.z, spot.facing, spot.seated);
      else if (!ch.isMoving) ch.walkTo(routeToMeeting(st, spot), spot.facing, spot.seated, i * 0.16);
    });
  }

  private disperse() {
    const order = [...this.workers.values()].sort((a, b) => STATIONS.findIndex(s => s.id === a.stationId) - STATIONS.findIndex(s => s.id === b.stationId));
    order.forEach((w, i) => {
      const ch = this.chars.get(w.id);
      const st = STATION_BY_ID.get(w.stationId);
      const spot = MEETING_SPOTS[i % MEETING_SPOTS.length];
      if (!ch || !st) return;
      ch.typing = true;
      if (this.reduced) { ch.place(st.x, st.z, st.facing, true); return; }
      const route = routeToMeeting(st, spot).slice(0, -1).reverse();
      ch.walkTo([...route, [st.x, st.z]], st.facing, true, i * 0.12);
    });
  }

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointer.clientX = e.clientX; this.pointer.clientY = e.clientY;
    this.pointer.dirty = true; this.pointer.inside = true;
  };
  private onPointerLeave = () => { this.pointer.inside = false; this.pointer.dirty = true; };
  private onPointerDown = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY, t: performance.now() }; this.tween = null; };
  private onPointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 700) return;
    this.onPointerMove(e);
    const target = this.pick();
    if (target?.type === "worker") this.cb.onSelect(target.id);
    else if (target?.type === "station") this.cb.onStation(target.id);
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") { this.zoom(1); e.preventDefault(); }
    else if (e.key === "-" || e.key === "_") { this.zoom(-1); e.preventDefault(); }
    else if (e.key.toLowerCase() === "q") this.rotate(-1);
    else if (e.key.toLowerCase() === "e") this.rotate(1);
    else if (e.key.toLowerCase() === "r") this.home();
  };
  private onLost = (e: Event) => { e.preventDefault(); this.cb.onContextLost(); };

  private pick(): HoverTarget {
    if (!this.pointer.inside) return null;
    this.raycaster.setFromCamera(this.tmpV2.set(this.pointer.x, this.pointer.y), this.camera);
    const targets: THREE.Object3D[] = [...[...this.chars.values()].map(c => c.hit), ...this.world.stationHits];
    const hits = this.raycaster.intersectObjects(targets, false);
    const worker = hits.find(h => h.object.userData.workerId);
    if (worker) return { type: "worker", id: worker.object.userData.workerId };
    const station = hits.find(h => h.object.userData.stationId);
    if (!station) return null;
    const sid = station.object.userData.stationId as string;
    const owner = [...this.workers.values()].find(w => w.stationId === sid);
    if (owner && !this.meeting) return { type: "worker", id: owner.id };
    return owner ? null : { type: "station", id: sid };
  }

  private updateHover() {
    if (!this.pointer.dirty) return;
    this.pointer.dirty = false;
    if (this.down) return;
    const next = this.pick();
    const same = next?.type === this.hoverTarget?.type && next?.id === this.hoverTarget?.id;
    if (!same) {
      if (this.hoverTarget?.type === "worker" && this.hoverTarget.id !== this.externalHover) this.chars.get(this.hoverTarget.id)?.setHover(false);
      if (this.hoverTarget?.type === "station") this.markerHover(this.hoverTarget.id, false);
      this.hoverTarget = next;
      if (next?.type === "worker") this.chars.get(next.id)?.setHover(true);
      if (next?.type === "station") this.markerHover(next.id, true);
      this.renderer.domElement.style.cursor = next ? "pointer" : "grab";
    }
    this.cb.onHover(next, this.pointer.clientX, this.pointer.clientY);
  }

  private markerHover(id: string, on: boolean) {
    const m = this.world.freeMarkers.get(id);
    if (m) m.scale.setScalar(on ? 1.35 : 1);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.active || this.disposed) return;
    const s = TIERS[this.tier];
    const fps = this.throttled ? 12 : s.maxFps;
    if (now - this.lastRender < 1000 / fps - 2) return;
    const dtMs = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;
    this.lastRender = now;
    const dt = Math.min(0.1, dtMs / 1000);
    this.timer.update(now);
    const t = this.timer.getElapsed();

    if (this.pref === "auto" && !this.throttled && this.tier !== "low" && this.budget.push(dtMs)) {
      this.applyTier(lowerTier(this.tier));
      this.cb.onTier(this.tier, true);
    }

    // Smoothly slide the projection centre when side panels open/close.
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 9);
    const ir = this.insetNow.right + (this.insets.right - this.insetNow.right) * k;
    const ib = this.insetNow.bottom + (this.insets.bottom - this.insetNow.bottom) * k;
    if (Math.abs(ir - this.insetNow.right) > 0.2 || Math.abs(ib - this.insetNow.bottom) > 0.2 || ir !== this.insets.right || ib !== this.insets.bottom) {
      this.insetNow = { right: Math.abs(ir - this.insets.right) < 0.5 ? this.insets.right : ir, bottom: Math.abs(ib - this.insets.bottom) < 0.5 ? this.insets.bottom : ib };
      this.applyViewOffset();
    }

    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = 1 - Math.pow(1 - tw.t, 3);
      const target = tw.from.clone().lerp(tw.to, e);
      const dist = THREE.MathUtils.lerp(tw.fromDist, tw.toDist, e);
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(dir, dist);
      if (tw.t >= 1) this.tween = null;
    }
    this.controls.update();
    this.updateHover();

    for (const ch of this.chars.values()) ch.update(dt, t, this.reduced, this.camera);
    if (!this.reduced) {
      this.world.screenMaterial.color.setScalar(0.86 + Math.sin(t * 1.3) * 0.03);
      for (const m of this.world.freeMarkers.values()) if (m.visible) m.rotation.y = t * 0.6;
    }
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  };

  private updateLabels() {
    if (!this.labels.size) return;
    const { w, h } = this.size;
    const items: LabelIn[] = [];
    for (const [id, l] of this.labels) {
      let world: THREE.Vector3 | null = null;
      if (l.kind === "worker") {
        const ch = this.chars.get(id);
        if (ch) world = ch.labelAnchor(this.tmpV);
      } else {
        const a = ZONE_LABEL_ANCHORS[id.replace("zone:", "") as ZoneId];
        if (a) world = this.tmpV.set(a[0], a[1], a[2]);
      }
      if (!world) continue;
      const v = world.project(this.camera);
      const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h;
      const onScreen = v.z < 1 && x > -40 && x < w + 40 && y > -40 && y < h + 40;
      const selected = id === this.selected, hovered = id === this.externalHover || (this.hoverTarget?.type === "worker" && this.hoverTarget.id === id);
      const priority = l.kind === "zone" ? 0.5 : selected ? 4 : hovered ? 3 : id === "director" ? 2 : 1 + y / h / 2;
      items.push({ id, kind: l.kind, x, y, w: l.w, h: l.h, priority, onScreen });
    }
    const layout = layoutLabels(items, { w, h }, this.blocked, this.prevLayout);
    for (const o of layout) {
      const l = this.labels.get(o.id);
      if (!l) continue;
      this.prevLayout.set(o.id, o);
      const transform = `translate3d(${Math.round(o.left)}px, ${Math.round(o.top)}px, 0)`;
      if (transform !== l.last) { l.el.style.transform = transform; l.last = transform; }
      const mode = o.mode + (o.lift ? "-lift" : "");
      if (mode !== l.mode) {
        l.el.dataset.mode = o.mode;
        l.el.style.setProperty("--lift", `${o.lift}px`);
        l.mode = mode;
      }
      const flag = o.id === this.selected ? "selected" : (this.hoverTarget?.type === "worker" && this.hoverTarget.id === o.id) || o.id === this.externalHover ? "hover" : "";
      if (l.el.dataset.state !== flag) l.el.dataset.state = flag;
    }
  }
}
