// Access control of the web API that reaches the local executor.
// There is no user authentication yet, so real execution is restricted to a
// local development server reached through loopback, from the app's own
// origin. A production build (e.g. on Vercel) always refuses: see
// docs/executor-local.md.
import "server-only";
import { isDevServer } from "./config";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type Gate = { ok: true } | { ok: false; status: number; reason: string };

/** Environment part of the gate: development server reached through loopback. */
export function environmentGate(request: Request): Gate {
  if (!isDevServer()) {
    return { ok: false, status: 403, reason: "A execução real está desativada neste ambiente: ela depende do executor local e dos logins dos clientes oficiais neste computador. Use o servidor local de desenvolvimento (pnpm dev + pnpm executor)." };
  }
  const url = new URL(request.url);
  const hostHeader = (request.headers.get("host") ?? url.host).split(":")[0].toLowerCase();
  if (!LOOPBACK.has(url.hostname.toLowerCase()) || !LOOPBACK.has(hostHeader)) {
    return { ok: false, status: 403, reason: "A execução real só é aceita em localhost nesta fase." };
  }
  return { ok: true };
}

export function executionGate(request: Request): Gate {
  const env = environmentGate(request);
  if (!env.ok) return env;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!LOOPBACK.has(new URL(origin).hostname.toLowerCase())) return { ok: false, status: 403, reason: "Origem não permitida." };
    } catch {
      return { ok: false, status: 403, reason: "Origem inválida." };
    }
  }
  if (request.headers.get("x-ayla-client") !== "web") {
    return { ok: false, status: 403, reason: "Requisição sem o cabeçalho do aplicativo." };
  }
  return { ok: true };
}

/** Status reads are harmless but still local-only while there is no authentication. */
export function readGate(request: Request): Gate {
  const url = new URL(request.url);
  if (!isDevServer() || !LOOPBACK.has(url.hostname.toLowerCase())) {
    return { ok: false, status: 403, reason: "Registros de execução disponíveis apenas no servidor local nesta fase." };
  }
  return { ok: true };
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
