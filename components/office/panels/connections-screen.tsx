"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, PlugZap, RefreshCw, ShieldCheck, Terminal, Trash2 } from "lucide-react";
import type { useRuns } from "@/hooks/use-runs";
import { CONNECTION_IDS, CONNECTION_OPTIONS, connectionLabel, connectionStatusFor } from "@/lib/engine/connections";
import type { ApiProvider, ConnectionId } from "@/lib/engine/types";
import type { Agent } from "@/lib/office/types";
import { ConnectionBadge, ConnectionSteps } from "./connection-panel";
import { Field } from "./field";

type RunsApi = ReturnType<typeof useRuns>;

const CLIENT_LABEL: Record<ConnectionId, string> = { claude_code: "Claude Code", codex: "Codex CLI" };
const PROVIDER_LABEL: Record<ApiProvider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

function CliConnectionCard({ id, runs, users }: { id: ConnectionId; runs: RunsApi; users: Agent[] }) {
  const [busy, setBusy] = useState<"" | "verify" | "probe">("");
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const status = runs.status?.connections[id];
  const opt = CONNECTION_OPTIONS.find(o => o.value === id)!;
  const verify = async () => { setBusy("verify"); setProbeMsg(null); await runs.verify(); setBusy(""); };
  const probe = async () => { setBusy("probe"); setProbeMsg(await runs.probe(id)); setBusy(""); };
  return (
    <article className={`conn-card ${status ? "" : "unknown"} wide`}>
      <div className="conn-head">
        {status?.state === "connected" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        <b>{CLIENT_LABEL[id]}</b>
        <ConnectionBadge status={status} />
        {status?.version && <span className="muted">{status.version}</span>}
        {status?.account && <span className="muted">· {status.account}</span>}
        <span className="muted">· {opt.label}</span>
        <span className="grow" />
        <button type="button" className="btn-secondary small" onClick={verify} disabled={!!busy}>{busy === "verify" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Verificar conexão</button>
        {status && (status.state === "connected" || status.state === "expired") && (
          <button type="button" className="btn-ghost small" onClick={probe} disabled={!!busy} title="Faz uma chamada real mínima pelo cliente oficial (usa um pouco da assinatura).">
            {busy === "probe" ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />} Testar sessão
          </button>
        )}
      </div>
      {status && <p className="conn-msg">{status.message}</p>}
      {status && status.state !== "connected" && (
        <div className="conn-login">
          <span className="eyebrow"><Terminal size={12} aria-hidden /> CONECTAR CONTA — no seu terminal, fora do Setor IA</span>
          <ConnectionSteps status={status} />
          <small>Depois de entrar, clique em “Verificar conexão” acima para o Setor IA detectar o login.</small>
        </div>
      )}
      {probeMsg && <p className={`conn-msg ${probeMsg.ok ? "ok" : "bad"}`}>{probeMsg.message}</p>}
      <div className="conn-users">
        <span className="eyebrow">USADA POR</span>
        {users.length ? users.map(a => <span key={a.id} className="chip">{a.name}</span>) : <span className="muted">Nenhum colaborador escolheu esta conexão.</span>}
      </div>
      <small className="muted">O Setor IA nunca pede nem guarda sua senha, cookie ou token de assinatura: ele só lê o estado que o próprio cliente informa.</small>
    </article>
  );
}

function AddApiConnectionForm({ runs, onDone }: { runs: RunsApi; onDone: () => void }) {
  const [provider, setProvider] = useState<ApiProvider>("anthropic");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    const r = await runs.createApiConnection({ provider, label: label.trim(), apiKey: apiKey.trim(), model: model.trim() });
    setBusy(false);
    if (r.ok) onDone(); else setError(r.error);
  };
  return (
    <div className="section-card">
      <p className="section-hint">A chave é cobrada separadamente das assinaturas Claude Team e ChatGPT Business, diretamente pelo provedor. Ela fica guardada criptografada no executor local deste computador; nunca é salva no navegador nem aparece de novo em texto puro.</p>
      <div className="form-row">
        <Field label="Provedor">
          <select value={provider} onChange={e => setProvider(e.target.value as ApiProvider)}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (ChatGPT)</option>
          </select>
        </Field>
        <Field label="Nome desta conexão"><input value={label} maxLength={80} placeholder="ex.: Minha chave Anthropic" onChange={e => setLabel(e.target.value)} /></Field>
      </div>
      <Field label="Chave de API" hint="Colada uma vez; depois só o final aparece, mascarado.">
        <input type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"} />
      </Field>
      <Field label="Modelo (opcional)" hint="Em branco = um padrão seguro do Setor IA para este provedor.">
        <input value={model} onChange={e => setModel(e.target.value)} placeholder={provider === "anthropic" ? "claude-sonnet-5" : "gpt-5"} />
      </Field>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions" style={{ padding: 0 }}>
        <button className="btn-secondary" onClick={onDone} disabled={busy}>Cancelar</button>
        <button className="btn-primary" onClick={submit} disabled={busy || !label.trim() || apiKey.trim().length < 16}>
          {busy ? <><Loader2 size={14} className="spin" /> Salvando…</> : <><KeyRound size={14} /> Salvar conexão</>}
        </button>
      </div>
    </div>
  );
}

function ApiConnectionCard({ id, provider, label, model, last4, state, message, checkedAt, users, runs, onRemoved }: {
  id: string; provider: ApiProvider; label: string; model: string; last4: string; state: string; message: string | null; checkedAt: string | null;
  users: Agent[]; runs: RunsApi; onRemoved: () => void;
}) {
  const [busy, setBusy] = useState<"" | "verify" | "remove">("");
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const verify = async () => { setBusy("verify"); setMsg(await runs.verifyApiConnection(id)); setBusy(""); };
  const remove = async () => { setBusy("remove"); await runs.deleteApiConnection(id); setBusy(""); onRemoved(); };
  const cls = state === "connected" ? "ok" : state === "unchecked" ? "unknown" : "bad";
  return (
    <article className={`conn-card ${cls} wide`}>
      <div className="conn-head">
        {state === "connected" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        <b>{PROVIDER_LABEL[provider]} · {label}</b>
        <span className={`conn-badge ${cls === "unknown" ? "" : cls}`}>{state === "connected" ? "Conectada" : state === "unchecked" ? "Ainda não testada" : state === "invalid" ? "Chave recusada" : "Falha na última verificação"}</span>
        <span className="muted">chave ····{last4}{model ? ` · modelo ${model}` : ""}</span>
        <span className="grow" />
        <button type="button" className="btn-secondary small" onClick={verify} disabled={!!busy} title="Faz uma chamada real mínima pela API (usa um pouco do uso pago dessa chave).">
          {busy === "verify" ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />} Testar sessão
        </button>
        <button type="button" className="btn-ghost small danger" onClick={() => setConfirmRemove(true)} disabled={!!busy}><Trash2 size={13} /> Remover</button>
      </div>
      {message && <p className="conn-msg">{message}</p>}
      {checkedAt && <small className="muted">Última verificação: {new Date(checkedAt).toLocaleString("pt-BR")}</small>}
      {msg && <p className={`conn-msg ${msg.ok ? "ok" : "bad"}`}>{msg.message}</p>}
      <div className="conn-users">
        <span className="eyebrow">USADA POR</span>
        {users.length ? users.map(a => <span key={a.id} className="chip">{a.name}</span>) : <span className="muted">Nenhum colaborador escolheu esta conexão.</span>}
      </div>
      {confirmRemove && (
        <div className="inline-confirm" role="alert">
          Remover esta conexão de API? Colaboradores que ainda a usarem passam a falhar com um motivo claro até você escolher outra conexão na ficha deles.
          <button className="btn-secondary" onClick={() => setConfirmRemove(false)}>Manter</button>
          <button className="btn-danger" onClick={remove}>Remover</button>
        </div>
      )}
    </article>
  );
}

export function ConnectionsScreen({ agents, runs }: { agents: Agent[]; runs: RunsApi }) {
  const [adding, setAdding] = useState(false);
  const apiConnections = runs.status?.apiConnections ?? [];
  const usersOf = (ref: string) => agents.filter(a => a.connection === ref);
  return (
    <div className="work-screen">
      <div className="screen-heading">
        <div><span className="eyebrow">CONFIGURAÇÕES</span><h2>Conexões de IA</h2><p>Contas por assinatura (Claude Code, Codex CLI) e conexões por chave de API, usadas pelos colaboradores da equipe.</p></div>
        <button className="btn-ghost" disabled={runs.checking} onClick={() => void runs.verify()}>{runs.checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Verificar tudo</button>
      </div>

      {!runs.status?.executor.reachable && (
        <div className="notice">Executor local indisponível: {runs.status?.executor.message ?? runs.statusError ?? "rode `pnpm executor` no terminal do projeto."} Sem ele, nenhuma conexão pode ser testada ou usada.</div>
      )}
      <div className="notice">
        <ShieldCheck size={14} aria-hidden /> Estas conexões vivem só neste computador, no executor local (arquivo <code>.dev.vars</code> + registro local criptografado). Uma versão hospedada do Setor IA (por exemplo na Vercel) não tem acesso a elas e não pode executar de verdade sem um pareamento remoto com este executor — ainda não implementado nesta versão.
      </div>

      <section className="run-sec">
        <h4>Contas por cliente oficial instalado</h4>
        <div className="conn-list">
          {CONNECTION_IDS.map(id => <CliConnectionCard key={id} id={id} runs={runs} users={usersOf(id)} />)}
        </div>
      </section>

      <section className="run-sec">
        <div className="pane-head">
          <h4>Conexões por API (cobrança separada das assinaturas)</h4>
          {!adding && <button className="btn-secondary small" onClick={() => setAdding(true)}><KeyRound size={14} /> Adicionar conexão de API</button>}
        </div>
        {adding && <AddApiConnectionForm runs={runs} onDone={() => setAdding(false)} />}
        <div className="conn-list">
          {apiConnections.map(a => (
            <ApiConnectionCard key={a.id} id={a.id} provider={a.provider} label={a.label} model={a.model} last4={a.last4} state={a.state} message={a.message} checkedAt={a.checkedAt} users={usersOf(`api:${a.id}`)} runs={runs} onRemoved={() => {}} />
          ))}
          {!apiConnections.length && !adding && <p className="muted">Nenhuma conexão de API cadastrada. Ela é opcional — as contas por assinatura acima continuam sendo o caminho principal.</p>}
        </div>
      </section>

      <section className="run-sec">
        <h4>Quem está pronto para executar</h4>
        <table className="ctx-table">
          <thead><tr><th>Colaborador</th><th>Conexão escolhida</th><th>Estado</th></tr></thead>
          <tbody>
            {agents.map(a => {
              const status = connectionStatusFor(a.connection, runs.status ?? undefined);
              const ready = status?.state === "connected";
              return (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.connection === "none" ? <span className="muted">Não definida</span> : connectionLabel(a.connection, apiConnections)}</td>
                  <td><span className={`conn-badge ${ready ? "ok" : "bad"}`}>{a.connection === "none" ? "Sem conexão" : ready ? "Pronto" : "Não pronto"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <small className="muted">Abra a ficha de cada colaborador (Funcionários) para escolher ou corrigir a conexão e o modelo.</small>
      </section>
    </div>
  );
}
