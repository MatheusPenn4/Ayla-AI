// API-key connections (Configurações → Conexões de IA): secret storage (encryption), the direct-HTTP adapter
// (Anthropic Messages API / OpenAI Chat Completions, both SIMULATED via a mocked global fetch — no real
// network call in this file), and the executor service's CRUD + safety gating (read-only always safe,
// write never safe: there is no file tool in this adapter).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, last4, parseBox, randomMachineKeyB64, parseMachineKeyB64, serializeBox } from "@/lib/executor/secret-store";
import { apiAdapter } from "@/lib/executor/adapters/api";
import { AgentError } from "@/lib/executor/adapters/types";
import { ExecutorService, type ExecutorConfig } from "@/lib/executor/service";
import { sqliteDriver } from "@/lib/executor/sqlite";
import { RunStore } from "@/lib/executor/store";
import { DeveloperHandoffZ } from "@/lib/executor/developer";
import type { ApiConnectionRecord } from "@/lib/engine/types";
import { member, request } from "./helpers";
import { buildNewRun, parseStartRequest } from "@/lib/executor/runs-service";

let work: string;
let store: RunStore;
beforeEach(() => { work = mkdtempSync(path.join(os.tmpdir(), "ayla-api-")); store = new RunStore(sqliteDriver(":memory:")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); vi.unstubAllGlobals(); });

const cfg = (secretKeyB64?: string): ExecutorConfig => ({
  version: "t", dataDir: work, storePath: ":memory:", workRoot: work,
  limits: { maxRunsPerHour: 50, maxConcurrentRuns: 1, callTimeoutMs: 1000, leaseMs: 60000, statusCacheMs: 0 },
  github: {}, secretKeyB64,
});
function svc(secretKeyB64?: string) {
  return new ExecutorService(cfg(secretKeyB64), { store, runner: async () => { throw new Error("nenhum processo real nestes testes"); }, env: {} });
}
const body = <T,>(r: { body: unknown }) => r.body as T;

describe("secret-store: chave de API cifrada em repouso", () => {
  it("cifra e decifra de volta ao texto original", () => {
    const key = parseMachineKeyB64(randomMachineKeyB64());
    const box = encryptSecret(key, "sk-ant-segredo-de-teste-123");
    expect(decryptSecret(key, box)).toBe("sk-ant-segredo-de-teste-123");
    expect(serializeBox(box)).not.toContain("segredo-de-teste");
  });
  it("decifrar com outra chave falha (autenticação do GCM)", () => {
    const key1 = parseMachineKeyB64(randomMachineKeyB64());
    const key2 = parseMachineKeyB64(randomMachineKeyB64());
    const box = encryptSecret(key1, "segredo");
    expect(() => decryptSecret(key2, box)).toThrow();
  });
  it("um texto cifrado adulterado é recusado, não decifrado silenciosamente", () => {
    const key = parseMachineKeyB64(randomMachineKeyB64());
    const box = encryptSecret(key, "segredo");
    const tampered = parseBox(serializeBox({ ...box, data: box.data.slice(0, -4) + "AAAA" }));
    expect(() => decryptSecret(key, tampered)).toThrow();
  });
  it("last4 mostra só o final da chave", () => expect(last4("sk-ant-abcdef1234")).toBe("1234"));
});

