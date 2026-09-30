// The executor's application logic, independent from HTTP: run queue,
// concurrency, cancellation, connection status. State lives in the RunStore
// (SQLite file); in-memory maps only track processes of this executor.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { apiConnectionIdOf, apiConnectionStatus, CONNECTION_IDS, isApiConnectionRef } from "@/lib/engine/connections";
import { HANDOFF_TARGETS, type AgentConnectionRef, type ConnectionId, type ConnectionStatus, type DirectorSnapshot, type EngineStatus, type LocalResolution, type RunRecord } from "@/lib/engine/types";
import { apiAdapter } from "./adapters/api";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import type { AgentAdapter } from "./adapters/types";
import { detect, LOGIN_STEPS, resolveClient, type ClientDeps } from "./clients";
import { DeveloperHandoffZ, prepareDeveloperHandoff } from "./developer";
import { developerPreview } from "./developer-preview";
import { HandoffRefused, HandoffZ, prepareHandoff, sourceOptions } from "./handoff";
import { ApplyRefused, applyReviewed, buildApplyReview, type ApplyDeps } from "./apply";
import { listLocalRepos } from "./local-git";
import { processRun } from "./planner";
import { spawnBackground, type BackgroundSpawner, type Runner } from "./proc";
import { ProjectRefused, authorizedDirs, getProject, listProjects, loadExecPlan, registerProject, removeProject, type ProjectDeps } from "./projects";
import { isArtifactName, type EnvDeps } from "./qa-env";
import { buildSetorIaFixture } from "./qa-fixtures";
import { SUPPORTED_MANAGERS, detectProject, validateConfig } from "./project-config";
import { detectQATooling } from "./qa-ops";
import { runVerification } from "./verify";
import { QAHandoffZ, prepareQAHandoff } from "./qa";
import { ReviewerHandoffZ, prepareReviewerHandoff } from "./reviewer";
import { EXECUTABLE_AGENTS, buildNewRun, parseStartRequest } from "./runs-service";
import { decryptSecret, encryptSecret, last4, parseBox, parseMachineKeyB64, randomMachineKeyB64, serializeBox } from "./secret-store";
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
  /**
   * Base64 32-byte key used to encrypt API-connection secrets at rest (see lib/executor/secret-store.ts).
   * Production (executor/main.ts) always persists one in .dev.vars, mode 0600, gitignored, the same pattern
   * as the executor's own bearer token. When absent (tests), a fresh one is generated in memory.
   */
  secretKeyB64?: string;
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
  /** Long-running processes (the app under test). Defaults to the real spawner. */
  spawnBg?: BackgroundSpawner;
  /** Test hook for the application flow (a throw simulates a failure right after the files were written). */
  applyAfterWrite?: () => Promise<void>;
  /** Test hook: a controlled stand-in for the package manager in isolated environments. */
  packageManager?: import("./qa-env").PackageManager;
};

/** `raw`: a file answer (artifacts) instead of JSON. */
export type Reply = { status: number; body: unknown; raw?: { contentType: string; data: Buffer; filename: string } };

/**
 * Read-only guarantee per adapter, required before the Architect may use it.
 * Verified with a real write attempt (scripts/check-readonly.ts); see docs/executor-local.md.
 */
export const READ_ONLY: Record<ConnectionId, { safe: boolean; how: string }> = {
  claude_code: { safe: true, how: "Claude Code sem nenhuma ferramenta (--tools \"\"), permissões negadas (--permission-mode dontAsk, --disallowedTools), sem MCP, sem personalizações e em pasta vazia." },
  codex: { safe: true, how: "Codex CLI em sandbox somente leitura (--sandbox read-only, approval_policy never), shell e ferramentas extras desligadas, sem busca na web e em pasta vazia." },
};

/**
 * Write confinement required before the Developer may use a connection. Unlike READ_ONLY, granting real
 * Edit/Write; must be backed by a client mechanism this Setor IA has actually read the documentation of
 * and can name here (see adapters/claude.ts, mode "developer_write"). Codex is left unverified in this
 * version: its workspace-write sandbox's network policy has not been confirmed on this system, so it is
 * blocked for the Developer rather than assumed safe.
 */
export const WRITE_RESTRICTED: Record<ConnectionId, { safe: boolean; how: string }> = {
  claude_code: { safe: true, how: "Claude Code em --restricted: remove Bash/PowerShell/REPL e WebFetch (não nomeados em --allowedTools), confina Read/Edit/Write/Glob/Grep à cópia de trabalho isolada (sem --add-dir), ignora configurações de usuário/projeto/local (sem hooks nem CLAUDE.md automático) e recusa bypassPermissions; --disallowedTools nega Bash/PowerShell/NotebookEdit/WebFetch/WebSearch/Task como segunda camada." },
  codex: { safe: false, how: "Bloqueado nesta versão: a política de rede do sandbox workspace-write do Codex CLI não foi verificada neste ambiente. Use Claude Code na ficha do Desenvolvedor." },
};
const err = (status: number, code: string, message: string, details?: string[]): Reply => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });

