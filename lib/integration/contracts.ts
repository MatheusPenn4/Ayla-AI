// Integration points for the future backend (agent engine, GitHub access,
// folder upload, delegation). Nothing in this file performs network calls.
// The UI only builds payloads and shows them; `orchestrator` is intentionally
// "not connected" so no demand can look executed in this phase.
import type { Agent, Demand, FolderSummary } from "@/lib/office/types";

export const DEMAND_SCHEMA = "setor-ia.demand/v1" as const;

export type AgentProfilePayload = Pick<Agent, "id" | "name" | "role" | "description" | "instructions" | "limits" | "deliverable" | "budget" | "handoffTo"> & {
  provider: string;
  modelName: string;
  tools: string[];
};

export type DemandPayload = {
  schema: typeof DEMAND_SCHEMA;
  demand: Pick<Demand, "id" | "title" | "description" | "acceptanceCriteria" | "project" | "priority" | "createdAt">;
  assignee: AgentProfilePayload;
  /** The whole team, so the engine can resolve hand-offs. */
  team: AgentProfilePayload[];
  source:
    | { kind: "github"; url: string; owner: string; repo: string; branch: string | null }
    | { kind: "folder"; summary: FolderSummary; note: "files-not-uploaded" }
    | { kind: "none" };
};

export function agentProfile(a: Agent): AgentProfilePayload {
  return {
    id: a.id, name: a.name, role: a.role, description: a.description, instructions: a.instructions, limits: a.limits,
    deliverable: a.deliverable, budget: a.budget, handoffTo: a.handoffTo, provider: String(a.model), modelName: a.modelName,
    tools: Object.entries(a.tools).filter(([, on]) => on).map(([k]) => k),
  };
}

export function buildDemandPayload(demand: Demand, agents: Agent[]): DemandPayload {
  const assignee = agents.find(a => a.id === demand.recipient) ?? agents[0];
  const source: DemandPayload["source"] =
    demand.source === "github" && demand.repo
      ? { kind: "github", url: demand.repo.url, owner: demand.repo.owner, repo: demand.repo.repo, branch: demand.repo.branch || null }
      : demand.source === "folder" && demand.folder
        ? { kind: "folder", summary: demand.folder, note: "files-not-uploaded" }
        : { kind: "none" };
  const { id, title, description, acceptanceCriteria, project, priority, createdAt } = demand;
  return { schema: DEMAND_SCHEMA, demand: { id, title, description, acceptanceCriteria, project, priority, createdAt }, assignee: agentProfile(assignee), team: agents.map(agentProfile), source };
}

export type IntegrationStatus = "not_connected" | "connected";

export interface OrchestratorAdapter {
  readonly status: IntegrationStatus;
  /** Sends a prepared demand to the engine. Must be implemented server-side (credentials never live in the browser). */
  submit(payload: DemandPayload): Promise<{ runId: string }>;
}

export class NotConnectedError extends Error {
  constructor() {
    super("O motor de agentes ainda não está conectado. A demanda permanece preparada na fila local.");
  }
}

export const orchestrator: OrchestratorAdapter = {
  status: "not_connected",
  submit: async () => { throw new NotConnectedError(); },
};

/**
 * Folder selection only keeps metadata. Paths are read from the browser's File
 * objects (webkitRelativePath) and never leave the device in this phase.
 */
export function summarizeFolder(files: File[]): FolderSummary {
  const counts = new Map<string, number>();
  let totalBytes = 0, hasPackageJson = false, hasGitDir = false;
  const first = files[0]?.webkitRelativePath || "";
  const name = first.split("/")[0] || "Pasta selecionada";
  for (const f of files) {
    totalBytes += f.size;
    const path = f.webkitRelativePath || f.name;
    const parts = path.split("/");
    if (parts.length === 2 && parts[1] === "package.json") hasPackageJson = true;
    if (parts.includes(".git")) { hasGitDir = true; continue; }
    if (parts.includes("node_modules")) continue;
    const dot = f.name.lastIndexOf(".");
    const ext = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : "sem extensão";
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  const topExtensions = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { name, fileCount: files.length, totalBytes, topExtensions, hasPackageJson, hasGitDir };
}

/** Parses https://github.com/owner/repo[/tree/branch][.git]. */
export function parseGithubUrl(input: string): { owner: string; repo: string; branch: string } | null {
  const m = /^https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^?#\s]+?)|\/[^\s?#]*)?\/?(?:[?#]\S*)?$/i.exec(input.trim());
  if (m && m[2].toLowerCase() === ".git") return null;
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3] ? decodeURIComponent(m[3]) : "" };
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
