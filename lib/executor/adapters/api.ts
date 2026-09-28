// A collaborator reached directly through the Anthropic or OpenAI HTTP API, using a key the user configured
// in Configurações → Conexões de IA, instead of an official client's subscription login. Billed separately
// from the Claude/ChatGPT subscriptions (see docs). No tool calling is implemented here at all — only a
// single structured-output request — so this adapter only ever runs in "read_only" mode: WRITE_RESTRICTED
// marks every API connection unsafe for the Developer (see lib/executor/service.ts), and this file refuses
// "developer_write" defensively too, in case that gate is ever bypassed.
import type { ApiConnectionRecord, CallUsage } from "@/lib/engine/types";
import { AgentError, type AgentAdapter, type AgentCall, type AgentReply } from "./types";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const DEFAULT_OPENAI_MODEL = "gpt-5";
/** No streaming and no tool loop here: one shot, so the output must fit in one response. */
const MAX_OUTPUT_TOKENS = 8192;

type ApiErrorClass = { code: "not_connected" | "usage_limit" | "model_unavailable" | "connection_lost" | "client_error"; retryable: boolean };

function classifyApiError(status: number, text: string): ApiErrorClass {
  if (status === 401 || status === 403) return { code: "not_connected", retryable: false };
  if (status === 429) return { code: "usage_limit", retryable: true };
  if (status === 404 || /model.*(not found|does not exist|unknown)/i.test(text)) return { code: "model_unavailable", retryable: false };
  if (status >= 500) return { code: "connection_lost", retryable: true };
  return { code: "client_error", retryable: true };
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

async function callAnthropic(rec: ApiConnectionRecord, apiKey: string, c: AgentCall): Promise<AgentReply> {
  const model = rec.model.trim() || DEFAULT_ANTHROPIC_MODEL;
  const body = {
    model, max_tokens: MAX_OUTPUT_TOKENS, system: c.system,
    messages: [{ role: "user", content: c.user }],
    tools: [{ name: "emit_result", description: "Envie a resposta final estruturada.", input_schema: c.schema }],
    tool_choice: { type: "tool", name: "emit_result" },
  };
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify(body),
      signal: combinedSignal(c.timeoutMs, c.signal),
    });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") throw new AgentError(c.signal?.aborted ? "canceled" : "timeout", c.signal?.aborted ? "A execução foi cancelada." : `A API Anthropic não respondeu dentro do limite de ${Math.round(c.timeoutMs / 60000)} min.`, c.signal?.aborted ? false : true);
    throw new AgentError("connection_lost", "Falha de rede ao chamar a API Anthropic.", true, (e as Error).message);
  }
  const text = await res.text();
  if (!res.ok) {
    const cls = classifyApiError(res.status, text);
    const msg = cls.code === "not_connected" ? "A chave de API da Anthropic foi recusada (inválida ou revogada). Corrija-a em Configurações → Conexões de IA."
      : cls.code === "usage_limit" ? "A API Anthropic recusou por limite de uso/taxa (HTTP 429)." : `A API Anthropic respondeu com erro (HTTP ${res.status}).`;
    throw new AgentError(cls.code, msg, cls.retryable, text.slice(0, 600));
  }
  let parsed: { content?: { type?: string; name?: string; input?: unknown }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; stop_reason?: string };
  try { parsed = JSON.parse(text); } catch { throw new AgentError("client_error", "A API Anthropic respondeu com um corpo que não é JSON.", true, text.slice(0, 300)); }
  const usage: CallUsage | null = parsed.usage ? {
    label: c.label, inputTokens: parsed.usage.input_tokens ?? null, outputTokens: parsed.usage.output_tokens ?? null,
    cacheReadTokens: parsed.usage.cache_read_input_tokens ?? null, cacheWriteTokens: parsed.usage.cache_creation_input_tokens ?? null,
    reasoningTokens: null, model, source: "API Anthropic (Messages API) · campo usage da resposta",
  } : null;
  if (parsed.stop_reason === "max_tokens") {
    const err = new AgentError("output_too_large", `A resposta da API Anthropic foi cortada em ${MAX_OUTPUT_TOKENS} tokens de saída (sem streaming nem novo turno nesta versão).`, false);
    err.usage = usage;
    throw err;
  }
  const toolUse = parsed.content?.find(b => b.type === "tool_use" && b.name === "emit_result");
  if (!toolUse) throw new AgentError("invalid_output", "A API Anthropic não devolveu a ferramenta de saída estruturada esperada.", true, text.slice(0, 300));
  return { output: toolUse.input ?? null, text: JSON.stringify(toolUse.input ?? null), usage };
}

