import * as THREE from "three";

// Every texture in the scene is generated here at runtime from <canvas>.
// No image files, no network: see ASSETS.md.

export const FONT_DISPLAY = "'Oxanium Variable', 'Trebuchet MS', sans-serif";
export const FONT_MONO = "'JetBrains Mono Variable', ui-monospace, monospace";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  return { c, ctx };
}

function finish(c: HTMLCanvasElement, repeat?: [number, number], srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  t.anisotropy = 4;
  return t;
}

export type FloorKind = "concrete" | "walnut" | "graphiteCarpet" | "epoxy" | "charcoalCarpet" | "stone";

/** Floors: dark, low-contrast materials so furniture and characters read first. */
export function floorTexture(kind: FloorKind, repeat: [number, number]) {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  const r = rng(kind.length * 977 + 13);
  const noise = (alpha: number, n = 2200) => {
    for (let i = 0; i < n; i++) {
      const v = r();
      ctx.fillStyle = v > 0.5 ? `rgba(255,255,255,${alpha * r()})` : `rgba(0,0,0,${alpha * r()})`;
      ctx.fillRect(r() * size, r() * size, 1 + r() * 2, 1 + r() * 2);
    }
  };
  const grid = (step: number, color: string, width = 1.5) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    for (let x = 0; x <= size; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke(); }
    for (let y = 0; y <= size; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke(); }
  };
  if (kind === "walnut") {
    // Dark walnut planks for the executive area.
    const planks = 6;
    for (let i = 0; i < planks; i++) {
      const hue = 22 + r() * 6, light = 22 + r() * 5;
      ctx.fillStyle = `hsl(${hue} 30% ${light}%)`;
      ctx.fillRect(0, (i * size) / planks, size, size / planks);
      ctx.fillStyle = "rgba(0,0,0,.35)";
      ctx.fillRect(0, (i * size) / planks, size, 1.5);
      ctx.fillRect(r() * size, (i * size) / planks, 1.5, size / planks);
      for (let g = 0; g < 7; g++) {
        ctx.strokeStyle = `rgba(255,220,180,${0.03 + r() * 0.04})`;
        ctx.beginPath();
        const y = (i * size) / planks + r() * (size / planks);
        ctx.moveTo(0, y); ctx.bezierCurveTo(size * 0.3, y + 3, size * 0.6, y - 3, size, y + 1); ctx.stroke();
      }
    }
    noise(0.04);
  } else if (kind === "concrete") {
    // Polished dark concrete for circulation areas.
    ctx.fillStyle = "#1b1e26"; ctx.fillRect(0, 0, size, size);
    noise(0.06, 5000);
    grid(128, "rgba(120,150,210,.07)");
  } else if (kind === "stone") {
    ctx.fillStyle = "#232733"; ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { ctx.fillStyle = `rgba(255,255,255,${0.012 + r() * 0.02})`; ctx.fillRect(x * 128 + 2, y * 128 + 2, 124, 124); }
    noise(0.05, 4000);
    grid(128, "rgba(0,0,0,.55)", 3);
  } else if (kind === "epoxy") {
    // QA lab: seamless blue-grey resin with a fine measurement grid.
    ctx.fillStyle = "#1f2638"; ctx.fillRect(0, 0, size, size);
    noise(0.035, 3000);
    grid(32, "rgba(110,150,255,.06)", 1);
    grid(128, "rgba(110,150,255,.13)", 1.5);
  } else {
    // Carpet tiles (graphite for the studio, charcoal-blue for the meeting room).
    const base = kind === "graphiteCarpet" ? [198, 18, 19] : [228, 16, 18];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const l = base[2] + ((x + y) % 2 ? 1.2 : -0.6) + r() * 0.6;
      ctx.fillStyle = `hsl(${base[0]} ${base[1]}% ${l}%)`;
      ctx.fillRect(x * 64, y * 64, 64, 64);
      ctx.strokeStyle = "rgba(0,0,0,.18)";
      ctx.strokeRect(x * 64 + 0.5, y * 64 + 0.5, 63, 63);
    }
    // Fine pile texture: many tiny, low-contrast flecks (no terrazzo speckle).
    for (let i = 0; i < 9000; i++) { ctx.fillStyle = `rgba(${r() > 0.5 ? "255,255,255" : "0,0,0"},${0.025 * r()})`; ctx.fillRect(r() * size, r() * size, 1, 1); }
  }
  return finish(c, repeat);
}

