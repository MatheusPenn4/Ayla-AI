"use client";

import { useRef, useState } from "react";
import { ArrowRight, FolderOpen, GitBranch, Plus, Send, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar } from "../avatar";
import { Field } from "./field";
import { formatBytes, parseGithubUrl, summarizeFolder } from "@/lib/integration/contracts";
import { newId } from "@/lib/office/defaults";
import type { Agent, Demand, DemandPriority, DemandSource, FolderSummary } from "@/lib/office/types";

type Form = { title: string; project: string; description: string; priority: DemandPriority; criteria: string[]; criterion: string; source: DemandSource; url: string; branch: string; folder: FolderSummary | null };
const empty = (): Form => ({ title: "", project: "", description: "", priority: "normal", criteria: [], criterion: "", source: "github", url: "", branch: "", folder: null });

function DemandForm({ onOpenChange, agents, recipient, onRecipient, onSubmit }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agents: Agent[];
  recipient: string;
  onRecipient: (id: string) => void;
  onSubmit: (d: Demand) => void;
}) {
  const [f, setF] = useState<Form>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reading, setReading] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<Form>) => setF(v => ({ ...v, ...p }));
  const who = agents.find(a => a.id === recipient) ?? agents[0];
  const repo = f.url.trim() ? parseGithubUrl(f.url) : null;

  const addCriterion = () => {
    const c = f.criterion.trim();
    if (!c) return;
    set({ criteria: [...f.criteria, c], criterion: "" });
  };

  const submit = () => {
    const e: Record<string, string> = {};
    const criteria = [...f.criteria, ...(f.criterion.trim() ? [f.criterion.trim()] : [])];
    if (!f.title.trim()) e.title = "Dê um título para a demanda.";
    if (!f.description.trim()) e.description = "Descreva o objetivo.";
    if (!criteria.length) e.criteria = "Inclua pelo menos um critério de aceite.";
    if (f.source === "github" && !repo) e.url = f.url.trim() ? "Use um link https://github.com/dono/repositorio." : "Informe o link do repositório ou escolha outra fonte.";
    if (f.source === "folder" && !f.folder) e.folder = "Selecione uma pasta ou escolha outra fonte.";
    setErrors(e);
    if (Object.keys(e).length) return;
    const branch = f.branch.trim() || repo?.branch || "";
    onSubmit({
      id: newId(), title: f.title.trim(), description: f.description.trim(), acceptanceCriteria: criteria, project: f.project.trim(),
      priority: f.priority, recipient: who.id, source: f.source,
      sourceLabel: f.source === "github" ? f.url.trim() : f.source === "folder" ? f.folder!.name : "",
      fileCount: f.folder?.fileCount ?? 0,
      repo: f.source === "github" && repo ? { url: f.url.trim(), owner: repo.owner, repo: repo.repo, branch } : undefined,
      folder: f.source === "folder" ? f.folder! : undefined,
      status: "prepared", createdAt: new Date().toISOString(),
    });
  };

  return (
    <>
        <DialogHeader>
          <span className="eyebrow">NOVA MISSÃO / FILA LOCAL</span>
          <DialogTitle>Preparar demanda</DialogTitle>
          <DialogDescription id="demand-desc">Descreva o trabalho e associe o projeto. Ela entra na fila como <b>preparada</b>.</DialogDescription>
        </DialogHeader>
        <div className="dialog-scroll">
          <div className="notice">Fase de interface: a demanda fica salva neste navegador. Ainda não há motor de agentes, clone do repositório, envio de arquivos ou delegação automática.</div>
          <div className="recipient">
            <Avatar look={who.look} color={who.color} size={44} />
            <Field label="Responsável" className="grow">
              <select value={who.id} onChange={e => onRecipient(e.target.value)}>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="Título da missão"><input value={f.title} maxLength={100} aria-invalid={!!errors.title} onChange={e => set({ title: e.target.value })} placeholder="Ex.: Corrigir cabeçalho do PDF da O.S." /></Field>
            <Field label="Projeto (opcional)"><input value={f.project} maxLength={80} onChange={e => set({ project: e.target.value })} placeholder="Ex.: Oliveira Locação" /></Field>
          </div>
          {errors.title && <p className="form-error" role="alert">{errors.title}</p>}
          <div className="field">
            <span>Prioridade</span>
            <div className="segmented small" role="radiogroup" aria-label="Prioridade">
              {(["baixa", "normal", "alta"] as const).map(p => <button key={p} type="button" role="radio" aria-checked={f.priority === p} className={`seg prio-${p}`} onClick={() => set({ priority: p })}>{p[0].toUpperCase() + p.slice(1)}</button>)}
            </div>
          </div>
          <Field label="Objetivo e contexto"><textarea rows={4} value={f.description} aria-invalid={!!errors.description} onChange={e => set({ description: e.target.value })} placeholder="O que precisa ser feito, por quê e qualquer contexto importante." /></Field>
          {errors.description && <p className="form-error" role="alert">{errors.description}</p>}
          <div className="field">
            <span>Critérios de aceite</span>
            {!!f.criteria.length && (
              <ol className="criteria">
                {f.criteria.map((c, i) => (
                  <li key={i}><span>{c}</span><button type="button" className="icon-btn" aria-label={`Remover critério ${i + 1}`} onClick={() => set({ criteria: f.criteria.filter((_, j) => j !== i) })}><X size={14} /></button></li>
                ))}
              </ol>
            )}
            <div className="criteria-input">
              <input value={f.criterion} aria-invalid={!!errors.criteria} onChange={e => set({ criterion: e.target.value })} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCriterion(); } }} placeholder="Ex.: O PDF mostra o logotipo e o número da O.S." />
              <button type="button" className="btn-secondary" onClick={addCriterion}><Plus size={15} /> Adicionar</button>
            </div>
            <small>Pressione Enter para adicionar. Cada critério vira um item verificável para o QA.</small>
          </div>
          {errors.criteria && <p className="form-error" role="alert">{errors.criteria}</p>}
          <div className="field">
            <span>Fonte do projeto</span>
            <div className="segmented" role="radiogroup" aria-label="Fonte do projeto">
              <button type="button" role="radio" aria-checked={f.source === "github"} className="seg" onClick={() => set({ source: "github" })}><GitBranch size={16} /> GitHub</button>
              <button type="button" role="radio" aria-checked={f.source === "folder"} className="seg" onClick={() => set({ source: "folder" })}><FolderOpen size={16} /> Pasta local</button>
              <button type="button" role="radio" aria-checked={f.source === "none"} className="seg" onClick={() => set({ source: "none" })}>Sem fonte</button>
            </div>
          </div>
          {f.source === "github" && (
            <div className="source-box">
              <div className="form-row wide-first">
                <Field label="URL do repositório"><input type="url" inputMode="url" value={f.url} aria-invalid={!!errors.url} onChange={e => set({ url: e.target.value })} placeholder="https://github.com/usuario/repositorio" /></Field>
                <Field label="Branch (opcional)"><input value={f.branch} maxLength={120} onChange={e => set({ branch: e.target.value })} placeholder={repo?.branch || "main"} /></Field>
              </div>
              {repo && <p className="source-preview"><GitBranch size={14} /> <b>{repo.owner}/{repo.repo}</b>{(f.branch || repo.branch) && <> · {f.branch || repo.branch}</>}<span>link apenas associado — sem acesso real nesta fase</span></p>}
              {errors.url && <p className="form-error" role="alert">{errors.url}</p>}
            </div>
          )}
          {f.source === "folder" && (
            <div className="source-box">
              <input
                ref={el => { folderRef.current = el; el?.setAttribute("webkitdirectory", ""); el?.setAttribute("directory", ""); }}
                type="file" multiple className="sr-only" tabIndex={-1} aria-hidden
                data-testid="folder-input"
                onChange={e => {
                  const files = [...(e.currentTarget.files ?? [])];
                  if (!files.length) return;
                  setReading(true);
                  // Only metadata is read (names, sizes). File contents are never opened or uploaded.
                  requestAnimationFrame(() => { set({ folder: summarizeFolder(files) }); setReading(false); });
                  e.currentTarget.value = "";
                }}
              />
              <button type="button" className="folder-picker" data-invalid={!!errors.folder || undefined} aria-describedby={errors.folder ? "folder-error" : undefined} onClick={() => folderRef.current?.click()}>
                <FolderOpen size={18} />
                <span>{reading ? "Lendo nomes dos arquivos…" : f.folder ? <><b>{f.folder.name}</b> · {f.folder.fileCount.toLocaleString("pt-BR")} arquivos · {formatBytes(f.folder.totalBytes)}</> : "Escolher pasta do projeto"}</span>
                <ArrowRight size={15} />
              </button>
              {f.folder && (
                <div className="folder-meta">
                  {f.folder.topExtensions.map(([ext, n]) => <span key={ext} className="tag">.{ext} <b>{n}</b></span>)}
                  {f.folder.hasPackageJson && <span className="tag ok">package.json</span>}
                  {f.folder.hasGitDir && <span className="tag ok">.git</span>}
                </div>
              )}
              <small>Somente nome, quantidade, tamanho e extensões ficam registrados. Os arquivos não são lidos nem enviados.</small>
              {errors.folder && <p className="form-error" id="folder-error" role="alert">{errors.folder}</p>}
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn-secondary" onClick={() => onOpenChange(false)}>Cancelar</button>
          <button className="btn-primary" onClick={submit}><Send size={15} /> Adicionar à fila</button>
        </div>
    </>
  );
}

/** The form lives inside the dialog content, so it starts fresh every time the dialog opens. */
export function DemandDialog(props: React.ComponentProps<typeof DemandForm>) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="game-dialog demand-dialog" aria-describedby="demand-desc">
        <DemandForm {...props} />
      </DialogContent>
    </Dialog>
  );
}
