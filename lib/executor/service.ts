// The executor's application logic, independent from HTTP: run queue,
// concurrency, cancellation, connection status. State lives in the RunStore
// (SQLite file); in-memory maps only track processes of this executor.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { CONNECTION_IDS } from "@/lib/engine/connections";
import { HANDOFF_TARGETS, type ConnectionId, type ConnectionStatus, type DirectorSnapshot, type EngineStatus, type RunRecord } from "@/lib/engine/types";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import type { AgentAdapter } from "./adapters/types";
import { detect, LOGIN_STEPS, resolveClient, type ClientDeps } from "./clients";
import { developerPreview } from "./developer-preview";
import { HandoffRefused, HandoffZ, prepareHandoff, sourceOptions } from "./handoff";
import { listLocalRepos } from "./local-git";
import { processRun } from "./planner";
import type { Runner } from "./proc";
import { EXECUTABLE_AGENTS, buildNewRun, parseStartRequest } from "./runs-service";
import type { RunStore } from "./store";
import type { EnvVars } from "./proc";

export type ExecutorConfig = {
  version: string;
  dataDir: string;
  storePath: string;
  workRoot: string;
  limits: { maxRunsPerHour: number; maxConcurrentRuns: number; callTimeoutMs: number; leaseMs: number; statusCacheMs: number };
  github: { token?: string; apiBase?: string; rawBase?: string; fetch?: typeof fetch };
  /** Local Git clones the user authorized for read-only reading (AYLA_LOCAL_REPOS, absolute paths). */
  localRepos?: string[];
};

export type ServiceDeps = {
  store: RunStore;
  runner: Runner;
  env: EnvVars;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  nodePath?: string;
  /** Test hook: replaces the adapters built from the detected clients. */
  adapters?: Partial<Record<ConnectionId, AgentAdapter | null>>;
  /** Test hook: replaces client detection. */
  detectors?: Partial<Record<ConnectionId, () => Promise<ConnectionStatus>>>;
};

export type Reply = { status: number; body: unknown };

/**
 * Read-only guarantee per adapter, required before the Architect may use it.
 * Verified with a real write attempt (scripts/check-readonly.ts); see docs/executor-local.md.
 */
export const READ_ONLY: Record<ConnectionId, { safe: boolean; how: string }> = {
  claude_code: { safe: true, how: "Claude Code sem nenhuma ferramenta (--tools \"\"), permissões negadas (--permission-mode dontAsk, --disallowedTools), sem MCP, sem personalizações e em pasta vazia." },
  codex: { safe: true, how: "Codex CLI em sandbox somente leitura (--sandbox read-only, approval_policy never), shell e ferramentas extras desligadas, sem busca na web e em pasta vazia." },
};
const err = (status: number, code: string, message: string, details?: string[]): Reply => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });

export class ExecutorService {
  private running = new Map<string, AbortController>();
  private waiting: string[] = [];
  private cache = new Map<ConnectionId, { at: number; status: ConnectionStatus }>();
  private checking = new Map<ConnectionId, Promise<ConnectionStatus>>();
  private clientDeps: ClientDeps;

  constructor(private cfg: ExecutorConfig, private deps: ServiceDeps) {
    mkdirSync(cfg.workRoot, { recursive: true });
    const statusDir = path.join(cfg.workRoot, "_status");
    mkdirSync(statusDir, { recursive: true });
    this.clientDeps = {
      runner: deps.runner, env: deps.env, platform: deps.platform ?? process.platform,
      exists: deps.exists ?? existsSync,
      cwd: statusDir, nodePath: deps.nodePath ?? process.execPath,
    };
  }

  get store() { return this.deps.store; }

  private gitDeps() {
    return { runner: this.deps.runner, env: this.deps.env, platform: this.clientDeps.platform, exists: this.clientDeps.exists };
  }

  /** Called once at start: runs left "planning" by a previous process are interrupted; queued ones resume. */
  async boot() {
    await this.store.ensureSchema();
    await this.store.interruptOrphans();
    for (const id of await this.store.queuedIds()) this.enqueue(id);
  }

  // ---- connections -------------------------------------------------------

