// Shared domain types for the office UI. The browser never talks to a model:
// runs go through the local executor (see lib/engine and lib/executor).
import type { SheetConnection } from "@/lib/engine/connections";

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

/**
 * Operating procedure of a collaborator, split in sections so long texts stay
 * readable and so the future engine can consume each part explicitly.
 */
export type Playbook = {
  /** Missão: what this collaborator is accountable for. */
  mission: string;
  /** Insumos necessários: what it needs before starting. */
  inputs: string;
  /** Método de trabalho: ordered steps. */
  method: string;
  /** Critérios de qualidade: verifiable bar for its output. */
  quality: string;
  /** Quando pedir esclarecimento. */
  clarify: string;
  /** Como apresentar evidências. */
  evidence: string;
};
export type PlaybookKey = keyof Playbook;

/** Special hand-off target: the person who created the demand. */
export const USER_TARGET = "user";

/** Which default profile (and version) a collaborator's configuration came from. */
export type PresetRef = {
  /** Default collaborator id ("director", …) or hire template id ("frontend", …); null = created from scratch. */
  id: string | null;
  /** Version of the preset the current texts are based on (1 = texts from the first release). */
  version: number;
  /** Newest preset version the user chose to keep ignoring. */
  dismissedVersion?: number;
};

export type Agent = {
  id: string;
  name: string;
  role: string;
  /** Primary colour: outfit, label accent and portrait ring. */
  color: string;
  description: string;
  /**
   * Provider planned in older versions ("Claude", "OpenAI", …). Kept untouched
   * for compatibility; the engine uses `connection`.
   */
  model: Provider | string;
  /** Official client this collaborator runs through (see lib/engine/connections.ts). */
  connection: SheetConnection;
  /** Model passed to the client ("" = the client's default). */
  modelName: string;
  /** Reasoning effort passed to the client ("" = the client's default). */
  effort: string;
  /** Structured operating procedure (see Playbook). */
  playbook: Playbook;
  /** Instruções complementares: free text kept from older versions or added by the user. */
  instructions: string;
  limits: string;
  deliverable: string;
  /** Regras de encaminhamento (text the engine must follow when routing). */
  handoff: string;
  /** Encaminha para: who receives the work when this step is done (agent ids). */
  handoffTo: string[];
  /** Devolve pendências para: who receives blocked/failed work (agent ids or USER_TARGET). */
  returnTo: string[];
  /** Maximum number of times this collaborator may send the same demand back (null = not defined). */
  maxCycles: number | null;
  /** Token budget per run: a Setor IA limit checked by estimate before and by reported usage after (not the subscription limit). */
  budget: number;
  tools: Record<ToolKey, boolean>;
  custom: boolean;
  zone: WorkZoneId;
  stationId: string;
  look: Appearance;
  preset: PresetRef;
};

export type DemandPriority = "baixa" | "normal" | "alta";
export type DemandSource = "github" | "folder" | "none" | "local";

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

/**
 * "Projeto local autorizado": a project the executor knows by id, a reference (branch/tag/commit) and the full SHA
 * it resolved to when the user looked at it. Only the id and the SHA authorize anything; the rest is for display.
 */
export type LocalSource = { projectId: string; projectLabel: string; owner: string; repo: string; ref: string; commit: string; subject: string; resolvedAt: string };

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
  local?: LocalSource;
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
