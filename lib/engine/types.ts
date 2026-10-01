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
  | "concluded" // Reviewer: final verdict recorded (facts/inferences/limitations separated)
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
  concluded: "Revisão final concluída",
  failed: "Falha",
  canceled: "Cancelada",
};

/** Director planning, one Director task handed off (with approval) to the Architect, the Developer, QA, or the Reviewer. */
export type RunKind = "director_plan" | "architect_task" | "developer_task" | "qa_task" | "reviewer_task";

/** Collaborators that can receive a read-only hand-off in this phase (see HandoffTargets for the Architect flow). */
export const HANDOFF_TARGETS = ["architect"] as const;
/** The Developer's hand-off is a separate, write-capable flow (see lib/executor/developer.ts); not merged into HANDOFF_TARGETS. */
export const DEVELOPER_ASSIGNEE = "developer";
/** QA's hand-off is a separate, read-only flow (see lib/executor/qa.ts); not merged into HANDOFF_TARGETS either. */
export const QA_ASSIGNEE = "qa";
/** The Reviewer's hand-off is a separate, read-only flow (see lib/executor/reviewer.ts): examines the demand, the real deliverables and QA's own parecer, and separates facts, inferences and limitations. */
export const REVIEWER_ASSIGNEE = "reviewer";

/**
 * How a collaborator reaches a model: through an official client installed and
 * logged in on this computer. The Setor IA never holds the account session.
 */
export type ConnectionId = "claude_code" | "codex";
export type ConnectionState = "not_installed" | "disconnected" | "connected" | "expired" | "unavailable";

/** Provider of an API-key connection (billed separately from the Claude/ChatGPT subscriptions). */
export type ApiProvider = "anthropic" | "openai";
export type ApiConnectionState = "unchecked" | "connected" | "invalid" | "error";
/**
 * A connection the user configured with their own API key instead of an official client's subscription
 * login. Stored encrypted at rest (see lib/executor/secret-store.ts); the key itself never leaves the
 * executor process and is never returned by any HTTP response — only this masked record is.
 */
export type ApiConnectionRecord = {
  id: string;
  provider: ApiProvider;
  /** Name the user gave this connection (e.g. "Minha chave Anthropic"). */
  label: string;
  /** Model name sent to the API ("" = a safe built-in default for the provider). */
  model: string;
  effort: string;
  /** Last 4 characters of the key, for display only. */
  last4: string;
  state: ApiConnectionState;
  message: string | null;
  checkedAt: string | null;
  createdAt: string;
};
/** A sheet or run's connection: an official client, or a configured API-key connection (`api:<id>`). */
export type AgentConnectionRef = ConnectionId | `api:${string}`;

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
    source: "github" | "folder" | "none" | "local";
    repo?: { url: string; owner: string; repo: string; branch: string };
    folder?: { name: string; fileCount: number; totalBytes: number; topExtensions: [string, number][]; hasPackageJson: boolean; hasGitDir: boolean };
    /** source "local": a project authorized in the executor, read at an exact commit (see LocalSourceRef). */
    local?: LocalSourceRef;
  };
  /** Saved sheets of the whole team (the Director included), taken from the browser at click time. */
  team: TeamMemberInput[];
  directorId: string;
  /** Answers to a previous run's questions (re-planning). */
  previousRunId?: string;
  answers?: { question: string; answer: string }[];
};

/**
 * "Projeto local autorizado" as the source of a demand. The browser only names the project (by the id the
 * executor gave it, never a path), the reference the user picked and the commit that reference resolved to
 * when the user looked at it; the executor re-validates all of it and reads exactly `commit` from the project's
 * Git objects. The optional fields are filled in by the executor when the run is created.
 */
export type LocalSourceRef = {
  projectId: string;
  /** Branch, tag or other Git reference picked ("" = the project's current HEAD when it was resolved). */
  ref: string;
  /** Full SHA the user saw before planning; the only commit that is read. */
  commit: string;
  projectLabel?: string;
  owner?: string;
  repo?: string;
  subject?: string;
  /** Where `ref` pointed when the plan started, when that is no longer `commit` (the user pinned an older SHA). */
  refNow?: string | null;
};

export type RefOption = { name: string; kind: "branch" | "remote" | "tag"; sha: string; subject: string; current: boolean };
export type ProjectRefs = { projectId: string; projectLabel: string; owner: string; repo: string; head: { sha: string; branch: string | null; subject: string }; refs: RefOption[]; truncated: boolean };

