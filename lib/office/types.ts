// Shared domain types for the office UI. Nothing here talks to a backend yet;
// see lib/integration/contracts.ts for the shapes a future engine will receive.

export type ZoneId = "director" | "dev" | "qa" | "meeting" | "lounge";
/** Zones that own workstations (the meeting room and lounge are shared spaces). */
export type WorkZoneId = "director" | "dev" | "qa";

export type ToolKey = "read" | "edit" | "terminal" | "github" | "browser";

export type HairStyle = "short" | "slick" | "spiky" | "curly" | "bun" | "long" | "ponytail" | "bald" | "mohawk";
export type Outfit = "blazer" | "hoodie" | "sweater" | "vest" | "tee" | "labcoat";
export type Accessory = "none" | "glasses" | "headphones" | "headset" | "cap" | "beanie" | "beard";

export type Appearance = {
  skin: string;
  hair: HairStyle;
  hairColor: string;
  outfit: Outfit;
  accessory: Accessory;
  pants: string;
};

export type Provider = "A definir" | "OpenAI" | "Claude" | "Outro provedor";

export type Agent = {
  id: string;
  name: string;
  role: string;
  /** Primary colour: outfit, label accent and portrait ring. */
  color: string;
  description: string;
  /** Planned provider. Historical field name kept for storage compatibility. */
  model: Provider | string;
  /** Planned model name (free text, e.g. "claude-sonnet-5"). Never used to call an API here. */
  modelName: string;
  instructions: string;
  limits: string;
  deliverable: string;
  /** Free-text notes about hand-offs (legacy field, still editable). */
  handoff: string;
  /** Structured hand-off targets (agent ids). */
  handoffTo: string[];
  budget: number;
  tools: Record<ToolKey, boolean>;
  custom: boolean;
  zone: WorkZoneId;
  stationId: string;
  look: Appearance;
};

export type DemandPriority = "baixa" | "normal" | "alta";
export type DemandSource = "github" | "folder" | "none";

export type FolderSummary = {
  name: string;
  fileCount: number;
  totalBytes: number;
  /** Most common extensions, e.g. [["ts", 120], ["css", 8]]. */
  topExtensions: [string, number][];
  hasPackageJson: boolean;
  hasGitDir: boolean;
};

export type RepoRef = { url: string; owner: string; repo: string; branch: string };

export type Demand = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  project: string;
  priority: DemandPriority;
  recipient: string;
  source: DemandSource;
  /** Human readable source (URL or folder name). Kept for v1 compatibility. */
  sourceLabel: string;
  fileCount: number;
  repo?: RepoRef;
  folder?: FolderSummary;
  /** Always "prepared" in this phase: nothing executes demands yet. */
  status: "prepared";
  createdAt: string;
};

export type Station = {
  id: string;
  zone: WorkZoneId;
  x: number;
  z: number;
  /** Rotation around Y; 0 means the seated worker faces +Z. */
  facing: number;
  kind: "desk" | "executive";
  /** Monitor setup: two 24" screens on an arm, or one curved 34" ultrawide. */
  monitors: "dual" | "ultrawide";
  /** Waypoints from the chair to the zone door (used by the meeting walk). */
  exit: [number, number][];
};