describe("adaptador de API (Anthropic/OpenAI): uma chamada, sem ferramentas, sem múltiplos turnos", () => {
  const rec = (over: Partial<ApiConnectionRecord> = {}): ApiConnectionRecord => ({
    id: "r1", provider: "anthropic", label: "teste", model: "", effort: "", last4: "abcd", state: "unchecked", message: null, checkedAt: null, createdAt: new Date().toISOString(), ...over,
  });
  const call = { label: "x", system: "s", user: "u", schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } }, model: "", effort: "", timeoutMs: 5000, workDir: work };

  it("Anthropic: extrai o input da ferramenta forçada e mapeia o usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "tool_use", name: "emit_result", input: { ok: true } }],
      usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "tool_use",
    }), { status: 200 })));
    const r = await apiAdapter(rec(), "sk-ant-x").call(call);
    expect(r.output).toEqual({ ok: true });
    expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("Anthropic: chave recusada (HTTP 401) vira not_connected, não retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })));
    await expect(apiAdapter(rec(), "sk-ant-invalida").call(call)).rejects.toMatchObject({ code: "not_connected", retryable: false });
  });

  it("Anthropic: resposta cortada em max_tokens vira output_too_large, não retryable, com o usage parcial preservado", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [], usage: { input_tokens: 4, output_tokens: 8192 }, stop_reason: "max_tokens" }), { status: 200 })));
    let caught: AgentError | null = null;
    try { await apiAdapter(rec(), "sk-ant-x").call(call); } catch (e) { caught = e as AgentError; }
    expect(caught).toMatchObject({ code: "output_too_large", retryable: false });
    expect(caught?.usage).toMatchObject({ outputTokens: 8192 });
  });

  it("OpenAI: parseia o JSON do content e mapeia o usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }), { status: 200 })));
    const r = await apiAdapter(rec({ provider: "openai" }), "sk-x").call(call);
    expect(r.output).toEqual({ ok: true });
    expect(r.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it("OpenAI: limite de uso (HTTP 429) vira usage_limit, retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })));
    await expect(apiAdapter(rec({ provider: "openai" }), "sk-x").call(call)).rejects.toMatchObject({ code: "usage_limit", retryable: true });
  });

  it("recusa modo developer_write: esta versão não tem ferramenta de arquivo pela API", async () => {
    await expect(apiAdapter(rec(), "sk-x").call({ ...call, mode: "developer_write" })).rejects.toMatchObject({ code: "client_error" });
  });
});

