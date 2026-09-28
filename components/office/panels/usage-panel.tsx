"use client";

import { promptComposition } from "@/lib/engine/composition";
import { connectionLabel } from "@/lib/engine/connections";
import { reportedTotal, type AgentConnectionRef, type CallUsage, type RunBudget } from "@/lib/engine/types";

const fmt = (n: number | null | undefined) => (n == null ? "indisponível" : n.toLocaleString("pt-BR"));

/**
 * Only figures the client reported; a category it did not report shows
 * “indisponível”. The composition of the prompt is measured by the Setor IA in
 * characters and is never turned into tokens per section.
 */
export function UsagePanel({ budget, connection, agentLabel, prompt, schemaChars = 0 }: {
  budget: RunBudget; connection: AgentConnectionRef; agentLabel: string;
  prompt?: { system: string; user: string } | null; schemaChars?: number;
}) {
  const b = budget;
  const sum = (get: (c: CallUsage) => number | null) => {
    const vals = b.calls.map(get).filter((n): n is number => typeof n === "number");
    return vals.length ? vals.reduce((x, y) => x + y, 0) : null;
  };
  const input = sum(c => c.inputTokens), cacheR = sum(c => c.cacheReadTokens), cacheW = sum(c => c.cacheWriteTokens), output = sum(c => c.outputTokens), reasoning = sum(c => c.reasoningTokens);
  const sources = [...new Set(b.calls.map(c => c.source ?? `${connectionLabel(connection)} · registro anterior à identificação da fonte (valores como gravados na época)`))];
  const comp = promptComposition(prompt ?? null, schemaChars);
  const perRequest = b.calls.flatMap(c => (c.apiCalls ?? []).map((x, i) => ({ call: c.label, i: i + 1, ...x })));
  return (
    <>
      <div className="token-grid">
        <div><span className="eyebrow">ENTRADA</span><b>{fmt(input)}</b><small>sem cache</small></div>
        <div><span className="eyebrow">CACHE LIDO</span><b>{fmt(cacheR)}</b><small>entrada servida do cache</small></div>
        <div><span className="eyebrow">CACHE GRAVADO</span><b>{fmt(cacheW)}</b><small>entrada gravada no cache</small></div>
        <div><span className="eyebrow">SAÍDA</span><b>{fmt(output)}</b><small>{reasoning != null ? `inclui ${reasoning.toLocaleString("pt-BR")} de raciocínio` : "raciocínio: indisponível"}</small></div>
        <div><span className="eyebrow">TOTAL INFORMADO</span><b>{b.reportedTotalTokens == null ? "não informado" : b.reportedTotalTokens.toLocaleString("pt-BR")}</b><small>soma das categorias informadas</small></div>
        <div className={b.exceeded ? "warn" : ""}><span className="eyebrow">ORÇAMENTO DA FICHA</span><b>{b.sheetTokens.toLocaleString("pt-BR")}</b><small>{b.reportedTotalTokens == null ? "referência do " + agentLabel : b.exceeded ? "alerta: uso informado acima da referência" : "uso informado dentro da referência"}</small></div>
      </div>
      {!b.calls.length && <p className="muted">Nenhuma chamada com uso informado nesta execução.</p>}
      {!!b.calls.length && (
        <table className="ctx-table"><thead><tr><th>Chamada</th><th>Entrada</th><th>Cache lido</th><th>Cache gravado</th><th>Saída</th><th>Raciocínio (na saída)</th><th>Total</th><th>Turnos</th><th>Modelo informado</th></tr></thead>
          <tbody>{b.calls.map((c, i) => <tr key={i}><td>{c.label}</td><td>{fmt(c.inputTokens)}</td><td>{fmt(c.cacheReadTokens)}</td><td>{fmt(c.cacheWriteTokens)}</td><td>{fmt(c.outputTokens)}</td><td>{fmt(c.reasoningTokens)}</td><td>{fmt(reportedTotal(c))}</td><td>{c.turns == null ? "indisponível" : c.turns}</td><td>{c.model ?? "não informado"}</td></tr>)}</tbody>
        </table>
      )}
      {!!b.calls.length && (
        perRequest.length ? (
          <>
            <h4 className="ctx-h">Por requisição ao modelo (informado pelo cliente)</h4>
            {b.calls.some(c => (c.turns ?? 0) > (c.apiCalls?.length ?? 0)) && <p className="muted">O cliente detalhou {b.calls.map(c => `${c.apiCalls?.length ?? 0} de ${c.turns ?? "?"} turnos`).join("; ")}: as linhas abaixo não somam o total, que vem do campo de totais do cliente.</p>}
            <table className="ctx-table"><thead><tr><th>Chamada</th><th>Requisição</th><th>Entrada</th><th>Cache lido</th><th>Cache gravado</th><th>Saída</th></tr></thead>
              <tbody>{perRequest.map((r, k) => <tr key={k}><td>{r.call}</td><td>{r.i}</td><td>{fmt(r.inputTokens)}</td><td>{fmt(r.cacheReadTokens)}</td><td>{fmt(r.cacheWriteTokens)}</td><td>{fmt(r.outputTokens)}</td></tr>)}</tbody>
            </table>
          </>
        ) : <p className="muted">Detalhe por requisição: indisponível para esta execução (o cliente não informou ou o registro é anterior a esta medição).</p>
      )}
      {comp.parts.length > 0 && (
        <>
          <h4 className="ctx-h">Composição do texto montado pelo Setor IA ({comp.total.toLocaleString("pt-BR")} caracteres)</h4>
          <table className="ctx-table"><thead><tr><th>Seção</th><th>Caracteres</th><th>Parte</th></tr></thead>
            <tbody>{comp.parts.map((p, i) => <tr key={i}><td>{p.label}{p.detail ? ` (${p.detail})` : ""}</td><td>{p.chars.toLocaleString("pt-BR")}</td><td>{comp.total ? `${Math.round((p.chars / comp.total) * 100)}%` : "—"}</td></tr>)}</tbody>
          </table>
          <p className="form-note">Esta composição é medida em <b>caracteres</b> pelo Setor IA. Não é possível atribuir tokens a cada seção: o cliente oficial informa apenas totais por categoria e acrescenta contexto próprio (definição da ferramenta de saída estruturada, instruções internas, turnos extras), cuja parte não é informada separadamente.</p>
        </>
      )}
      <p className="form-note">
        <b>Fonte da medição:</b> {sources.length ? sources.join("; ") : "—"}. Antes da chamada, o Setor IA só estima o texto que envia ({b.estimatedInputTokens == null ? "sem estimativa" : `≈ ${b.estimatedInputTokens.toLocaleString("pt-BR")} tokens`}); essa estimativa nunca aparece como medida.
        O orçamento da ficha é referência e alerta, não um limite rígido: o cliente não pode ser interrompido no meio da resposta. Saldo e limites da assinatura não são informados ao Setor IA.
      </p>
    </>
  );
}
