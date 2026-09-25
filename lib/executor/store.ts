// Durable run storage behind a tiny SQL driver interface.
// The executor uses a local SQLite file (node:sqlite, see sqlite.ts). The SQL
// is portable: Postgres needs only a driver that maps "?" placeholders to $n.
import type { RunBudget, RunDetail, RunError, RunEvent, RunRecord, RunStatus, SourceContext } from "@/lib/engine/types";

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
    error_json TEXT,
    budget_json TEXT NOT NULL,
    raw_output TEXT,
    previous_run_id TEXT
  )`,
  // At most one active run per demand, enforced by the database (no duplicate runs on double click / refresh).
  `CREATE UNIQUE INDEX IF NOT EXISTS director_runs_one_active ON director_runs (demand_id) WHERE status IN ('queued', 'planning')`,
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
];

type Row = Record<string, unknown>;
const parse = <T>(v: unknown): T | null => (typeof v === "string" && v ? (JSON.parse(v) as T) : null);
const nowIso = () => new Date().toISOString();

function toRecord(r: Row): RunRecord {
  return {
    id: String(r.id), demandId: String(r.demand_id), agentId: String(r.agent_id), status: r.status as RunStatus,
    connection: r.connection as RunRecord["connection"], model: String(r.model), effort: String(r.effort ?? ""),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    startedAt: (r.started_at as string) ?? null, finishedAt: (r.finished_at as string) ?? null, leaseUntil: (r.lease_until as string) ?? null,
    attempt: Number(r.attempt ?? 0), snapshotHash: String(r.snapshot_hash),
    budget: parse<RunBudget>(r.budget_json)!, context: parse<SourceContext>(r.context_json),
    result: parse<RunRecord["result"]>(r.result_json), error: parse<RunError>(r.error_json),
    previousRunId: (r.previous_run_id as string) ?? null,
  };
}

export type NewRun = {
  id: string; demandId: string; agentId: string; idempotencyKey: string; connection: RunRecord["connection"]; model: string;
  effort: string; snapshotHash: string; snapshot: RunDetail["snapshot"]; budget: RunBudget; previousRunId: string | null;
};

export type RunPatch = Partial<{
  status: RunStatus; startedAt: string | null; finishedAt: string | null; leaseUntil: string | null; attempt: number;
  prompt: RunDetail["prompt"]; context: SourceContext | null; result: RunRecord["result"]; error: RunError | null; budget: RunBudget; rawOutput: string | null;
}>;

const COLUMN: Record<keyof RunPatch, [string, (v: unknown) => unknown]> = {
  status: ["status", v => v], startedAt: ["started_at", v => v], finishedAt: ["finished_at", v => v], leaseUntil: ["lease_until", v => v],
  attempt: ["attempt", v => v], prompt: ["prompt_json", v => (v == null ? null : JSON.stringify(v))], context: ["context_json", v => (v == null ? null : JSON.stringify(v))],
  result: ["result_json", v => (v == null ? null : JSON.stringify(v))], error: ["error_json", v => (v == null ? null : JSON.stringify(v))],
  budget: ["budget_json", v => JSON.stringify(v)], rawOutput: ["raw_output", v => v],
};

export class RunStore {
  private ready: Promise<void> | null = null;
  constructor(private db: SqlDriver) {}

  get kind() { return this.db.kind; }

  ensureSchema() {
    this.ready ??= (async () => { for (const s of SCHEMA) await this.db.exec(s); })();
    return this.ready;
  }

  /**
   * Creates a run or returns the one that already answers this request:
   * same idempotency key → same run; an active run for the demand → that run.
   */
  async create(input: NewRun): Promise<{ run: RunRecord; created: boolean }> {
    await this.ensureSchema();
    const byKey = await this.db.all(`SELECT * FROM director_runs WHERE idempotency_key = ?`, [input.idempotencyKey]);
    if (byKey[0]) return { run: toRecord(byKey[0]), created: false };
    const active = await this.activeForDemand(input.demandId);
    if (active) return { run: active, created: false };
    const t = nowIso();
    try {
      await this.db.run(
        `INSERT INTO director_runs (id, demand_id, agent_id, idempotency_key, status, connection, model, effort, created_at, updated_at, attempt, snapshot_hash, snapshot_json, budget_json, previous_run_id)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [input.id, input.demandId, input.agentId, input.idempotencyKey, input.connection, input.model, input.effort, t, t, input.snapshotHash, JSON.stringify(input.snapshot), JSON.stringify(input.budget), input.previousRunId],
      );
    } catch (err) {
      // Lost a race against a concurrent click: return the winner.
      const winner = (await this.db.all(`SELECT * FROM director_runs WHERE idempotency_key = ?`, [input.idempotencyKey]))[0] ?? null;
      const act = winner ? toRecord(winner) : await this.activeForDemand(input.demandId);
      if (act) return { run: act, created: false };
      throw err;
    }
    await this.event(input.id, "created", "Execução criada e colocada na fila do executor local.");
    return { run: (await this.get(input.id))!, created: true };
  }

  async activeForDemand(demandId: string) {
    await this.ensureSchema();
    const rows = await this.db.all(`SELECT * FROM director_runs WHERE demand_id = ? AND status IN ('queued', 'planning') LIMIT 1`, [demandId]);
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
