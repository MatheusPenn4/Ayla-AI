"use client";

// Projetos locais → Configurar execução: how the executor runs ONE project in isolated environments (the
// verification of an applied delivery and the tool-equipped QA). The executor detects what the project has and
// suggests it; the user edits and confirms. Commands run the project's own code (in a copy, without the user's
// credentials) — the confirmation says so. Values of variables are sent once and never shown again.
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Save, Wand2 } from "lucide-react";
import { EngineApiError, engineApi } from "@/lib/engine/client";
import type { LocalProject, ProjectRunConfig, ProjectRunDetection } from "@/lib/engine/types";
import { mainServiceOf, servicesOf } from "@/lib/engine/services";
import { ProjectStackEditor, type StackForm } from "./project-stack-editor";

const KEYS = [
  ["install", "Instalação", "Instala as dependências pelo lockfile (ex.: npm ci). Obrigatório."],
  ["typecheck", "Tipos", "ex.: npx tsc --noEmit"],
  ["lint", "Lint", "ex.: npm run lint"],
  ["test", "Testes", "ex.: npm test"],
  ["build", "Build", "ex.: npm run build"],
  ["seed", "Dados de teste (opcional)", "Roda depois da instalação; só com dados locais de teste"],
] as const;
type Key = (typeof KEYS)[number][0];
type EnvRow = { name: string; value: string; set: boolean; external: boolean; remove: boolean };

const EMPTY: ProjectRunConfig = { workDir: "", packageManager: "npm", commands: { install: "", typecheck: "", lint: "", test: "", build: "", dev: "", seed: "" }, app: { host: "localhost", port: null, readyPath: "/", readyText: "", timeoutSec: 120 }, browserData: "app", env: [], acknowledgedAt: null, updatedAt: null };

