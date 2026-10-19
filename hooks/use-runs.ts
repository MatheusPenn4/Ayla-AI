"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EngineApiError, buildStartRequest, engineApi, toTeamInput, type AutopilotUsageHistory, type HandoffFollowUp } from "@/lib/engine/client";
import { ACTIVE_STATUSES, type ApiProvider, type ApplicationRecord, type AutopilotRecord, type ConnectionId, type EngineStatus, type RunRecord, type TaskCompletion } from "@/lib/engine/types";
import type { Agent, Demand } from "@/lib/office/types";

const message = (e: unknown, fallback: string) => (e instanceof EngineApiError ? `${e.message}${e.details?.length ? ` (${e.details.join("; ")})` : ""}` : fallback);

/**
 * Director runs of the local demands. The local executor is the source of
 * truth: runs are loaded from it on mount, polled while active, and survive
 * reloads (they live in its SQLite file, not in the browser).
 */
export function useRuns(demands: Demand[], hydrated: boolean) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  /** Piloto automático: policies of these demands (newest first) and the usage history behind the budget suggestion. */
  const [autopilots, setAutopilots] = useState<AutopilotRecord[]>([]);
  const [usageHistory, setUsageHistory] = useState<AutopilotUsageHistory | null>(null);
  const [completions, setCompletions] = useState<Record<string, TaskCompletion[]>>({});
  const [applications, setApplications] = useState<Record<string, ApplicationRecord[]>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [startErrors, setStartErrors] = useState<Record<string, string>>({});
  // One idempotency key per demand while a start request is in flight;
  // the synchronous ref blocks a second click before React re-renders.
  const keys = useRef(new Map<string, string>());
  const demandKey = demands.map(d => d.id).join(",");

  const refreshStatus = useCallback(async (refresh = false) => {
    try { setStatus(await engineApi.status(refresh)); setStatusError(null); }
    catch (e) { setStatusError(message(e, "Servidor local indisponível.")); }
  }, []);

  /** “Verificar conexão”: re-runs the official clients' status commands. */
  const verify = useCallback(async () => {
    setChecking(true);
    try { await refreshStatus(true); } finally { setChecking(false); }
  }, [refreshStatus]);

  /** Minimal real call through the client (explicit user action; uses a little of the subscription). */
  const probe = useCallback(async (id: ConnectionId) => {
    try {
      const r = await engineApi.probe(id);
      setStatus(s => (s ? { ...s, connections: { ...s.connections, [id]: r.status } } : s));
      return { ok: r.ok, message: r.ok ? r.message : `${r.message}${r.detail ? ` — ${r.detail}` : ""}` };
    } catch (e) {
      return { ok: false, message: message(e, "Falha ao testar a sessão.") };
    }
  }, []);

  const refresh = useCallback(async () => {
    const ids = demandKey ? demandKey.split(",") : [];
    if (!ids.length) { setRuns([]); setAutopilots([]); return; }
    try { setRuns((await engineApi.list(ids)).runs); } catch { /* keep last known state; the banner reports executor problems */ }
    // Separate request: an older executor without the autopilot keeps the runs working.
    try { const r = await engineApi.listAutopilots(ids); setAutopilots(r.autopilots); setUsageHistory(r.usageHistory); } catch { /* panel shows the executor's own error when used */ }
  }, [demandKey]);

  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => { void refreshStatus(); void refresh(); }, 0);
    return () => clearTimeout(t);
  }, [hydrated, refresh, refreshStatus]);

  const anyActive = runs.some(r => ACTIVE_STATUSES.includes(r.status));
  // A live policy moves by itself (the supervisor sends the next task): keep polling while one is live.
  const anyLivePolicy = autopilots.some(a => a.status === "active" || a.status === "waiting_user" || a.status === "waiting_rate_limit");
  useEffect(() => {
    if (!anyActive && !anyLivePolicy) return;
    const t = setInterval(() => { void refresh(); }, anyActive ? 2000 : 4000);
    return () => clearInterval(t);
  }, [anyActive, anyLivePolicy, refresh]);
  /** The latest policy of a plan (any status), or null. */
  const autopilotFor = useCallback((planRunId: string) => autopilots.find(a => a.planRunId === planRunId) ?? null, [autopilots]);
  // When a run ends, connection state may have changed (expired session, limit…).
  const prevActive = useRef(false);
  useEffect(() => {
    if (prevActive.current && !anyActive) void refreshStatus();
    prevActive.current = anyActive;
  }, [anyActive, refreshStatus]);

  const isHandoff = (r: RunRecord) => r.kind === "architect_task" || r.kind === "developer_task" || r.kind === "qa_task" || r.kind === "reviewer_task";
  // Director plans of a demand (the queue card) and hand-offs of a plan's tasks (Architect or Developer) are kept apart.
  const latestFor = useCallback((demandId: string) => runs.find(r => r.demandId === demandId && !isHandoff(r)) ?? null, [runs]);
  const historyFor = useCallback((demandId: string) => runs.filter(r => r.demandId === demandId && !isHandoff(r)), [runs]);
  /** Hand-offs of one task of a plan, newest first (Architect or Developer — a task has exactly one assignee). */
  const taskRunsFor = useCallback((planRunId: string, taskId: string) => runs.filter(r => isHandoff(r) && r.parentRunId === planRunId && r.taskId === taskId), [runs]);
  const handoffsOf = useCallback((planRunId: string) => runs.filter(r => isHandoff(r) && r.parentRunId === planRunId), [runs]);

  const start = useCallback(async (demand: Demand, agents: Agent[], followUp?: { previousRunId: string; answers: { question: string; answer: string }[] }) => {
    if (keys.current.has(demand.id)) return { ok: false as const, error: "Já existe um pedido em andamento para esta demanda." };
    const key = `${demand.id}:${crypto.randomUUID()}`;
    keys.current.set(demand.id, key);
    setPending(s => new Set(s).add(demand.id));
    setStartErrors(e => { const n = { ...e }; delete n[demand.id]; return n; });
    try {
      const { run } = await engineApi.start(buildStartRequest(demand, agents, "director", key, followUp));
      setRuns(list => [run, ...list.filter(r => r.id !== run.id)]);
      return { ok: true as const, run };
    } catch (e) {
      const error = message(e, "Falha ao iniciar a execução.");
      setStartErrors(s => ({ ...s, [demand.id]: error }));
      return { ok: false as const, error };
    } finally {
      keys.current.delete(demand.id);
      setPending(s => { const n = new Set(s); n.delete(demand.id); return n; });
    }
  }, []);

  /**
   * “Enviar ao Arquiteto”: asks the executor to prepare (validate + freeze) the hand-off.
   * A repeated click while the request is in flight is ignored; the executor also dedups per task.
   */
  const preparing = useRef(new Set<string>());
  const prepareHandoff = useCallback(async (planRunId: string, taskId: string, agents: Agent[], followUp?: HandoffFollowUp) => {
    const key = `${planRunId}:${taskId}`;
    if (preparing.current.has(key)) return { ok: false as const, error: "O envio desta tarefa já está sendo preparado." };
    const architect = agents.find(a => a.id === "architect");
    if (!architect) return { ok: false as const, error: "O Arquiteto não está na equipe." };
    preparing.current.add(key);
    setPending(s => new Set(s).add(key));
    try {
      const { run } = await engineApi.prepareHandoff({ idempotencyKey: `h:${crypto.randomUUID()}`, directorRunId: planRunId, taskId, agent: toTeamInput(architect, agents), ...(followUp ?? {}) });
      setRuns(list => [run, ...list.filter(r => r.id !== run.id)]);
      return { ok: true as const, run };
    } catch (e) {
      return { ok: false as const, error: message(e, "Falha ao preparar o envio ao Arquiteto.") };
    } finally {
      preparing.current.delete(key);
      setPending(s => { const n = new Set(s); n.delete(key); return n; });
    }
  }, []);

  /**
   * “Enviar ao Desenvolvedor”: asks the executor to prepare (validate + freeze) the hand-off.
   * Builds no working copy and calls no model — that only happens after approve(). editScope is the
   * user's own explicit choice of what the Developer may touch (never inferred from the Architect's text);
   * the executor still checks every path against the real tree of the chosen commit.
   */
  const preparingDev = useRef(new Set<string>());
  const prepareDeveloperHandoff = useCallback(async (planRunId: string, taskId: string, agents: Agent[], editScope: { path: string; action: "alterar" | "criar" | "consultar" }[], opts?: { source?: { commit: string }; revisionReason?: string }) => {
    const key = `${planRunId}:${taskId}`;
    if (preparingDev.current.has(key)) return { ok: false as const, error: "O envio desta tarefa já está sendo preparado." };
    const developer = agents.find(a => a.id === "developer");
    if (!developer) return { ok: false as const, error: "O Desenvolvedor não está na equipe." };
    preparingDev.current.add(key);
    setPending(s => new Set(s).add(key));
    try {
      const { run } = await engineApi.prepareDeveloperHandoff({ idempotencyKey: `h:${crypto.randomUUID()}`, directorRunId: planRunId, taskId, agent: toTeamInput(developer, agents), editScope, ...(opts ?? {}) });
      setRuns(list => [run, ...list.filter(r => r.id !== run.id)]);
      return { ok: true as const, run };
    } catch (e) {
      return { ok: false as const, error: message(e, "Falha ao preparar o envio ao Desenvolvedor.") };
    } finally {
      preparingDev.current.delete(key);
      setPending(s => { const n = new Set(s); n.delete(key); return n; });
    }
  }, []);

  /**
   * “Enviar ao QA”: asks the executor to prepare (validate + freeze) the hand-off. Calls no model — that
   * only happens after approve().
   */
  const preparingQA = useRef(new Set<string>());
  const prepareQAHandoff = useCallback(async (planRunId: string, taskId: string, agents: Agent[], opts: { repeat?: boolean } = {}) => {
    const key = `${planRunId}:${taskId}`;
    if (preparingQA.current.has(key)) return { ok: false as const, error: "O envio desta tarefa já está sendo preparado." };
    const qa = agents.find(a => a.id === "qa");
    if (!qa) return { ok: false as const, error: "O QA não está na equipe." };
    preparingQA.current.add(key);
    setPending(s => new Set(s).add(key));
    try {
      const { run } = await engineApi.prepareQAHandoff({ idempotencyKey: `h:${crypto.randomUUID()}`, directorRunId: planRunId, taskId, agent: toTeamInput(qa, agents), ...(opts.repeat ? { repeat: true } : {}) });
      setRuns(list => [run, ...list.filter(r => r.id !== run.id)]);
      return { ok: true as const, run };
    } catch (e) {
      return { ok: false as const, error: message(e, "Falha ao preparar o envio ao QA.") };
    } finally {
      preparingQA.current.delete(key);
      setPending(s => { const n = new Set(s); n.delete(key); return n; });
    }
  }, []);

  /**
   * "Enviar ao Revisor": asks the executor to prepare (validate + freeze) the hand-off. Calls no model — that
   * only happens after approve().
   */
  const preparingReviewer = useRef(new Set<string>());
  const prepareReviewerHandoff = useCallback(async (planRunId: string, taskId: string, agents: Agent[], opts: { repeat?: boolean } = {}) => {
    const key = `${planRunId}:${taskId}`;
    if (preparingReviewer.current.has(key)) return { ok: false as const, error: "O envio desta tarefa já está sendo preparado." };
    const reviewer = agents.find(a => a.id === "reviewer");
    if (!reviewer) return { ok: false as const, error: "O Revisor não está na equipe." };
    preparingReviewer.current.add(key);
    setPending(s => new Set(s).add(key));
    try {
      const { run } = await engineApi.prepareReviewerHandoff({ idempotencyKey: `h:${crypto.randomUUID()}`, directorRunId: planRunId, taskId, agent: toTeamInput(reviewer, agents), ...(opts.repeat ? { repeat: true } : {}) });
      setRuns(list => [run, ...list.filter(r => r.id !== run.id)]);
      return { ok: true as const, run };
    } catch (e) {
      return { ok: false as const, error: message(e, "Falha ao preparar o envio ao Revisor.") };
    } finally {
      preparingReviewer.current.delete(key);
      setPending(s => { const n = new Set(s); n.delete(key); return n; });
    }
  }, []);

  /** API-key connections (Configurações → Conexões de IA): create, verify (real minimal call) and remove. List comes from engine status. */
  const createApiConnection = useCallback(async (req: { provider: ApiProvider; label: string; apiKey: string; model?: string; effort?: string }) => {
    try { const { apiConnection } = await engineApi.createApiConnection(req); await refreshStatus(true); return { ok: true as const, apiConnection }; }
    catch (e) { return { ok: false as const, error: message(e, "Falha ao cadastrar a conexão de API.") }; }
  }, [refreshStatus]);
  const verifyApiConnection = useCallback(async (id: string) => {
    try {
      const r = await engineApi.verifyApiConnection(id);
      setStatus(s => (s ? { ...s, apiConnections: s.apiConnections.map(a => (a.id === id ? r.apiConnection : a)) } : s));
      return { ok: r.ok, message: r.ok ? r.message : `${r.message}${r.detail ? ` — ${r.detail}` : ""}` };
    } catch (e) {
      return { ok: false, message: message(e, "Falha ao testar a conexão de API.") };
    }
  }, []);
  const deleteApiConnection = useCallback(async (id: string) => {
    try { await engineApi.deleteApiConnection(id); setStatus(s => (s ? { ...s, apiConnections: s.apiConnections.filter(a => a.id !== id) } : s)); return { ok: true as const }; }
    catch (e) { return { ok: false as const, error: message(e, "Falha ao remover a conexão de API.") }; }
  }, []);

  /** Validated task-completions of one plan (dependencyEvidence's only source besides a completed run). Fetched on demand, not polled. */
  const loadCompletions = useCallback(async (planRunId: string) => {
    try { const { completions: list } = await engineApi.listCompletions(planRunId); setCompletions(s => ({ ...s, [planRunId]: list })); }
    catch { /* the dependency UI just shows nothing extra; the executor re-checks for real regardless */ }
  }, []);
  const completionsFor = useCallback((planRunId: string, taskId: string) => (completions[planRunId] ?? []).filter(c => c.taskId === taskId), [completions]);

  /** Applications (and their verification) of one plan's Developer runs. Fetched on demand; the apply dialog polls while a verification runs. */
  const loadApplications = useCallback(async (planRunId: string) => {
    try { const { applications: list } = await engineApi.listApplications(planRunId); setApplications(s => ({ ...s, [planRunId]: list })); return list; }
    catch { return null; }
  }, []);
  const applicationsFor = useCallback((planRunId: string, runIds: string[]) => (applications[planRunId] ?? []).filter(a => runIds.includes(a.runId)), [applications]);

  const approving = useRef(new Set<string>());
  const approve = useCallback(async (runId: string, snapshotHash: string) => {
    if (approving.current.has(runId)) return { ok: false as const, error: "Confirmação já enviada." };
    approving.current.add(runId);
    try {
      const { run } = await engineApi.approve(runId, snapshotHash);
      setRuns(list => list.map(r => (r.id === run.id ? run : r)));
      return { ok: true as const, run };
    } catch (e) {
      return { ok: false as const, error: message(e, "Falha ao confirmar o envio.") };
    } finally {
      approving.current.delete(runId);
    }
  }, []);

  const cancel = useCallback(async (runId: string) => {
    try { const { run } = await engineApi.cancel(runId); setRuns(list => list.map(r => (r.id === run.id ? run : r))); } catch { /* shown on next refresh */ }
  }, []);

  return { autopilots, autopilotFor, usageHistory, status, statusError, checking, runs, pending, startErrors, latestFor, historyFor, taskRunsFor, handoffsOf, start, prepareHandoff, prepareDeveloperHandoff, prepareQAHandoff, prepareReviewerHandoff, loadCompletions, completionsFor, loadApplications, applicationsFor, approve, cancel, refresh, refreshStatus, verify, probe, createApiConnection, verifyApiConnection, deleteApiConnection };
}