async function callOpenAI(rec: ApiConnectionRecord, apiKey: string, c: AgentCall): Promise<AgentReply> {
  const model = rec.model.trim() || DEFAULT_OPENAI_MODEL;
  const body = {
    model,
    messages: [{ role: "system", content: c.system }, { role: "user", content: c.user }],
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: "json_schema", json_schema: { name: "resultado", schema: c.schema, strict: true } },
  };
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: combinedSignal(c.timeoutMs, c.signal),
    });
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") throw new AgentError(c.signal?.aborted ? "canceled" : "timeout", c.signal?.aborted ? "A execução foi cancelada." : `A API OpenAI não respondeu dentro do limite de ${Math.round(c.timeoutMs / 60000)} min.`, c.signal?.aborted ? false : true);
    throw new AgentError("connection_lost", "Falha de rede ao chamar a API OpenAI.", true, (e as Error).message);
  }
  const text = await res.text();
  if (!res.ok) {
    const cls = classifyApiError(res.status, text);
    const msg = cls.code === "not_connected" ? "A chave de API da OpenAI foi recusada (inválida ou revogada). Corrija-a em Configurações → Conexões de IA."
      : cls.code === "usage_limit" ? "A API OpenAI recusou por limite de uso/taxa (HTTP 429)." : `A API OpenAI respondeu com erro (HTTP ${res.status}).`;
    throw new AgentError(cls.code, msg, cls.retryable, text.slice(0, 600));
  }
  let parsed: { choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } };
  try { parsed = JSON.parse(text); } catch { throw new AgentError("client_error", "A API OpenAI respondeu com um corpo que não é JSON.", true, text.slice(0, 300)); }
  const usage: CallUsage | null = parsed.usage ? {
    label: c.label, inputTokens: parsed.usage.prompt_tokens ?? null, outputTokens: parsed.usage.completion_tokens ?? null,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? null,
    model, source: "API OpenAI (Chat Completions) · campo usage da resposta",
  } : null;
  const choice = parsed.choices?.[0];
  if (choice?.finish_reason === "length") {
    const err = new AgentError("output_too_large", `A resposta da API OpenAI foi cortada em ${MAX_OUTPUT_TOKENS} tokens de saída (sem streaming nem novo turno nesta versão).`, false);
    err.usage = usage;
    throw err;
  }
  const content = choice?.message?.content;
  if (!content) throw new AgentError("invalid_output", "A API OpenAI não devolveu conteúdo estruturado.", true, text.slice(0, 300));
  let output: unknown;
  try { output = JSON.parse(content); } catch { throw new AgentError("invalid_output", "A API OpenAI respondeu, mas o conteúdo não é um JSON válido.", true, content.slice(0, 300)); }
  return { output, text: content, usage };
}

/** Adapter for a configured API-key connection. No tools, no streaming, no multi-turn loop — one shot. */
export function apiAdapter(rec: ApiConnectionRecord, apiKey: string): AgentAdapter {
  return {
    id: "api",
    async call(c: AgentCall): Promise<AgentReply> {
      if (c.mode === "developer_write") throw new AgentError("client_error", "Conexões de API não têm ferramenta de arquivo nesta versão: não podem ser usadas pelo Desenvolvedor.", false);
      return rec.provider === "anthropic" ? callAnthropic(rec, apiKey, c) : callOpenAI(rec, apiKey, c);
    },
  };
}
