// Render quality tiers. "auto" starts from a GPU/DPR guess and steps down
// once if the measured frame time is too high (e.g. MacBook Pro 2016 on a
// Retina display, or software rendering).
export type Tier = "high" | "balanced" | "low";

export type TierSettings = {
  maxDpr: number;
  shadows: boolean;
  shadowMap: number;
  pointLights: number;
  maxFps: number;
  anisotropy: number;
};

export const TIERS: Record<Tier, TierSettings> = {
  high: { maxDpr: 2, shadows: true, shadowMap: 2048, pointLights: 5, maxFps: 60, anisotropy: 8 },
  balanced: { maxDpr: 1.5, shadows: true, shadowMap: 1024, pointLights: 3, maxFps: 60, anisotropy: 4 },
  low: { maxDpr: 1, shadows: false, shadowMap: 512, pointLights: 0, maxFps: 30, anisotropy: 1 },
};

export const TIER_LABEL: Record<Tier, string> = { high: "Alta", balanced: "Equilibrada", low: "Leve" };

export function detectTier(gl: WebGL2RenderingContext): Tier {
  let renderer = "";
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
  } catch { /* some browsers hide the renderer string */ }
  if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(renderer)) return "low";
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent) || window.innerWidth < 700;
  if (mobile || cores <= 4) return "balanced";
  // Integrated GPUs (Intel Iris/UHD, older Radeon Pro on laptops) → balanced.
  if (/intel|iris|uhd|hd graphics|radeon pro 4|radeon pro 5|mali|adreno|powervr/.test(renderer)) return "balanced";
  return "high";
}

export const lowerTier = (t: Tier): Tier => (t === "high" ? "balanced" : "low");

/** Rolling frame-time monitor used by the "auto" preference. */
export class FrameBudget {
  private samples: number[] = [];
  private warm = 0;
  private downgrades = 0;
  constructor(private maxDowngrades = 2) {}
  reset() { this.samples = []; this.warm = 0; }
  /** Returns true when the scene should drop one tier. */
  push(dtMs: number) {
    if (this.downgrades >= this.maxDowngrades) return false;
    this.warm += dtMs;
    if (this.warm < 2500) return false; // ignore shader compilation hitches
    if (dtMs > 250) return false; // tab switch / breakpoint
    this.samples.push(dtMs);
    if (this.samples.length < 150) return false;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.samples = [];
    if (median > 26) { this.downgrades++; this.warm = 0; return true; }
    return false;
  }
}
