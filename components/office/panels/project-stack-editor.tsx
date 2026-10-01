"use client";

// Configurar execução → "Processos da aplicação": the processes the application under test needs (a frontend and an
// API on different ports, or just one), where each runs, how it is ready, which origin is the main one, which other
// exact origins the QA browser may reach, and the variables that connect the processes (resolved from the ports the
// executor picks when it starts them). These controls limit the BROWSER; they do not isolate the network of the
// commands or scripts the project runs.
import { Plus, Trash2 } from "lucide-react";
import type { ProjectExtraOrigin, ProjectLink, ProjectRunDetection, ProjectService } from "@/lib/engine/types";

export type StackForm = { services: ProjectService[]; mainService: string; extraOrigins: ProjectExtraOrigin[]; links: ProjectLink[] };

const slug = (base: string, taken: string[]) => { let n = 1, id = base; while (taken.includes(id)) id = `${base}${++n}`; return id; };
const num = (v: string) => (v.trim() ? Number(v) : null);

export function ProjectStackEditor({ value, onChange, detection }: { value: StackForm; onChange: (v: StackForm) => void; detection: ProjectRunDetection }) {
  const { services, mainService, extraOrigins, links } = value;
  const ids = services.map(s => s.id);
  const set = (patch: Partial<StackForm>) => onChange({ ...value, ...patch });
  const setService = (i: number, patch: Partial<ProjectService>) => {
    const old = services[i];
    const next = services.map((s, j) => (j === i ? { ...s, ...patch } : s));
    // Renaming a process keeps the references to it (main process, links) consistent.
    const renamed = patch.id !== undefined && patch.id !== old.id;
    set({
      services: next,
      ...(renamed ? { mainService: mainService === old.id ? patch.id! : mainService, links: links.map(l => ({ ...l, service: l.service === old.id ? patch.id! : l.service, to: l.to.map(t => (t === old.id ? patch.id! : t)) })) } : {}),
    });
  };
  const add = () => {
    const id = slug(services.length ? "api" : "web", ids);
    set({ services: [...services, { id, label: id === "api" ? "API" : id === "web" ? "Frontend" : id, dir: "", install: "", command: "", host: "localhost", port: null, readyPath: "/", readyText: "", timeoutSec: 120, browser: true }], mainService: mainService || id });
  };
  const remove = (i: number) => {
    const gone = services[i].id;
    const rest = services.filter((_, j) => j !== i);
    set({ services: rest, mainService: mainService === gone ? rest[0]?.id ?? "" : mainService, links: links.filter(l => l.service !== gone).map(l => ({ ...l, to: l.to.filter(t => t !== gone) })) });
  };
  const dirs = [...new Set(["", ...detection.workDirs.map(d => d.dir)])];

  return (
    <div className="field stack-editor">
      <span>Processos da aplicação em teste</span>
      <small>Frontend e API separados? Cadastre cada processo. Eles sobem na ordem abaixo, cada um só depois que o anterior responde; as portas são escolhidas (ou usadas, se fixas) <b>antes</b> de iniciar qualquer um, e os endereços ficam congelados na execução. {"{port}"} e PORT recebem a porta de cada processo.</small>
      {!services.length && <p className="muted">Nenhum processo configurado: o navegador do QA fica indisponível (verificações por comando continuam).</p>}
      {services.map((s, i) => (
        <fieldset key={i} className="svc-card">
          <legend>
            <label className="check-row"><input type="radio" name="main-service" checked={mainService === s.id} onChange={() => set({ mainService: s.id })} /> origem principal</label>
          </legend>
          <div className="config-grid">
            <label className="field"><span>Identificador</span><input value={s.id} onChange={e => setService(i, { id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} aria-label={`Identificador do processo ${i + 1}`} spellCheck={false} /></label>
            <label className="field"><span>Nome</span><input value={s.label} onChange={e => setService(i, { label: e.target.value })} aria-label={`Nome do processo ${i + 1}`} /></label>
            <label className="field"><span>Pasta (relativa à raiz)</span>
              <input list={`dirs-${i}`} value={s.dir} onChange={e => setService(i, { dir: e.target.value })} placeholder="(raiz)" aria-label={`Pasta do processo ${i + 1}`} spellCheck={false} />
              <datalist id={`dirs-${i}`}>{dirs.map(d => <option key={d} value={d}>{d || "(raiz)"}</option>)}</datalist>
            </label>
          </div>
          <label className="field"><span>Comando que inicia o processo</span>
            <input value={s.command} onChange={e => setService(i, { command: e.target.value })} placeholder="ex.: npm run dev -- --port {port}  ou  node server.js" aria-label={`Comando do processo ${i + 1}`} spellCheck={false} />
          </label>
          <label className="field"><span>Instalação nesta pasta (opcional)</span>
            <input value={s.install} onChange={e => setService(i, { install: e.target.value })} placeholder="vazio = coberta pela instalação do projeto; ex.: npm ci (pasta com package.json próprio)" aria-label={`Instalação do processo ${i + 1}`} spellCheck={false} />
          </label>
          <div className="config-grid">
            <label className="field"><span>Endereço local</span><select value={s.host} onChange={e => setService(i, { host: e.target.value as ProjectService["host"] })}><option value="localhost">localhost</option><option value="127.0.0.1">127.0.0.1</option></select></label>
            <label className="field"><span>Porta</span><input value={s.port ?? ""} onChange={e => setService(i, { port: num(e.target.value) })} placeholder="vazia = dinâmica" inputMode="numeric" aria-label={`Porta do processo ${i + 1}`} /></label>
            <label className="field"><span>Pronto quando responder em</span><input value={s.readyPath} onChange={e => setService(i, { readyPath: e.target.value })} placeholder="/" aria-label={`Caminho de prontidão do processo ${i + 1}`} /></label>
            <label className="field"><span>…contendo o texto (opcional)</span><input value={s.readyText} onChange={e => setService(i, { readyText: e.target.value })} /></label>
            <label className="field"><span>Tempo máximo (s)</span><input value={s.timeoutSec} onChange={e => setService(i, { timeoutSec: Number(e.target.value) || 0 })} inputMode="numeric" /></label>
          </div>
          <div className="svc-foot">
            <label className="check-row"><input type="checkbox" checked={mainService === s.id || s.browser} disabled={mainService === s.id} onChange={e => setService(i, { browser: e.target.checked })} /> o navegador do QA pode acessar este processo</label>
            <button type="button" className="btn-ghost small danger" onClick={() => remove(i)}><Trash2 size={12} /> remover processo</button>
          </div>
        </fieldset>
      ))}
      <button type="button" className="btn-ghost small" onClick={add} disabled={services.length >= 6}><Plus size={12} /> processo (frontend, API…)</button>

      <span>Variáveis que ligam os processos</span>
      <small>Valem só para estes processos e são resolvidas depois que as portas existem. Ex.: <code>VITE_API_URL</code> = origem da API → enviada ao frontend. Para CORS, <b>o Setor IA não altera o código nem o CORS do projeto</b>: se a API exigir, defina aqui a variável que ela lê (ex.: <code>CORS_ORIGIN</code> = origem do frontend → enviada à API).</small>
      {links.map((l, i) => (
        <div key={i} className="inline-form link-row">
          <input value={l.name} onChange={e => set({ links: links.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="NOME_DA_VARIÁVEL" aria-label="Nome da variável de ligação" spellCheck={false} />
          <select value={l.as} onChange={e => set({ links: links.map((x, j) => (j === i ? { ...x, as: e.target.value as ProjectLink["as"] } : x)) })} aria-label="Valor da variável"><option value="origin">origem (http://host:porta)</option><option value="port">só a porta</option><option value="host">só o host</option></select>
          <span>do processo</span>
          <select value={l.service} onChange={e => set({ links: links.map((x, j) => (j === i ? { ...x, service: e.target.value } : x)) })} aria-label="Processo de origem">{services.map(s => <option key={s.id} value={s.id}>{s.label} ({s.id})</option>)}</select>
          {l.as === "origin" && <input value={l.suffix} onChange={e => set({ links: links.map((x, j) => (j === i ? { ...x, suffix: e.target.value } : x)) })} placeholder="complemento (ex.: /api)" aria-label="Complemento da origem" spellCheck={false} />}
          <span>enviada a</span>
          {services.map(s => (
            <label key={s.id} className="check-row"><input type="checkbox" checked={!l.to.length || l.to.includes(s.id)} onChange={e => {
              const all = services.map(x => x.id);
              const cur = l.to.length ? l.to : all;
              const nextTo = e.target.checked ? [...new Set([...cur, s.id])] : cur.filter(t => t !== s.id);
              set({ links: links.map((x, j) => (j === i ? { ...x, to: nextTo.length === all.length ? [] : nextTo } : x)) });
            }} /> {s.id}</label>
          ))}
          <button type="button" className="btn-ghost small danger" onClick={() => set({ links: links.filter((_, j) => j !== i) })} aria-label="Remover variável de ligação"><Trash2 size={12} /></button>
        </div>
      ))}
      <button type="button" className="btn-ghost small" disabled={!services.length} onClick={() => set({ links: [...links, { name: "", service: services[0]?.id ?? "", as: "origin", suffix: "", to: [] }] })}><Plus size={12} /> variável de ligação</button>

      <span>Outras origens que o navegador do QA pode acessar</span>
      <small>Além da origem principal e dos processos liberados acima. Origens <b>exatas</b> (protocolo, host e porta), locais por padrão. Acesso a um endereço fora deste computador exige autorização explícita; as portas do executor e da interface do Setor IA e serviços locais sensíveis (bancos de dados, Docker, SSH…) nunca são aceitos. Redirecionamentos e WebSockets são conferidos.</small>
      {extraOrigins.map((o, i) => (
        <div key={i} className="inline-form">
          <input value={o.origin} onChange={e => set({ extraOrigins: extraOrigins.map((x, j) => (j === i ? { ...x, origin: e.target.value.trim() } : x)) })} placeholder="http://localhost:9100" aria-label="Origem adicional" spellCheck={false} />
          <input value={o.label} onChange={e => set({ extraOrigins: extraOrigins.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="nome (ex.: mock de pagamento)" aria-label="Nome da origem adicional" />
          <label className="check-row"><input type="checkbox" checked={o.external} onChange={e => set({ extraOrigins: extraOrigins.map((x, j) => (j === i ? { ...x, external: e.target.checked } : x)) })} /> origem externa autorizada</label>
          <button type="button" className="btn-ghost small danger" onClick={() => set({ extraOrigins: extraOrigins.filter((_, j) => j !== i) })} aria-label="Remover origem adicional"><Trash2 size={12} /></button>
        </div>
      ))}
      <button type="button" className="btn-ghost small" disabled={extraOrigins.length >= 10} onClick={() => set({ extraOrigins: [...extraOrigins, { origin: "", label: "", external: false }] })}><Plus size={12} /> origem adicional</button>
      <small className="muted">Estes controles limitam o <b>navegador</b> do QA. Não isolam a rede dos comandos e scripts do projeto (instalação, testes, o próprio servidor): o isolamento do sistema operacional continua parcial.</small>
    </div>
  );
}
