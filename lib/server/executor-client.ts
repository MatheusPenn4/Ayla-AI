// Server-side bridge from the Next API routes to the local executor.
// The token never leaves the server; the browser only talks to /api/*.
import "server-only";
import { serverConfig } from "./config";

export type ExecutorReply = { status: number; body: unknown };

export const EXECUTOR_OFFLINE =
  "O executor local não está respondendo. Em um terminal na pasta do projeto, rode: pnpm executor (e mantenha-o aberto).";

/** Binary answer (artifacts). Same token, same loopback-only rule as callExecutor; JSON errors are passed through. */
export async function callExecutorRaw(path: string): Promise<{ ok: true; data: ArrayBuffer; contentType: string } | { ok: false; status: number; body: unknown }> {
  const cfg = serverConfig().executor;
  if (!cfg.token) return { ok: false, status: 503, body: { error: { code: "executor_not_configured", message: "O token do executor local não está configurado." } } };
  let url: URL;
  try { url = new URL(path, cfg.url); } catch { return { ok: false, status: 500, body: { error: { code: "executor_url", message: "AYLA_EXECUTOR_URL inválida." } } }; }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return { ok: false, status: 500, body: { error: { code: "executor_url", message: "AYLA_EXECUTOR_URL precisa apontar para este computador (127.0.0.1)." } } };
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(30_000), cache: "no-store" });
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    if (!res.ok) return { ok: false, status: res.status, body: await res.json().catch(() => ({ error: { code: "executor_bad_reply", message: "Resposta inválida do executor local." } })) };
    return { ok: true, data: await res.arrayBuffer(), contentType: type };
  } catch {
    return { ok: false, status: 503, body: { error: { code: "executor_offline", message: EXECUTOR_OFFLINE } } };
  }
}

export async function callExecutor(path: string, init: { method?: "GET" | "POST" | "DELETE"; body?: unknown; timeoutMs?: number } = {}): Promise<ExecutorReply> {
  const cfg = serverConfig().executor;
  if (!cfg.token) {
    return { status: 503, body: { error: { code: "executor_not_configured", message: "O token do executor local não está configurado. Rode pnpm executor uma vez (ele cria o token em .dev.vars) e reinicie o pnpm dev." } } };
  }
  let url: URL;
  try { url = new URL(path, cfg.url); } catch { return { status: 500, body: { error: { code: "executor_url", message: "AYLA_EXECUTOR_URL inválida." } } }; }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return { status: 500, body: { error: { code: "executor_url", message: "AYLA_EXECUTOR_URL precisa apontar para este computador (127.0.0.1)." } } };
  }
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${cfg.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({ error: { code: "executor_bad_reply", message: "Resposta inválida do executor local." } }));
    return { status: res.status, body };
  } catch {
    return { status: 503, body: { error: { code: "executor_offline", message: EXECUTOR_OFFLINE } } };
  }
}