describe("ExecutorService: conexões de API (CRUD) — a chave nunca sai do executor em texto puro", () => {
  it("cadastra e lista só o registro mascarado (sem secretJson, sem a chave)", async () => {
    const s = svc();
    const created = body<{ apiConnection: ApiConnectionRecord }>(await s.createApiConnection({ provider: "anthropic", label: "Minha chave", apiKey: "sk-ant-" + "x".repeat(20) }));
    expect(created.apiConnection).toMatchObject({ provider: "anthropic", label: "Minha chave", last4: "xxxx", state: "unchecked" });
    expect(JSON.stringify(created)).not.toContain("sk-ant-");
    const list = body<{ apiConnections: ApiConnectionRecord[] }>(await s.listApiConnections());
    expect(list.apiConnections.map(a => a.id)).toContain(created.apiConnection.id);
    expect(JSON.stringify(list)).not.toContain("sk-ant-");
  });

  it("recusa corpo inválido (provider, label ou apiKey ausentes/curtos)", async () => {
    const s = svc();
    expect((await s.createApiConnection({})).status).toBe(400);
    expect((await s.createApiConnection({ provider: "anthropic", label: "x", apiKey: "curta" })).status).toBe(400);
    expect((await s.createApiConnection({ provider: "outro", label: "x", apiKey: "x".repeat(20) })).status).toBe(400);
  });

  it("testar sessão (real, simulada): uma chamada mínima real; atualiza o estado guardado", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "emit_result", input: { ok: true } }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })));
    const s = svc();
    const created = body<{ apiConnection: ApiConnectionRecord }>(await s.createApiConnection({ provider: "anthropic", label: "x", apiKey: "sk-ant-" + "y".repeat(20) }));
    const r = body<{ ok: boolean; apiConnection: ApiConnectionRecord }>(await s.verifyApiConnection(created.apiConnection.id));
    expect(r.ok).toBe(true);
    expect(r.apiConnection.state).toBe("connected");
    const list = body<{ apiConnections: ApiConnectionRecord[] }>(await s.listApiConnections());
    expect(list.apiConnections[0].state).toBe("connected");
  });

  it("testar sessão com chave recusada marca o registro como inválido, sem derrubar o executor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })));
    const s = svc();
    const created = body<{ apiConnection: ApiConnectionRecord }>(await s.createApiConnection({ provider: "anthropic", label: "x", apiKey: "sk-ant-" + "z".repeat(20) }));
    const r = body<{ ok: boolean; apiConnection: ApiConnectionRecord }>(await s.verifyApiConnection(created.apiConnection.id));
    expect(r.ok).toBe(false);
    expect(r.apiConnection.state).toBe("invalid");
  });

  it("remove a conexão; ela some da listagem", async () => {
    const s = svc();
    const created = body<{ apiConnection: ApiConnectionRecord }>(await s.createApiConnection({ provider: "openai", label: "x", apiKey: "sk-" + "w".repeat(20) }));
    const del = body<{ removed: boolean }>(await s.deleteApiConnection(created.apiConnection.id));
    expect(del.removed).toBe(true);
    const list = body<{ apiConnections: ApiConnectionRecord[] }>(await s.listApiConnections());
    expect(list.apiConnections).toHaveLength(0);
  });

  it("duas execuções do serviço com a MESMA chave base64 (persistida) decifram a mesma chave salva pela outra", async () => {
    const keyB64 = randomMachineKeyB64();
    const s1 = svc(keyB64);
    const created = body<{ apiConnection: ApiConnectionRecord }>(await s1.createApiConnection({ provider: "anthropic", label: "x", apiKey: "sk-ant-persistente" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "emit_result", input: { ok: true } }], usage: {} }), { status: 200 })));
    // A second service instance (as if the executor restarted), same store and same machine key.
    const s2 = svc(keyB64);
    const r = body<{ ok: boolean }>(await s2.verifyApiConnection(created.apiConnection.id));
    expect(r.ok).toBe(true); // decrypts fine — proves the key round-trips across "restarts" sharing the same machine key
  });

  it("uma conexão de API é sempre segura para o Arquiteto/QA (somente leitura), mas nunca para o Desenvolvedor (sem ferramenta de arquivo)", async () => {
    const s = svc();
    const created = body<{ apiConnection: ApiConnectionRecord }>(await s.createApiConnection({ provider: "anthropic", label: "x", apiKey: "sk-ant-" + "v".repeat(20) }));
    const apiRef = `api:${created.apiConnection.id}`;
    const parsed = parseStartRequest(request({}, {}));
    if (!parsed.ok) throw new Error("fixture inválida");
    const plan = await store.create(buildNewRun(parsed.value));
    await store.update(plan.run.id, { status: "plan_ready", result: { outcome: "plan_ready", objective_summary: "x", context_understanding: "x", flow: { type: "short", rationale: "x", skipped_roles: [] }, questions: [], steps: [], tasks: [{ id: "t1", step_id: "s1", assignee: "developer", title: "x", scope: "x", inputs: "x", deliverable: "x", acceptance_criteria: [], depends_on: [] }], risks: [], assumptions: [], not_verified: [], limitations: [] } });
    const devAgent = member("developer", { connection: apiRef as never });
    const editScope = [{ path: "src/x.ts", action: "alterar" as const }];
    const parsedDev = DeveloperHandoffZ.safeParse({ idempotencyKey: "h:teste-dev-api-conexao", directorRunId: plan.run.id, taskId: "t1", agent: devAgent, editScope });
    expect(parsedDev.success).toBe(true);
    const r = await s.prepareDeveloper({ idempotencyKey: "h:teste-dev-api-conexao", directorRunId: plan.run.id, taskId: "t1", agent: devAgent, editScope });
    expect(body<{ error: { code: string } }>(r).error.code).toBe("adapter_not_write_restricted");
  });
});