/**
 * Monitor atlas: 4×2 cells of 384×240. Screens show calm, generic workspaces
 * (editor, design canvas, docs, idle terminal, brand lock screen). Nothing here
 * pretends that a task, test or agent is running.
 */
export const MONITOR_CELLS = { cols: 4, rows: 2 };
export const SCREEN_CELL = { editor: 0, editorAlt: 1, design: 2, lock: 3, docs: 4, terminal: 5, review: 6, wallpaper: 7 } as const;

export function drawMonitorAtlas(ctx: CanvasRenderingContext2D) {
  const cw = 384, ch = 240;
  const r = rng(4242);
  const code = ["#7fd8ff", "#9fb2ff", "#5ec8ff", "#c8d6ff", "#6fe6ff"];
  const panel = (ox: number, oy: number, bg: string, bar = "#141a28") => {
    ctx.fillStyle = bg; ctx.fillRect(ox, oy, cw, ch);
    ctx.fillStyle = bar; ctx.fillRect(ox, oy, cw, 18);
    ctx.fillStyle = "rgba(160,190,255,.35)";
    for (let d = 0; d < 3; d++) { ctx.beginPath(); ctx.arc(ox + 12 + d * 12, oy + 9, 3.2, 0, 7); ctx.fill(); }
  };
  const lines = (ox: number, oy: number, x0: number, w: number, rows: number, palette: string[], step = 15) => {
    let indent = 0;
    for (let l = 0; l < rows; l++) {
      indent = Math.max(0, Math.min(3, indent + (r() > 0.62 ? 1 : r() > 0.72 ? -1 : 0)));
      let x = ox + x0 + indent * 14;
      const y = oy + 30 + l * step;
      const tokens = 1 + Math.floor(r() * 4);
      for (let t = 0; t < tokens && x < ox + x0 + w - 20; t++) {
        const tw = 12 + r() * 52;
        ctx.fillStyle = palette[Math.floor(r() * palette.length)];
        ctx.globalAlpha = 0.95; ctx.fillRect(x, y, tw, 6); ctx.globalAlpha = 1;
        x += tw + 7;
      }
    }
  };
  const brand = (ox: number, oy: number, big: boolean) => {
    const g = ctx.createLinearGradient(ox, oy, ox + cw, oy + ch);
    g.addColorStop(0, "#050811"); g.addColorStop(0.55, big ? "#0b1a36" : "#0a1428"); g.addColorStop(1, "#0f2c52");
    ctx.fillStyle = g; ctx.fillRect(ox, oy, cw, ch);
    ctx.strokeStyle = "rgba(80,170,255,.22)"; ctx.lineWidth = 1;
    for (let k = 0; k < 6; k++) { ctx.beginPath(); ctx.arc(ox + cw * 0.82, oy + ch * 1.05, 60 + k * 34, Math.PI, Math.PI * 1.5); ctx.stroke(); }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `700 ${big ? 38 : 30}px ${FONT_DISPLAY}`; ctx.fillStyle = "#e8f1ff";
    ctx.fillText("PENSEI ALTO", ox + cw / 2, oy + ch / 2 - (big ? 6 : 0));
    ctx.fillStyle = "#3fb4ff"; ctx.fillRect(ox + cw / 2 - 34, oy + ch / 2 + (big ? 22 : 18), 68, 3);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  };
  ctx.clearRect(0, 0, cw * 4, ch * 2);
  for (let i = 0; i < 8; i++) {
    const ox = (i % 4) * cw, oy = Math.floor(i / 4) * ch;
    if (i === SCREEN_CELL.lock) brand(ox, oy, true);
    else if (i === SCREEN_CELL.wallpaper) brand(ox, oy, false);
    else if (i === SCREEN_CELL.design) {
      // Design canvas: artboards with wireframe blocks.
      panel(ox, oy, "#1a1d26", "#232733");
      ctx.fillStyle = "#12141b"; ctx.fillRect(ox, oy + 18, 44, ch - 18); ctx.fillRect(ox + cw - 64, oy + 18, 64, ch - 18);
      for (const [ax, ay, aw, ah] of [[60, 36, 120, 180], [196, 36, 110, 84], [196, 132, 110, 84]]) {
        ctx.fillStyle = "#f1f4fb"; ctx.fillRect(ox + ax, oy + ay, aw, ah);
        ctx.fillStyle = "#d6def0"; ctx.fillRect(ox + ax + 8, oy + ay + 8, aw - 16, 22);
        ctx.fillStyle = "#3f8cff"; ctx.fillRect(ox + ax + 8, oy + ay + ah - 22, 40, 12);
        ctx.fillStyle = "#c3cde3"; for (let k = 0; k < 3; k++) ctx.fillRect(ox + ax + 8, oy + ay + 40 + k * 12, aw - 24 - k * 10, 5);
      }
      ctx.strokeStyle = "#3fb4ff"; ctx.lineWidth = 1.5; ctx.strokeRect(ox + 196, oy + 36, 110, 84);
    } else if (i === SCREEN_CELL.docs) {
      panel(ox, oy, "#141a28");
      ctx.fillStyle = "#171c28"; ctx.fillRect(ox + 70, oy + 26, cw - 140, ch - 34);
      ctx.fillStyle = "#e6ecfa"; ctx.fillRect(ox + 90, oy + 42, 150, 10);
      ctx.fillStyle = "rgba(210,222,245,.45)";
      for (let k = 0; k < 9; k++) ctx.fillRect(ox + 90, oy + 66 + k * 15, 170 + ((k * 37) % 50), 5);
    } else if (i === SCREEN_CELL.terminal) {
      // Idle terminal: only a prompt and a cursor.
      panel(ox, oy, "#07090e", "#10131b");
      ctx.font = `600 18px ${FONT_MONO}`; ctx.fillStyle = "#5ec8ff"; ctx.fillText("~/pensei-alto $", ox + 16, oy + 48);
      ctx.fillStyle = "#e8f1ff"; ctx.fillRect(ox + 172, oy + 34, 10, 18);
    } else if (i === SCREEN_CELL.review) {
      // Side-by-side reading layout (two neutral panes).
      panel(ox, oy, "#111829");
      ctx.fillStyle = "#1b2130"; ctx.fillRect(ox + cw / 2 - 1, oy + 18, 2, ch - 18);
      lines(ox, oy, 12, cw / 2 - 20, 12, code, 16);
      lines(ox, oy, cw / 2 + 12, cw / 2 - 20, 12, code, 16);
    } else {
      // Code editor (dark theme, blue/cyan syntax).
      panel(ox, oy, i === SCREEN_CELL.editor ? "#101b2e" : "#141a2e");
      ctx.fillStyle = "rgba(255,255,255,.035)"; ctx.fillRect(ox, oy + 18, 64, ch - 18);
      for (let l = 0; l < 8; l++) { ctx.fillStyle = "rgba(170,195,255,.22)"; ctx.fillRect(ox + 10, oy + 32 + l * 16, 40, 5); }
      lines(ox, oy, 78, cw - 90, 13, code);
    }
    const g = ctx.createRadialGradient(ox + cw / 2, oy + ch / 2, 30, ox + cw / 2, oy + ch / 2, cw * 0.72);
    g.addColorStop(0, "rgba(120,180,255,0.07)"); g.addColorStop(1, "rgba(0,0,0,0.18)");
    ctx.fillStyle = g; ctx.fillRect(ox, oy, cw, ch);
  }
}

