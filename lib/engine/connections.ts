// Connection choices shown in the sheet and how older sheets map onto them.
// Shared by the browser and the executor; no secrets and no client calls here.
import type { AgentConnectionRef, ApiConnectionRecord, ConnectionId, ConnectionState, ConnectionStatus, EngineStatus } from "./types";

export type SheetConnection = AgentConnectionRef | "none";

export const CONNECTION_OPTIONS: { value: ConnectionId | "none"; label: string; short: string; client: string | null }[] = [
  { value: "none", label: "Não definida", short: "Sem conexão", client: null },
  { value: "claude_code", label: "Claude — assinatura (via Claude Code)", short: "Claude · Claude Code", client: "Claude Code" },
  { value: "codex", label: "ChatGPT Business (via Codex CLI)", short: "ChatGPT · Codex", client: "Codex CLI" },
];

export const CONNECTION_IDS: ConnectionId[] = ["claude_code", "codex"];

export const isConnectionId = (v: unknown): v is ConnectionId => v === "claude_code" || v === "codex";

/** An API-key connection reference, e.g. "api:3f9c...". */
export const isApiConnectionRef = (v: unknown): v is `api:${string}` => typeof v === "string" && v.startsWith("api:");
export const apiConnectionIdOf = (ref: string) => ref.slice(4);
export const apiConnectionRef = (id: string): `api:${string}` => `api:${id}`;

/** Short label for a sheet's connection, looking up an API connection's own record when needed. */
export function connectionLabel(v: string | undefined | null, apiConnections?: ApiConnectionRecord[]) {
  if (isApiConnectionRef(v)) {
    const rec = apiConnections?.find(a => a.id === apiConnectionIdOf(v));
    if (rec) return `API ${rec.provider === "anthropic" ? "Anthropic" : "OpenAI"} · ${rec.label}`;
    return "API (conexão removida)";
  }
  return CONNECTION_OPTIONS.find(o => o.value === v)?.short ?? "Sem conexão";
}

/** A synthetic ConnectionStatus built from an API connection's own record (never a live probe) — shared by the executor (service.ts) and the browser UI, so both build the exact same display for an "api:" ref. */
export function apiConnectionStatus(rec: ApiConnectionRecord | null, id: string): ConnectionStatus {
  if (!rec) return { id: "api", client: "Conexão de API", state: "unavailable", version: null, account: null, message: "Esta conexão de API foi removida em Configurações → Conexões de IA.", steps: ["Escolha outra conexão nesta ficha."], checkedAt: new Date().toISOString(), models: [], modelsSource: null, efforts: [], apiConnectionId: id };
  const client = `API ${rec.provider === "anthropic" ? "Anthropic" : "OpenAI"} · ${rec.label}`;
  const state: ConnectionState = rec.state === "connected" ? "connected" : rec.state === "invalid" ? "expired" : rec.state === "error" ? "unavailable" : "disconnected";
  const message = rec.state === "unchecked" ? "Ainda não testada: clique em “Testar sessão”." : rec.message ?? (state === "connected" ? "Chave confirmada na última verificação." : "Falha na última verificação.");
  const steps = state === "connected" ? [] : ["Abra Configurações → Conexões de IA, corrija a chave se preciso e clique em “Testar sessão”."];
  return { id: "api", client, state, version: null, account: `chave terminada em ${rec.last4}`, message, steps, checkedAt: rec.checkedAt ?? new Date().toISOString(), models: [], modelsSource: null, efforts: [], apiConnectionId: rec.id };
}

/** Status for any sheet/run connection — an official client from the engine status map, or a configured API connection built from its own record. */
export function connectionStatusFor(ref: string | undefined | null, status: Pick<EngineStatus, "connections" | "apiConnections"> | null | undefined): ConnectionStatus | undefined {
  if (!ref || ref === "none" || !status) return undefined;
  if (isApiConnectionRef(ref)) return apiConnectionStatus(status.apiConnections?.find(a => a.id === apiConnectionIdOf(ref)) ?? null, apiConnectionIdOf(ref));
  return isConnectionId(ref) ? status.connections[ref] : undefined;
}

/** Read-only guarantee for a sheet/run connection — API connections have no tool-calling at all in this version, so they are always read-only-safe. */
export function readOnlyInfoFor(ref: string | undefined | null, status: Pick<EngineStatus, "readOnly"> | null | undefined): { safe: boolean; how: string } | undefined {
  if (!ref || ref === "none") return undefined;
  if (isApiConnectionRef(ref)) return { safe: true, how: "Conexões de API não têm nenhuma ferramenta nesta versão (uma única chamada, só texto estruturado): são sempre restritas a leitura." };
  return isConnectionId(ref) ? status?.readOnly[ref] : undefined;
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
