"use client";

// Configurações → Projetos locais: the folders the executor may apply Developer diffs to and build isolated
// verification/QA environments from. A path typed here is sent ONCE; the executor validates it (absolute,
// the real top level of a Git repository) and from then on everything refers to the project by id.
import { useState } from "react";
import { FolderGit2, Loader2, Plus, Settings2, Trash2 } from "lucide-react";
import type { useRuns } from "@/hooks/use-runs";
import { EngineApiError, engineApi } from "@/lib/engine/client";
import type { ProjectRunConfig } from "@/lib/engine/types";
import { ProjectConfigEditor } from "./project-config-editor";

type RunsApi = ReturnType<typeof useRuns>;

export function ProjectsSection({ runs }: { runs: RunsApi }) {
  const projects = runs.status?.projects ?? [];
  const [dir, setDir] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<"" | "add" | string>("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const add = async () => {
    setBusy("add"); setMsg(null);
    try {
      const { project, created } = await engineApi.registerProject(dir.trim(), label.trim());
      setMsg({ ok: true, text: created ? `Projeto “${project.label}” autorizado.` : "Esta pasta já estava autorizada." });
      setDir(""); setLabel("");
      await runs.refreshStatus(true);
    } catch (e) { setMsg({ ok: false, text: e instanceof EngineApiError ? e.message : "Não foi possível cadastrar a pasta." }); }
    finally { setBusy(""); }
  };
  const remove = async (id: string) => {
    setBusy(id);
    try { await engineApi.removeProject(id); await runs.refreshStatus(true); } finally { setBusy(""); }
  };

  return (
    <section className="run-sec">
      <h4>Projetos locais (aplicação de diffs e ambientes de verificação)</h4>
      <p className="pane-intro">Pastas deste computador em que o executor pode aplicar, com a sua confirmação, o diff de um Desenvolvedor, e de onde ele monta cópias isoladas para verificar e testar uma versão exata. Nada é commitado, enviado ou publicado.</p>
      <div className="conn-list">
        {projects.map(p => (
          <div key={p.id} className={`conn-card ${p.problem ? "bad" : "ok"}`}>
            <div className="conn-head">
              <FolderGit2 size={16} aria-hidden />
              <b>{p.label}</b>
              <span className={`conn-badge ${p.problem ? "bad" : "ok"}`}>{p.problem ? "indisponível" : "autorizado"}</span>
              <span className="muted">{p.source === "env" ? "via AYLA_LOCAL_REPOS (.dev.vars)" : `cadastrado aqui${p.createdAt ? ` em ${new Date(p.createdAt).toLocaleString("pt-BR")}` : ""}`}</span>
              <span className="grow" />
              {!p.problem && <button type="button" className="btn-secondary small" aria-expanded={editing === p.id} onClick={() => setEditing(editing === p.id ? null : p.id)}><Settings2 size={13} /> Configurar execução</button>}
              {p.source === "ui" && <button type="button" className="btn-ghost small danger" disabled={!!busy} onClick={() => void remove(p.id)}>{busy === p.id ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Remover</button>}
            </div>
            <p className="conn-msg"><code>{p.dir}</code></p>
            <p className="conn-msg">{p.owner ? `${p.owner}/${p.repo}` : "sem origin do GitHub"} · branch {p.branch ?? "—"} · HEAD <code>{p.head?.slice(0, 12) ?? "—"}</code>{p.headSubject ? ` (${p.headSubject})` : ""} · {p.dirty === null ? "estado local desconhecido" : p.dirty ? `${p.dirty} alteração(ões) local(is) não commitada(s)` : "sem alterações locais"}</p>
            {p.problem && <p className="conn-msg bad">{p.problem}</p>}
            {!p.problem && <p className={`conn-msg ${p.runConfig?.acknowledgedAt ? "ok" : "bad"}`}>{runSummary(p.runConfig ?? null)}</p>}
            {editing === p.id && <ProjectConfigEditor project={p} onSaved={() => void runs.refreshStatus(true)} onClose={() => setEditing(null)} />}
          </div>
        ))}
        {!projects.length && <p className="muted">Nenhum projeto autorizado ainda.</p>}
      </div>
      <div className="field">
        <span>Autorizar uma pasta (caminho completo da raiz do repositório)</span>
        <div className="inline-form">
          <input value={dir} onChange={e => setDir(e.target.value)} placeholder="C:\Users\você\Documents\projeto" aria-label="Caminho completo da pasta do projeto" />
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Nome (opcional)" aria-label="Nome do projeto" />
          <button type="button" className="btn-secondary small" disabled={!dir.trim() || busy === "add" || !runs.status?.executionEnabled} onClick={() => void add()}>{busy === "add" ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Autorizar</button>
        </div>
        <small>O executor confere que é a raiz real de um repositório Git (com remoto “origin” do GitHub) antes de aceitar. Não é preciso editar variáveis de ambiente.</small>
      </div>
      {msg && <p className={msg.ok ? "form-note" : "form-error"} role={msg.ok ? undefined : "alert"}>{msg.text}</p>}
    </section>
  );
}

/** One line: what the isolated environments will run for this project (or that nothing runs yet). */
function runSummary(c: ProjectRunConfig | null) {
  if (!c?.acknowledgedAt) return "Execução não configurada: verificação da entrega e QA com ferramentas não rodam comandos nem navegador neste projeto até você confirmar a configuração.";
  const k = ([["typecheck", "tipos"], ["lint", "lint"], ["test", "testes"], ["build", "build"], ["dev", "servidor"]] as const);
  const on = k.filter(([id]) => c.commands[id].trim()).map(([, l]) => l), off = k.filter(([id]) => !c.commands[id].trim()).map(([, l]) => l);
  return `Execução: ${c.packageManager} em ${c.workDir || "(raiz)"} · configurado: ${on.join(", ") || "nada"}${off.length ? ` · não configurado: ${off.join(", ")}` : ""}${c.env.length ? ` · ${c.env.length} variável(is) de teste` : ""} · navegador: ${c.browserData === "setor_ia_fixture" ? "dados simulados do Setor IA" : "servidor da própria aplicação"}.`;
}
