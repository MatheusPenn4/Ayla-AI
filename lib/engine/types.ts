// Types shared by the browser and the server for Director runs.
// No secrets, no server-only imports.
// The executor (lib/executor, Node) and the web app (browser + Next API) both use them.

export type RunStatus = "queued" | "planning" | "awaiting_clarification" | "plan_ready" | "failed" | "canceled";
export const ACTIVE_STATUSES: RunStatus[] = ["queued", "planning"];
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Na fila do executor",
  planning: "Planejando",
  awaiting_clarification: "Aguardando esclarecimento",
  plan_ready: "Plano pronto",
  failed: "Falha",
  canceled: "Cancelada",
};

/**
 * How a collaborator reaches a model: through an official client installed and
 * logged in on this computer. The Setor IA never holds the account session.
 */
export type ConnectionId = "claude_code" | "codex";
export type ConnectionState = "not_installed" | "disconnected" | "connected" | "expired" | "unavailable";

/** What the browser sends to start a run. The server re-validates everything. */
export type StartRunRequest = {
  idempotencyKey: string;
  demand: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    project: string;
    priority: "baixa" | "normal" | "alta";
    source: "github" | "folder" | "none";
    repo?: { url: string; owner: string; repo: string; branch: string };
    folder?: { name: string; fileCount: number; totalBytes: number; topExtensions: [string, number][]; hasPackageJson: boolean; hasGitDir: boolean };
  };
  /** Saved sheets of the whole team (the Director included), taken from the browser at click time. */
  team: TeamMemberInput[];
  directorId: string;
  /** Answers to a previous run's questions (re-planning). */
  previousRunId?: string;
  answers?: { question: string; answer: string }[];
};

export type TeamMemberInput = {
  id: string;
  name: string;
  role: string;
  specialty: string;
  /** Official client chosen in the sheet ("none" = not chosen). */
  connection: ConnectionId | "none";
  modelName: string;
  effort: string;
  budget: number;
  handoffTo: string[];
  returnTo: string[];
  maxCycles: number | null;
  tools: Record<string, boolean>;
  brief: string;
  playbook: Record<string, string>;
  limits: string;
  deliverable: string;
  rules: string;
};

export type RunEvent = { seq: number; at: string; kind: string; message: string; data?: unknown };

export type ConsultedFile = { path: string; bytes: number; sentChars: number; truncated: boolean; reason: string };

export type SourceContext =
  | { kind: "none"; note: string }
  | { kind: "folder"; note: string; summary: NonNullable<StartRunRequest["demand"]["folder"]> }
  | {
      kind: "github";
      owner: string;
      repo: string;
      branch: string;
      commit: string;
      visibility: "public";
      description: string | null;
      defaultBranch: string;
      treeEntries: number;
      treeTruncated: boolean;
      structureSample: string[];
      files: ConsultedFile[];
      skipped: { path: string; reason: string }[];
      limits: { maxFiles: number; maxFileBytes: number; maxTotalChars: number; timeoutMs: number };
      elapsedMs: number;
    };

export type PlanQuestion = { question: string; why_it_blocks: string };
export type PlanStep = { id: string; title: string; owner: string; depends_on: string[]; done_when: string };
export type PlanTask = {
  id: string;
  step_id: string;
  assignee: string;
  title: string;
  scope: string;
  inputs: string;
  deliverable: string;
  acceptance_criteria: string[];
  depends_on: string[];
};
export type DirectorPlan = {
  outcome: "plan_ready" | "needs_clarification";
  objective_summary: string;
  context_understanding: string;
  flow: { type: "short" | "standard" | "full"; rationale: string; skipped_roles: string[] };
  questions: PlanQuestion[];
  steps: PlanStep[];
  tasks: PlanTask[];
  risks: string[];
  assumptions: string[];
  not_verified: string[];
};

/** Usage as reported by the official client after a call (never estimated). */
export type CallUsage = {
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Model the client says it used (Claude reports it; Codex does not). */
  model: string | null;
};

export type RunBudget = {
  /** Token budget in the sheet at click time: a Setor IA limit, not the subscription limit. */
  sheetTokens: number;
  /** Rough estimate (characters ÷ 3.5) of the text the Setor IA sends; the client adds its own instructions. */
  estimatedInputTokens: number | null;
  /** One entry per call, only with figures the client reported. */
  calls: CallUsage[];
  /** Sum of reported tokens, or null when the client reported nothing. */
  reportedTotalTokens: number | null;
  /** True when reported usage went over the sheet budget (the client cannot be stopped mid-call). */
  exceeded: boolean;
};

export type RunError = {
  code: string;
  message: string;
  detail?: string;
  retryable: boolean;
  /** What the user can do to recover. */
  recovery?: string[];
};

export type RunRecord = {
  id: string;
  demandId: string;
  agentId: string;
  status: RunStatus;
  /** Official client used by this run. */
  connection: ConnectionId;
  /** Model requested in the sheet ("" = the client's default). */
  model: string;
  /** Reasoning effort requested in the sheet ("" = the client's default). */
  effort: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** While planning: the executor renews this; once past, the run is considered interrupted. */
  leaseUntil: string | null;
  attempt: number;
  snapshotHash: string;
  budget: RunBudget;
  context: SourceContext | null;
  result: (DirectorPlan & { limitations: string[] }) | null;
  error: RunError | null;
  previousRunId: string | null;
};

export type RunDetail = RunRecord & {
  events: RunEvent[];
  /** Exactly what the Director received (frozen at run creation). */
  snapshot: { director: TeamMemberInput; team: Pick<TeamMemberInput, "id" | "name" | "role" | "specialty" | "connection">[]; demand: StartRunRequest["demand"]; answers: StartRunRequest["answers"] | null };
  prompt: { system: string; user: string } | null;
  rawOutput: string | null;
};

export type ModelOption = { value: string; label: string; efforts: string[]; defaultEffort: string | null };

export type ConnectionStatus = {
  id: ConnectionId;
  /** Name of the official client. */
  client: string;
  state: ConnectionState;
  /** Client version reported by the client itself. */
  version: string | null;
  /** Kind of account the client says it is using (e.g. "Claude Team", "ChatGPT"). No e-mail. */
  account: string | null;
  message: string;
  /** Exact steps for the user, in their own terminal, when action is needed. */
  steps: string[];
  checkedAt: string;
  /** Models the installed client itself lists (empty = only the client's default). */
  models: ModelOption[];
  modelsSource: string | null;
  /** Effort levels the client accepts when no model-specific list exists. */
  efforts: string[];
};

export type EngineStatus = {
  /** The Next server can reach the local executor. */
  executor: { reachable: boolean; message: string | null; version: string | null };
  /** Web gate: real execution only through the local development server. */
  executionEnabled: boolean;
  disabledReason: string | null;
  store: { ok: boolean; kind: string; path: string | null; message: string | null };
  connections: Partial<Record<ConnectionId, ConnectionStatus>>;
  github: { mode: "public-only"; tokenConfigured: boolean };
  limits: { maxRunsPerHour: number; maxConcurrentRuns: number; callTimeoutMs: number };
  /** Collaborators that may run in this phase. */
  executableAgents: string[];
};
