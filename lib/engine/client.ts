// Browser-side calls to the engine API (Next routes that forward to the local
// executor). No secrets here: the executor token stays on the server.
import { agentBrief } from "@/lib/integration/contracts";
import type { Agent, Demand } from "@/lib/office/types";
import type { DeveloperPreview } from "./developer-preview";
import type { ApiConnectionRecord, ApiProvider, ConnectionId, ConnectionStatus, EngineStatus, RunDetail, RunRecord, SourceComparison, StartRunRequest, TaskCompletion, TeamMemberInput } from "./types";

const HEADERS = { "content-type": "application/json", "x-ayla-client": "web" };

/** Follow-up of a hand-off: how each earlier question was resolved and which source/commit to read. */
export type HandoffFollowUp = {
  previousRunId?: string;
  answers?: { question: string; answer: string }[];
  technical?: { question: string; files: string[] }[];
  decisions?: { topic: string; answer: string }[];
  source?: { via: "github" | "local_git"; commit: string };
  revisionReason?: string;
  /** Files confirmed for reading (path or path#Symbol). */
  files?: string[];
};

/** Commits and suggested files for a first hand-off (see lib/executor/handoff.ts#sourceOptions). */
export type SourceOptions = {
  directorCommit: string | null; owner: string | null; repo: string | null;
  dependencies: { taskId: string; runId: string; revision: number | null; commit: string | null; via: "github" | "local_git" | null }[];
  localRepos: { dirName: string; head: string; headSubject: string }[];
  proposed: { via: "github" | "local_git"; commit: string; why: string } | null;
  suggestedFiles: { ref: string; reason: string }[];
  comparisons: SourceComparison[];
  previous: { runId: string; status: string; revision: number | null; commit: string | null; via: "github" | "local_git" | null; files: string[] } | null;
};

export class EngineApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: string[]) { super(message); }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init?.headers ?? {}) }, cache: "no-store" }); }
  catch { throw new EngineApiError("network", "Não foi possível falar com o servidor local.", 0); }
  const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: string[] } } & T;
  if (!res.ok && body.error) throw new EngineApiError(body.error.code, body.error.message, res.status, body.error.details);
  if (!res.ok) throw new EngineApiError("http_" + res.status, `O servidor respondeu ${res.status}.`, res.status);
  return body;
}

export function toTeamInput(a: Agent, team: Agent[]): TeamMemberInput {
  return {
    id: a.id, name: a.name, role: a.role, specialty: a.description, connection: a.connection, modelName: a.modelName.trim(), effort: a.effort,
    budget: a.budget, handoffTo: a.handoffTo, returnTo: a.returnTo, maxCycles: a.maxCycles, tools: { ...a.tools },
    brief: agentBrief(a, team), playbook: { ...a.playbook }, limits: a.limits, deliverable: a.deliverable, rules: a.handoff,
  };
}

export function buildStartRequest(demand: Demand, agents: Agent[], directorId: string, idempotencyKey: string, followUp?: { previousRunId: string; answers: { question: string; answer: string }[] }): StartRunRequest {
  return {
    idempotencyKey,
    directorId,
    team: agents.map(a => toTeamInput(a, agents)),
    demand: {
      id: demand.id, title: demand.title, description: demand.description, acceptanceCriteria: demand.acceptanceCriteria, project: demand.project,
      priority: demand.priority, source: demand.source,
      ...(demand.source === "github" && demand.repo ? { repo: demand.repo } : {}),
      ...(demand.source === "folder" && demand.folder ? { folder: demand.folder } : {}),
    },
    ...(followUp ? { previousRunId: followUp.previousRunId, answers: followUp.answers } : {}),
  };
}

