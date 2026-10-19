"use client";

import { useMemo, useState } from "react";
import { Bot, Loader2, Pause, Play, ShieldCheck, Square } from "lucide-react";
import { toast } from "sonner";
import type { useRuns } from "@/hooks/use-runs";
import { EngineApiError, engineApi, toTeamInput } from "@/lib/engine/client";
import { connectionLabel } from "@/lib/engine/connections";
import { STAGE_LABEL, autopilotTimeline, suggestAutopilotBudget } from "@/lib/engine/autopilot";
import { AUTOPILOT_FINAL, AUTOPILOT_STATUS_LABEL, type AutopilotRecord, type AutopilotStage, type RunDetail, type TeamMemberInput } from "@/lib/engine/types";
import type { Agent } from "@/lib/office/types";

type RunsApi = ReturnType<typeof useRuns>;
const fmt = (n: number) => n.toLocaleString("pt-BR");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const ROLE: Record<string, string> = { architect: "Arquiteto", developer: "Desenvolvedor", qa: "QA", reviewer: "Revisor", director: "Diretor" };
const RULES = [
  "D1 · O Arquiteto aceita o commit que o executor propõe, mesmo diferente do que o Diretor leu; o motivo fica registrado na revisão.",
  "D2 · O QA só é enviado quando há uma versão para testar (projeto local autorizado com a entrega).",
  "D3 · Qualquer falha para a política; nada é tentado de novo sozinho.",
  "D4 · Uma tarefa já enviada nunca é enviada “novamente” pelo piloto automático.",
];
const BRAKES = "Para e chama você: esclarecimento pedido, falha, cancelamento, uso não informado, estimativa acima da ficha, orçamento da demanda, máximo de execuções, validade.";

const errText = (e: unknown, fallback: string) => (e instanceof EngineApiError ? `${e.message}${e.details?.length ? ` (${e.details.join("; ")})` : ""}` : fallback);

/**
 * Piloto automático (fase 1) of one Director plan: the user approves ONE policy, and the executor's supervisor
 * sends the Architect, QA and Reviewer tasks by itself, stopping on its brakes. The Developer stays manual.
 * Everything shown here comes from the executor's records; this panel never sends a hand-off itself.
 */
export function AutopilotPanel({ plan, agents, runs, onOpenRun }: { plan: RunDetail; agents: Agent[]; runs: RunsApi; onOpenRun: (id: string) => void }) {
  const tasks = useMemo(() => plan.result?.tasks ?? [], [plan.result]);
  const ap = runs.autopilotFor(plan.id);
  const open = ap && !AUTOPILOT_FINAL.includes(ap.status) ? ap : null;
  const enabled = !!runs.status?.executionEnabled;
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string, fail: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); } catch (e) { toast.error(errText(e, fail)); } finally { setBusy(false); void runs.refresh(); }
  };

  return (
    <section className="run-sec autopilot">
      <h4><Bot size={15} aria-hidden /> Piloto automático</h4>
      {open
        ? <PolicyView ap={open} busy={busy} enabled={enabled} onOpenRun={onOpenRun}
            onApprove={() => act(() => engineApi.autopilotAction(open.id, "approve", open.policyHash), "Piloto automático ativado.", "Falha ao ativar o piloto automático.")}
            onPause={() => act(() => engineApi.autopilotAction(open.id, "pause"), "Piloto automático pausado.", "Falha ao pausar.")}
            onResume={() => act(() => engineApi.autopilotAction(open.id, "resume", open.policyHash), "Piloto automático retomado.", "Falha ao retomar.")}
            onCancel={() => act(() => engineApi.autopilotAction(open.id, "cancel"), open.status === "awaiting_approval" ? "Política descartada." : "Piloto automático encerrado.", "Falha ao encerrar.")} />
        : <NewPolicy plan={plan} tasks={tasks} agents={agents} runs={runs} last={ap} busy={busy} enabled={enabled}
            onPrepare={req => act(() => engineApi.prepareAutopilot(req), "Política preparada: revise e confirme.", "Falha ao preparar a política.")} />}
    </section>
  );
}