  async connection(id: ConnectionId, force = false): Promise<ConnectionStatus> {
    const hit = this.cache.get(id);
    if (!force && hit && Date.now() - hit.at < this.cfg.limits.statusCacheMs) return hit.status;
    const pending = this.checking.get(id);
    if (pending) return pending;
    const p = (async () => {
      const d = this.deps.detectors?.[id] ?? (() => detect[id](this.clientDeps));
      let st = await d();
      // The client may still list a saved login that the service already refused.
      if (st.state === "connected") {
        const last = await this.store.lastConnectionOutcome(id);
        if (last && !last.ok && last.code === "session_expired") {
          st = { ...st, state: "expired", message: `${st.client} ainda tem um login salvo, mas a última chamada real foi recusada por sessão expirada (${new Date(last.at).toLocaleString("pt-BR")}).`, steps: LOGIN_STEPS[id].expired };
        } else if (last && !last.ok && last.code === "auth_busy") {
          // Not an expired login (the client says it is transient), but the user must know the last real call failed on it.
          st = { ...st, message: `${st.message} Atenção: a última chamada real (${new Date(last.at).toLocaleString("pt-BR")}) falhou porque o cliente não conseguiu renovar o token de acesso. Se repetir, rode o cliente uma vez no seu terminal para ele renovar o login.` };
        }
      }
      this.cache.set(id, { at: Date.now(), status: st });
      return st;
    })().finally(() => this.checking.delete(id));
    this.checking.set(id, p);
    return p;
  }

  private adapterFor(id: ConnectionId): AgentAdapter | null {
    if (this.deps.adapters && id in this.deps.adapters) return this.deps.adapters[id] ?? null;
    const inv = resolveClient(id, this.clientDeps);
    if (!inv) return null;
    return id === "claude_code" ? claudeAdapter(inv, this.deps.runner, this.deps.env) : codexAdapter(inv, this.deps.runner, this.deps.env);
  }