/** What a reference of an authorized project resolves to (shown to the user before planning). */
export type ResolvedSource = {
  projectId: string; projectLabel: string; dirName: string; owner: string; repo: string;
  /** What the user asked for ("" = the project's current HEAD) and what it is. */
  ref: string; refKind: "head" | "branch" | "remote" | "tag" | "commit" | "expression";
  commit: string; subject: string; committedAt: string | null;
  /** The project's current HEAD (the commit that is checked out, which may differ from the one being read). */
  head: { sha: string; branch: string | null };
  /** Uncommitted entries of the project: they are NOT read (only committed objects are). */
  dirty: { count: number; paths: string[] } | null;
  /** The commit is reachable from a remote-tracking ref of the local clone (nothing is fetched). */
  published: boolean;
  /** Where `ref` points today, when the user pinned another SHA. */
  refNow?: string | null;
};

export type TeamMemberInput = {
  id: string;
  name: string;
  role: string;
  specialty: string;
  /** Official client or API connection chosen in the sheet ("none" = not chosen). */
  connection: AgentConnectionRef | "none";
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
  /** Local reads: how many token-like strings were replaced by [REDACTED] in the text sent (the sha256 is of the original). */
  redactions?: number;
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
      visibility: "public" | "local";
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
      local?: {
        dirName: string; published: boolean; descendantOf: string | null; isDescendant: boolean | null;
        /** Demand source "Projeto local autorizado": which authorized project, which reference, and where it pointed. */
        projectId?: string; projectLabel?: string; ref?: string; refNow?: string | null; subject?: string;
        /** Uncommitted entries of the project at read time: they are NOT part of the context (only committed objects are read). */
        dirty?: { count: number; paths: string[] };
        /** SHA-256 of the exact source text sent to the model (the review screen shows the same hash before planning). */
        textSha256?: string;
      };
      /** Files kept out of the context by the protection rules (personal configuration, keys, environment files): count and a few names. */
      withheld?: { count: number; examples: string[] };
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
  directorConnection: AgentConnectionRef;
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
  /**
   * The real, authorized scope for this run — set explicitly by the user when preparing the hand-off
   * (never inferred from the Architect's text). This, not suggestedEditScope, is what the client's tool
   * confinement and the post-run diff validation actually enforce.
   */
  editScope: EditScopeEntry[];
  /**
   * Non-binding forecast, mentioned in the task and the Architect's analyses (extractFileRefs + verb
   * heuristic) — shown to the user as a starting point when they pick editScope, but never itself a grant.
   * "a confirmar" = the heuristic found an edit verb but could not tell create from modify (no local repo
   * access at preview time).
   */
  suggestedEditScope: { path: string; action: "alterar" | "criar" | "consultar" | "a confirmar"; from: string[] }[];
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
  /** SHA-256 of `diffText`, recorded when the executor computed the diff (absent on runs older than this field). Checked again before the diff is applied anywhere. */
  diffSha256?: string;
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
export type TaskCompletionKind = "resolved_clarification" | "direct_implementation" | "applied_run_result";

/** One real, controlled check the orchestrator ran (never claimed without having actually run it). */
export type VerificationCheck = { ran: boolean; command: string; result: string; at: string } | null;
export type Verification = { typecheck: VerificationCheck; lint: VerificationCheck; tests: VerificationCheck; build: VerificationCheck };

/**
 * Validated evidence that a task's real deliverable exists and was checked, beyond the model's own reply —
 * this, never a bare `LocalResolution`, is what other tasks' dependencies are allowed to consult (see
 * lib/engine/dependency.ts). `kind: "resolved_clarification"` requires `sourceRunId` to point at a run that
 * itself carries a matching `LocalResolution` (the raw, narrower fact); `kind: "direct_implementation"`
 * covers work implemented directly by the orchestrator outside any hand-off, with no source run at all;
 * `kind: "applied_run_result"` records that the diff a Developer run produced (`sourceRunId`, status
 * implementation_ready) was applied to the checkout, verified and committed — the run itself is untouched.
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
  /** Set when the delivery was applied through the interface (see ApplicationRecord): the change is then NOT in `commit` (never committed automatically) — `commit` is the target's HEAD at application time and the applied files are identified by their hashes in that application. */
  applicationId?: string | null;
};

/** What the executor lets this QA run do (enforced by client flags, not by the prompt) — read-only, like the Architect. */
export type QATool = { label: string; allowed: boolean; how: string };

