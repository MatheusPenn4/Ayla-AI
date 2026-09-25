"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, PlugZap, RefreshCw } from "lucide-react";
import { CONNECTION_OPTIONS, CONNECTION_STATE_LABEL, DISCONNECTED_BEHAVIOUR, connectionFromLegacyProvider, type SheetConnection } from "@/lib/engine/connections";
import type { ConnectionId, ConnectionStatus, EngineStatus } from "@/lib/engine/types";
import { Field } from "./field";

export type EngineControls = {
  status: EngineStatus | null;
  statusError: string | null;
  verify: () => Promise<void>;
  probe: (id: ConnectionId) => Promise<{ ok: boolean; message: string }>;
};

const STATE_CLASS: Record<ConnectionStatus["state"], string> = {
  connected: "ok", disconnected: "bad", expired: "bad", not_installed: "bad", unavailable: "warn",
};

export function ConnectionBadge({ status }: { status: ConnectionStatus | undefined }) {
  if (!status) return <span className="conn-badge unknown">estado desconhecido</span>;
  return <span className={`conn-badge ${STATE_CLASS[status.state]}`}>{CONNECTION_STATE_LABEL[status.state]}</span>;
}

export function ConnectionSteps({ status }: { status: ConnectionStatus }) {
  if (!status.steps.length) return null;
  return <ol className="conn-steps">{status.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>;
}

export function ConnectionPanel({ connection, modelName, effort, legacyProvider, executable, engine, onChange }: {
  connection: SheetConnection;
  modelName: string;
  effort: string;
  legacyProvider: string;
  /** How this collaborator runs in this phase: by itself (Director), only through an approved hand-off (Architect), or not yet. */
  executable: "starts" | "handoff" | "none";
  engine: EngineControls | undefined;
  onChange: (part: { connection?: SheetConnection; modelName?: string; effort?: string }) => void;
}) {
  const [busy, setBusy] = useState<"" | "verify" | "probe">("");
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const status = connection !== "none" ? engine?.status?.connections[connection] : undefined;
  const executorDown = !!engine && !!engine.status && !engine.status.executor.reachable;
  const models = status?.models ?? [];
  const selectedModel = models.find(m => m.value === modelName);
  const efforts = connection === "codex" ? (selectedModel?.efforts ?? []) : (status?.efforts ?? []);
  const legacyUnmapped = legacyProvider && legacyProvider !== "A definir" && connectionFromLegacyProvider(legacyProvider) === "none";

  const verify = async () => { if (!engine) return; setBusy("verify"); setProbeMsg(null); try { await engine.verify(); } finally { setBusy(""); } };
  const probe = async () => { if (!engine || connection === "none") return; setBusy("probe"); try { setProbeMsg(await engine.probe(connection)); } finally { setBusy(""); } };

  return (
    <div className="conn-panel">
      <Field label="Conexão de execução" hint="Cliente oficial instalado e autenticado neste computador. O Setor IA não guarda senha, cookie nem token das suas contas.">
        <select value={connection} onChange={e => { onChange({ connection: e.target.value as SheetConnection, modelName: "", effort: "" }); setProbeMsg(null); }}>
          {CONNECTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {legacyUnmapped && <p className="form-note">Provedor planejado em uma versão anterior da ficha: <b>{legacyProvider}</b> (mantido, mas sem cliente oficial suportado).</p>}

      {connection !== "none" && (
        <div className={`conn-card ${status ? STATE_CLASS[status.state] : "unknown"}`}>
          <div className="conn-head">
            {status?.state === "connected" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <b>{status?.client ?? CONNECTION_OPTIONS.find(o => o.value === connection)?.client}</b>
            <ConnectionBadge status={status} />
            {status?.version && <span className="muted">{status.version}</span>}
            {status?.account && <span className="muted">· {status.account}</span>}
            <span className="grow" />
            <button type="button" className="btn-ghost" onClick={verify} disabled={!engine || !!busy}>{busy === "verify" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Verificar conexão</button>
            {status && (status.state === "connected" || status.state === "expired") && (
              <button type="button" className="btn-ghost" onClick={probe} disabled={!!busy} title="Faz uma chamada real mínima pelo cliente oficial (usa um pouco da assinatura).">{busy === "probe" ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />} Testar sessão</button>
            )}
          </div>
          {executorDown && <p className="conn-msg">{engine?.status?.executor.message}</p>}
          {engine?.statusError && <p className="conn-msg">{engine.statusError}</p>}
          {status && <p className="conn-msg">{status.message}</p>}
          {status && <ConnectionSteps status={status} />}
          {probeMsg && <p className={`conn-msg ${probeMsg.ok ? "ok" : "bad"}`}>{probeMsg.message}</p>}
          <small>O login é feito por você, no terminal, pelo próprio cliente oficial; o Setor IA apenas verifica o estado com os comandos de status do cliente.</small>
        </div>
      )}

      {connection !== "none" && (
        <div className="form-row">
          <Field label="Modelo" hint={status?.modelsSource ?? "Sem lista de modelos do cliente: será usado o modelo padrão do cliente."}>
            <select value={modelName} onChange={e => onChange({ modelName: e.target.value, effort: "" })}>
              <option value="">Padrão do cliente</option>
              {models.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              {modelName && !selectedModel && <option value={modelName}>{modelName} (salvo na ficha; não listado pelo cliente)</option>}
            </select>
          </Field>
          {(efforts.length > 0 || effort) && (
            <Field label="Esforço de raciocínio" hint={connection === "codex" ? "Níveis que o catálogo do Codex informa para este modelo." : "Níveis aceitos pelo Claude Code (claude --help)."}>
              <select value={effort} onChange={e => onChange({ effort: e.target.value })}>
                <option value="">Padrão do cliente</option>
                {efforts.map(l => <option key={l} value={l}>{l}</option>)}
                {effort && !efforts.includes(effort) && <option value={effort}>{effort} (salvo na ficha)</option>}
              </select>
            </Field>
          )}
        </div>
      )}

      <p className="form-note">
        {executable === "starts" && <>Este colaborador executa nesta fase (somente planejamento). {DISCONNECTED_BEHAVIOUR} Os limites de uso da assinatura são controlados pelo Claude/ChatGPT e não são informados ao Setor IA; o orçamento de tokens da ficha é outro limite, do próprio Setor IA.</>}
        {executable === "handoff" && <>Este colaborador executa <b>somente</b> quando você revisa e confirma uma tarefa do Diretor atribuída a ele, e apenas para análise: sem editar arquivos, sem comandos, sem rede. {DISCONNECTED_BEHAVIOUR} O orçamento de tokens da ficha é referência/alerta, não o limite da assinatura.</>}
        {executable === "none" && <>Nesta fase este colaborador <b>não executa</b>: aparece apenas como responsável proposto nos planos do Diretor. A conexão escolhida fica registrada para as próximas etapas.</>}
      </p>
    </div>
  );
}