  /**
   * Optional real check of a session with a minimal call (uses a little of the subscription).
   * Only on explicit request from the user.
   */
  async probe(id: ConnectionId): Promise<Reply> {
    const st = await this.connection(id, true);
    if (st.state === "not_installed" || st.state === "disconnected" || st.state === "unavailable") return { status: 200, body: { ok: false, status: st, message: st.message } };
    const adapter = this.adapterFor(id);
    if (!adapter) return { status: 200, body: { ok: false, status: st, message: "Cliente não encontrado." } };
    const workDir = path.join(this.cfg.workRoot, `_probe-${id}-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      const r = await adapter.call({
        label: "teste de sessão", system: "Responda apenas no formato pedido.", user: "Responda com ok = true.",
        schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
        model: "", effort: "", timeoutMs: Math.min(this.cfg.limits.callTimeoutMs, 120000), workDir,
      });
      await this.store.logConnection(id, true, null);
      this.cache.delete(id);
      return { status: 200, body: { ok: true, status: await this.connection(id, true), message: "Sessão confirmada com uma chamada real mínima.", usage: r.usage } };
    } catch (e) {
      const code = (e as { code?: string }).code ?? "client_error";
      if (code === "session_expired" || code === "not_connected" || code === "auth_busy") await this.store.logConnection(id, false, code);
      this.cache.delete(id);
      return { status: 200, body: { ok: false, status: await this.connection(id, true), message: (e as Error).message, code, detail: (e as { detail?: string }).detail } };
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  async status(force = false): Promise<Omit<EngineStatus, "executionEnabled" | "disabledReason">> {
    let storeOk = true, storeMsg: string | null = null;
    try { await this.store.ensureSchema(); } catch (e) { storeOk = false; storeMsg = (e as Error).message; }
    const connections: EngineStatus["connections"] = {};
    await Promise.all(CONNECTION_IDS.map(async id => { connections[id] = await this.connection(id, force); }));
    return {
      executor: { reachable: true, message: null, version: this.cfg.version },
      store: { ok: storeOk, kind: this.store.kind, path: this.cfg.storePath, message: storeMsg },
      connections,
      github: { mode: "public-only", tokenConfigured: !!this.cfg.github.token },
      limits: { maxRunsPerHour: this.cfg.limits.maxRunsPerHour, maxConcurrentRuns: this.cfg.limits.maxConcurrentRuns, callTimeoutMs: this.cfg.limits.callTimeoutMs },
      executableAgents: EXECUTABLE_AGENTS,
      handoffTargets: [...HANDOFF_TARGETS],
      readOnly: READ_ONLY,
      localRepos: (await listLocalRepos(this.cfg.localRepos ?? [], this.gitDeps())).map(r => ({ dirName: r.dirName, owner: r.owner, repo: r.repo, head: r.head, headSubject: r.headSubject })),
    };
  }

  // ---- runs --------------------------------------------------------------

  async start(body: unknown): Promise<Reply> {
    const parsed = parseStartRequest(body);
    if (!parsed.ok) return err(400, "invalid_request", "Dados da demanda ou da ficha inválidos.", parsed.errors);
    const req = parsed.value;
    const store = this.store;
    if (req.previousRunId) {
      const prev = await store.get(req.previousRunId);
      if (!prev || prev.demandId !== req.demand.id || prev.status !== "awaiting_clarification") {
        return err(400, "invalid_previous_run", "As respostas não correspondem a uma execução desta demanda aguardando esclarecimento.");
      }
    }
    // Dedup first: a repeated click must not count against the limits nor start a second process.
    const existing = await store.activeForDemand(req.demand.id);
    if (existing) return { status: 200, body: { run: existing, created: false } };
    if ((await store.countActive()) >= this.cfg.limits.maxConcurrentRuns + 5) return err(429, "too_many_active", "Há execuções demais aguardando. Espere a conclusão das atuais.");
    if ((await store.countCreatedSince(new Date(Date.now() - 3600_000).toISOString())) >= this.cfg.limits.maxRunsPerHour) {
      return err(429, "rate_limited", `Limite local de ${this.cfg.limits.maxRunsPerHour} execuções por hora atingido (proteção do uso da sua assinatura).`);
    }
    const { run, created } = await store.create(buildNewRun(req));
    if (created) this.enqueue(run.id);
    return { status: created ? 202 : 200, body: { run, created } };
  }

  // ---- hand-off to the Architect -----------------------------------------

  /** Step 1: validate against the executor's own records and freeze what will be sent. Nothing runs. */
  async prepare(body: unknown): Promise<Reply> {
    const parsed = HandoffZ.safeParse(body);
    if (!parsed.success) return err(400, "invalid_request", "Dados do encaminhamento inválidos.", parsed.error.issues.slice(0, 10).map(i => `${i.path.join(".")}: ${i.message}`));
    const req = parsed.data;
    if (req.agent.connection !== "none" && !READ_ONLY[req.agent.connection].safe) {
      return err(409, "adapter_not_read_only", "Esta conexão não pode ser restrita a somente leitura e está bloqueada para o Arquiteto. Escolha a outra conexão na ficha dele.");
    }
    if ((await this.store.countCreatedSince(new Date(Date.now() - 3600_000).toISOString())) >= this.cfg.limits.maxRunsPerHour) {
      return err(429, "rate_limited", `Limite local de ${this.cfg.limits.maxRunsPerHour} execuções por hora atingido (proteção do uso da sua assinatura).`);
    }
    try {
      const { run, created } = await prepareHandoff(req, this.handoffDeps());
      return { status: created ? 201 : 200, body: { run: await this.store.detail(run.id), created } };
    } catch (e) {
      if (e instanceof HandoffRefused) return err(e.status, e.code, e.message, e.details);
      throw e;
    }
  }

  private handoffDeps() {
    return { store: this.store, github: this.cfg.github, local: { dirs: this.cfg.localRepos ?? [], git: this.gitDeps() } };
  }

  /** Before step 1: commits and files to choose from for a hand-off (read-only; nothing is recorded, no model is called). */
  async sourceOptions(directorRunId: string, taskId: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(directorRunId) || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) return err(400, "invalid_request", "Plano ou tarefa inválidos.");
    try { return { status: 200, body: await sourceOptions({ directorRunId, taskId }, this.handoffDeps()) }; }
    catch (e) { if (e instanceof HandoffRefused) return err(e.status, e.code, e.message, e.details); throw e; }
  }

  /** Preview of a future Developer hand-off: a view of the records only (no run, no model call, no write access). */
  async developerPreview(directorRunId: string, taskId: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(directorRunId) || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) return err(400, "invalid_request", "Plano ou tarefa inválidos.");
    try { return { status: 200, body: { preview: await developerPreview({ directorRunId, taskId }, this.handoffDeps()) } }; }
    catch (e) { if (e instanceof HandoffRefused) return err(e.status, e.code, e.message, e.details); throw e; }
  }

  /** Step 2: the user's confirmation of the exact prepared content (identified by its hash). */
  async approve(id: string, body: unknown): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return err(404, "not_found", "Execução não encontrada.");
    const hash = (body as { snapshotHash?: unknown } | null)?.snapshotHash;
    const run = await this.store.get(id);
    if (!run || run.kind !== "architect_task") return err(404, "not_found", "Encaminhamento não encontrado.");
    if (run.status !== "awaiting_approval") return { status: 200, body: { run, approved: false } };
    if (typeof hash !== "string" || hash !== run.snapshotHash) return err(409, "content_changed", "O conteúdo confirmado não corresponde ao encaminhamento preparado. Abra a revisão de novo.");
    const parent = run.parentRunId ? await this.store.get(run.parentRunId) : null;
    if (!parent || parent.status !== "plan_ready") return err(409, "plan_not_ready", "O plano do Diretor desta tarefa não está mais disponível.");
    if (!(await this.store.approve(id))) return { status: 200, body: { run: await this.store.get(id), approved: false } };
    await this.store.event(id, "approved", "Envio confirmado por você. O Arquiteto entrou na fila do executor local.");
    this.enqueue(id);
    return { status: 202, body: { run: await this.store.get(id), approved: true } };
  }

  private enqueue(id: string) {
    if (this.running.has(id) || this.waiting.includes(id)) return;
    this.waiting.push(id);
    this.pump();
  }

  private pump() {
    while (this.running.size < this.cfg.limits.maxConcurrentRuns && this.waiting.length) {
      const id = this.waiting.shift()!;
      const ac = new AbortController();
      this.running.set(id, ac);
      void this.execute(id, ac).finally(() => { this.running.delete(id); this.pump(); });
    }
  }

  private async execute(id: string, ac: AbortController) {
    const snap = await this.store.snapshot(id);
    const run = await this.store.get(id);
    if (!snap || !run) return;
    const conn = run.connection;
    await processRun(id, {
      store: this.store,
      connection: () => this.connection(conn, true),
      adapter: this.adapterFor(conn),
      limits: { callTimeoutMs: this.cfg.limits.callTimeoutMs, leaseMs: this.cfg.limits.leaseMs },
      github: { ...this.cfg.github, permitted: (snap as DirectorSnapshot).director?.tools.github !== false },
      workRoot: this.cfg.workRoot,
      signal: ac.signal,
    });
    this.cache.delete(conn);
  }

  async list(demandIds: string[]): Promise<Reply> {
    const ids = demandIds.filter(s => /^[A-Za-z0-9_-]{1,64}$/.test(s)).slice(0, 200);
    const runs = await this.store.listForDemands(ids);
    for (const r of runs) if (r.status === "planning" && !this.running.has(r.id)) await this.store.reapIfStale(r.id);
    return { status: 200, body: { runs: await this.store.listForDemands(ids) } };
  }

  async get(id: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return err(404, "not_found", "Execução não encontrada.");
    if (!this.running.has(id)) await this.store.reapIfStale(id);
    const run = await this.store.detail(id);
    if (!run) return err(404, "not_found", "Execução não encontrada.");
    return { status: 200, body: { run } };
  }

  async cancel(id: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return err(404, "not_found", "Execução não encontrada.");
    const before = await this.store.get(id);
    const changed = await this.store.update(id, { status: "canceled", finishedAt: new Date().toISOString(), leaseUntil: null }, ["awaiting_approval", "queued", "planning"]);
    if (changed) {
      this.waiting = this.waiting.filter(w => w !== id);
      const ac = this.running.get(id);
      ac?.abort();
      await this.store.event(id, "canceled", before?.status === "awaiting_approval"
        ? "Envio descartado por você antes da confirmação. Nada foi executado."
        : ac ? "Execução cancelada pelo usuário: o processo do cliente oficial foi encerrado. O uso já consumido até esse ponto pode contar na assinatura." : "Execução cancelada pelo usuário antes de começar.");
    }
    const run: RunRecord | null = await this.store.get(id);
    if (!run) return err(404, "not_found", "Execução não encontrada.");
    return { status: 200, body: { run, canceled: changed > 0 } };
  }

  /** Waits for the current processes (used by tests and graceful shutdown). */
  async idle() {
    while (this.running.size || this.waiting.length) await new Promise(r => setTimeout(r, 10));
  }

  abortAll() { for (const ac of this.running.values()) ac.abort(); }
}
