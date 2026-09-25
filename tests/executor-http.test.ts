// HTTP protection of the local executor, against a real server on 127.0.0.1.
// Clients are simulated (scripted adapters and detectors).
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRequest, createExecutorServer } from "@/lib/executor/http";
import { ExecutorService } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore } from "@/lib/executor/store";
import { connected, fakeAdapter, goodPlan, reply, request } from "./helpers";

const TOKEN = "t".repeat(43);
let port = 0;
let server: Server;
let work: string;
let service: ExecutorService;

const freePort = () => new Promise<number>(res => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

type Res = { status: number; body: Record<string, unknown> };
function send(method: string, p: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest({ host: "127.0.0.1", port, method, path: p, headers: { authorization: `Bearer ${TOKEN}`, ...(data ? { "content-type": "application/json" } : {}), ...headers } }, res => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", d => (s += d));
      res.on("end", () => { expect(res.headers["access-control-allow-origin"]).toBeUndefined(); resolve({ status: res.statusCode ?? 0, body: s ? JSON.parse(s) : {} }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), "ayla-http-"));
  port = await freePort();
  service = new ExecutorService(
    { version: "t", dataDir: work, storePath: ":memory:", workRoot: work, limits: { maxRunsPerHour: 20, maxConcurrentRuns: 1, callTimeoutMs: 1000, leaseMs: 60000, statusCacheMs: 0 }, github: {} },
    { store: new RunStore(sqliteDriver(":memory:")), runner: async () => { throw new Error("sem processos"); }, env: {}, detectors: { claude_code: async () => connected(), codex: async () => connected("codex", { state: "disconnected", message: "sem login" }) }, adapters: { claude_code: fakeAdapter([reply(goodPlan()), reply(goodPlan())]).adapter } },
  );
  await service.boot();
  server = createExecutorServer(service, { token: TOKEN, port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
});
afterAll(async () => {
  await service.idle();
  await new Promise(r => server.close(r));
  rmSync(work, { recursive: true, force: true });
});

describe("proteção do executor local", () => {
  it("sem token, ou com token errado: 401", async () => {
    expect((await send("GET", "/v1/status", { authorization: "" })).status).toBe(401);
    expect((await send("GET", "/v1/status", { authorization: `Bearer ${"x".repeat(43)}` })).status).toBe(401);
  });
  it("requisições com marcas de navegador (Origin, Sec-Fetch-*) são recusadas mesmo com token", async () => {
    expect((await send("GET", "/v1/status", { origin: "https://site-qualquer.example" })).status).toBe(403);
    expect((await send("GET", "/v1/status", { origin: "http://localhost:3000" })).status).toBe(403);
    expect((await send("POST", "/v1/runs", { "sec-fetch-mode": "cors" }, request())).status).toBe(403);
    expect((await send("OPTIONS", "/v1/runs", { "access-control-request-method": "POST" })).status).toBe(403);
  });
  it("Host diferente de 127.0.0.1/localhost (DNS rebinding) é recusado", async () => {
    expect((await send("GET", "/v1/status", { host: `evil.example:${port}` })).status).toBe(421);
    expect(checkRequest({ method: "GET", headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` } }, { token: TOKEN, port }).ok).toBe(true);
  });
  it("somente JSON, com tamanho limitado", async () => {
    expect((await send("POST", "/v1/runs", { "content-type": "text/plain" }, "oi")).status).toBe(415);
    expect((await send("POST", "/v1/runs", {}, "{ruim")).status).toBe(400);
    expect((await send("POST", "/v1/runs", {}, JSON.stringify({ x: "a".repeat(1_100_000) }))).status).toBe(413);
  });
  it("status: conexões reais detectadas são repassadas sem segredos", async () => {
    const r = await send("GET", "/v1/status");
    expect(r.status).toBe(200);
    expect((r.body.connections as Record<string, { state: string }>).codex.state).toBe("disconnected");
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });
  it("entrada inválida é validada no executor (não se confia no navegador)", async () => {
    const r = await send("POST", "/v1/runs", {}, { ...request(), directorId: "qa" });
    expect(r.status).toBe(400);
  });
  it("fluxo completo: cria, deduplica clique repetido, conclui e consulta", async () => {
    const req = request({}, { id: "http-1" });
    const a = await send("POST", "/v1/runs", {}, req);
    const b = await send("POST", "/v1/runs", {}, req);
    expect(a.status).toBe(202);
    expect([200, 202]).toContain(b.status);
    expect((b.body.run as { id: string }).id).toBe((a.body.run as { id: string }).id);
    await service.idle();
    const id = (a.body.run as { id: string }).id;
    const d = await send("GET", `/v1/runs/${id}`);
    expect((d.body.run as { status: string }).status).toBe("plan_ready");
    const list = await send("GET", "/v1/runs?demands=http-1,../../x");
    expect((list.body.runs as unknown[]).length).toBe(1);
    expect((await send("GET", "/v1/runs/nao-e-um-id")).status).toBe(404);
  });
});