export function monitorAtlas() {
  const { c, ctx } = canvas(384 * 4, 240 * 2);
  drawMonitorAtlas(ctx);
  const texture = finish(c);
  return { texture, redraw: () => { drawMonitorAtlas(ctx); texture.needsUpdate = true; } };
}

/**
 * Soft light atlas for fake indirect lighting on additive planes:
 * left half = radial pool, right half = vertical wash (bright at the bottom edge).
 */
export function glowAtlas() {
  const { c, ctx } = canvas(256, 128);
  const rg = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  rg.addColorStop(0, "rgba(255,255,255,0.9)"); rg.addColorStop(0.45, "rgba(255,255,255,0.28)"); rg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = rg; ctx.fillRect(0, 0, 128, 128);
  const lg = ctx.createLinearGradient(0, 128, 0, 0);
  lg.addColorStop(0, "rgba(255,255,255,0.85)"); lg.addColorStop(0.25, "rgba(255,255,255,0.3)"); lg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = lg; ctx.fillRect(130, 0, 124, 128);
  // Fade the wash at its left/right ends so strips blend into the walls.
  ctx.save();
  ctx.beginPath(); ctx.rect(128, 0, 128, 128); ctx.clip();
  ctx.globalCompositeOperation = "destination-in";
  const hg = ctx.createLinearGradient(128, 0, 256, 0);
  hg.addColorStop(0, "rgba(0,0,0,0)"); hg.addColorStop(0.12, "rgba(0,0,0,1)"); hg.addColorStop(0.88, "rgba(0,0,0,1)"); hg.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = hg; ctx.fillRect(128, 0, 128, 128);
  ctx.restore();
  return finish(c);
}