function NewPolicy({ plan, tasks, agents, runs, last, busy, enabled, onPrepare }: {
  plan: RunDetail; tasks: NonNullable<RunDetail["result"]>["tasks"]; agents: Agent[]; runs: RunsApi; last: AutopilotRecord | null; busy: boolean; enabled: boolean;
  onPrepare: (req: Parameters<typeof engineApi.prepareAutopilot>[0]) => void;
}) {
  const timeline = useMemo(() => autopilotTimeline(tasks, null), [tasks]);
  const autoIds = timeline.filter(r => r.mode === "auto").map(r => r.taskId);
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(autoIds.map(id => [id, true])));
  const included = timeline.filter(r => r.mode === "auto" && picked[r.taskId]);
  const sheetOf = (stage: AutopilotStage) => agents.find(a => a.id === stage) ?? null;
  const suggestion = suggestAutopilotBudget(included.map(r => ({ assignee: r.assignee as AutopilotStage })), runs.usageHistory, s => sheetOf(s)?.budget ?? 0);
  const [budget, setBudget] = useState<string>("");
  const [maxRuns, setMaxRuns] = useState<string>("");
  const [hours, setHours] = useState("24");
  const budgetN = Number(budget || suggestion.budgetTokens), maxN = Number(maxRuns || suggestion.maxRuns), hoursN = Number(hours);
  const stages = [...new Set(included.map(r => r.assignee as AutopilotStage))];
  const problems: string[] = [];
  if (!included.length) problems.push("Marque ao menos uma tarefa automática.");
  for (const s of stages) {
    const a = sheetOf(s);
    if (!a) problems.push(`O ${STAGE_LABEL[s]} não está na equipe.`);
    else if (a.connection === "none") problems.push(`Escolha a conexão do ${STAGE_LABEL[s]} na ficha dele (aba Perfil).`);
  }
  if (!Number.isInteger(budgetN) || budgetN < 1000) problems.push("Orçamento: um número inteiro de tokens, a partir de 1.000.");
  if (!Number.isInteger(maxN) || maxN < 1 || maxN > 60) problems.push("Máximo de execuções: de 1 a 60.");
  if (!Number.isInteger(hoursN) || hoursN < 1 || hoursN > 72) problems.push("Validade: de 1 a 72 horas.");

  const submit = () => {
    const sheets: Partial<Record<AutopilotStage, TeamMemberInput>> = {};
    for (const s of stages) { const a = sheetOf(s); if (a) sheets[s] = toTeamInput(a, agents); }
    onPrepare({ idempotencyKey: `ap:${crypto.randomUUID()}`, planRunId: plan.id, sheets, taskIds: included.map(r => r.taskId), budgetTokens: budgetN, maxRuns: maxN, validityHours: hoursN });
  };

  return (
    <>
      <p className="pane-intro">Você aprova <b>uma política</b> e o executor envia sozinho as tarefas do <b>Arquiteto</b>, do <b>QA</b> e do <b>Revisor</b>, na ordem das dependências, com as fichas congeladas agora. O <b>Desenvolvedor continua com você</b>. {BRAKES}</p>
      {last && <small className="muted">Política anterior ({last.id.slice(0, 8)}): {AUTOPILOT_STATUS_LABEL[last.status]}{last.stop ? ` · ${last.stop.message}` : ""}.</small>}
      <ol className="ap-timeline">
        {timeline.map(r => (
          <li key={r.taskId} className={`ap-row ap-${r.mode}`}>
            {r.mode === "auto" || r.mode === "excluded"
              ? <label className="radio"><input type="checkbox" checked={!!picked[r.taskId]} onChange={e => setPicked(p => ({ ...p, [r.taskId]: e.target.checked }))} aria-label={`Incluir ${r.taskId}`} /> <b>{r.taskId}</b> · {r.title}</label>
              : <span><b>{r.taskId}</b> · {r.title}</span>}
            <span className="ap-mode">{ROLE[r.assignee] ?? r.assignee} · {r.mode === "manual" ? "você" : picked[r.taskId] ? "automático" : "fora da política"}</span>
            {r.reason && r.assignee !== "developer" && <small className="muted">{r.reason}</small>}
          </li>
        ))}
      </ol>
      <div className="ap-fields">
        <label>Orçamento total da demanda (tokens)<input inputMode="numeric" value={budget} placeholder={String(suggestion.budgetTokens)} onChange={e => setBudget(e.target.value.replace(/\D/g, ""))} /></label>
        <label>Máximo de execuções<input inputMode="numeric" value={maxRuns} placeholder={String(suggestion.maxRuns)} onChange={e => setMaxRuns(e.target.value.replace(/\D/g, ""))} /></label>
        <label>Validade (horas)<input inputMode="numeric" value={hours} onChange={e => setHours(e.target.value.replace(/\D/g, ""))} /></label>
      </div>
      <small className="muted">Sugestão de orçamento ({fmt(suggestion.budgetTokens)}): {suggestion.basis.join(" · ")} É um teto que <b>para</b> o piloto automático, contado pelo uso que os clientes informam.</small>
      {!!stages.length && (
        <ul className="ap-sheets">{stages.map(s => { const a = sheetOf(s); return <li key={s}><b>{STAGE_LABEL[s]}</b>: {a ? `${a.name} · ${connectionLabel(a.connection)}${a.modelName ? ` · ${a.modelName}` : ""} · ficha ${fmt(a.budget)} tokens` : "não está na equipe"}</li>; })}</ul>
      )}
      <details><summary>Regras congeladas com a política (D1–D4)</summary><ul>{RULES.map(r => <li key={r}>{r}</li>)}</ul></details>
      {!!problems.length && <ul className="form-error">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
      {!enabled && <p className="run-hint bad">{runs.status?.disabledReason ?? "Executor local indisponível."}</p>}
      <div className="task-actions">
        <button className="btn-primary small" disabled={busy || !enabled || !!problems.length} onClick={submit}>
          {busy ? <><Loader2 size={13} className="spin" /> Preparando…</> : <><ShieldCheck size={13} /> Preparar política para revisar</>}
        </button>
      </div>
    </>
  );
}

