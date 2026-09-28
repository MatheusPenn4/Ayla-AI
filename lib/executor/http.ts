// HTTP interface of the local executor.
// It is meant to be called ONLY by the Setor IA server process on this
// computer (the Next API routes), never by a web page:
// - listens on 127.0.0.1 only;
// - Host header must be the loopback address and port (blocks DNS rebinding);
// - any request carrying browser markers (Origin, Sec-Fetch-*) is refused,
//   and no CORS headers are ever sent, so pages on the internet cannot call it;
// - every request needs the bearer token kept in .dev.vars (compared in
//   constant time, never logged, never sent to the browser);
// - JSON only, small bodies, fixed routes.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isConnectionId } from "@/lib/engine/connections";
import type { ExecutorService, Reply } from "./service";

export const MAX_BODY_BYTES = 1_000_000;

export type HttpOptions = { token: string; port: number };

function tokenMatches(header: string | undefined, token: string) {
  const m = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pure check, exported for tests. */
export function checkRequest(req: Pick<IncomingMessage, "headers" | "method">, opts: HttpOptions): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const h = req.headers;
  const allowedHosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`];
  if (!h.host || !allowedHosts.includes(h.host.toLowerCase())) return { ok: false, status: 421, code: "bad_host", message: "Host não permitido." };
  if (h.origin !== undefined || Object.keys(h).some(k => k.startsWith("sec-fetch-"))) {
    return { ok: false, status: 403, code: "browser_request", message: "O executor não aceita chamadas de páginas web. Use a interface do Setor IA." };
  }
  if (req.method === "OPTIONS") return { ok: false, status: 403, code: "no_cors", message: "Sem CORS." };
  if (!tokenMatches(h.authorization, opts.token)) return { ok: false, status: 401, code: "unauthorized", message: "Token do executor ausente ou inválido." };
  return { ok: true };
}

function send(res: ServerResponse, r: Reply) {
  const body = JSON.stringify(r.body);
  res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw Object.assign(new Error("Content-Type deve ser application/json."), { status: 415 });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Corpo grande demais."), { status: 413 });
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { throw Object.assign(new Error("JSON inválido."), { status: 400 }); }
}

export async function handle(service: ExecutorService, req: IncomingMessage, opts: HttpOptions): Promise<Reply> {
  const gate = checkRequest(req, opts);
  if (!gate.ok) return { status: gate.status, body: { error: { code: gate.code, message: gate.message } } };
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
  const p = url.pathname;
  const m = req.method;
  try {
    if (m === "GET" && p === "/v1/status") return { status: 200, body: await service.status(url.searchParams.get("refresh") === "1") };
    if (m === "POST" && p === "/v1/connections/check") {
      const body = (await readJson(req)) as { id?: unknown; probe?: unknown } | null;
      if (body?.probe === true) {
        if (!isConnectionId(body.id)) return { status: 400, body: { error: { code: "invalid_request", message: "Conexão inválida." } } };
        return await service.probe(body.id);
      }
      return { status: 200, body: await service.status(true) };
    }
    if (m === "POST" && p === "/v1/runs") return await service.start(await readJson(req));
    if (m === "GET" && p === "/v1/runs") return await service.list((url.searchParams.get("demands") ?? "").split(",").map(s => s.trim()));
    let r = /^\/v1\/runs\/([0-9a-f-]{36})$/.exec(p);
    if (m === "GET" && r) return await service.get(r[1]);
    r = /^\/v1\/runs\/([0-9a-f-]{36})\/cancel$/.exec(p);
    if (m === "POST" && r) return await service.cancel(r[1]);
    r = /^\/v1\/runs\/([0-9a-f-]{36})\/approve$/.exec(p);
    if (m === "POST" && r) return await service.approve(r[1], await readJson(req));
    r = /^\/v1\/runs\/([0-9a-f-]{36})\/resolve-locally$/.exec(p);
    if (m === "POST" && r) return await service.resolveClarificationLocally(r[1], await readJson(req));
    r = /^\/v1\/runs\/([0-9a-f-]{36})\/completions$/.exec(p);
    if (m === "GET" && r) return await service.listCompletions(r[1]);
    if (m === "POST" && p === "/v1/qa-handoffs") return await service.prepareQA(await readJson(req));
    if (m === "POST" && p === "/v1/reviewer-handoffs") return await service.prepareReviewer(await readJson(req));
    if (m === "POST" && p === "/v1/task-completions") return await service.recordTaskCompletion(await readJson(req));
    if (m === "GET" && p === "/v1/api-connections") return await service.listApiConnections();
    if (m === "POST" && p === "/v1/api-connections") return await service.createApiConnection(await readJson(req));
    r = /^\/v1\/api-connections\/([0-9a-f-]{36})$/.exec(p);
    if (m === "DELETE" && r) return await service.deleteApiConnection(r[1]);
    r = /^\/v1\/api-connections\/([0-9a-f-]{36})\/verify$/.exec(p);
    if (m === "POST" && r) return await service.verifyApiConnection(r[1]);
    if (m === "POST" && p === "/v1/handoffs") return await service.prepare(await readJson(req));
    if (m === "GET" && p === "/v1/handoffs/source-options") return await service.sourceOptions(url.searchParams.get("plan") ?? "", url.searchParams.get("task") ?? "");
    if (m === "GET" && p === "/v1/developer-preview") return await service.developerPreview(url.searchParams.get("plan") ?? "", url.searchParams.get("task") ?? "");
    if (m === "POST" && p === "/v1/developer-handoffs") return await service.prepareDeveloper(await readJson(req));
    return { status: 404, body: { error: { code: "not_found", message: "Rota inexistente." } } };
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return { status, body: { error: { code: status === 500 ? "internal" : "invalid_body", message: status === 500 ? "Falha interna do executor." : (e as Error).message } } };
  }
}

export function createExecutorServer(service: ExecutorService, opts: HttpOptions): Server {
  const server = createServer((req, res) => { void handle(service, req, opts).then(r => send(res, r), () => send(res, { status: 500, body: { error: { code: "internal", message: "Falha interna do executor." } } })); });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return server;
}
