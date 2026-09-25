"use client";

import { reportedTotal, type CallUsage, type ConnectionId, type RunBudget } from "@/lib/engine/types";

const fmt = (n: number | null | undefined) => (n == null ? "indisponível" : n.toLocaleString("pt-BR"));
const CLIENT: Record<ConnectionId, string> = { claude_code: "Claude Code", codex: "Codex CLI" };

/** Only figures the client reported; a category it did not report shows “indisponível”. */
export function UsagePanel({ budget, connection, agentLabel }: { budget: RunBudget; connection: ConnectionId; agentLabel: string }) {
  const b = budget;
  const sum = (get: (c: CallUsage) => number | null) => {
    const vals = b.calls.map(get).filter((n): n is number => typeof n === "number");
    return vals.length ? vals.reduce((x, y) => x + y, 0) : null;
  };
  const input = sum(c => c.inputTokens), cacheR = sum(c => c.cacheReadTokens), cacheW = sum(c => c.cacheWriteTokens), output = sum(c => c.outputTokens), reasoning = sum(c => c.reasoningTokens);
  const sources = [...new Set(b.calls.map(c => c.source ?? `${CLIENT[connection]} · registro anterior à identificação da fonte (valores como gravados na época)`))];
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
        <table className="ctx-table"><thead><tr><th>Chamada</th><th>Entrada</th><th>Cache lido</th><th>Cache gravado</th><th>Saída</th><th>Raciocínio (na saída)</th><th>Total</th><th>Modelo informado</th></tr></thead>
          <tbody>{b.calls.map((c, i) => <tr key={i}><td>{c.label}</td><td>{fmt(c.inputTokens)}</td><td>{fmt(c.cacheReadTokens)}</td><td>{fmt(c.cacheWriteTokens)}</td><td>{fmt(c.outputTokens)}</td><td>{fmt(c.reasoningTokens)}</td><td>{fmt(reportedTotal(c))}</td><td>{c.model ?? "não informado"}</td></tr>)}</tbody>
        </table>
      )}
      <p className="form-note">
        <b>Fonte da medição:</b> {sources.length ? sources.join("; ") : "—"}. Antes da chamada, o Setor IA só estima o texto que envia ({b.estimatedInputTokens == null ? "sem estimativa" : `≈ ${b.estimatedInputTokens.toLocaleString("pt-BR")} tokens`}); essa estimativa nunca aparece como medida.
        O orçamento da ficha é referência e alerta, não um limite rígido: o cliente não pode ser interrompido no meio da resposta. Saldo e limites da assinatura não são informados ao Setor IA.
      </p>
    </>
  );
}