function PolicyView({ ap, busy, enabled, onOpenRun, onApprove, onPause, onResume, onCancel }: {
  ap: AutopilotRecord; busy: boolean; enabled: boolean; onOpenRun: (id: string) => void;
  onApprove: () => void; onPause: () => void; onResume: () => void; onCancel: () => void;
}) {
  const p = ap.policy;
  const live = ap.status === "active" || ap.status === "waiting_user" || ap.status === "waiting_rate_limit";
  return (
    <>
      <div className={`run-live ap-status ap-st-${ap.status}`}>
        {ap.status === "active" ? <Loader2 size={15} className="spin" /> : <Bot size={15} />}
        <div>
          <b>{AUTOPILOT_STATUS_LABEL[ap.status]}</b> · {fmt(ap.usedTokens)} de {fmt(p.budgetTokens)} tokens · {ap.runs.length} de {p.maxRuns} execução(ões) · válido até {when(p.expiresAt)}
          {ap.waiting && <small>{ap.waiting.message}{ap.waiting.until ? ` (por volta de ${when(ap.waiting.until)})` : ""}</small>}
          {ap.stop && <small className="ap-stop">Parou: {ap.stop.message}</small>}
        </div>
      </div>
      {ap.status === "awaiting_approval" && <p className="pane-intro">Revise a política. Confirmar autoriza o executor a <b>enviar e confirmar sozinho</b> as tarefas abaixo, com estas fichas e limites; nada além disso.</p>}
      <ul className="ap-sheets">
        <li><b>Tarefas automáticas</b>: {p.tasks.map(t => `${t.id} (${STAGE_LABEL[t.assignee]})`).join(", ")}</li>
        {(Object.keys(p.sheets) as AutopilotStage[]).map(s => { const a = p.sheets[s]!; return <li key={s}><b>{STAGE_LABEL[s]}</b> (ficha congelada): {a.name} · {connectionLabel(a.connection)}{a.modelName ? ` · ${a.modelName}` : ""} · ficha {fmt(a.budget)} tokens</li>; })}
        <li><b>Política</b> {ap.id.slice(0, 8)} · hash <code>{ap.policyHash.slice(0, 12)}</code>{ap.approvedAt ? ` · confirmada em ${when(ap.approvedAt)}` : ""}</li>
      </ul>
      <details><summary>Regras e freios</summary><ul>{RULES.map(r => <li key={r}>{r}</li>)}<li>{BRAKES}</li></ul></details>
      {!!ap.runs.length && (
        <ol className="ap-runs">{ap.runs.map(r => <li key={r.runId}><button className="btn-ghost small" onClick={() => onOpenRun(r.runId)}>{r.taskId} · execução {r.runId.slice(0, 8)}</button> <small className="muted">enviada {when(r.at)} · projeção {fmt(r.projectedTokens)} tokens</small></li>)}</ol>
      )}
      {ap.stop?.runId && !ap.runs.some(r => r.runId === ap.stop!.runId) && (
        <p className="run-hint">O envio {ap.stop.runId.slice(0, 8)} ficou aguardando a sua revisão: <button className="btn-ghost small" onClick={() => onOpenRun(ap.stop!.runId!)}>abrir</button></p>
      )}
      <div className="task-actions">
        {ap.status === "awaiting_approval" && <button className="btn-primary small" disabled={busy || !enabled} onClick={onApprove}><ShieldCheck size={13} /> Confirmar e ativar</button>}
        {live && <button className="btn-secondary small" disabled={busy} onClick={onPause}><Pause size={13} /> Pausar</button>}
        {ap.status === "paused" && <button className="btn-primary small" disabled={busy || !enabled} onClick={onResume}><Play size={13} /> Retomar</button>}
        <button className="btn-ghost small" disabled={busy} onClick={onCancel}><Square size={13} /> {ap.status === "awaiting_approval" ? "Descartar" : "Encerrar"}</button>
      </div>
    </>
  );
}
