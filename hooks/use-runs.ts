"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EngineApiError, buildStartRequest, engineApi, toTeamInput, type HandoffFollowUp } from "@/lib/engine/client";
import { ACTIVE_STATUSES, type ConnectionId, type EngineStatus, type RunRecord } from "@/lib/engine/types";
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
    if (!ids.length) { setRuns([]); return; }
    try { setRuns((await engineApi.list(ids)).runs); } catch { /* keep last known state; the banner reports executor problems */ }
  }, [demandKey]);

  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => { void refreshStatus(); void refresh(); }, 0);
    return () => clearTimeout(t);
  }, [hydrated, refresh, refreshStatus]);

  const anyActive = runs.some(r => ACTIVE_STATUSES.includes(r.status));
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(t);
  }, [anyActive, refresh]);
  // When a run ends, connection state may have changed (expired session, limit…).
  const prevActive = useRef(false);
  useEffect(() => {
    if (prevActive.current && !anyActive) void refreshStatus();
    prevActive.current = anyActive;
  }, [anyActive, refreshStatus]);

  const isHandoff = (r: RunRecord) => r.kind === "architect_task" || r.kind === "developer_task";
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
   * Builds no working copy and calls no model — that only happens after approve().
   */
  const preparingDev = useRef(new Set<string>());
  const prepareDeveloperHandoff = useCallback(async (planRunId: string, taskId: string, agents: Agent[], opts?: { source?: { commit: string }; revisionReason?: string }) => {
    const key = `${planRunId}:${taskId}`;
    if (preparingDev.current.has(key)) return { ok: false as const, error: "O envio desta tarefa já está sendo preparado." };
    const developer = agents.find(a => a.id === "developer");
    if (!developer) return { ok: false as const, error: "O Desenvolvedor não está na equipe." };
    preparingDev.current.add(key);
    setPending(s => new Set(s).add(key));
    try {
      const { run } = await engineApi.prepareDeveloperHandoff({ idempotencyKey: `h:${crypto.randomUUID()}`, directorRunId: planRunId, taskId, agent: toTeamInput(developer, agents), ...(opts ?? {}) });
      setRuns(list => [run, ...list.filter(r => r.id !== run.id)]);
      return { ok: true as const, run };
    } catch (e) {
      return { ok: false as const, error: message(e, "Falha ao preparar o envio ao Desenvolvedor.") };
    } finally {
      preparingDev.current.delete(key);
      setPending(s => { const n = new Set(s); n.delete(key); return n; });
    }
  }, []);

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

  return { status, statusError, checking, runs, pending, startErrors, latestFor, historyFor, taskRunsFor, handoffsOf, start, prepareHandoff, prepareDeveloperHandoff, approve, cancel, refresh, refreshStatus, verify, probe };
}