/** One task's real, delivered evidence, as QA receives it — never the model's self-report alone. */
export type QADeliverable = {
  taskId: string;
  title: string;
  assignee: string;
  /** How this deliverable came to exist — mirrors DependencyEvidence's own distinctions (lib/engine/dependency.ts). */
  origin: "run_completed" | "resolved_clarification_validated" | "direct_implementation_validated" | "applied_run_result_validated";
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
  /** Tool-equipped QA: ids of executor-produced evidence (QAEvidence.id) this verdict rests on. */
  evidenceIds?: string[];
  /** Criteria spanning several collaborators: the part QA itself evaluated... */
  evaluatedPart?: string;
  /** ...and the part that stays pending (never turned into an approval). */
  pendingPart?: string;
  /** Why something stays pending: a tool QA did not have, evidence that was not enough, or a later step of the plan (e.g. the Reviewer). */
  pendingReason?: QAPendingReason;
  /** future_step only: the downstream task of the plan that owns the pending part. */
  pendingTask?: string;
};

export type QAPendingReason = "tool_unavailable" | "insufficient_evidence" | "future_step";

/** The QA's own structured report — self-reported, cross-checked against the real deliverables it was given, never against a live re-run it has no tool to make. */
export type QAResult = {
  outcome: "done" | "needs_clarification";
  summary: string;
  /** One entry per acceptance criterion of the DEMAND (not of the QA task itself). */
  criteria: QACriterionJudgement[];
  questions: PlanQuestion[];
  not_verified: string[];
  recommendation: "ready_for_review" | "blocked" | "needs_more_work";
  /** Tool-equipped QA only: every piece of evidence the executor produced (the only evidence a verdict may cite), the exact version tested and the environment. */
  evidence?: QAEvidence[];
  testedVersion?: TestedVersion;
  environment?: QAEnvironmentReport;
  /** Tool-equipped QA only: how many model calls this review took. */
  rounds?: number;
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
  /** "executor_operations": QA asks for controlled operations (read, commands, browser) the EXECUTOR runs in an isolated environment of the exact tested version; the model itself still gets no tools. Absent on older, text-only QA runs. */
  toolsMode?: "executor_operations";
  /** The exact version QA will test (resolved at prepare time from the delivery evidence). */
  testedVersion?: TestedVersion;
  /** What the executor could actually provide when this hand-off was prepared. */
  tooling?: QAToolingStatus;
  /** Maximum model calls this review may make (planning, evaluation, one optional extra round) — each may get one format correction. */
  maxModelCalls?: number;
  /** updatedAt of the project execution settings this review was prepared with (a later change is not used silently). */
  projectConfigAt?: string | null;
};

// ---- Local projects, diff application, isolated verification environments ----------------------

/** A local Git project the user authorized in the executor (AYLA_LOCAL_REPOS or Configurações → Projetos locais). */
export type LocalProject = {
  id: string;
  source: "env" | "ui";
  dir: string;
  dirName: string;
  label: string;
  owner: string | null;
  repo: string | null;
  head: string | null;
  headSubject: string | null;
  branch: string | null;
  /** Uncommitted entries reported by `git status` (null when unreadable). */
  dirty: number | null;
  /** Why this project cannot be used right now (null = usable). */
  problem: string | null;
  createdAt: string | null;
  /** How the executor runs this project in isolated environments (null = not configured yet: nothing is run). */
  runConfig?: ProjectRunConfig | null;
};

/** Package managers the executor can drive in isolated environments (identified by the lockfile). */
export type SupportedPackageManager = "npm" | "pnpm";

/**
 * Execution settings of one project (Configurações → Projetos locais), confirmed by the user. Commands are
 * command lines WITHOUT a shell (no pipes/redirections), starting with the package manager, npx or node;
 * "" = not configured (shown as "não configurado", never as a passing check). They run the project's own
 * code, only inside an isolated copy of the tested version, without the user's credentials.
 */
