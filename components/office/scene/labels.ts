// Screen-space label placement. Pure and framework-free so it can run every
// frame: greedy by priority, tries a few vertical lifts, then falls back to a
// compact dot, then hides. Previous placements are tried first (no flicker).

export type LabelKind = "worker" | "zone";
export type LabelIn = { id: string; kind: LabelKind; x: number; y: number; w: number; h: number; priority: number; onScreen: boolean };
export type LabelMode = "full" | "compact" | "hidden";
export type LabelOut = { id: string; left: number; top: number; mode: LabelMode; lift: number };
type Rect = { l: number; t: number; r: number; b: number };

const LIFTS = [0, 26, 52];
const COMPACT = 22;
const GAP = 4;

const hit = (a: Rect, b: Rect) => a.l < b.r + GAP && a.r + GAP > b.l && a.t < b.b + GAP && a.b + GAP > b.t;

export function layoutLabels(items: LabelIn[], view: { w: number; h: number }, blocked: Rect[], prev: Map<string, LabelOut>): LabelOut[] {
  const placed: Rect[] = [...blocked];
  const out: LabelOut[] = [];
  const order = [...items].sort((a, b) => b.priority - a.priority || b.y - a.y);
  const inView = (r: Rect) => r.l >= 2 && r.t >= 2 && r.r <= view.w - 2 && r.b <= view.h - 2;
  const free = (r: Rect) => inView(r) && !placed.some(p => hit(p, r));

  for (const it of order) {
    if (!it.onScreen) { out.push({ id: it.id, left: it.x, top: it.y, mode: "hidden", lift: 0 }); continue; }
    const before = prev.get(it.id);
    if (it.kind === "zone") {
      const shifts = [0, -48, 48, -96, 96];
      let done = false;
      for (const dx of shifts) {
        const r = { l: it.x - it.w / 2 + dx, t: it.y - it.h / 2, r: it.x + it.w / 2 + dx, b: it.y + it.h / 2 };
        if (free(r)) { placed.push(r); out.push({ id: it.id, left: r.l, top: r.t, mode: "full", lift: 0 }); done = true; break; }
      }
      if (!done) out.push({ id: it.id, left: it.x, top: it.y, mode: "hidden", lift: 0 });
      continue;
    }
    const lifts = before && before.mode === "full" ? [before.lift, ...LIFTS.filter(l => l !== before.lift)] : LIFTS;
    let done = false;
    for (const lift of lifts) {
      const r = { l: it.x - it.w / 2, t: it.y - it.h - 6 - lift, r: it.x + it.w / 2, b: it.y - 6 - lift };
      if (free(r)) { placed.push(r); out.push({ id: it.id, left: r.l, top: r.t, mode: "full", lift }); done = true; break; }
    }
    if (done) continue;
    const c = { l: it.x - COMPACT / 2, t: it.y - COMPACT - 4, r: it.x + COMPACT / 2, b: it.y - 4 };
    if (free(c)) { placed.push(c); out.push({ id: it.id, left: c.l, top: c.t, mode: "compact", lift: 0 }); }
    else out.push({ id: it.id, left: c.l, top: c.t, mode: it.priority >= 3 ? "compact" : "hidden", lift: 0 });
  }
  return out;
}
