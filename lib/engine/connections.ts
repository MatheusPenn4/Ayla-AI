// Connection choices shown in the sheet and how older sheets map onto them.
// Shared by the browser and the executor; no secrets and no client calls here.
import type { ConnectionId, ConnectionState } from "./types";

export type SheetConnection = ConnectionId | "none";

export const CONNECTION_OPTIONS: { value: SheetConnection; label: string; short: string; client: string | null }[] = [
  { value: "none", label: "Não definida", short: "Sem conexão", client: null },
  { value: "claude_code", label: "Claude — assinatura (via Claude Code)", short: "Claude · Claude Code", client: "Claude Code" },
  { value: "codex", label: "ChatGPT Business (via Codex CLI)", short: "ChatGPT · Codex", client: "Codex CLI" },
];

export const CONNECTION_IDS: ConnectionId[] = ["claude_code", "codex"];

export const isConnectionId = (v: unknown): v is ConnectionId => v === "claude_code" || v === "codex";

export function connectionLabel(v: string | undefined | null) {
  return CONNECTION_OPTIONS.find(o => o.value === v)?.short ?? "Sem conexão";
}

export const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  not_installed: "Não instalado",
  disconnected: "Desconectado",
  connected: "Conectado",
  expired: "Sessão expirada",
  unavailable: "Indisponível",
};

/**
 * Older sheets only had a planned provider ("Claude", "OpenAI", …). The same
 * choice is kept by mapping it onto the official client of that provider;
 * anything else stays "none" and the old value is kept in the sheet untouched.
 */
export function connectionFromLegacyProvider(provider: unknown): SheetConnection {
  if (provider === "Claude") return "claude_code";
  if (provider === "OpenAI") return "codex";
  return "none";
}

/** What happens to a run when the chosen connection is not usable. */
export const DISCONNECTED_BEHAVIOUR =
  "Se a conexão estiver indisponível no momento do clique, a execução é registrada como falha com o motivo e os passos para reconectar. Nada é trocado de provedor automaticamente e nenhum plano de exemplo é exibido.";
