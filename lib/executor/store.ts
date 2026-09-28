// Durable run storage behind a tiny SQL driver interface.
// The executor uses a local SQLite file (node:sqlite, see sqlite.ts). The SQL
// is portable: Postgres needs only a driver that maps "?" placeholders to $n.
import { randomUUID } from "node:crypto";
import type { DeveloperDiff, LocalResolution, RunBudget, RunDetail, RunError, RunEvent, RunRecord, RunStatus, SourceContext, TaskCompletion, Verification } from "@/lib/engine/types";

export interface SqlDriver {
  readonly kind: string;
  exec(sql: string): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS director_runs (
    id TEXT PRIMARY KEY,
    demand_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    connection TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    lease_until TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    snapshot_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    prompt_json TEXT,
    context_json TEXT,
    result_json TEXT,
    rejected_diff_json TEXT,
    local_resolution_json TEXT,
    error_json TEXT,
    budget_json TEXT NOT NULL,
    raw_output TEXT,
    previous_run_id TEXT,
    kind TEXT NOT NULL DEFAULT 'director_plan',
    parent_run_id TEXT,
    task_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS director_runs_by_demand ON director_runs (demand_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS director_run_events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT,
    PRIMARY KEY (run_id, seq)
  )`,
  // Outcome of real client calls per connection (used to report an expired session).
  `CREATE TABLE IF NOT EXISTS connection_log (
    connection TEXT NOT NULL,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    code TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ayla_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Validated evidence that a task's real deliverable exists, beyond a bare LocalResolution or the model's
  // own reply — the only thing dependencyEvidence() (lib/engine/dependency.ts) accepts as "done". Append-only:
  // never updated in place, so earlier validations stay in the history even if a later one is recorded.
  `CREATE TABLE IF NOT EXISTS task_completions (
    id TEXT PRIMARY KEY,
    demand_id TEXT NOT NULL,
    parent_run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_run_id TEXT,
    commit_hash TEXT NOT NULL,
    files_json TEXT NOT NULL,
    verification_json TEXT NOT NULL,
    note TEXT NOT NULL,
    validated_by TEXT NOT NULL,
    validated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS task_completions_by_task ON task_completions (parent_run_id, task_id, created_at)`,
];

/** Current schema version. v1 = Director only (commit ae8e896); v2 = run kinds + hand-off links; v3 = rejected Developer diffs kept for inspection; v4 = clarifications resolved outside the model, kept for inspection; v5 = QA hand-off + validated task-completion evidence. */
export const SCHEMA_VERSION = 5;

/** Columns added after v1. ALTER ... ADD COLUMN keeps every existing row unchanged (new columns get the default). */
const ADDED_COLUMNS: [string, string][] = [
  ["kind", "TEXT NOT NULL DEFAULT 'director_plan'"],
  ["parent_run_id", "TEXT"],
  ["task_id", "TEXT"],
  ["rejected_diff_json", "TEXT"],
  ["local_resolution_json", "TEXT"],
];

const INDEXES = [
  // At most one active Director plan per demand (no duplicate runs on double click / refresh).
  `CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_plan ON director_runs (demand_id) WHERE kind = 'director_plan' AND status IN ('queued', 'planning')`,
  // At most one pending/active hand-off per task of a plan, whether to the Architect, the Developer or QA.
  `CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_task ON director_runs (parent_run_id, task_id) WHERE kind IN ('architect_task', 'developer_task', 'qa_task') AND status IN ('awaiting_approval', 'queued', 'planning')`,
  `CREATE INDEX IF NOT EXISTS runs_by_parent ON director_runs (parent_run_id, task_id, created_at)`,
];

const TASK_OPEN = `('awaiting_approval', 'queued', 'planning')`;

type Row = Record<string, unknown>;
const parse = <T>(v: unknown): T | null => (typeof v === "string" && v ? (JSON.parse(v) as T) : null);
const nowIso = () => new Date().toISOString();

function toRecord(r: Row): RunRecord {
  const kind = ((r.kind === "architect_task" || r.kind === "developer_task" || r.kind === "qa_task") ? r.kind : "director_plan") as RunRecord["kind"];
  return {
    id: String(r.id), kind, demandId: String(r.demand_id), agentId: String(r.agent_id), status: r.status as RunStatus,
    parentRunId: (r.parent_run_id as string) ?? null, taskId: (r.task_id as string) ?? null,
    connection: r.connection as RunRecord["connection"], model: String(r.model), effort: String(r.effort ?? ""),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    startedAt: (r.started_at as string) ?? null, finishedAt: (r.finished_at as string) ?? null, leaseUntil: (r.lease_until as string) ?? null,
    attempt: Number(r.attempt ?? 0), snapshotHash: String(r.snapshot_hash),
    budget: parse<RunBudget>(r.budget_json)!, context: parse<SourceContext>(r.context_json),
    result: kind === "director_plan" ? parse<RunRecord["result"]>(r.result_json) : null,
    analysis: kind === "architect_task" ? parse<RunRecord["analysis"]>(r.result_json) : null,
    developer: kind === "developer_task" ? parse<RunRecord["developer"]>(r.result_json) : null,
    qa: kind === "qa_task" ? parse<RunRecord["qa"]>(r.result_json) : null,
    rejectedDiff: kind === "developer_task" ? parse<DeveloperDiff>(r.rejected_diff_json) : null,
    localResolution: parse<LocalResolution>(r.local_resolution_json),
    error: parse<RunError>(r.error_json),
    previousRunId: (r.previous_run_id as string) ?? null,
  };
}

function toCompletion(r: Row): TaskCompletion {
  return {
    id: String(r.id), demandId: String(r.demand_id), parentRunId: String(r.parent_run_id), taskId: String(r.task_id),
    kind: r.kind as TaskCompletion["kind"], sourceRunId: (r.source_run_id as string) ?? null, commit: String(r.commit_hash),
    files: parse<string[]>(r.files_json) ?? [], verification: parse<Verification>(r.verification_json)!,
    note: String(r.note), validatedBy: r.validated_by as TaskCompletion["validatedBy"], validatedAt: String(r.validated_at), createdAt: String(r.created_at),
  };
}

export type NewRun = {
  id: string; demandId: string; agentId: string; idempotencyKey: string; connection: RunRecord["connection"]; model: string;
  effort: string; snapshotHash: string; snapshot: RunDetail["snapshot"]; budget: RunBudget; previousRunId: string | null;
  /** Defaults: director_plan, created as queued. */
  kind?: RunRecord["kind"];
  parentRunId?: string | null;
  taskId?: string | null;
  initialStatus?: "queued" | "awaiting_approval";
  prompt?: RunDetail["prompt"];
  context?: SourceContext | null;
};

export type RunPatch = Partial<{
  status: RunStatus; startedAt: string | null; finishedAt: string | null; leaseUntil: string | null; attempt: number;
  prompt: RunDetail["prompt"]; context: SourceContext | null; result: RunRecord["result"] | RunRecord["analysis"] | RunRecord["developer"]; error: RunError | null; budget: RunBudget; rawOutput: string | null;
  /** Developer only: the real diff kept when the run failed after one was computed. */
  rejectedDiff: DeveloperDiff | null;
}>;

const COLUMN: Record<keyof RunPatch, [string, (v: unknown) => unknown]> = {
  status: ["status", v => v], startedAt: ["started_at", v => v], finishedAt: ["finished_at", v => v], leaseUntil: ["lease_until", v => v],
  attempt: ["attempt", v => v], prompt: ["prompt_json", v => (v == null ? null : JSON.stringify(v))], context: ["context_json", v => (v == null ? null : JSON.stringify(v))],
  result: ["result_json", v => (v == null ? null : JSON.stringify(v))], error: ["error_json", v => (v == null ? null : JSON.stringify(v))],
  budget: ["budget_json", v => JSON.stringify(v)], rawOutput: ["raw_output", v => v],
  rejectedDiff: ["rejected_diff_json", v => (v == null ? null : JSON.stringify(v))],
};

export class RunStore {
  private ready: Promise<void> | null = null;
  constructor(private db: SqlDriver) {}

  get kind() { return this.db.kind; }

  ensureSchema() {
    this.ready ??= (async () => {
      for (const s of SCHEMA) await this.db.exec(s);
      await this.migrate();
    })();
    return this.ready;
  }

  /** True when the file was written by an older schema (used to take a backup before migrating). */
  async needsMigration() {
    const tables = await this.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
    if (!tables.some(t => t.name === "director_runs")) return false;
    const cols = await this.db.all<{ name: string }>(`PRAGMA table_info(director_runs)`);
    return ADDED_COLUMNS.some(([c]) => !cols.some(x => x.name === c)) || !tables.some(t => t.name === "task_completions");
  }

  /** Consistent copy of the whole database (SQLite VACUUM INTO). */
  async backupTo(file: string) {
    await this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }

  /**
   * v1 → v2: adds the new columns (existing rows keep their data; kind becomes
   * 'director_plan'), replaces the v1 "one active run per demand" index by the
   * kind-aware ones. Idempotent.
   */
  private async migrate() {
    const cols = await this.db.all<{ name: string }>(`PRAGMA table_info(director_runs)`);
    for (const [c, def] of ADDED_COLUMNS) if (!cols.some(x => x.name === c)) await this.db.exec(`ALTER TABLE director_runs ADD COLUMN ${c} ${def}`);
    await this.db.exec(`DROP INDEX IF EXISTS director_runs_one_active`);
    // Recreated every boot: an existing database may still have the pre-Developer definition (architect_task only).
    await this.db.exec(`DROP INDEX IF EXISTS runs_one_active_task`);
    for (const s of INDEXES) await this.db.exec(s);
    await this.db.run(`INSERT INTO ayla_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(SCHEMA_VERSION)]);
  }

  /**
   * Creates a run or returns the one that already answers this request:
   * same idempotency key → same run; an active run for the demand → that run.
   */
  async create(input: NewRun): Promise<{ run: RunRecord; created: boolean }> {
    await this.ensureSchema();
    const kind = input.kind ?? "director_plan";
    const byKey = await this.db.all(`SELECT * FROM director_runs WHERE idempotency_key = ?`, [input.idempotencyKey]);
    if (byKey[0]) return { run: toRecord(byKey[0]), created: false };
    const openRun = () => (kind === "architect_task" || kind === "developer_task" || kind === "qa_task" ? this.openForTask(input.parentRunId ?? "", input.taskId ?? "") : this.activeForDemand(input.demandId));
    const active = await openRun();
    if (active) return { run: active, created: false };
    const t = nowIso();
    try {
      await this.db.run(
        `INSERT INTO director_runs (id, demand_id, agent_id, idempotency_key, status, connection, model, effort, created_at, updated_at, attempt, snapshot_hash, snapshot_json, budget_json, previous_run_id, kind, parent_run_id, task_id, prompt_json, context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.demandId, input.agentId, input.idempotencyKey, input.initialStatus ?? "queued", input.connection, input.model, input.effort, t, t, input.snapshotHash, JSON.stringify(input.snapshot), JSON.stringify(input.budget), input.previousRunId,
          kind, input.parentRunId ?? null, input.taskId ?? null, input.prompt ? JSON.stringify(input.prompt) : null, input.context ? JSON.stringify(input.context) : null],
      );
    } catch (err) {
      // Lost a race against a concurrent click: return the winner.
      const winner = (await this.db.all(`SELECT * FROM director_runs WHERE idempotency_key = ?`, [input.idempotencyKey]))[0] ?? null;
      const act = winner ? toRecord(winner) : await openRun();
      if (act) return { run: act, created: false };
      throw err;
    }
    await this.event(input.id, "created", kind === "architect_task"
      ? "Encaminhamento preparado para o Arquiteto. Nada será executado antes da sua confirmação."
      : kind === "developer_task"
        ? "Encaminhamento preparado para o Desenvolvedor. Nenhuma cópia de trabalho foi criada e nada será executado antes da sua confirmação."
        : kind === "qa_task"
          ? "Encaminhamento preparado para o QA. Nada será executado antes da sua confirmação."
          : "Execução criada e colocada na fila do executor local.");
    return { run: (await this.get(input.id))!, created: true };
  }

  /**
   * Hand-off of a task that is waiting for approval, queued or running (Architect or Developer — a task
   * has exactly one assignee, so parent_run_id + task_id alone identify its hand-offs without a kind filter).
   */
  async openForTask(parentRunId: string, taskId: string) {
    await this.ensureSchema();
    const rows = await this.db.all(`SELECT * FROM director_runs WHERE parent_run_id = ? AND task_id = ? AND status IN ${TASK_OPEN} LIMIT 1`, [parentRunId, taskId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Every hand-off of a task, newest first (Architect or Developer). */
  async runsForTask(parentRunId: string, taskId: string) {
    await this.ensureSchema();
    return (await this.db.all(`SELECT * FROM director_runs WHERE parent_run_id = ? AND task_id = ? ORDER BY created_at DESC`, [parentRunId, taskId])).map(toRecord);
  }

  /** The user's confirmation: awaiting_approval → queued, atomically (a repeated click changes nothing). */
  async approve(id: string) {
    const { changes } = await this.db.run(`UPDATE director_runs SET status = 'queued', updated_at = ? WHERE id = ? AND kind IN ('architect_task', 'developer_task', 'qa_task') AND status = 'awaiting_approval'`, [nowIso(), id]);
    return changes === 1;
  }

  /**
   * Records that a Developer clarification was resolved OUTSIDE the model (orchestrator/human decision),
   * never changing `status` (the model's own outcome stays exactly as returned) and never touching
   * `result_json`. Only applies to a developer_task run still in "awaiting_clarification"; a run that moved
   * on (a fresh attempt was sent, or it was superseded) refuses, since the note would no longer be about the
   * task's current run. Idempotent columns, but each call still appends its own event (an audit trail, not a toggle).
   */
  async resolveClarificationLocally(id: string, resolution: LocalResolution) {
    await this.ensureSchema();
    const { changes } = await this.db.run(
      `UPDATE director_runs SET local_resolution_json = ?, updated_at = ? WHERE id = ? AND kind = 'developer_task' AND status = 'awaiting_clarification'`,
      [JSON.stringify(resolution), nowIso(), id],
    );
    if (changes === 1) await this.event(id, "clarification_resolved_locally", `Esclarecimento resolvido fora do modelo: ${resolution.note}`, resolution);
    return changes === 1;
  }

  /**
   * Appends a validated TaskCompletion — the only thing dependencyEvidence() (lib/engine/dependency.ts)
   * accepts as "this task is done" besides a real completed run. Append-only: never updates a row in place,
   * so an earlier validation is never silently replaced. Also records an immutable event on the plan run
   * (parentRunId), since a direct_implementation completion has no run of its own to attach to.
   */
  async recordTaskCompletion(input: Omit<TaskCompletion, "id" | "createdAt">): Promise<TaskCompletion> {
    await this.ensureSchema();
    const row: TaskCompletion = { ...input, id: randomUUID(), createdAt: nowIso() };
    await this.db.run(
      `INSERT INTO task_completions (id, demand_id, parent_run_id, task_id, kind, source_run_id, commit_hash, files_json, verification_json, note, validated_by, validated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.demandId, row.parentRunId, row.taskId, row.kind, row.sourceRunId, row.commit, JSON.stringify(row.files), JSON.stringify(row.verification), row.note, row.validatedBy, row.validatedAt, row.createdAt],
    );
    await this.event(row.parentRunId, "task_completion_recorded", `Entrega validada de ${row.taskId} (${row.kind === "direct_implementation" ? "implementada diretamente, fora do encaminhamento" : "esclarecimento resolvido e validado"}): commit ${row.commit.slice(0, 12)}, ${row.files.length} arquivo(s), validado por ${row.validatedBy}.`, row);
    return row;
  }

  /** Every validated completion of one task, newest first. */
  async taskCompletions(parentRunId: string, taskId: string): Promise<TaskCompletion[]> {
    await this.ensureSchema();
    const rows = await this.db.all(`SELECT * FROM task_completions WHERE parent_run_id = ? AND task_id = ? ORDER BY created_at DESC`, [parentRunId, taskId]);
    return rows.map(toCompletion);
  }

  /** Every validated completion of every task of one plan, newest first — one query for the whole dependency graph. */
  async taskCompletionsForPlan(parentRunId: string): Promise<TaskCompletion[]> {
    await this.ensureSchema();
    const rows = await this.db.all(`SELECT * FROM task_completions WHERE parent_run_id = ? ORDER BY created_at DESC`, [parentRunId]);
    return rows.map(toCompletion);
  }

  async activeForDemand(demandId: string) {
    await this.ensureSchema();
    const rows = await this.db.all(`SELECT * FROM director_runs WHERE kind = 'director_plan' AND demand_id = ? AND status IN ('queued', 'planning') LIMIT 1`, [demandId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async get(id: string) {
    await this.ensureSchema();
    const rows = await this.db.all(`SELECT * FROM director_runs WHERE id = ?`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async detail(id: string): Promise<RunDetail | null> {
    await this.ensureSchema();
    const rows = await this.db.all(`SELECT * FROM director_runs WHERE id = ?`, [id]);
    if (!rows[0]) return null;
    const events = await this.events(id);
    return { ...toRecord(rows[0]), events, snapshot: parse<RunDetail["snapshot"]>(rows[0].snapshot_json)!, prompt: parse<RunDetail["prompt"]>(rows[0].prompt_json), rawOutput: (rows[0].raw_output as string) ?? null };
  }

  async snapshot(id: string) {
    const rows = await this.db.all(`SELECT snapshot_json FROM director_runs WHERE id = ?`, [id]);
    return rows[0] ? parse<RunDetail["snapshot"]>(rows[0].snapshot_json) : null;
  }

  /** All runs of the given demands, newest first (for the queue). */
  async listForDemands(demandIds: string[]) {
    await this.ensureSchema();
    if (!demandIds.length) return [];
    const ids = demandIds.slice(0, 200);
    const rows = await this.db.all(`SELECT * FROM director_runs WHERE demand_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at DESC`, ids);
    return rows.map(toRecord);
  }

  async update(id: string, patch: RunPatch, onlyIfStatus?: RunStatus[]) {
    const sets: string[] = ["updated_at = ?"], params: unknown[] = [nowIso()];
    for (const [k, v] of Object.entries(patch) as [keyof RunPatch, unknown][]) {
      const [col, enc] = COLUMN[k];
      sets.push(`${col} = ?`);
      params.push(enc(v));
    }
    let sql = `UPDATE director_runs SET ${sets.join(", ")} WHERE id = ?`;
    params.push(id);
    if (onlyIfStatus?.length) { sql += ` AND status IN (${onlyIfStatus.map(() => "?").join(",")})`; params.push(...onlyIfStatus); }
    return (await this.db.run(sql, params)).changes;
  }

  /** Atomically moves a queued run to planning; false when someone else already claimed it. */
  async claim(id: string, leaseMs: number) {
    const t = Date.now();
    const changes = await this.db.run(
      `UPDATE director_runs SET status = 'planning', started_at = ?, lease_until = ?, attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'queued'`,
      [new Date(t).toISOString(), new Date(t + leaseMs).toISOString(), new Date(t).toISOString(), id],
    );
    return changes.changes === 1;
  }

  async renewLease(id: string, leaseMs: number) {
    await this.db.run(`UPDATE director_runs SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'planning'`, [new Date(Date.now() + leaseMs).toISOString(), nowIso(), id]);
  }

  /**
   * A planning run whose lease expired (executor stopped or crashed) is marked
   * as failed/interrupted so the demand can be planned again.
   */
  async reapIfStale(id: string) {
    const t = nowIso();
    const err = JSON.stringify({ code: "interrupted", message: "A execução foi interrompida (o executor local foi encerrado ou reiniciado durante o planejamento). Você pode planejar novamente.", retryable: true });
    const { changes } = await this.db.run(`UPDATE director_runs SET status = 'failed', error_json = ?, finished_at = ?, updated_at = ?, lease_until = NULL WHERE id = ? AND status = 'planning' AND lease_until IS NOT NULL AND lease_until < ?`, [err, t, t, id, t]);
    if (changes) await this.event(id, "interrupted", "Execução marcada como interrompida: o prazo de processamento expirou sem conclusão.");
    return changes > 0;
  }

  async event(runId: string, kind: string, message: string, data?: unknown) {
    await this.db.run(
      `INSERT INTO director_run_events (run_id, seq, at, kind, message, data_json)
       SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ? FROM director_run_events WHERE run_id = ?`,
      [runId, nowIso(), kind, message, data === undefined ? null : JSON.stringify(data), runId],
    );
  }

  async events(runId: string): Promise<RunEvent[]> {
    const rows = await this.db.all(`SELECT seq, at, kind, message, data_json FROM director_run_events WHERE run_id = ? ORDER BY seq`, [runId]);
    return rows.map(r => ({ seq: Number(r.seq), at: String(r.at), kind: String(r.kind), message: String(r.message), data: parse(r.data_json) ?? undefined }));
  }

  /** Runs left in "planning" by a previous executor process: nobody is working on them any more. */
  async interruptOrphans() {
    await this.ensureSchema();
    const rows = await this.db.all<{ id: string }>(`SELECT id FROM director_runs WHERE status = 'planning'`);
    const t = nowIso();
    const err = JSON.stringify({ code: "interrupted", message: "A execução foi interrompida: o executor local foi encerrado durante o planejamento. Você pode planejar novamente.", retryable: true, recovery: ["Clique em “Planejar novamente”."] });
    for (const r of rows) {
      const { changes } = await this.db.run(`UPDATE director_runs SET status = 'failed', error_json = ?, finished_at = ?, updated_at = ?, lease_until = NULL WHERE id = ? AND status = 'planning'`, [err, t, t, r.id]);
      if (changes) await this.event(r.id, "interrupted", "Execução marcada como interrompida ao reiniciar o executor.");
    }
    return rows.length;
  }

  async queuedIds() {
    await this.ensureSchema();
    return (await this.db.all<{ id: string }>(`SELECT id FROM director_runs WHERE status = 'queued' ORDER BY created_at`)).map(r => r.id);
  }

  async logConnection(connection: string, ok: boolean, code: string | null) {
    await this.ensureSchema();
    await this.db.run(`INSERT INTO connection_log (connection, at, ok, code) VALUES (?, ?, ?, ?)`, [connection, nowIso(), ok ? 1 : 0, code]);
    await this.db.run(`DELETE FROM connection_log WHERE connection = ? AND at < ?`, [connection, new Date(Date.now() - 30 * 86400_000).toISOString()]);
  }

  /** Latest real-call outcome for a connection. */
  async lastConnectionOutcome(connection: string) {
    await this.ensureSchema();
    const rows = await this.db.all<{ at: string; ok: number; code: string | null }>(`SELECT at, ok, code FROM connection_log WHERE connection = ? ORDER BY at DESC LIMIT 1`, [connection]);
    return rows[0] ? { at: String(rows[0].at), ok: Number(rows[0].ok) === 1, code: rows[0].code } : null;
  }

  async countCreatedSince(iso: string) {
    await this.ensureSchema();
    const rows = await this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM director_runs WHERE created_at >= ?`, [iso]);
    return Number(rows[0]?.n ?? 0);
  }

  async countActive() {
    await this.ensureSchema();
    const rows = await this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM director_runs WHERE status IN ('queued', 'planning')`);
    return Number(rows[0]?.n ?? 0);
  }
}
