// Types shared by the browser and the server for runs (Director plans and
// the tasks the user hands off to the Architect).
// No secrets, no server-only imports.
// The executor (lib/executor, Node) and the web app (browser + Next API) both use them.

export type RunStatus =
  | "awaiting_approval" // hand-off prepared, waiting for the user's confirmation (nothing runs)
  | "queued" | "planning" | "awaiting_clarification"
  | "plan_ready" // Director: plan done
  | "analysis_ready" // Architect: analysis done
  | "implementation_ready" // Developer: edits done, diff computed and in scope
  | "review_ready" // QA: every criterion classified (approved/rejected/not_verified), real evidence attached
  | "failed" | "canceled";
export const ACTIVE_STATUSES: RunStatus[] = ["queued", "planning"];
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  awaiting_approval: "Aguardando sua aprovação",
  queued: "Na fila do executor",
  planning: "Em execução",
  awaiting_clarification: "Aguardando esclarecimento",
  plan_ready: "Plano pronto",
  analysis_ready: "Análise concluída",
  implementation_ready: "Implementação pronta (não aplicada)",
  review_ready: "Revisão de QA concluída",
  failed: "Falha",
  canceled: "Cancelada",
};

/** Director planning, one Director task handed off (with approval) to the Architect, the Developer, or QA. */
export type RunKind = "director_plan" | "architect_task" | "developer_task" | "qa_task";

/** Collaborators that can receive a read-only hand-off in this phase (see HandoffTargets for the Architect flow). */
export const HANDOFF_TARGETS = ["architect"] as const;
/** The Developer's hand-off is a separate, write-capable flow (see lib/executor/developer.ts); not merged into HANDOFF_TARGETS. */
export const DEVELOPER_ASSIGNEE = "developer";
/** QA's hand-off is a separate, read-only flow (see lib/executor/qa.ts); not merged into HANDOFF_TARGETS either. */
export const QA_ASSIGNEE = "qa";

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

export type ConsultedFile = {
  path: string; bytes: number; sentChars: number; truncated: boolean; reason: string;
  /** Git blob id of the file at the commit (identical id = identical content). */
  blob?: string | null;
  /** SHA-256 of the full file content read (lets two runs be compared without storing the file). */
  sha256?: string;
  /** Large file sent as outline + blocks: which lines of the committed file were sent. */
  excerpt?: { ranges: [number, number][]; totalLines: number; symbols: string[] };
};

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
      /** Where the content came from: the public GitHub API (default) or an authorized local Git clone. */
      via?: "github" | "local_git";
      /** Local Git reads only: folder name, whether the commit is published on GitHub (per local origin refs), ancestry. */
      local?: { dirName: string; published: boolean; descendantOf: string | null; isDescendant: boolean | null };
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
/**
 * Usage exactly as reported by the official client. A category the client did
 * not report is null ("indisponível"), never an estimate.
 * Records written before the `source` field existed carry numbers for every
 * category (0 meant "reported as 0" or "not reported"); they are shown as-is.
 */
export type CallUsage = {
  label: string;
  /** Input tokens not served from cache. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Reasoning/thinking tokens, already included in outputTokens. */
  reasoningTokens: number | null;
  /** Model the client says it used (Claude reports it; Codex does not). */
  model: string | null;
  /** Where the numbers come from (client + field). */
  source?: string;
  /** Per model request, when the client reports it (Claude Code: usage.iterations; Codex: one turn.completed per turn). */
  apiCalls?: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null }[];
  /** Agent turns the client says it used (Claude Code: num_turns). */
  turns?: number | null;
  /** Wall time reported by the client (Claude Code: duration_ms). */
  durationMs?: number | null;
};