/** UV rectangles inside glowAtlas(). */
export const GLOW_UV = { pool: [0.02, 0.02, 0.48, 0.98], wash: [0.52, 0.0, 0.98, 1.0] } as const;

export function skylineTexture() {
  const { c, ctx } = canvas(1024, 256);
  const r = rng(99);
  const sky = ctx.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, "#050814"); sky.addColorStop(0.6, "#0e1a33"); sky.addColorStop(1, "#1c3558");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 1024, 256);
  for (let i = 0; i < 90; i++) { ctx.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.6})`; ctx.fillRect(r() * 1024, r() * 120, 1.5, 1.5); }
  for (let layer = 0; layer < 2; layer++) {
    let x = 0;
    while (x < 1024) {
      const w = 30 + r() * 70, h = (layer ? 70 : 110) + r() * (layer ? 90 : 100);
      ctx.fillStyle = layer ? "#070a14" : "#0e1528";
      ctx.fillRect(x, 256 - h, w, h);
      if (layer) for (let wy = 256 - h + 8; wy < 250; wy += 10) for (let wx = x + 5; wx < x + w - 6; wx += 9) {
        if (r() > 0.74) { ctx.fillStyle = r() > 0.6 ? "#8fd6ff" : "#e6eeff"; ctx.globalAlpha = 0.5 + r() * 0.5; ctx.fillRect(wx, wy, 4, 5); ctx.globalAlpha = 1; }
      }
      x += w + (layer ? 2 : 10);
    }
  }
  return finish(c);
}

/** Soft radial blob used for contact shadows and light pools. */
export function radialTexture(inner = "rgba(0,0,0,0.55)", outer = "rgba(0,0,0,0)") {
  const { c, ctx } = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, inner); g.addColorStop(1, outer);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  return finish(c, undefined, false);
}

export type DashboardData = {
  demands: { title: string; recipient: string; priority: string }[];
  demandCount: number;
  team: { name: string; zone: string; color: string }[];
  meeting: boolean;
};

/** Big wall screens. Only real, local data is shown; nothing pretends to run. */
export class WallScreen {
  readonly texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  constructor(public kind: "queue" | "team" | "meeting", private w = 1024, private h = 512) {
    const { c, ctx } = canvas(w, h);
    this.ctx = ctx;
    this.texture = finish(c);
  }
  draw(d: DashboardData) {
    const { ctx, w, h } = this;
    const accent = this.kind === "queue" ? "#5ec8ff" : this.kind === "team" ? "#e0b36a" : "#8f9dff";
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#0a111f"); bg.addColorStop(1, "#05080f");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(143,214,255,.06)"; ctx.lineWidth = 1;
    for (let y = 0; y < h; y += 4) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke(); }
    ctx.fillStyle = accent; ctx.fillRect(0, 0, 10, h);
    ctx.font = `700 40px ${FONT_DISPLAY}`; ctx.textBaseline = "top"; ctx.fillStyle = accent;
    const title = this.kind === "queue" ? "FILA DE DEMANDAS" : this.kind === "team" ? "EQUIPE & ESTAÇÕES" : "SALA DE REUNIÃO";
    ctx.fillText(title, 44, 36);
    ctx.font = `500 22px ${FONT_MONO}`; ctx.fillStyle = "rgba(220,232,255,.6)";
    const sub = this.kind === "queue" ? "preparadas · aguardando integração do motor" : this.kind === "team" ? `${d.team.length} funcionários no escritório` : d.meeting ? "equipe reunida" : "livre";
    ctx.fillText(sub, 44, 88);
    if (this.kind === "queue") {
      ctx.font = `800 150px ${FONT_DISPLAY}`; ctx.fillStyle = "#eaf6ff"; ctx.textAlign = "right";
      ctx.fillText(String(d.demandCount).padStart(2, "0"), w - 44, 20); ctx.textAlign = "left";
      if (!d.demands.length) {
        ctx.font = `500 28px ${FONT_MONO}`; ctx.fillStyle = "rgba(220,232,255,.45)";
        ctx.fillText("Nenhuma demanda preparada.", 44, 220);
        ctx.fillText("Fale com o Diretor para criar uma.", 44, 262);
      }
      d.demands.slice(0, 4).forEach((item, i) => {
        const y = 200 + i * 72;
        ctx.fillStyle = "rgba(143,214,255,.08)"; ctx.fillRect(44, y, w - 88, 58);
        ctx.fillStyle = item.priority === "alta" ? "#ff8a7a" : item.priority === "baixa" ? "#7df0b4" : "#ffd479";
        ctx.fillRect(44, y, 6, 58);
        ctx.font = `600 27px ${FONT_DISPLAY}`; ctx.fillStyle = "#eaf6ff";
        ctx.fillText(clip(ctx, item.title, w - 420), 68, y + 14);
        ctx.font = `500 20px ${FONT_MONO}`; ctx.fillStyle = "rgba(220,232,255,.6)"; ctx.textAlign = "right";
        ctx.fillText(clip(ctx, `→ ${item.recipient}`, 280), w - 64, y + 19); ctx.textAlign = "left";
      });
    } else if (this.kind === "team") {
      const cols = 2, rowH = 44;
      d.team.slice(0, 16).forEach((m, i) => {
        const x = 44 + (i % cols) * ((w - 88) / cols), y = 150 + Math.floor(i / cols) * rowH;
        ctx.fillStyle = m.color; ctx.beginPath(); ctx.arc(x + 10, y + 16, 9, 0, 7); ctx.fill();
        ctx.font = `600 25px ${FONT_DISPLAY}`; ctx.fillStyle = "#eaf6ff"; ctx.fillText(clip(ctx, m.name, 240), x + 32, y + 2);
        ctx.font = `500 18px ${FONT_MONO}`; ctx.fillStyle = "rgba(220,232,255,.5)"; ctx.fillText(m.zone.toUpperCase(), x + 290, y + 7);
      });
    } else {
      ctx.font = `800 64px ${FONT_DISPLAY}`; ctx.fillStyle = d.meeting ? "#d8c9ff" : "rgba(220,232,255,.35)";
      ctx.fillText(d.meeting ? "ALINHAMENTO" : "DISPONÍVEL", 44, 200);
      ctx.font = `500 24px ${FONT_MONO}`; ctx.fillStyle = "rgba(220,232,255,.55)";
      ctx.fillText(d.meeting ? "Reunião visual · sem execução de tarefas" : "Use “Reunir equipe” para trazer todos aqui", 44, 300);
    }
    this.texture.needsUpdate = true;
  }
  dispose() { this.texture.dispose(); }
}

function clip(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}