export type ProjectRunConfig = {
  /** Folder of the package (relative to the repository root; "" = the root). */
  workDir: string;
  packageManager: SupportedPackageManager;
  commands: { install: string; typecheck: string; lint: string; test: string; build: string; dev: string; seed: string };
  /** The application under test: {port} in the dev command (and PORT) receive the port; ready = GET readyPath answers < 400 (and contains readyText, if set). */
  app: { host: "localhost" | "127.0.0.1"; port: number | null; readyPath: string; readyText: string; timeoutSec: number };
  /** What the QA browser talks to: the app's own server in the isolated copy, or (Setor IA itself) read-only records served by the executor. */
  browserData: "app" | "setor_ia_fixture";
  /** Variables given to the test environment only. Values are kept encrypted in the executor and never returned. */
  env: { name: string; set: boolean; external: boolean }[];
  /**
   * Several processes (frontend + API...). Absent in settings saved before this existed: those mean ONE process made
   * of `commands.dev` + `app` (see servicesOf in project-config.ts); nothing has to be configured again. When present,
   * `commands.dev` and `app` mirror the main process, so older readers keep working.
   */
  services?: ProjectService[];
  /** Id of the process whose origin is the application's main origin (the QA browser opens it). */
  mainService?: string;
  /** Exact origins besides the processes' own that the QA browser may reach (an API sandbox, a CDN...). Local by default. */
  extraOrigins?: ProjectExtraOrigin[];
  /** Variables that connect one process to another, resolved after the ports are allocated (e.g. VITE_API_URL = origin of "api"). */
  links?: ProjectLink[];
  acknowledgedAt: string | null;
  updatedAt: string | null;
};

/** One process of the application under test, started in the isolated copy (no shell). */
export type ProjectService = {
  id: string;
  label: string;
  /** Folder it runs in, relative to the repository root ("" = the root). */
  dir: string;
  /** Optional install for this folder (e.g. a second package next to the first), run before the processes start; "" = covered by the project's install. */
  install: string;
  command: string;
  host: "localhost" | "127.0.0.1";
  /** null = dynamic: the executor allocates a free port ({port} in the command and PORT receive it). */
  port: number | null;
  readyPath: string;
  readyText: string;
  timeoutSec: number;
  /** The QA browser may talk to this process's origin (the main process's always may). */
  browser: boolean;
};
export type ProjectExtraOrigin = { origin: string; label: string; external: boolean };
export type ProjectLink = { name: string; service: string; as: "origin" | "host" | "port"; suffix: string; to: string[] };

/** What the executor found in the project (suggestions the user can edit; nothing is saved by detection). */
export type ProjectRunDetection = {
  workDirs: { dir: string; lockfiles: string[]; manager: string | null; supported: boolean; scripts: string[] }[];
  chosen: string;
  manager: { name: string | null; supported: boolean; detail: string };
  suggestion: ProjectRunConfig | null;
  notes: string[];
  fixtureAvailable: boolean;
  unsupported: string[];
};

export type ApplyCheck = { ok: boolean; label: string; detail: string };
export type ApplyFileState = { path: string; action: DeveloperDiffFile["status"]; exists: boolean; sha256: string | null; localChange: string | null };

/** What the user reviews before "Aplicar ao projeto local". `token` identifies exactly this state of the target. */
export type ApplyReview = {
  token: string;
  createdAt: string;
  run: { id: string; planId: string; taskId: string; taskTitle: string; baseCommit: string; finishedAt: string | null };
  project: LocalProject;
  diff: { text: string; sha256: string; recordedSha256: string | null; integrity: "verified" | "legacy_unrecorded" | "mismatch"; files: DeveloperDiffFile[]; truncated: boolean };
  checks: ApplyCheck[];
  target: { head: string; branch: string | null; dirtyTotal: number; dirtyOutside: string[]; affected: ApplyFileState[] };
  /** incorporated = the diff is already in a commit of the project's history (ancestor of HEAD) and the files changed afterwards: nothing to apply. */
  applyCheck: { state: "applies" | "already_present" | "incorporated" | "conflict" | "error"; conflicts: { path: string; reason: string }[]; output: string; incorporatedIn?: string };
  /** Non-empty = the confirmation is refused, with these reasons. */
  blockers: string[];
  applications: ApplicationRecord[];
};

export type ArtifactRef = { name: string; kind: "log" | "screenshot" | "download" | "clipboard" | "comparison" | "text"; bytes: number; sha256: string; label: string };

/** One real command the executor ran (never claimed without having run it). */
export type CommandEvidence = {
  label: string; command: string; cwd: string; exitCode: number | null; durationMs: number; startedAt: string;
  timedOut: boolean; canceled: boolean; logArtifact: string | null; tail: string;
};