export class ExecutorService {
  private running = new Map<string, AbortController>();
  private waiting: string[] = [];
  private cache = new Map<ConnectionId, { at: number; status: ConnectionStatus }>();
  private checking = new Map<ConnectionId, Promise<ConnectionStatus>>();
  private clientDeps: ClientDeps;
  private secretKey: Buffer;
  /** Verifications of applied deliveries running in this process (cancellable). */
  private verifying = new Map<string, AbortController>();

  constructor(private cfg: ExecutorConfig, private deps: ServiceDeps) {
    mkdirSync(cfg.workRoot, { recursive: true });
    const statusDir = path.join(cfg.workRoot, "_status");
    mkdirSync(statusDir, { recursive: true });
    this.clientDeps = {
      runner: deps.runner, env: deps.env, platform: deps.platform ?? process.platform,
      exists: deps.exists ?? existsSync,
      cwd: statusDir, nodePath: deps.nodePath ?? process.execPath,
    };
    this.secretKey = parseMachineKeyB64(cfg.secretKeyB64 ?? randomMachineKeyB64());
  }

  get store() { return this.deps.store; }

  private gitDeps() {
    return { runner: this.deps.runner, env: this.deps.env, platform: this.clientDeps.platform, exists: this.clientDeps.exists };
  }

  private projectDeps(): ProjectDeps { return { store: this.store, git: this.gitDeps(), envDirs: this.cfg.localRepos ?? [], decrypt: box => decryptSecret(this.secretKey, parseBox(box)) }; }
  private envDeps(signal?: AbortSignal): EnvDeps { return { git: this.gitDeps(), spawnBg: this.deps.spawnBg ?? spawnBackground, nodePath: this.deps.nodePath ?? process.execPath, signal, packageManager: this.deps.packageManager }; }
  private get artifactsRoot() { return path.join(this.cfg.dataDir, "artifacts"); }
  private applyDeps(): ApplyDeps { return { store: this.store, git: this.gitDeps(), projects: this.projectDeps(), dataDir: this.cfg.dataDir, workRoot: this.cfg.workRoot, afterWrite: this.deps.applyAfterWrite }; }
  /** AYLA_LOCAL_REPOS + the projects registered in the interface (usable ones). */
  private authorized() { return authorizedDirs(this.projectDeps()); }

