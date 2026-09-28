import type { CallUsage, ConnectionId } from "@/lib/engine/types";

export type AgentCall = {
  label: string;
  /** System instructions (phase protocol + saved sheet). */
  system: string;
  /** Demand, team and source data. */
  user: string;
  /** JSON Schema the final answer must follow. */
  schema: Record<string, unknown>;
  /** "" = the client's default model. */
  model: string;
  /** "" = the client's default effort. */
  effort: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Working directory owned by this call: empty for "read_only", the Developer's isolated copy for "developer_write". */
  workDir: string;
  /**
   * Where the adapter's own supporting files (system prompt, output schema) are written. Defaults to `workDir`
   * when absent. Must be set to a directory OUTSIDE `workDir` whenever `workDir` is itself diffed afterwards
   * (the Developer's isolated copy) — otherwise the adapter's own file is mistaken for an out-of-scope edit.
   */
  scratchDir?: string;
  /** Progress reported by the client while it runs (streaming clients only). */
  onProgress?: (p: AgentProgress) => void;
  /**
   * Capability profile enforced by client flags (never by the prompt alone).
   * "read_only" (default): no tools at all — the Architect's profile.
   * "developer_write": Read/Edit/Write/Glob/Grep confined to workDir, no Bash/PowerShell/network/MCP/hooks.
   */
  mode?: "read_only" | "developer_write";
};

export type AgentProgress = { kind: "started" | "api_retry" | "model_output" | "turn" | "client_error"; message: string; data?: unknown };

export type AgentReply = {
  /** Parsed structured answer (null when the client returned no JSON). */
  output: unknown;
  /** Text of the final answer as returned. */
  text: string;
  /** Only what the client reported; null when it reported nothing. */
  usage: CallUsage | null;
};

/** Error codes shared by all adapters (shown to the user with recovery steps). */
export type AgentErrorCode =
  | "not_installed" | "not_connected" | "session_expired" | "auth_busy" | "usage_limit" | "model_unavailable"
  | "timeout" | "canceled" | "connection_lost" | "client_error" | "invalid_output" | "output_too_large";

export class AgentError extends Error {
  /** Usage the client reported before failing (may be partial). */
  usage?: CallUsage | null;
  constructor(public code: AgentErrorCode, message: string, public retryable: boolean, public detail?: string) { super(message); }
}

export interface AgentAdapter {
  readonly id: ConnectionId;
  call(c: AgentCall): Promise<AgentReply>;
}

/** Classifies an error text reported by a client. Order matters: most specific first. */
export function classifyClientError(text: string, status?: number | null): { code: AgentErrorCode; retryable: boolean } {
  const t = text.toLowerCase();
  if (/not logged in|missing bearer|no auth/.test(t)) return { code: "not_connected", retryable: false };
  // Claude Code 2.1: "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.
  // This is usually transient" — the saved login is still valid; it is not an expired session (seen in a real run, 28/09/2026).
  if (/another claude code process is refreshing|exited mid-refresh/.test(t)) return { code: "auth_busy", retryable: true };
  if (/login expired|session expired|token (has )?expired|refresh token|invalid_grant|re-?authenticate|unauthorized|\b401\b|oauth token/.test(t)) return { code: "session_expired", retryable: false };
  if (/please run \/login|codex login/.test(t)) return { code: "not_connected", retryable: false };
  if (status === 429 || /usage limit|rate limit|limit reached|hit your .*limit|out of (extra )?usage|too many requests|\b429\b|quota|weekly limit|5-hour/.test(t)) return { code: "usage_limit", retryable: true };
  if (status === 404 || /selected model|model .*(not (found|supported|available)|does not exist)|unrecognized_model|not supported when using/.test(t)) return { code: "model_unavailable", retryable: false };
  if (/econnreset|enotfound|etimedout|network|stream disconnected|connection (closed|reset|refused)|socket hang up|overloaded|\b5\d\d\b|reconnecting/.test(t)) return { code: "connection_lost", retryable: true };
  return { code: "client_error", retryable: true };
}

export const ERROR_MESSAGE: Record<AgentErrorCode, string> = {
  not_installed: "O cliente oficial escolhido na ficha não está instalado neste computador.",
  not_connected: "O cliente oficial não tem login salvo neste computador.",
  session_expired: "A sessão salva pelo cliente oficial expirou ou foi recusada. É preciso entrar novamente.",
  auth_busy: "O cliente oficial não conseguiu renovar o token de acesso: ele informa que outro processo dele está renovando ou saiu no meio da renovação. Ele trata isso como falha passageira e não diz que o login expirou.",
  usage_limit: "O limite de uso da assinatura foi atingido (informado pelo cliente). Aguarde a renovação do limite ou escolha outra conexão na ficha.",
  model_unavailable: "O modelo escolhido na ficha não está disponível para esta conta no cliente oficial.",
  timeout: "O cliente não terminou dentro do tempo limite do executor.",
  canceled: "A execução foi cancelada e o processo do cliente foi encerrado.",
  connection_lost: "A conexão do cliente com o serviço caiu durante a execução.",
  client_error: "O cliente oficial terminou com erro.",
  invalid_output: "O cliente respondeu, mas não no formato esperado.",
  output_too_large: "A saída do cliente passou do limite de tamanho do executor.",
};