/** The exact code a verification or a QA run tested, identified by hashes. */
export type TestedVersion =
  | { kind: "commit"; projectId: string; dirName: string; commit: string; treeHash: string | null; label: string }
  | { kind: "commit_plus_patch"; projectId: string; dirName: string; commit: string; patchSha256: string; runId: string; treeHash: string | null; label: string }
  | { kind: "commit_plus_files"; projectId: string; dirName: string; commit: string; applicationId: string; files: { path: string; sha256: string | null }[]; treeHash: string | null; label: string };

export type ApplicationVerification = {
  status: "running" | "passed" | "failed" | "canceled" | "error";
  startedAt: string;
  finishedAt: string | null;
  version: TestedVersion | null;
  checks: CommandEvidence[];
  message: string;
  /** TaskCompletion created only once every check passed. */
  completionId: string | null;
  /** Checks the project has no command for (listed, never counted as passing). */
  notConfigured?: string[];
};

export type ApplicationRecord = {
  id: string; runId: string; planId: string; taskId: string; projectId: string; projectDir: string;
  head: string; baseCommit: string; diffSha256: string; reviewToken: string; idempotencyKey: string;
  outcome: "applied" | "already_present" | "failed_restored" | "failed_unrestored";
  message: string;
  files: { path: string; action: string; beforeSha256: string | null; afterSha256: string | null }[];
  createdAt: string;
  verification: ApplicationVerification | null;
};

/** What the executor can provide to a tool-equipped QA on this computer (checked, never assumed). */
export type QAToolingStatus = {
  checkedAt: string;
  git: { ok: boolean; detail: string };
  packageManager: { ok: boolean; name: string; detail: string };
  browser: { ok: boolean; detail: string; engine: string | null; executable: string | null };
  /** Per operation: available or not, and why. */
  operations: { id: "read" | "search" | "commands" | "browser"; label: string; available: boolean; how: string }[];
  /** The application under test as configured (frozen with the review): processes, ports, and where the browser may go. */
  topology?: ConfiguredTopology;
};

/** What the review shows BEFORE the run: dynamic ports are only known when the processes start. */
export type ConfiguredTopology = {
  main: string | null;
  services: { id: string; label: string; dir: string; command: string; install: string; port: number | null; host: string; main: boolean; browser: boolean }[];
  extraOrigins: ProjectExtraOrigin[];
  links: ProjectLink[];
  /** The executor's own ports the browser can never reach. */
  controlPorts: number[];
};

/** What really ran: the resolved (frozen) addresses, the origins the browser was allowed, and what the guard refused. */
export type StackReport = {
  main: string;
  services: { id: string; label: string; dir: string; command: string; origin: string; port: number; portKind: "fixa" | "dinâmica"; ready: string; main: boolean; browser: boolean }[];
  allowedOrigins: { origin: string; label: string; why: string; external: boolean }[];
  links: { name: string; value: string; to: string[] }[];
  /** Network-level guard in front of the browser (limits the BROWSER only). */
  guard: { byOrigin: Record<string, { allowed: number; blocked: number }>; blocked: { at: string; method: string; target: string; reason: string }[]; blockedTotal: number } | null;
  /** CORS problems seen by the page, with what to do in the TEST environment (the executor never edits the project's CORS). */
  cors: string[];
  stopped: string;
};

export type QAEvidence = {
  id: string;
  method: "inspection" | "command" | "browser";
  /** 1-based indexes of the demand's criteria the requester said this is for (informative). */
  criteria: number[];
  purpose: string;
  /** "executor" = produced automatically (baseline checks, the diff); "qa" = requested by QA in a round. */
  requestedBy: "executor" | "qa";
  round: number;
  version: string;
  steps: string[];
  command: CommandEvidence | null;
  observed: string;
  /** The operation itself ran to the end (NOT "the criterion passed"). */
  ok: boolean;
  artifacts: ArtifactRef[];
  author: "executor";
  origin: string;
};

export type QAEnvironmentReport = {
  preparedAt: string;
  dependencies: CommandEvidence | null;
  network: string;
  browser: string | null;
  appUrl: string | null;
  /** Which application and API were used (resolved addresses, authorized origins, what was blocked). Absent in reviews made before multi-process support. */
  stack?: StackReport;
  /** Tracked files of the tested version changed during the review (must be empty). */
  modifiedDeliveryFiles: string[];
  apiRequests: { blocked: number; servedFromFixture: number; notFound: number };
  cleanup: string;
};

