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

export type FloorKind = "concrete" | "wood" | "carpetTeal" | "carpetCoral" | "carpetViolet" | "tiles";

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
  if (kind === "wood") {
    const planks = 6;
    for (let i = 0; i < planks; i++) {
      const hue = 24 + r() * 8, light = 30 + r() * 7;
      ctx.fillStyle = `hsl(${hue} 38% ${light}%)`;
      ctx.fillRect(0, (i * size) / planks, size, size / planks);
      ctx.fillStyle = "rgba(0,0,0,.28)";
      ctx.fillRect(0, (i * size) / planks, size, 1.5);
      const off = r() * size;
      ctx.fillRect(off, (i * size) / planks, 1.5, size / planks);
      for (let g = 0; g < 7; g++) {
        ctx.strokeStyle = `rgba(40,20,10,${0.08 + r() * 0.1})`;
        ctx.beginPath();
        const y = (i * size) / planks + r() * (size / planks);
        ctx.moveTo(0, y); ctx.bezierCurveTo(size * 0.3, y + 3, size * 0.6, y - 3, size, y + 1); ctx.stroke();
      }
    }
    noise(0.05);
  } else if (kind === "concrete" || kind === "tiles") {
    ctx.fillStyle = kind === "concrete" ? "#23263a" : "#2a2f45";
    ctx.fillRect(0, 0, size, size);
    noise(0.07, 5000);
    ctx.strokeStyle = kind === "concrete" ? "rgba(140,160,220,.09)" : "rgba(160,180,240,.12)";
    ctx.lineWidth = 2;
    const step = kind === "concrete" ? 128 : 64;
    for (let x = 0; x <= size; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke(); }
    for (let y = 0; y <= size; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke(); }
  } else {
    const base = kind === "carpetTeal" ? [186, 30, 20] : kind === "carpetCoral" ? [12, 28, 22] : [258, 26, 23];
    // Carpet tiles with alternating pile direction.
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const l = base[2] + ((x + y) % 2 ? 1.6 : -0.8) + r() * 0.8;
      ctx.fillStyle = `hsl(${base[0]} ${base[1]}% ${l}%)`;
      ctx.fillRect(x * 64, y * 64, 64, 64);
      ctx.strokeStyle = "rgba(0,0,0,.12)";
      ctx.strokeRect(x * 64 + 0.5, y * 64 + 0.5, 63, 63);
    }
    noise(0.06, 6000);
  }
  return finish(c, repeat);
}

