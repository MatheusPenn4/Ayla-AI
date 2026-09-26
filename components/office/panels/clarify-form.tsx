"use client";

import { useState } from "react";
import { BookOpen, MessageSquareText, Plus, Send, Trash2 } from "lucide-react";
import type { useRuns } from "@/hooks/use-runs";
import type { HandoffFollowUp } from "@/lib/engine/client";
import type { ArchitectSnapshot, RunDetail } from "@/lib/engine/types";

type RunsApi = ReturnType<typeof useRuns>;
type Mode = "user" | "reading";
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Resolves the Architect's questions for a new hand-off. Nothing is sent to
 * the model here: submitting only asks the executor to prepare a new envio,
 * which the user reviews and confirms separately.
 */
export function ClarifyForm({ run, runs, onSubmit }: { run: RunDetail; runs: RunsApi; onSubmit: (f: HandoffFollowUp) => void }) {
  const questions = run.analysis?.questions ?? [];
  const ctx = run.context?.kind === "github" ? run.context : null;
  const prevVia = ctx?.via ?? "github";
  const local = (runs.status?.localRepos ?? []).find(r => ctx && r.owner.toLowerCase() === ctx.owner.toLowerCase() && r.repo.toLowerCase() === ctx.repo.toLowerCase());
  const [modes, setModes] = useState<Record<number, Mode>>({});
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [files, setFiles] = useState<Record<number, string>>({});
  const [decisions, setDecisions] = useState<{ topic: string; answer: string }[]>([]);
  const [source, setSource] = useState<"same" | "local" | "other">("same");
  const [otherCommit, setOtherCommit] = useState("");
  const [otherVia, setOtherVia] = useState<"github" | "local_git">("github");
  const [reason, setReason] = useState("");
  const revision = (((run.snapshot as ArchitectSnapshot).revision?.number) ?? 1) + 1;

  const refs = (i: number) => (files[i] ?? "").split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  const chosen = source === "same" ? (ctx ? { via: prevVia, commit: ctx.commit } : undefined) : source === "local" && local ? { via: "local_git" as const, commit: local.head } : HEX40.test(otherCommit) ? { via: otherVia, commit: otherCommit } : undefined;
  const changed = source !== "same";
  const problems: string[] = [];
  questions.forEach((_, i) => {
    const m = modes[i] ?? "user";
    if (m === "user" && !(answers[i] ?? "").trim()) problems.push(`Pergunta ${i + 1}: escreva sua resposta ou marque “resolver lendo arquivos”.`);
    if (m === "reading" && !refs(i).length) problems.push(`Pergunta ${i + 1}: indique ao menos um arquivo (caminho ou caminho#Símbolo).`);
  });
  if (ctx && !chosen) problems.push("Escolha a fonte e o commit do novo envio.");
  if (changed && !reason.trim()) problems.push("Explique por que o commit ou a fonte vai mudar (fica registrado na revisão).");

  const submit = () => onSubmit({
    answers: questions.flatMap((q, i) => ((modes[i] ?? "user") === "user" ? [{ question: q.question, answer: answers[i].trim() }] : [])),
    technical: questions.flatMap((q, i) => ((modes[i] ?? "user") === "reading" ? [{ question: q.question, files: refs(i) }] : [])),
    decisions: decisions.filter(d => d.topic.trim() && d.answer.trim()),
    ...(chosen ? { source: chosen } : {}),
    ...(changed ? { revisionReason: reason.trim() } : {}),
  });

  return (
    <div className="clarify">
      <p className="pane-intro">Resolva cada pergunta de um jeito: <b>sua resposta</b> (decisão sua, fica marcada como resposta do solicitante) ou <b>leitura de arquivos</b> (o executor lê os arquivos no commit escolhido e o Arquiteto responde a partir do conteúdo). Isso só prepara um novo envio — você revisa e confirma antes de qualquer chamada.</p>
      {questions.map((q, i) => {
        const m = modes[i] ?? "user";
        return (
          <div key={i} className="question">
            <b>{i + 1}. {q.question}</b>
            <small>Por que bloqueia: {q.why_it_blocks || "—"}</small>
            <div className="segmented small" role="radiogroup" aria-label={`Como resolver a pergunta ${i + 1}`}>
              <button type="button" role="radio" aria-checked={m === "user"} className="seg" onClick={() => setModes(s => ({ ...s, [i]: "user" }))}><MessageSquareText size={13} /> Eu respondo</button>
              <button type="button" role="radio" aria-checked={m === "reading"} className="seg" onClick={() => setModes(s => ({ ...s, [i]: "reading" }))}><BookOpen size={13} /> Resolver lendo arquivos</button>
            </div>
            {m === "user"
              ? <textarea rows={2} value={answers[i] ?? ""} onChange={e => setAnswers(s => ({ ...s, [i]: e.target.value }))} placeholder="Sua resposta (decisão sua)" aria-label={`Sua resposta à pergunta ${i + 1}`} />
              : <input value={files[i] ?? ""} onChange={e => setFiles(s => ({ ...s, [i]: e.target.value }))} placeholder="ex.: components/office/panels/run-dialog.tsx#DirectorBody, lib/engine/types.ts#DirectorPlan" aria-label={`Arquivos para a pergunta ${i + 1}`} />}
          </div>
        );
      })}

      <div className="question">
        <b>Decisões adicionais suas (opcional)</b>
        <small>Pontos que você quer decidir agora, mesmo que o Arquiteto não tenha perguntado. Ficam marcados como decisão do solicitante.</small>
        {decisions.map((d, k) => (
          <div key={k} className="decision-row">
            <input value={d.topic} onChange={e => setDecisions(x => x.map((y, j) => (j === k ? { ...y, topic: e.target.value } : y)))} placeholder="Assunto" aria-label="Assunto da decisão" />
            <input value={d.answer} onChange={e => setDecisions(x => x.map((y, j) => (j === k ? { ...y, answer: e.target.value } : y)))} placeholder="Sua decisão" aria-label="Sua decisão" />
            <button type="button" className="icon-btn" onClick={() => setDecisions(x => x.filter((_, j) => j !== k))} aria-label="Remover decisão"><Trash2 size={14} /></button>
          </div>
        ))}
        {decisions.length < 5 && <button type="button" className="btn-ghost small" onClick={() => setDecisions(x => [...x, { topic: "", answer: "" }])}><Plus size={13} /> Adicionar decisão</button>}
      </div>

      {ctx && (
        <div className="question">
          <b>Fonte e commit do novo envio</b>
          <small>Envio anterior: commit <code>{ctx.commit.slice(0, 12)}</code> {prevVia === "local_git" ? "da cópia local" : "do GitHub público"}. O envio anterior não é alterado; uma troca vira uma nova revisão registrada.</small>
          <label className="radio"><input type="radio" checked={source === "same"} onChange={() => setSource("same")} /> Manter o mesmo commit ({ctx.commit.slice(0, 12)})</label>
          <label className={`radio ${local ? "" : "disabled"}`}><input type="radio" disabled={!local} checked={source === "local"} onChange={() => setSource("local")} /> {local ? <>Cópia local autorizada “{local.dirName}”: HEAD <code>{local.head.slice(0, 12)}</code> — {local.headSubject}</> : "Cópia local: nenhuma pasta autorizada para este repositório (AYLA_LOCAL_REPOS)"}</label>
          <label className="radio"><input type="radio" checked={source === "other"} onChange={() => setSource("other")} /> Outro commit</label>
          {source === "other" && (
            <div className="decision-row">
              <select value={otherVia} onChange={e => setOtherVia(e.target.value as "github" | "local_git")} aria-label="Fonte do commit"><option value="github">GitHub público</option><option value="local_git" disabled={!local}>Cópia local autorizada</option></select>
              <input value={otherCommit} onChange={e => setOtherCommit(e.target.value.trim().toLowerCase())} placeholder="hash completo (40 caracteres)" aria-label="Commit" />
            </div>
          )}
          {changed && <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Motivo da troca (ex.: o código citado pela tarefa só existe em commits locais não publicados)" aria-label="Motivo da revisão" />}
        </div>
      )}

      {!!problems.length && <ul className="form-problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      <button className="btn-primary" disabled={!!problems.length || !runs.status?.executionEnabled} onClick={submit}><Send size={15} /> Preparar novo envio (revisão {revision}) para revisar</button>
    </div>
  );
}