  /** Called once at start: runs left "planning" by a previous process are interrupted; queued ones resume. */
  async boot() {
    await this.store.ensureSchema();
    await this.store.interruptOrphans();
    await this.store.interruptVerifications();
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

  /** Status for any connection a sheet/run may use — an official client (cached, force-refreshable) or a configured API connection (read from its own record; verifying it is a separate, explicit action — verifyApiConnection). */
  async connectionOrApi(ref: AgentConnectionRef, force = false): Promise<ConnectionStatus> {
    if (isApiConnectionRef(ref)) return apiConnectionStatus(await this.store.getApiConnectionRecord(apiConnectionIdOf(ref)), apiConnectionIdOf(ref));
    return this.connection(ref, force);
  }

  private async adapterForRef(ref: AgentConnectionRef): Promise<AgentAdapter | null> {
    if (!isApiConnectionRef(ref)) return this.adapterFor(ref);
    const found = await this.store.getApiConnectionSecret(apiConnectionIdOf(ref));
    if (!found) return null;
    return apiAdapter(found.record, decryptSecret(this.secretKey, parseBox(found.secretJson)));
  }

  private readOnlySafe(ref: AgentConnectionRef): boolean {
    return isApiConnectionRef(ref) || READ_ONLY[ref].safe;
  }

  private writeSafe(ref: AgentConnectionRef): boolean {
    return !isApiConnectionRef(ref) && WRITE_RESTRICTED[ref].safe;
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

  // ---- API-key connections -------------------------------------------------
  // Billed separately from the Claude/ChatGPT subscriptions used by the official clients. The key never
  // leaves this method (or verifyApiConnection/adapterForRef): every reply below returns only the masked
  // ApiConnectionRecord, never the key itself.

  async createApiConnection(body: unknown): Promise<Reply> {
    const b = (body ?? {}) as { provider?: unknown; label?: unknown; apiKey?: unknown; model?: unknown; effort?: unknown };
    if (b.provider !== "anthropic" && b.provider !== "openai") return err(400, "invalid_body", "provider deve ser anthropic ou openai.");
    if (typeof b.label !== "string" || !b.label.trim() || b.label.length > 80) return err(400, "invalid_body", "Informe um nome para a conexão (até 80 caracteres).");
    if (typeof b.apiKey !== "string" || b.apiKey.trim().length < 16 || b.apiKey.length > 400) return err(400, "invalid_body", "Chave de API ausente ou com tamanho inválido.");
    const model = typeof b.model === "string" ? b.model.trim() : "";
    const effort = typeof b.effort === "string" ? b.effort.trim() : "";
    if (model && !/^[A-Za-z0-9._-]{1,80}$/.test(model)) return err(400, "invalid_body", "Nome de modelo inválido.");
    if (effort && !/^[a-z]{2,12}$/.test(effort)) return err(400, "invalid_body", "Nível de esforço inválido.");
    const key = b.apiKey.trim();
    const record = await this.store.createApiConnection({
      id: randomUUID(), provider: b.provider, label: b.label.trim(), model, effort,
      last4: last4(key), secretJson: serializeBox(encryptSecret(this.secretKey, key)),
    });
    return { status: 201, body: { apiConnection: record } };
  }

  async listApiConnections(): Promise<Reply> {
    return { status: 200, body: { apiConnections: await this.store.listApiConnections() } };
  }

  /** Real minimal call through the stored key (uses a little of the API's own paid usage). Only on explicit request. */
  async verifyApiConnection(id: string): Promise<Reply> {
    if (typeof id !== "string" || !id) return err(400, "invalid_request", "Conexão inválida.");
    const found = await this.store.getApiConnectionSecret(id);
    if (!found) return err(404, "not_found", "Conexão de API não encontrada.");
    const adapter = apiAdapter(found.record, decryptSecret(this.secretKey, parseBox(found.secretJson)));
    try {
      const r = await adapter.call({
        label: "teste de sessão", system: "Responda apenas no formato pedido.", user: "Responda com ok = true.",
        schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
        model: "", effort: "", timeoutMs: Math.min(this.cfg.limits.callTimeoutMs, 60000), workDir: this.cfg.workRoot,
      });
      await this.store.setApiConnectionCheck(id, "connected", "Chave confirmada com uma chamada real mínima.");
      return { status: 200, body: { ok: true, apiConnection: await this.store.getApiConnectionRecord(id), message: "Chave confirmada com uma chamada real mínima.", usage: r.usage } };
    } catch (e) {
      const code = (e as { code?: string }).code ?? "client_error";
      const state = code === "not_connected" ? "invalid" : "error";
      const message = (e as Error).message;
      await this.store.setApiConnectionCheck(id, state, message);
      return { status: 200, body: { ok: false, apiConnection: await this.store.getApiConnectionRecord(id), message, code, detail: (e as { detail?: string }).detail } };
    }
  }

  async deleteApiConnection(id: string): Promise<Reply> {
    if (typeof id !== "string" || !id) return err(400, "invalid_request", "Conexão inválida.");
    const removed = await this.store.deleteApiConnection(id);
    return { status: 200, body: { removed } };
  }

  async status(force = false): Promise<Omit<EngineStatus, "executionEnabled" | "disabledReason">> {
    const projects = await listProjects(this.projectDeps());
    let storeOk = true, storeMsg: string | null = null;
    try { await this.store.ensureSchema(); } catch (e) { storeOk = false; storeMsg = (e as Error).message; }
    const connections: EngineStatus["connections"] = {};
    await Promise.all(CONNECTION_IDS.map(async id => { connections[id] = await this.connection(id, force); }));
    return {
      executor: { reachable: true, message: null, version: this.cfg.version },
      store: { ok: storeOk, kind: this.store.kind, path: this.cfg.storePath, message: storeMsg },
      connections,
      apiConnections: await this.store.listApiConnections(),
      github: { mode: "public-only", tokenConfigured: !!this.cfg.github.token },
      limits: { maxRunsPerHour: this.cfg.limits.maxRunsPerHour, maxConcurrentRuns: this.cfg.limits.maxConcurrentRuns, callTimeoutMs: this.cfg.limits.callTimeoutMs },
      executableAgents: EXECUTABLE_AGENTS,
      handoffTargets: [...HANDOFF_TARGETS],
      readOnly: READ_ONLY,
      localRepos: (await listLocalRepos(await this.authorized(), this.gitDeps())).map(r => ({ dirName: r.dirName, owner: r.owner, repo: r.repo, head: r.head, headSubject: r.headSubject })),
      projects,
      qaTooling: await detectQATooling(this.envDeps(), await (async () => { const p = projects.find(x => !x.problem && x.runConfig?.acknowledgedAt); return p ? loadExecPlan(p.id, this.projectDeps()) : null; })(), true),
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
    if (req.agent.connection !== "none" && !this.readOnlySafe(req.agent.connection as AgentConnectionRef)) {
      return err(409, "adapter_not_read_only", "Esta conexão não pode ser restrita a somente leitura e está bloqueada para o Arquiteto. Escolha a outra conexão na ficha dele.");
    }
    if ((await this.store.countCreatedSince(new Date(Date.now() - 3600_000).toISOString())) >= this.cfg.limits.maxRunsPerHour) {
      return err(429, "rate_limited", `Limite local de ${this.cfg.limits.maxRunsPerHour} execuções por hora atingido (proteção do uso da sua assinatura).`);
    }
    try {
      const { run, created } = await prepareHandoff(req, await this.handoffDeps());
      return { status: created ? 201 : 200, body: { run: await this.store.detail(run.id), created } };
    } catch (e) {
      if (e instanceof HandoffRefused) return err(e.status, e.code, e.message, e.details);
      throw e;
    }
  }

  private async handoffDeps() {
    return { store: this.store, github: this.cfg.github, local: { dirs: await this.authorized(), git: this.gitDeps() }, projects: this.projectDeps(), envDeps: this.envDeps() };
  }

  /** Before step 1: commits and files to choose from for a hand-off (read-only; nothing is recorded, no model is called). */
  async sourceOptions(directorRunId: string, taskId: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(directorRunId) || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) return err(400, "invalid_request", "Plano ou tarefa inválidos.");
    try { return { status: 200, body: await sourceOptions({ directorRunId, taskId }, await this.handoffDeps()) }; }
    catch (e) { if (e instanceof HandoffRefused) return err(e.status, e.code, e.message, e.details); throw e; }
  }

  /** Preview of a future Developer hand-off: a view of the records only (no run, no model call, no write access). */
  async developerPreview(directorRunId: string, taskId: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(directorRunId) || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) return err(400, "invalid_request", "Plano ou tarefa inválidos.");
    try { return { status: 200, body: { preview: await developerPreview({ directorRunId, taskId }, await this.handoffDeps()) } }; }
    catch (e) { if (e instanceof HandoffRefused) return err(e.status, e.code, e.message, e.details); throw e; }
  }

  // ---- hand-off to the Developer ------------------------------------------

  /**
   * Step 1: validate against the executor's own records and freeze what will be sent. Nothing is built or
   * called — the isolated working copy is only materialized inside execute(), and only after approval.
   */
  async prepareDeveloper(body: unknown): Promise<Reply> {
    const parsed = DeveloperHandoffZ.safeParse(body);
    if (!parsed.success) return err(400, "invalid_request", "Dados do encaminhamento inválidos.", parsed.error.issues.slice(0, 10).map(i => `${i.path.join(".")}: ${i.message}`));
    const req = parsed.data;
    if (req.agent.connection !== "none" && !this.writeSafe(req.agent.connection as AgentConnectionRef)) {
      return err(409, "adapter_not_write_restricted", "Esta conexão não tem isolamento de escrita comprovado e está bloqueada para o Desenvolvedor. Escolha Claude Code na ficha dele — conexões de API não têm ferramenta de arquivo nesta versão.");
    }
    if ((await this.store.countCreatedSince(new Date(Date.now() - 3600_000).toISOString())) >= this.cfg.limits.maxRunsPerHour) {
      return err(429, "rate_limited", `Limite local de ${this.cfg.limits.maxRunsPerHour} execuções por hora atingido (proteção do uso da sua assinatura).`);
    }
    try {
      const { run, created } = await prepareDeveloperHandoff(req, await this.handoffDeps(), { callTimeoutMs: this.cfg.limits.callTimeoutMs });
      return { status: created ? 201 : 200, body: { run: await this.store.detail(run.id), created } };
    } catch (e) {
      if (e instanceof HandoffRefused) return err(e.status, e.code, e.message, e.details);
      throw e;
    }
  }

  // ---- hand-off to QA -----------------------------------------------------

  /**
   * Step 1: validate against the executor's own records — every dependency of this task, transitively, must
   * have real, validated evidence (see lib/engine/dependency.ts) — and freeze what will be sent, including
   * the exact version to test and the operations the executor can really provide. The model still gets no
   * tool of its own; nothing is called and no environment is built here.
   */
  async prepareQA(body: unknown): Promise<Reply> {
    const parsed = QAHandoffZ.safeParse(body);
    if (!parsed.success) return err(400, "invalid_request", "Dados do encaminhamento inválidos.", parsed.error.issues.slice(0, 10).map(i => `${i.path.join(".")}: ${i.message}`));
    const req = parsed.data;
    if (req.agent.connection !== "none" && !this.readOnlySafe(req.agent.connection as AgentConnectionRef)) {
      return err(409, "adapter_not_read_only", "Esta conexão não pode ser restrita a somente leitura e está bloqueada para o QA. Escolha a outra conexão na ficha dele.");
    }
    if ((await this.store.countCreatedSince(new Date(Date.now() - 3600_000).toISOString())) >= this.cfg.limits.maxRunsPerHour) {
      return err(429, "rate_limited", `Limite local de ${this.cfg.limits.maxRunsPerHour} execuções por hora atingido (proteção do uso da sua assinatura).`);
    }
    try {
      const { run, created } = await prepareQAHandoff(req, await this.handoffDeps());
      return { status: created ? 201 : 200, body: { run: await this.store.detail(run.id), created } };
    } catch (e) {
      if (e instanceof HandoffRefused) return err(e.status, e.code, e.message, e.details);
      throw e;
    }
  }

  // ---- hand-off to the Reviewer -------------------------------------------

  /**
   * Step 1: validate against the executor's own records — the task must depend on a QA task that already
   * reached review_ready — and freeze what will be sent. The Reviewer reuses exactly what QA itself was
   * given (its frozen snapshot) plus QA's own concluded parecer; no live tools, nothing is called here.
   */
  async prepareReviewer(body: unknown): Promise<Reply> {
    const parsed = ReviewerHandoffZ.safeParse(body);
    if (!parsed.success) return err(400, "invalid_request", "Dados do encaminhamento inválidos.", parsed.error.issues.slice(0, 10).map(i => `${i.path.join(".")}: ${i.message}`));
    const req = parsed.data;
    if (req.agent.connection !== "none" && !this.readOnlySafe(req.agent.connection as AgentConnectionRef)) {
      return err(409, "adapter_not_read_only", "Esta conexão não pode ser restrita a somente leitura e está bloqueada para o Revisor. Escolha a outra conexão na ficha dele.");
    }
    if ((await this.store.countCreatedSince(new Date(Date.now() - 3600_000).toISOString())) >= this.cfg.limits.maxRunsPerHour) {
      return err(429, "rate_limited", `Limite local de ${this.cfg.limits.maxRunsPerHour} execuções por hora atingido (proteção do uso da sua assinatura).`);
    }
    try {
      const { run, created } = await prepareReviewerHandoff(req, await this.handoffDeps());
      return { status: created ? 201 : 200, body: { run: await this.store.detail(run.id), created } };
    } catch (e) {
      if (e instanceof HandoffRefused) return err(e.status, e.code, e.message, e.details);
      throw e;
    }
  }

  /** Every validated task-completion of a plan — used by the UI to show "entrega local validada" vs. a bare model result. */
  async listCompletions(parentRunId: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(parentRunId)) return err(400, "invalid_request", "Plano inválido.");
    return { status: 200, body: { completions: await this.store.taskCompletionsForPlan(parentRunId) } };
  }