/** One statement the Reviewer verified directly against real evidence (never the model's own say-so). */
export type ReviewerFact = { statement: string; evidence: string };
/** One conclusion the Reviewer drew without a directly cited fact — must say what it is based on. */
export type ReviewerInference = { statement: string; basis: string };
export type ReviewerVerdict = "aprovado" | "aprovado_com_ressalvas" | "reprovado";

/**
 * The Reviewer's own structured parecer — like QA, self-reported and cross-checked against real evidence
 * it was given, never against a live re-run it has no tool to make. Unlike QA (which classifies the
 * demand's own criteria one by one), the Reviewer separates what it verified directly (facts), what it
 * concluded without a directly cited fact (inferences), and what stays unverified, then states one overall
 * verdict. It never overrides QA's own criterion verdicts — "aprovado" here is refused when the QA parecer
 * still has a rejected or not_verified criterion (see lib/engine/reviewer-schema.ts).
 */
export type ReviewerResult = {
  outcome: "done" | "needs_clarification";
  summary: string;
  facts: ReviewerFact[];
  inferences: ReviewerInference[];
  not_verified: string[];
  questions: PlanQuestion[];
  verdict: ReviewerVerdict;
};

/** What the executor lets this Reviewer run do (enforced by client flags, not by the prompt) — read-only, like QA. */
export type ReviewerTool = { label: string; allowed: boolean; how: string };

/**
 * Frozen at "Enviar ao Revisor" (prepare). The Reviewer gets no live tools at all (read_only mode): it
 * reuses exactly what QA itself was given and QA's own concluded parecer — never a live shell, never write
 * access, never a second, parallel evidence-gathering pass over the repository.
 */
export type ReviewerSnapshot = {
  kind: "reviewer_task";
  agent: TeamMemberInput;
  team: Pick<TeamMemberInput, "id" | "name" | "role" | "specialty" | "connection">[];
  demand: StartRunRequest["demand"];
  task: HandoffTask;
  plan: { objective_summary: string; step: PlanStep | null; dependents: { id: string; title: string; assignee: string }[] };
  /** The QA task this one depends on, and its own concluded parecer. */
  qa: { taskId: string; runId: string; result: QAResult };
  /** Architect analyses QA itself had in context (reused, not re-derived). */
  analyses: (DependencyAnalysis & { taskId: string; title: string })[];
  /** Real, validated deliverables QA itself had in context (reused, not re-derived). */
  deliverables: QADeliverable[];
  tools: ReviewerTool[];
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
  /** Official client or API connection used by this run. */
  connection: AgentConnectionRef;
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
  /** Reviewer's final parecer (kind reviewer_task): facts, inferences and an overall verdict, built on QA's own evidence. */
  reviewer: (ReviewerResult & { limitations: string[] }) | null;
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
  snapshot: DirectorSnapshot | ArchitectSnapshot | DeveloperSnapshot | QASnapshot | ReviewerSnapshot;
  prompt: { system: string; user: string } | null;
  rawOutput: string | null;
};

export type ModelOption = { value: string; label: string; efforts: string[]; defaultEffort: string | null };

export type ConnectionStatus = {
  /** "api" for a synthetic status built from an ApiConnectionRecord (see lib/executor/service.ts). */
  id: ConnectionId | "api";
  /** Name of the official client, or "API <provider> (<label>)" for an API connection. */
  client: string;
  state: ConnectionState;
  /** Client version reported by the client itself. */
  version: string | null;
  /** Kind of account the client says it is using (e.g. "Claude Team", "ChatGPT"). No e-mail. Masked key tail for API connections. */
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
  /** Set only for a synthetic status built from an API connection — the record it came from. */
  apiConnectionId?: string;
};

export type EngineStatus = {
  /** The Next server can reach the local executor. */
  executor: { reachable: boolean; message: string | null; version: string | null };
  /** Web gate: real execution only through the local development server. */
  executionEnabled: boolean;
  disabledReason: string | null;
  store: { ok: boolean; kind: string; path: string | null; message: string | null };
  connections: Partial<Record<ConnectionId, ConnectionStatus>>;
  /** API-key connections the user configured (masked; the key itself never leaves the executor). */
  apiConnections: ApiConnectionRecord[];
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
  /** Authorized local projects (with full paths: this is the user's own computer). */
  projects?: LocalProject[];
  /** What a tool-equipped QA can actually use on this computer. */
  qaTooling?: QAToolingStatus;
};