/** Sum of the categories the client reported (input + cache + output); null when none was reported. */
export function reportedTotal(u: CallUsage): number | null {
  const parts = [u.inputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.outputTokens].filter((n): n is number => typeof n === "number");
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

export type RunBudget = {
  /** Token budget in the sheet at click time: a Setor IA limit, not the subscription limit. */
  sheetTokens: number;
  /** Rough estimate (characters ÷ 3.5) of the text the Setor IA sends; the client adds its own instructions. */
  estimatedInputTokens: number | null;
  /** One entry per call, only with figures the client reported. */
  calls: CallUsage[];
  /** Sum of reported tokens, or null when the client reported nothing. */
  reportedTotalTokens: number | null;
  /** True when reported usage went over the sheet budget (reference/alert only: the client cannot be stopped mid-call). */
  exceeded: boolean;
};

export type ArchitectAnalysis = {
  outcome: "analysis_ready" | "needs_clarification";
  technical_understanding: string;
  assumptions: string[];
  /** basis "read" = content actually sent to the Architect; "inferred" = deduced without reading. */
  examined: { ref: string; kind: "file" | "symbol" | "contract" | "config" | "other"; basis: "read" | "inferred"; note: string }[];
  recommendation: { summary: string; rationale: string };
  /** Only when there is a real technical decision to make. */
  alternatives: { option: string; tradeoff: string; why_not_chosen: string }[];
  dependencies: string[];
  compatibility: string[];
  risks: { risk: string; regression_area: string; mitigation: string }[];
  developer_guidance: string[];
  /** Recommendations for QA: the Architect ran nothing. */
  qa_checks: string[];
  questions: PlanQuestion[];
  not_verified: string[];
};

/** Task handed off to the Architect, as stored by the executor (copied from the Director's frozen plan). */
export type HandoffTask = PlanTask;

/** Part of the Director's plan the Architect receives (a verifiable excerpt, not the whole plan). */
export type PlanExcerpt = {
  directorRunId: string;
  directorConnection: ConnectionId;
  objective_summary: string;
  flow: { type: DirectorPlan["flow"]["type"]; rationale: string };
  step: PlanStep | null;
  /** Tasks this one depends on, with the Architect's earlier analysis summary when there is one. */
  dependsOn: { id: string; title: string; assignee: string; analysisSummary: string | null; analysisRunId: string | null; analysis?: DependencyAnalysis | null }[];
  /** Tasks that depend on this one (who will use the analysis). */
  dependents: { id: string; title: string; assignee: string }[];
  risks: string[];
  assumptions: string[];
  not_verified: string[];
  /** Files the Director really read (paths, sizes) at the pinned commit. */
  directorFiles: { path: string; bytes: number; truncated: boolean }[];
  directorCommit: string | null;
  /** Items of the plan not repeated here (the full plan stays in the Director run). */
  omitted?: { risks: number; assumptions: number; not_verified: number };
};

/**
 * Concluded analysis of a task this one depends on, as sent to the next collaborator: a bounded excerpt
 * of the registered analysis (not facts verified again), with the commit it was made on and the user's
 * decisions recorded in that hand-off.
 */
export type DependencyAnalysis = {
  runId: string;
  revision: number | null;
  commit: string | null;
  via: "github" | "local_git" | null;
  understanding: string;
  recommendation: { summary: string; rationale: string };
  guidance: string[];
  risks: string[];
  assumptions: string[];
  notVerified: string[];
  examined: { ref: string; basis: "read" | "inferred" }[];
  /** Decisions the user stated in that hand-off (they stay the user's). */
  decisions: { topic: string; answer: string }[];
  omitted: { guidance: number; risks: number; assumptions: number; notVerified: number; examined: number };
};

/** Where a file stands in two commits of the same repository (read from the authorized local clone). */
export type SourceComparison = {
  from: { commit: string; label: string };
  to: { commit: string; label: string };
  /** "descendant" = `to` contains `from` in its history. */
  relation: "same" | "descendant" | "not_descendant" | "unknown";
  /** Files changed between the two commits (whole repository), when known. */
  changedTotal: number | null;
  files: { path: string; atFrom: boolean; atTo: boolean; changed: boolean | null }[];
  note: string;
};

/** How one of the Architect's earlier questions was resolved before a new hand-off. */
export type Clarification = {
  question: string;
  /** Hand-off run that asked it. */
  askedIn: string;
  resolution:
    | { by: "user"; answer: string }
    | { by: "reading"; requested: string[]; readFiles: string[]; missing: string[]; commit: string };
};

/** Why and how this hand-off differs from the previous one of the same task. */
export type ContextRevision = {
  number: number;
  previousRunId: string | null;
  previousCommit: string | null;
  previousVia: "github" | "local_git" | null;
  commit: string | null;
  via: "github" | "local_git" | null;
  changedCommit: boolean;
  reason: string;
  /** Files the user confirmed for reading when preparing (path or path#Symbol) and why each was suggested. */
  requestedFiles?: { ref: string; reason: string }[];
  /** The chosen commit compared with the Director's commit and with the commits of the dependency analyses. */
  comparisons?: SourceComparison[];
};

/** Where a file of the task stands: create it, change it, or only read it for context (never a grant by itself). */
export type EditScopeEntry = { path: string; action: "criar" | "alterar" | "consultar"; from: string[] };

/** What the executor lets this Developer run do (enforced by client flags and the isolated copy, not by the prompt). */
export type DeveloperTool = { label: string; allowed: boolean; how: string };

/**
 * Frozen at "Enviar ao Desenvolvedor" (prepare). No file is materialized yet: the isolated working copy is
 * built only when the run is approved (see lib/executor/worktree.ts). Nothing here is sent to the model as
 * pasted file content — the Developer reads the working copy itself, through its own confined tools.
 */
export type DeveloperSnapshot = {
  kind: "developer_task";
  agent: TeamMemberInput;
  team: Pick<TeamMemberInput, "id" | "name" | "role" | "specialty" | "connection">[];
  demand: StartRunRequest["demand"];
  task: HandoffTask;
  plan: { objective_summary: string; step: PlanStep | null; dependents: { id: string; title: string; assignee: string }[] };
  dependencies: (DependencyAnalysis & { taskId: string; title: string })[];
  base: {
    owner: string; repo: string; commit: string; dirName: string;
    treeEntries: number;
    /** Up to 60 paths, for reference only (the working copy has the whole tree). */
    sampleFiles: string[];
  };
  editScope: EditScopeEntry[];
  outOfScope: string[];
  tools: DeveloperTool[];
  revision: ContextRevision;
  limits: { timeoutMs: number; maxDiffChars: number };
};

export type DeveloperChange = { path: string; action: "created" | "modified" | "deleted"; reason: string };
export type DeveloperAcceptance = { criterion: string; status: "met" | "not_met" | "not_verified"; note: string };

/** The Developer's own structured report (self-reported; cross-checked against the independently computed diff). */
export type DeveloperResult = {
  outcome: "done" | "needs_clarification";
  summary: string;
  changes: DeveloperChange[];
  acceptance: DeveloperAcceptance[];
  questions: PlanQuestion[];
  not_verified: string[];
  assumptions: string[];
};

export type DeveloperDiffFile = { path: string; status: "added" | "modified" | "deleted"; additions: number | null; deletions: number | null; inScope: boolean };

/** Computed by the executor from the isolated copy (git diff), independent of what the model reports. */
export type DeveloperDiff = {
  baseCommit: string;
  files: DeveloperDiffFile[];
  diffText: string;
  diffTruncated: boolean;
  /** Files touched outside the approved edit scope (a non-empty list fails validation). */
  outOfScope: string[];
};

/**
 * A run's clarification question resolved OUTSIDE the model (e.g. the model asked a scope question the
 * user/orchestrator decided directly, such as "where should the test file go"). Never implies the model
 * itself finished the call: `RunRecord.status` stays whatever the model actually returned (e.g.
 * "awaiting_clarification"); this only records, verifiably, that a human/orchestrator resolved it and how.
 */
export type LocalResolution = {
  at: string;
  by: "orchestrator";
  /** What was resolved, in the resolver's own words. */
  note: string;
  /** Commit that carries the resolution (e.g. the one that added the missing test file). */
  commit: string;
  /** Test file that demonstrates the resolution, when applicable. */
  testFile: string | null;
  testCount: number | null;
};

/** How a task's dependency requirement was satisfied — evidence-based, never assumed just because a field exists. */
export type TaskCompletionKind = "resolved_clarification" | "direct_implementation";

/** One real, controlled check the orchestrator ran (never claimed without having actually run it). */
export type VerificationCheck = { ran: boolean; command: string; result: string; at: string } | null;
export type Verification = { typecheck: VerificationCheck; lint: VerificationCheck; tests: VerificationCheck; build: VerificationCheck };

/**
 * Validated evidence that a task's real deliverable exists and was checked, beyond the model's own reply —
 * this, never a bare `LocalResolution`, is what other tasks' dependencies are allowed to consult (see
 * lib/engine/dependency.ts). `kind: "resolved_clarification"` requires `sourceRunId` to point at a run that
 * itself carries a matching `LocalResolution` (the raw, narrower fact); `kind: "direct_implementation"`
 * covers work implemented directly by the orchestrator outside any hand-off, with no source run at all.
 */
export type TaskCompletion = {
  id: string;
  demandId: string;
  parentRunId: string;
  taskId: string;
  kind: TaskCompletionKind;
  sourceRunId: string | null;
  commit: string;
  files: string[];
  verification: Verification;
  note: string;
  validatedBy: "orchestrator";
  validatedAt: string;
  createdAt: string;
};

/** What the executor lets this QA run do (enforced by client flags, not by the prompt) — read-only, like the Architect. */
export type QATool = { label: string; allowed: boolean; how: string };

/** One task's real, delivered evidence, as QA receives it — never the model's self-report alone. */
export type QADeliverable = {
  taskId: string;
  title: string;
  assignee: string;
  /** How this deliverable came to exist — mirrors DependencyEvidence's own distinctions (lib/engine/dependency.ts). */
  origin: "run_completed" | "resolved_clarification_validated" | "direct_implementation_validated";
  commit: string | null;
  files: string[];
  verification: Verification | null;
  diffText: string | null;
  diffTruncated: boolean;
  note: string;
};

export type QACriterionVerdict = "approved" | "rejected" | "not_verified";
export type QACriterionJudgement = {
  criterion: string;
  verdict: QACriterionVerdict;
  /** Required for "rejected": what was done, what was expected, what was observed, and the impact. */
  rejected?: { steps: string; expected: string; observed: string; impact: string };
  /** Required for "not_verified": why it could not be checked. */
  notVerifiedReason?: string;
  /** Required for "approved": the real evidence that justifies it (a file, a test result, a diff line...). */
  evidence?: string;
};

/** The QA's own structured report — self-reported, cross-checked against the real deliverables it was given, never against a live re-run it has no tool to make. */
export type QAResult = {
  outcome: "done" | "needs_clarification";
  summary: string;
  /** One entry per acceptance criterion of the DEMAND (not of the QA task itself). */
  criteria: QACriterionJudgement[];
  questions: PlanQuestion[];
  not_verified: string[];
  recommendation: "ready_for_review" | "blocked" | "needs_more_work";
};

/**
 * Frozen at "Enviar ao QA" (prepare). QA gets no live tools at all (read_only mode, like the Architect):
 * everything it can see is pasted as text below — the real commits, diffs, analyses and verification
 * results already computed by the orchestrator, never a live shell, never write access.
 */
export type QASnapshot = {
  kind: "qa_task";
  agent: TeamMemberInput;
  team: Pick<TeamMemberInput, "id" | "name" | "role" | "specialty" | "connection">[];
  demand: StartRunRequest["demand"];
  task: HandoffTask;
  plan: { objective_summary: string; step: PlanStep | null; dependents: { id: string; title: string; assignee: string }[] };
  /** Architect analyses along the whole dependency chain (not just direct deps), for context. */
  analyses: (DependencyAnalysis & { taskId: string; title: string })[];
  /** Real, validated deliverables along the whole dependency chain: commits, files, verification, diffs. */
  deliverables: QADeliverable[];
  tools: QATool[];
  /** Estimated size of the frozen text, and what was left out to keep the context proportional to what's needed. */
  contextBudget: { estimatedInputTokens: number; omitted: string[] };
};

export type DirectorSnapshot = {
  kind?: "director_plan";
  director: TeamMemberInput;
  team: Pick<TeamMemberInput, "id" | "name" | "role" | "specialty" | "connection">[];
  demand: StartRunRequest["demand"];
  answers: StartRunRequest["answers"] | null;
};

export type ArchitectSnapshot = {
  kind: "architect_task";
  /** The Architect's saved sheet at approval time. */
  agent: TeamMemberInput;
  team: Pick<TeamMemberInput, "id" | "name" | "role" | "specialty" | "connection">[];
  demand: StartRunRequest["demand"];
  task: HandoffTask;
  plan: PlanExcerpt;
  /** What this execution may do, as enforced by the executor (not a request to the model). */
  tools: { label: string; allowed: boolean; how: string }[];
  /** Legacy (first release): answers without the question-by-question record. */
  answers: StartRunRequest["answers"] | null;
  /** Revision of the context (commit/source), linked to the previous hand-off of the task. */
  revision?: ContextRevision;
  /** Earlier questions and how each was resolved (the user's answers are marked as the user's). */
  clarifications?: Clarification[];
  /** Extra decisions stated by the user for this hand-off. */
  decisions?: { topic: string; answer: string }[];
  /** Summary of the previous analysis of this task (reused, not re-derived). */
  previousAnalysis?: { runId: string; commit: string | null; understanding: string; provisional: string } | null;
  /** What is asked and what stays out of scope (shown before approval and sent to the Architect). */
  scope?: { asked: string[]; outOfScope: string[] };
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
  kind: RunKind;
  demandId: string;
  agentId: string;
  status: RunStatus;
  /** Architect task: the Director run the task comes from. */
  parentRunId: string | null;
  /** Architect task: the task id inside the parent plan. */
  taskId: string | null;
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
  /** Director plan (kind director_plan). */
  result: (DirectorPlan & { limitations: string[] }) | null;
  /** Architect analysis (kind architect_task). */
  analysis: (ArchitectAnalysis & { limitations: string[] }) | null;
  /** Developer implementation (kind developer_task): its own report plus the diff the executor computed. */
  developer: (DeveloperResult & { limitations: string[]; diff: DeveloperDiff | null }) | null;
  /** QA review (kind qa_task): per-criterion verdicts, cross-checked against real deliverables, never a live re-run. */
  qa: (QAResult & { limitations: string[] }) | null;
  /** Developer only: the real diff computed even when it was rejected (out-of-scope edit, invalid response). Kept for inspection; never applied to the project. Null on success (the diff then lives in `developer.diff`) or when the run never reached a computed diff. */
  rejectedDiff: DeveloperDiff | null;
  /** Set only when a clarification question was resolved outside the model (see LocalResolution). Null otherwise. */
  localResolution: LocalResolution | null;
  error: RunError | null;
  previousRunId: string | null;
};

export type RunDetail = RunRecord & {
  events: RunEvent[];
  /** Exactly what the collaborator received (frozen at run creation). */
  snapshot: DirectorSnapshot | ArchitectSnapshot | DeveloperSnapshot | QASnapshot;
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
  /** Collaborators that run only after the user approves a Director task assigned to them. */
  handoffTargets: string[];
  /** Whether each adapter can be restricted to read-only work (required for the Architect). */
  readOnly: Partial<Record<ConnectionId, { safe: boolean; how: string }>>;
  /** Local Git clones the user authorized for read-only reading (AYLA_LOCAL_REPOS). No full paths. */
  localRepos?: { dirName: string; owner: string; repo: string; head: string; headSubject: string }[];
};