export function ProjectConfigEditor({ project, onSaved, onClose }: { project: LocalProject; onSaved: () => void; onClose: () => void }) {
  const [detection, setDetection] = useState<ProjectRunDetection | null>(null);
  const [form, setForm] = useState<ProjectRunConfig | null>(null);
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [stack, setStack] = useState<StackForm | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<"" | "load" | "save">("load");
  const [msg, setMsg] = useState<{ ok: boolean; text: string; details?: string[] } | null>(null);

  const load = async (workDir?: string, keepForm = false) => {
    setBusy("load");
    try {
      const r = await engineApi.projectConfig(project.id, workDir);
      setDetection(r.detection);
      if (!keepForm) {
        const base = r.config ?? r.detection.suggestion ?? { ...EMPTY, workDir: r.detection.chosen };
        setForm(base);
        // Settings saved before multi-process support show up as ONE process (made of the old dev command + server fields).
        setStack({ services: servicesOf(base), mainService: mainServiceOf(base)?.id ?? "", extraOrigins: base.extraOrigins ?? [], links: base.links ?? [] });
        setEnv((r.config?.env ?? []).map(e => ({ name: e.name, value: "", set: e.set, external: e.external, remove: false })));
      } else if (r.detection.suggestion) {
        const s = r.detection.suggestion;
        setForm(f => (f ? { ...f, workDir: s.workDir, packageManager: s.packageManager, commands: s.commands, browserData: s.browserData } : s));
        // A single, untouched "app" process follows the package folder that was just chosen.
        setStack(st => (st && st.services.length === 1 && st.services[0].id === "app" ? { ...st, services: [{ ...st.services[0], dir: s.workDir, command: s.commands.dev }] } : st));
      }
    } catch (e) { setMsg({ ok: false, text: e instanceof EngineApiError ? e.message : "Não foi possível ler a configuração." }); }
    finally { setBusy(""); }
  };
  // Loaded once per project (deferred: no state change inside the effect body itself).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [project.id]);

  if (!form || !detection || !stack) return <div className="conn-panel"><p className="muted">{busy ? <><Loader2 size={13} className="spin" /> Lendo o projeto…</> : msg?.text}</p></div>;
  const sug = detection.suggestion;
  const set = (patch: Partial<ProjectRunConfig>) => setForm(f => ({ ...f!, ...patch }));
  const setCmd = (k: Key, v: string) => setForm(f => ({ ...f!, commands: { ...f!.commands, [k]: v } }));

  const save = async () => {
    setBusy("save"); setMsg(null);
    try {
      const main = stack.services.find(x => x.id === stack.mainService) ?? stack.services[0];
      const config = { ...form, commands: { ...form.commands, dev: main?.command ?? "" }, services: stack.services, mainService: main?.id ?? "", extraOrigins: stack.extraOrigins, links: stack.links, env: env.filter(e => e.name.trim()).map(e => ({ name: e.name.trim(), external: e.external, remove: e.remove, ...(e.value ? { value: e.value } : {}) })) };
      await engineApi.saveProjectConfig(project.id, config, ack);
      setMsg({ ok: true, text: "Configuração salva. As próximas verificações e revisões do QA deste projeto usam estes comandos." });
      setAck(false);
      await load();
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof EngineApiError ? e.message : "Não foi possível salvar.", details: e instanceof EngineApiError ? e.details : undefined });
    } finally { setBusy(""); }
  };

  return (
    <div className="conn-panel project-config">
      <h5>Execução em ambiente isolado — {project.label}</h5>
      <p className="form-note">Usada por “Verificar entrega aplicada” e pelo QA com ferramentas. O executor monta uma cópia da versão exata (nunca o seu checkout) e roda ali os comandos abaixo, sem shell, sem as suas credenciais pessoais (pasta pessoal, .npmrc e login do Git trocados por vazios), com cancelamento. Comando vazio = <b>não configurado</b>: aparece assim e nunca conta como verificação aprovada.</p>
      {detection.notes.map(n => <p key={n} className="form-note">{n}</p>)}
      {!sug && <p className="form-note bad">{detection.manager.detail}</p>}

      <div className="config-grid">
        <label className="field"><span>Diretório de execução (relativo à raiz)</span>
          <select value={form.workDir} onChange={e => void load(e.target.value, true)} disabled={!!busy}>
            {detection.workDirs.map(d => <option key={d.dir} value={d.dir}>{d.dir || "(raiz)"}{d.lockfiles.length ? ` — ${d.lockfiles.join(", ")}` : " — sem lockfile"}{d.supported ? "" : " (não suportado)"}</option>)}
          </select>
          <small>Pastas com package.json encontradas na raiz autorizada.</small>
        </label>
        <label className="field"><span>Gerenciador de pacotes</span>
          <select value={form.packageManager} onChange={e => set({ packageManager: e.target.value as ProjectRunConfig["packageManager"] })}>
            <option value="npm">npm (package-lock.json)</option>
            <option value="pnpm">pnpm (pnpm-lock.yaml)</option>
          </select>
          <small>Detectado: {detection.manager.detail}. Suportados: npm e pnpm. yarn, bun, Python e outros ainda não.</small>
        </label>
      </div>

      {KEYS.map(([k, label, hint]) => (
        <label key={k} className="field">
          <span>{label} {!form.commands[k].trim() && <em className="conn-badge">não configurado</em>}
            {sug && sug.commands[k] && sug.commands[k] !== form.commands[k] && <button type="button" className="btn-ghost small" onClick={() => setCmd(k, sug.commands[k])}><Wand2 size={12} /> usar sugestão: <code>{sug.commands[k]}</code></button>}
          </span>
          <input value={form.commands[k]} onChange={e => setCmd(k, e.target.value)} placeholder={hint} aria-label={label} spellCheck={false} />
        </label>
      ))}

      <ProjectStackEditor value={stack} onChange={setStack} detection={detection} />

      <label className="field"><span>Dados vistos pelo navegador do QA</span>
        <select value={form.browserData} onChange={e => set({ browserData: e.target.value as ProjectRunConfig["browserData"] })}>
          <option value="app">O próprio servidor da aplicação, na cópia isolada, com as variáveis de teste abaixo</option>
          {detection.fixtureAvailable && <option value="setor_ia_fixture">Dados simulados do Setor IA (somente leitura; nada chega ao executor real)</option>}
        </select>
        <small>O navegador só acessa as origens autorizadas acima (principal, processos liberados e adicionais); as demais são bloqueadas, com o motivo registrado.</small>
      </label>

      <div className="field"><span>Variáveis do ambiente de teste</span>
        <small>Guardadas criptografadas no executor e nunca devolvidas em texto. Valores que apontam para fora deste computador são recusados, a menos que você marque que é um ambiente de teste externo — os testes não usam dados de produção por padrão.</small>
        {env.map((e, i) => (
          <div key={i} className="inline-form">
            <input value={e.name} onChange={ev => setEnv(l => l.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)))} placeholder="NOME" aria-label="Nome da variável" disabled={e.set} />
            <input type="password" value={e.value} onChange={ev => setEnv(l => l.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)))} placeholder={e.set ? "definida — deixe vazio para manter" : "valor"} aria-label={`Valor de ${e.name || "variável"}`} autoComplete="off" />
            <label className="check-row"><input type="checkbox" checked={e.external} onChange={ev => setEnv(l => l.map((x, j) => (j === i ? { ...x, external: ev.target.checked } : x)))} /> permitir endereço externo</label>
            <label className="check-row"><input type="checkbox" checked={e.remove} onChange={ev => setEnv(l => l.map((x, j) => (j === i ? { ...x, remove: ev.target.checked } : x)))} /> remover</label>
          </div>
        ))}
        <button type="button" className="btn-ghost small" onClick={() => setEnv(l => [...l, { name: "", value: "", set: false, external: false, remove: false }])}>+ variável</button>
      </div>

      <div className="notice warn-box" role="note">
        <AlertTriangle size={15} aria-hidden />
        <div>
          <b>Estes comandos executam código do próprio projeto neste computador.</b> Instalação, testes, build e o servidor rodam scripts do repositório (e das dependências dele) numa cópia isolada da versão testada, sem acesso às suas sessões do Claude Code/Codex, ao seu .npmrc, ao login do Git nem às variáveis de ambiente pessoais. Eles ainda podem usar a rede e ler arquivos deste computador pelo caminho completo; só autorize projetos em que você confia.
          <label className="check-row"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> Entendo e autorizo o executor a rodar estes comandos deste projeto em ambientes isolados.</label>
        </div>
      </div>
      {project.runConfig?.acknowledgedAt && <p className="muted">Configuração atual confirmada em {new Date(project.runConfig.acknowledgedAt).toLocaleString("pt-BR")}. Salvar de novo pede nova confirmação; revisões do QA já preparadas não passam a usar a nova configuração.</p>}
      {msg && <div className={msg.ok ? "form-note" : "form-error"} role={msg.ok ? undefined : "alert"}>{msg.text}{msg.details?.length ? <ul>{msg.details.map(d => <li key={d}>{d}</li>)}</ul> : null}</div>}
      <div className="task-actions">
        <button type="button" className="btn-primary small" disabled={!ack || !!busy} onClick={() => void save()}>{busy === "save" ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Salvar configuração</button>
        <button type="button" className="btn-ghost small" onClick={onClose}>Fechar</button>
      </div>
    </div>
  );
}