  /** Step 2: the user's confirmation of the exact prepared content (identified by its hash). Architect, Developer, QA or Reviewer. */
  async approve(id: string, body: unknown): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return err(404, "not_found", "Execução não encontrada.");
    const hash = (body as { snapshotHash?: unknown } | null)?.snapshotHash;
    const run = await this.store.get(id);
    if (!run || (run.kind !== "architect_task" && run.kind !== "developer_task" && run.kind !== "qa_task" && run.kind !== "reviewer_task")) return err(404, "not_found", "Encaminhamento não encontrado.");
    if (run.status !== "awaiting_approval") return { status: 200, body: { run, approved: false } };
    if (typeof hash !== "string" || hash !== run.snapshotHash) return err(409, "content_changed", "O conteúdo confirmado não corresponde ao encaminhamento preparado. Abra a revisão de novo.");
    const parent = run.parentRunId ? await this.store.get(run.parentRunId) : null;
    if (!parent || parent.status !== "plan_ready") return err(409, "plan_not_ready", "O plano do Diretor desta tarefa não está mais disponível.");
    if (!(await this.store.approve(id))) return { status: 200, body: { run: await this.store.get(id), approved: false } };
    const approvedMsg = run.kind === "developer_task" ? "Envio confirmado por você. O Desenvolvedor entrou na fila do executor local; a cópia de trabalho isolada será montada agora."
      : run.kind === "qa_task" ? "Envio confirmado por você. O QA entrou na fila do executor local."
      : run.kind === "reviewer_task" ? "Envio confirmado por você. O Revisor entrou na fila do executor local."
      : "Envio confirmado por você. O Arquiteto entrou na fila do executor local.";
    await this.store.event(id, "approved", approvedMsg);
    this.enqueue(id);
    return { status: 202, body: { run: await this.store.get(id), approved: true } };
  }

  /**
   * Records that a Developer clarification was resolved outside the model — an orchestrator/human decision
   * (e.g. a scope question about where a test file belongs), never a claim that the model itself finished
   * the call. Never touches `status` or `result`: those stay exactly what the model returned. Not a general
   * user-facing action — there is no UI button for it; it exists so this kind of resolution is durable and
   * auditable (a real field plus an event) instead of only asserted in a chat transcript.
   */
  async resolveClarificationLocally(id: string, body: unknown): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return err(404, "not_found", "Execução não encontrada.");
    const b = body as { note?: unknown; commit?: unknown; testFile?: unknown; testCount?: unknown } | null;
    if (typeof b?.note !== "string" || !b.note.trim()) return err(400, "invalid_body", "Informe o que foi resolvido (note).");
    if (typeof b?.commit !== "string" || !/^[0-9a-f]{40}$/.test(b.commit)) return err(400, "invalid_body", "Informe o commit (hash de 40 caracteres) que resolveu isto.");
    if (b.testFile !== undefined && b.testFile !== null && typeof b.testFile !== "string") return err(400, "invalid_body", "testFile deve ser texto ou nulo.");
    if (b.testCount !== undefined && b.testCount !== null && (typeof b.testCount !== "number" || !Number.isInteger(b.testCount) || b.testCount < 0)) return err(400, "invalid_body", "testCount deve ser um número inteiro não negativo ou nulo.");
    const run = await this.store.get(id);
    if (!run || run.kind !== "developer_task") return err(404, "not_found", "Execução do Desenvolvedor não encontrada.");
    if (run.status !== "awaiting_clarification") return err(409, "not_awaiting_clarification", "Esta execução não está aguardando esclarecimento (pode já ter uma tentativa mais recente).");
    const resolution: LocalResolution = { at: new Date().toISOString(), by: "orchestrator", note: b.note.trim(), commit: b.commit, testFile: (b.testFile as string | undefined) ?? null, testCount: (b.testCount as number | undefined) ?? null };
    if (!(await this.store.resolveClarificationLocally(id, resolution))) return err(409, "conflict", "Não foi possível registrar: a execução mudou de estado.");
    return { status: 200, body: { run: await this.store.get(id) } };
  }

  /**
   * Records validated evidence that a task's real deliverable exists — the only thing dependencyEvidence()
   * accepts as "done" besides a genuinely completed run (see lib/engine/dependency.ts). Not a general
   * user-facing action: no UI button calls this; it exists so the orchestrator's own verification work
   * (typecheck/lint/tests/build actually run, files actually committed) is durable and auditable, and so a
   * dependent task's block is lifted only by real evidence, never by a bare LocalResolution existing.
   */
  async recordTaskCompletion(body: unknown): Promise<Reply> {
    const b = body as {
      demandId?: unknown; parentRunId?: unknown; taskId?: unknown; kind?: unknown; sourceRunId?: unknown;
      commit?: unknown; files?: unknown; verification?: unknown; note?: unknown;
    } | null;
    if (typeof b?.parentRunId !== "string" || !/^[0-9a-f-]{36}$/.test(b.parentRunId)) return err(400, "invalid_body", "parentRunId inválido.");
    if (typeof b.taskId !== "string" || !b.taskId.trim()) return err(400, "invalid_body", "Informe taskId.");
    if (b.kind !== "resolved_clarification" && b.kind !== "direct_implementation" && b.kind !== "applied_run_result") return err(400, "invalid_body", "kind deve ser resolved_clarification, direct_implementation ou applied_run_result.");
    if (typeof b.commit !== "string" || !/^[0-9a-f]{40}$/.test(b.commit)) return err(400, "invalid_body", "Informe o commit (hash de 40 caracteres).");
    if (!Array.isArray(b.files) || !b.files.every(f => typeof f === "string")) return err(400, "invalid_body", "files deve ser uma lista de caminhos.");
    if (typeof b.note !== "string" || !b.note.trim()) return err(400, "invalid_body", "Informe note.");
    const checkOk = (c: unknown) => c === null || (typeof c === "object" && c !== null && typeof (c as { ran?: unknown }).ran === "boolean" && typeof (c as { command?: unknown }).command === "string" && typeof (c as { result?: unknown }).result === "string" && typeof (c as { at?: unknown }).at === "string");
    const v = b.verification as { typecheck?: unknown; lint?: unknown; tests?: unknown; build?: unknown } | null;
    if (!v || !checkOk(v.typecheck) || !checkOk(v.lint) || !checkOk(v.tests) || !checkOk(v.build)) return err(400, "invalid_body", "verification deve ter typecheck/lint/tests/build, cada um nulo ou {ran, command, result, at}.");
    const plan = await this.store.get(b.parentRunId);
    if (!plan || plan.kind !== "director_plan" || !plan.result) return err(404, "plan_not_found", "Plano do Diretor não encontrado ou sem resultado.");
    const task = plan.result.tasks.find(t => t.id === b.taskId);
    if (!task) return err(404, "task_not_found", `A tarefa "${b.taskId}" não existe neste plano.`);
    let sourceRunId: string | null = null;
    if (b.kind === "resolved_clarification") {
      if (typeof b.sourceRunId !== "string" || !/^[0-9a-f-]{36}$/.test(b.sourceRunId)) return err(400, "invalid_body", "resolved_clarification exige sourceRunId (a execução com o esclarecimento resolvido).");
      const source = await this.store.get(b.sourceRunId);
      if (!source || source.kind !== "developer_task" || source.taskId !== b.taskId) return err(404, "source_run_not_found", "sourceRunId não corresponde a uma execução do Desenvolvedor desta tarefa.");
      if (source.status !== "awaiting_clarification" || !source.localResolution) return err(409, "no_local_resolution", "A execução indicada não tem um esclarecimento resolvido localmente (localResolution) para validar.");
      if (source.localResolution.commit !== b.commit) return err(409, "commit_mismatch", "O commit informado não é o mesmo do localResolution da execução indicada.");
      sourceRunId = b.sourceRunId;
    } else if (b.kind === "applied_run_result") {
      // The delivery must point at THE Developer run that produced the diff (same plan, same task, finished for real),
      // and may list only files that run itself changed — applying the result never widens what the run delivered.
      if (typeof b.sourceRunId !== "string" || !/^[0-9a-f-]{36}$/.test(b.sourceRunId)) return err(400, "invalid_body", "applied_run_result exige sourceRunId (a execução do Desenvolvedor cujo resultado foi aplicado).");
      const source = await this.store.get(b.sourceRunId);
      if (!source || source.kind !== "developer_task" || source.taskId !== b.taskId || source.parentRunId !== b.parentRunId) return err(404, "source_run_not_found", "sourceRunId não corresponde a uma execução do Desenvolvedor desta tarefa neste plano.");
      if (source.status !== "implementation_ready" || !source.developer?.diff) return err(409, "source_not_ready", "A execução indicada não está concluída (implementation_ready) com um diff registrado.");
      const delivered = new Set(source.developer.diff.files.map(f => f.path));
      const extra = (b.files as string[]).filter(f => !delivered.has(f));
      if (!(b.files as string[]).length || extra.length) return err(409, "files_outside_run_diff", `Os arquivos informados precisam ser os que a execução original alterou; fora do diff dela: ${extra.join(", ") || "(lista vazia)"}.`);
      sourceRunId = b.sourceRunId;
    } else if (b.sourceRunId !== undefined && b.sourceRunId !== null) {
      return err(400, "invalid_body", "direct_implementation não usa sourceRunId (não há execução de origem).");
    }
    const completion = await this.store.recordTaskCompletion({
      demandId: plan.demandId, parentRunId: b.parentRunId, taskId: b.taskId, kind: b.kind, sourceRunId,
      commit: b.commit, files: b.files as string[], verification: v as never, note: b.note.trim(), validatedBy: "orchestrator", validatedAt: new Date().toISOString(),
    });
    return { status: 201, body: { completion } };
  }

  // ---- local projects -------------------------------------------------------

  async listProjects(): Promise<Reply> {
    return { status: 200, body: { projects: await listProjects(this.projectDeps()) } };
  }

  /** The only place a folder path typed in the interface is accepted — validated here, then referenced by id only. */
  async registerProject(body: unknown): Promise<Reply> {
    try {
      const { project, created } = await registerProject((body ?? {}) as { dir?: unknown; label?: unknown }, this.projectDeps());
      return { status: created ? 201 : 200, body: { project, created } };
    } catch (e) { if (e instanceof ProjectRefused) return err(e.status, e.code, e.message); throw e; }
  }

  async removeProject(id: string): Promise<Reply> {
    return { status: 200, body: { removed: await removeProject(id, this.projectDeps()) } };
  }

  /** The saved execution settings (variable names only) and what the executor detects in the project, as editable suggestions. */
  async projectConfig(id: string, workDir?: string | null): Promise<Reply> {
    const project = await getProject(id, this.projectDeps());
    if (!project) return err(404, "not_found", "Projeto não encontrado.");
    if (project.problem) return err(409, "project_unavailable", project.problem);
    const detection = detectProject(project.dir, workDir ?? project.runConfig?.workDir);
    return { status: 200, body: { project, config: project.runConfig ?? null, detection, supportedManagers: SUPPORTED_MANAGERS } };
  }

  /**
   * Saves the execution settings. They run the project's own code, so the user must acknowledge that
   * explicitly (acknowledgeCodeExecution); values of variables are encrypted here and never returned.
   */
  async saveProjectConfig(id: string, body: unknown): Promise<Reply> {
    const project = await getProject(id, this.projectDeps());
    if (!project) return err(404, "not_found", "Projeto não encontrado.");
    if (project.problem) return err(409, "project_unavailable", project.problem);
    const b = (body ?? {}) as { config?: unknown; acknowledgeCodeExecution?: unknown };
    if (b.acknowledgeCodeExecution !== true) return err(400, "acknowledgement_required", "Confirme que entende que estes comandos executam código do próprio projeto neste computador (numa cópia isolada, sem as suas credenciais).");
    const saved = await this.store.getProjectConfig(id);
    const v = validateConfig(b.config, project.dir, saved?.config.env.map(e => e.name) ?? [], name => (saved?.secrets[name] ? decryptSecret(this.secretKey, parseBox(saved.secrets[name])) : null));
    if (!v.ok) return err(400, "invalid_config", "A configuração não foi salva.", v.errors);
    const secrets: Record<string, string> = {};
    for (const e of v.config.env) secrets[e.name] = v.setValues[e.name] !== undefined ? serializeBox(encryptSecret(this.secretKey, v.setValues[e.name])) : saved!.secrets[e.name];
    const now = new Date().toISOString();
    await this.store.saveProjectConfig(id, { ...v.config, env: v.config.env.map(e => ({ ...e, set: true })), acknowledgedAt: now, updatedAt: now }, secrets);
    const after = await getProject(id, this.projectDeps());
    return { status: 200, body: { project: after, config: after?.runConfig ?? null } };
  }

  // ---- applying a Developer diff to a local project ------------------------------

  /** "Revisar alterações": everything the user must see before confirming; also freezes the target state behind a token. */
  async applyReview(runId: string, projectId: string): Promise<Reply> {
    try { return { status: 200, body: { review: (await buildApplyReview(runId, projectId, this.applyDeps())).review } }; }
    catch (e) { if (e instanceof ApplyRefused) return err(e.status, e.code, e.message); throw e; }
  }

  /** "Aplicar ao projeto local": the user's confirmation of one review token. Never commits. */
  async applyDiff(body: unknown): Promise<Reply> {
    try {
      const { application, duplicate } = await applyReviewed((body ?? {}) as Record<string, unknown>, this.applyDeps());
      return { status: duplicate ? 200 : 201, body: { application, duplicate } };
    } catch (e) {
      if (e instanceof ApplyRefused) return { status: e.status, body: { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } } };
      throw e;
    }
  }

  async applicationsForPlan(planId: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(planId)) return err(400, "invalid_request", "Plano inválido.");
    return { status: 200, body: { applications: await this.store.applicationsForPlan(planId) } };
  }

  /** "Verificar entrega aplicada": starts the project's checks on the applied version in the background (cancellable). */
  async verifyApplication(id: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return err(404, "not_found", "Aplicação não encontrada.");
    const app = await this.store.getApplication(id);
    if (!app) return err(404, "not_found", "Aplicação não encontrada.");
    if (app.outcome !== "applied" && app.outcome !== "already_present") return err(409, "not_applied", "Só uma aplicação bem-sucedida pode ser verificada.");
    if (this.verifying.has(id)) return { status: 200, body: { application: app, started: false } };
    if (app.verification?.status === "passed") return { status: 200, body: { application: app, started: false } };
    const ac = new AbortController();
    this.verifying.set(id, ac);
    await this.store.setApplicationVerification(id, { status: "running", startedAt: new Date().toISOString(), finishedAt: null, version: null, checks: [], message: "Na fila: montando o ambiente isolado…", completionId: null });
    void runVerification(id, { store: this.store, projects: this.projectDeps(), envDeps: this.envDeps(ac.signal), workRoot: this.cfg.workRoot, artifactsRoot: this.artifactsRoot })
      .catch(() => {}).finally(() => this.verifying.delete(id));
    return { status: 202, body: { application: await this.store.getApplication(id), started: true } };
  }

  async cancelVerification(id: string): Promise<Reply> {
    const ac = this.verifying.get(id);
    ac?.abort();
    return { status: 200, body: { canceled: !!ac, application: await this.store.getApplication(id) } };
  }

  /** Waits for background verifications (tests). */
  async verificationsIdle() { while (this.verifying.size) await new Promise(r => setTimeout(r, 20)); }

  // ---- artifacts and audit annotations ----------------------------------------------

  /** A file the executor itself produced for a run or an application (logs, screenshots, downloads, comparisons). */
  async artifact(ownerId: string, name: string): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(ownerId) || !isArtifactName(name)) return err(404, "not_found", "Artefato não encontrado.");
    const file = path.join(this.artifactsRoot, ownerId, name);
    if (!existsSync(file)) return err(404, "not_found", "Artefato não encontrado.");
    const ext = path.extname(name).toLowerCase();
    const contentType = ext === ".png" ? "image/png" : ext === ".json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
    return { status: 200, body: null, raw: { contentType, data: readFileSync(file), filename: name } };
  }

  /**
   * Append-only audit note on an existing run: correcting who actually ran the tests a parecer mentions, or complementary evidence produced later (e.g. a re-run of one check).
   * Never touches the run's status or result: the historical parecer stays exactly as it was produced.
   */
  async annotate(id: string, body: unknown): Promise<Reply> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return err(404, "not_found", "Execução não encontrada.");
    const b = (body ?? {}) as { kind?: unknown; statement?: unknown; references?: unknown };
    if (b.kind !== "authorship_correction" && b.kind !== "complementary_evidence") return err(400, "invalid_body", "kind deve ser authorship_correction ou complementary_evidence.");
    if (typeof b.statement !== "string" || b.statement.trim().length < 20 || b.statement.length > 4000) return err(400, "invalid_body", "Informe a correção (20 a 4000 caracteres).");
    const run = await this.store.get(id);
    if (!run) return err(404, "not_found", "Execução não encontrada.");
    const refs = Array.isArray(b.references) ? b.references.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
    await this.store.event(id, b.kind, b.statement.trim(), { recordedBy: "orchestrator", at: new Date().toISOString(), references: refs, note: "Registro complementar: o parecer original não foi alterado." });
    return { status: 201, body: { run: await this.store.detail(id) } };
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
    const adapter = await this.adapterForRef(conn);
    const dirs = await this.authorized();
    await processRun(id, {
      store: this.store,
      connection: () => this.connectionOrApi(conn, true),
      adapter,
      limits: { callTimeoutMs: this.cfg.limits.callTimeoutMs, leaseMs: this.cfg.limits.leaseMs },
      github: { ...this.cfg.github, permitted: (snap as DirectorSnapshot).director?.tools.github !== false },
      local: dirs.length ? { dirs, git: this.gitDeps() } : undefined,
      workRoot: this.cfg.workRoot,
      signal: ac.signal,
      qa: { envDeps: this.envDeps(ac.signal), projects: this.projectDeps(), artifactsRoot: this.artifactsRoot, fixture: (planId, srcDir) => buildSetorIaFixture(this.store, planId, srcDir) },
    });
    if (!isApiConnectionRef(conn)) this.cache.delete(conn);
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
        : ac ? "Execução cancelada pelo usuário: os processos iniciados por ela (cliente oficial, ambiente isolado, aplicação em teste) foram encerrados. Se o cliente já tinha sido chamado, o uso consumido até esse ponto pode contar na assinatura." : "Execução cancelada pelo usuário antes de começar.");
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