/** Monitor atlas: 4×2 cells of 256×160, each a different calm "screen". */
export const MONITOR_CELLS = { cols: 4, rows: 2 };
export function monitorAtlas() {
  const cw = 256, ch = 160;
  const { c, ctx } = canvas(cw * 4, ch * 2);
  const r = rng(4242);
  const themes = [
    { bg: "#0d1a2b", bar: "#17304a", colors: ["#7ee0ff", "#c29bff", "#ffd479", "#7df0b4"] },
    { bg: "#141224", bar: "#241f3d", colors: ["#ff9ec7", "#8fb8ff", "#ffe08a", "#b2f5a5"] },
    { bg: "#0b1512", bar: "#11261f", colors: ["#6cf0a6", "#6cf0a6", "#b8ffd7", "#3fbf7f"] },
    { bg: "#1a1320", bar: "#2d2034", colors: ["#ffb38a", "#ff8d8d", "#ffe3a3", "#9fe6ff"] },
  ];
  for (let i = 0; i < 8; i++) {
    const ox = (i % 4) * cw, oy = Math.floor(i / 4) * ch;
    const th = themes[i % themes.length];
    ctx.fillStyle = th.bg; ctx.fillRect(ox, oy, cw, ch);
    ctx.fillStyle = th.bar; ctx.fillRect(ox, oy, cw, 14);
    for (let d = 0; d < 3; d++) { ctx.fillStyle = ["#ff6b6b", "#ffd166", "#6be38f"][d]; ctx.beginPath(); ctx.arc(ox + 10 + d * 10, oy + 7, 3, 0, 7); ctx.fill(); }
    if (i === 3 || i === 7) {
      // Kanban / checklist cell.
      for (let col = 0; col < 3; col++) {
        ctx.fillStyle = "rgba(255,255,255,.05)"; ctx.fillRect(ox + 10 + col * 80, oy + 22, 72, ch - 30);
        for (let k = 0; k < 2 + Math.floor(r() * 3); k++) { ctx.fillStyle = th.colors[(col + k) % 4]; ctx.globalAlpha = 0.8; ctx.fillRect(ox + 15 + col * 80, oy + 30 + k * 26, 62, 18); ctx.globalAlpha = 1; }
      }
    } else if (i === 2 || i === 6) {
      // Test runner style.
      for (let l = 0; l < 9; l++) {
        const ok = r() > 0.12;
        ctx.fillStyle = ok ? "#58e39a" : "#ff7a7a"; ctx.fillRect(ox + 12, oy + 24 + l * 14, 8, 8);
        ctx.fillStyle = "rgba(220,240,255,.55)"; ctx.fillRect(ox + 28, oy + 25 + l * 14, 60 + r() * 120, 6);
      }
    } else {
      // Code editor: sidebar + indented lines.
      ctx.fillStyle = "rgba(255,255,255,.04)"; ctx.fillRect(ox, oy + 14, 46, ch - 14);
      for (let l = 0; l < 6; l++) { ctx.fillStyle = "rgba(200,220,255,.25)"; ctx.fillRect(ox + 8, oy + 24 + l * 14, 28, 5); }
      let indent = 0;
      for (let l = 0; l < 10; l++) {
        indent = Math.max(0, Math.min(3, indent + (r() > 0.6 ? 1 : r() > 0.7 ? -1 : 0)));
        let x = ox + 56 + indent * 12;
        const y = oy + 22 + l * 13;
        const tokens = 1 + Math.floor(r() * 4);
        for (let t = 0; t < tokens && x < ox + cw - 20; t++) {
          const w = 10 + r() * 44;
          ctx.fillStyle = th.colors[Math.floor(r() * 4)];
          ctx.globalAlpha = 0.85; ctx.fillRect(x, y, w, 6); ctx.globalAlpha = 1;
          x += w + 6;
        }
      }
    }
    // Soft vignette so screens read as glowing glass.
    const g = ctx.createRadialGradient(ox + cw / 2, oy + ch / 2, 20, ox + cw / 2, oy + ch / 2, cw * 0.7);
    g.addColorStop(0, "rgba(255,255,255,0.04)"); g.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = g; ctx.fillRect(ox, oy, cw, ch);
  }
  return finish(c);
}

export function skylineTexture() {
  const { c, ctx } = canvas(1024, 256);
  const r = rng(99);
  const sky = ctx.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, "#0b0f2a"); sky.addColorStop(0.6, "#241a45"); sky.addColorStop(1, "#4a2a55");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 1024, 256);
  for (let i = 0; i < 90; i++) { ctx.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.6})`; ctx.fillRect(r() * 1024, r() * 120, 1.5, 1.5); }
  for (let layer = 0; layer < 2; layer++) {
    let x = 0;
    while (x < 1024) {
      const w = 30 + r() * 70, h = (layer ? 70 : 110) + r() * (layer ? 90 : 100);
      ctx.fillStyle = layer ? "#0d0c1f" : "#16143a";
      ctx.fillRect(x, 256 - h, w, h);
      if (layer) for (let wy = 256 - h + 8; wy < 250; wy += 10) for (let wx = x + 5; wx < x + w - 6; wx += 9) {
        if (r() > 0.72) { ctx.fillStyle = r() > 0.5 ? "#ffd98a" : "#8fd6ff"; ctx.globalAlpha = 0.5 + r() * 0.5; ctx.fillRect(wx, wy, 4, 5); ctx.globalAlpha = 1; }
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
    const accent = this.kind === "queue" ? "#8fd6ff" : this.kind === "team" ? "#f0bd5e" : "#b69cff";
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#0c1326"); bg.addColorStop(1, "#070b18");
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