export const engineApi = {
  status: (refresh = false) => call<EngineStatus>(`/api/engine/status${refresh ? "?refresh=1" : ""}`),
  checkConnections: () => call<Omit<EngineStatus, "executionEnabled" | "disabledReason">>("/api/engine/connections", { method: "POST", body: "{}" }),
  probe: (id: ConnectionId) => call<{ ok: boolean; status: ConnectionStatus; message: string; code?: string; detail?: string }>("/api/engine/connections", { method: "POST", body: JSON.stringify({ id, probe: true }) }),
  start: (req: StartRunRequest) => call<{ run: RunRecord; created: boolean }>("/api/runs", { method: "POST", body: JSON.stringify(req) }),
  list: (demandIds: string[]) => call<{ runs: RunRecord[] }>(`/api/runs?demands=${demandIds.map(encodeURIComponent).join(",")}`),
  get: (id: string) => call<{ run: RunDetail }>(`/api/runs/${id}`),
  cancel: (id: string) => call<{ run: RunRecord; canceled: boolean }>(`/api/runs/${id}/cancel`, { method: "POST" }),
  /** Hand-off step 1: the executor validates the task and returns the frozen content for review (status awaiting_approval). */
  prepareHandoff: (req: { idempotencyKey: string; directorRunId: string; taskId: string; agent: TeamMemberInput } & HandoffFollowUp) =>
    call<{ run: RunDetail; created: boolean }>("/api/handoffs", { method: "POST", body: JSON.stringify(req) }),
  /** Before step 1: commits and suggested files to choose from (read-only). */
  sourceOptions: (planRunId: string, taskId: string) => call<SourceOptions>(`/api/handoffs/source-options?plan=${planRunId}&task=${encodeURIComponent(taskId)}`),
  /** Preview of a future Developer hand-off (a view: no run, no model call, no write access). */
  developerPreview: (planRunId: string, taskId: string) => call<{ preview: DeveloperPreview }>(`/api/developer-preview?plan=${planRunId}&task=${encodeURIComponent(taskId)}`),
  /**
   * Developer hand-off step 1: freezes the review. No working copy is built and no model is called here.
   * editScope is chosen explicitly by the user (never inferred from the Architect's text) and is checked
   * against the real tree of the chosen commit before the hand-off is frozen.
   */
  prepareDeveloperHandoff: (req: { idempotencyKey: string; directorRunId: string; taskId: string; agent: TeamMemberInput; source?: { commit: string }; revisionReason?: string; editScope: { path: string; action: "alterar" | "criar" | "consultar" }[] }) =>
    call<{ run: RunDetail; created: boolean }>("/api/developer-handoffs", { method: "POST", body: JSON.stringify(req) }),
  /** QA hand-off step 1: freezes the review. No model is called here. */
  prepareQAHandoff: (req: { idempotencyKey: string; directorRunId: string; taskId: string; agent: TeamMemberInput }) =>
    call<{ run: RunDetail; created: boolean }>("/api/qa-handoffs", { method: "POST", body: JSON.stringify(req) }),
  /** Reviewer hand-off step 1: freezes the review. No model is called here. */
  prepareReviewerHandoff: (req: { idempotencyKey: string; directorRunId: string; taskId: string; agent: TeamMemberInput }) =>
    call<{ run: RunDetail; created: boolean }>("/api/reviewer-handoffs", { method: "POST", body: JSON.stringify(req) }),
  /** Hand-off step 2: the user's confirmation of exactly that content (Architect, Developer, QA or Reviewer). */
  approve: (id: string, snapshotHash: string) => call<{ run: RunRecord; approved: boolean }>(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ snapshotHash }) }),
  /** Every validated task-completion of a plan (evidence dependencyEvidence() accepts as "done" beyond a completed run). */
  listCompletions: (planRunId: string) => call<{ completions: TaskCompletion[] }>(`/api/runs/${planRunId}/completions`),
  /** API-key connections configured in Configurações → Conexões de IA — masked; the key itself never reaches the browser. */
  listApiConnections: () => call<{ apiConnections: ApiConnectionRecord[] }>("/api/api-connections"),
  createApiConnection: (req: { provider: ApiProvider; label: string; apiKey: string; model?: string; effort?: string }) =>
    call<{ apiConnection: ApiConnectionRecord }>("/api/api-connections", { method: "POST", body: JSON.stringify(req) }),
  /** Real minimal call through the stored key (uses a little of the API's own paid usage). Only on explicit request. */
  verifyApiConnection: (id: string) => call<{ ok: boolean; apiConnection: ApiConnectionRecord; message: string; code?: string; detail?: string }>(`/api/api-connections/${id}/verify`, { method: "POST", body: "{}" }),
  deleteApiConnection: (id: string) => call<{ removed: boolean }>(`/api/api-connections/${id}`, { method: "DELETE" }),
};
