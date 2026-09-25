// Integration points for the future backend (agent engine, GitHub access,
// folder upload, delegation). Nothing in this file performs network calls.
// The UI only builds payloads and shows them; `orchestrator` is intentionally
// "not connected" so no demand can look executed in this phase.
import type { Agent, Demand, FolderSummary, Playbook } from "@/lib/office/types";
import { USER_TARGET } from "@/lib/office/types";
import { TOOL_INFO } from "@/lib/office/defaults";

export const DEMAND_SCHEMA = "setor-ia.demand/v2" as const;
export const AGENT_SCHEMA = "setor-ia.agent/v2" as const;

/**
 * Everything the engine needs to run one collaborator, taken verbatim from the
 * saved sheet. The engine must build its prompts from these fields (or from
 * `brief`, which is derived from them) and nothing else.
 */
export type AgentProfilePayload = {
  schema: typeof AGENT_SCHEMA;
  id: string;
  name: string;
  role: string;
  /** Especialidade. */
  specialty: string;
  playbook: Playbook;
  /** Instruções complementares (may be empty). */
  instructions: string;
  limits: string;
  deliverable: string;
  routing: {
    /** Encaminha para (agent ids). */
    handoffTo: string[];
    /** Devolve pendências para (agent ids or "user"). */
    returnTo: string[];
    /** Maximum returns of the same demand by this collaborator; null = not defined. */
    maxCycles: number | null;
    /** Regras de encaminhamento, as written by the user. */
    rules: string;
  };
  /** Planned permissions only. */
  toolsPlanned: string[];
  /** Tools actually connected. Always empty in this phase. */
  toolsConnected: string[];
  /** Planned token budget per task; not enforced yet. */
  budget: { tokensPerTask: number; enforced: false };
  provider: string;
  modelName: string;
  preset: Agent["preset"];
  /** Human-readable composition of the fields above, shown in the sheet ("Prévia"). */
  brief: string;
};

export type DemandPayload = {
  schema: typeof DEMAND_SCHEMA;
  status: "prepared";
  engine: IntegrationStatus;
  demand: Pick<Demand, "id" | "title" | "description" | "acceptanceCriteria" | "project" | "priority" | "createdAt">;
  assignee: AgentProfilePayload;
  /** The whole team, so the engine can resolve hand-offs. */
  team: AgentProfilePayload[];
  source:
    | { kind: "github"; url: string; owner: string; repo: string; branch: string | null }
    | { kind: "folder"; summary: FolderSummary; note: "files-not-uploaded" }
    | { kind: "none" };
};

const SECTIONS: [keyof Playbook, string][] = [
  ["mission", "Missão"], ["inputs", "Insumos necessários"], ["method", "Método de trabalho"],
  ["quality", "Critérios de qualidade"], ["clarify", "Quando pedir esclarecimento"], ["evidence", "Como apresentar evidências"],
];

const targetName = (id: string, team: Agent[]) => (id === USER_TARGET ? "Solicitante (usuário)" : team.find(a => a.id === id)?.name ?? id);

/** Deterministic text built only from the saved sheet. Empty sections are omitted. */
export function agentBrief(a: Agent, team: Agent[]): string {
  const NL = "\n";
  const section = (title: string, body: string) => `## ${title}${NL}${body}`;
  const out: string[] = [`# ${a.name} — ${a.role}`];
  if (a.description.trim()) out.push(`Especialidade: ${a.description.trim()}`);
  for (const [k, label] of SECTIONS) if (a.playbook[k].trim()) out.push(section(label, a.playbook[k].trim()));
  if (a.limits.trim()) out.push(section("Limites e restrições", a.limits.trim()));
  if (a.deliverable.trim()) out.push(section("Formato de entrega", a.deliverable.trim()));
  const routing = [
    `Encaminha para: ${a.handoffTo.length ? a.handoffTo.map(id => targetName(id, team)).join(", ") : "ninguém definido"}.`,
    `Devolve pendências para: ${a.returnTo.length ? a.returnTo.map(id => targetName(id, team)).join(", ") : "ninguém definido"}.`,
    `Máximo de devoluções por demanda: ${a.maxCycles ?? "não definido"}.`,
  ];
  if (a.handoff.trim()) routing.push(a.handoff.trim());
  out.push(section("Encaminhamento", routing.join(NL)));
  if (a.instructions.trim()) out.push(section("Instruções complementares", a.instructions.trim()));
  const planned = TOOL_INFO.filter(t => a.tools[t.key]).map(t => t.label);
  out.push(section("Ferramentas", `Permissões planejadas: ${planned.length ? planned.join(", ") : "nenhuma"}. Nenhuma ferramenta está conectada nesta fase.`));
  out.push(section("Orçamento", `${a.budget.toLocaleString("pt-BR")} tokens por tarefa (planejado, ainda não aplicado).`));
  return out.join(NL + NL);
}

export function agentProfile(a: Agent, team: Agent[] = [a]): AgentProfilePayload {
  return {
    schema: AGENT_SCHEMA,
    id: a.id, name: a.name, role: a.role, specialty: a.description,
    playbook: { ...a.playbook }, instructions: a.instructions, limits: a.limits, deliverable: a.deliverable,
    routing: { handoffTo: [...a.handoffTo], returnTo: [...a.returnTo], maxCycles: a.maxCycles, rules: a.handoff },
    toolsPlanned: Object.entries(a.tools).filter(([, on]) => on).map(([k]) => k),
    toolsConnected: [],
    budget: { tokensPerTask: a.budget, enforced: false },
    provider: String(a.model), modelName: a.modelName, preset: { ...a.preset },
    brief: agentBrief(a, team),
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
  return {
    schema: DEMAND_SCHEMA, status: "prepared", engine: orchestrator.status,
    demand: { id, title, description, acceptanceCriteria, project, priority, createdAt },
    assignee: agentProfile(assignee, agents), team: agents.map(a => agentProfile(a, agents)), source,
  };
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
