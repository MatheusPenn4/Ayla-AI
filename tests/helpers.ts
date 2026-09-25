// Shared fixtures for the engine tests. Everything here is a test double:
// no official client and no network is involved unless a test says so.
import type { ConnectionStatus, DirectorPlan, StartRunRequest, TeamMemberInput } from "@/lib/engine/types";
import { AgentError, type AgentAdapter, type AgentCall, type AgentReply } from "@/lib/executor/adapters/types";

export const member = (id: string, extra: Partial<TeamMemberInput> = {}): TeamMemberInput => ({
  id, name: id, role: "papel", specialty: "", connection: "claude_code", modelName: "", effort: "", budget: 16000, handoffTo: [], returnTo: [], maxCycles: null,
  tools: { read: true, github: true }, brief: `# ${id}\nMissão do ${id}.`, playbook: {}, limits: "", deliverable: "", rules: "", ...extra,
});

export function request(over: Partial<StartRunRequest> = {}, demandOver: Partial<StartRunRequest["demand"]> = {}): StartRunRequest {
  return {
    idempotencyKey: `k-${Math.random().toString(36).slice(2, 12)}`,
    directorId: "director",
    team: [member("director", { handoffTo: ["developer", "qa"] }), member("developer", { connection: "codex" }), member("qa"), member("reviewer", { connection: "none" })],
    demand: { id: "d1", title: "Trocar cor do botão", description: "O botão salvar deve ficar azul.", acceptanceCriteria: ["Botão azul"], project: "P", priority: "normal", source: "none", ...demandOver },
    ...over,
  };
}

export const goodPlan = (over: Partial<DirectorPlan> = {}): DirectorPlan => ({
  outcome: "plan_ready", objective_summary: "Deixar o botão salvar azul.", context_understanding: "Só a descrição.",
  flow: { type: "short", rationale: "Mudança local.", skipped_roles: ["architect"] }, questions: [],
  steps: [{ id: "s1", title: "Implementar", owner: "developer", depends_on: [], done_when: "Botão azul" }, { id: "s2", title: "Verificar", owner: "qa", depends_on: ["s1"], done_when: "Critério verificado" }],
  tasks: [
    { id: "t1", step_id: "s1", assignee: "developer", title: "Alterar estilo", scope: "CSS do botão", inputs: "Demanda", deliverable: "Diff", acceptance_criteria: ["Botão azul"], depends_on: [] },
    { id: "t2", step_id: "s2", assignee: "qa", title: "Conferir", scope: "Tela de edição", inputs: "Versão", deliverable: "Relatório", acceptance_criteria: ["Evidência"], depends_on: ["t1"] },
  ],
  risks: [], assumptions: [], not_verified: ["Nada executado"], ...over,
});

export const connected = (id: "claude_code" | "codex" = "claude_code", over: Partial<ConnectionStatus> = {}): ConnectionStatus => ({
  id, client: id === "claude_code" ? "Claude Code" : "Codex CLI", state: "connected", version: "teste", account: id === "claude_code" ? "Claude Team" : "ChatGPT",
  message: "Conectado (dublê de teste).", steps: [], checkedAt: new Date().toISOString(), models: [], modelsSource: null, efforts: [], ...over,
});

export const usage = (input = 1200, output = 800) => ({ label: "x", inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, model: "modelo-informado" });

type Step = AgentReply | AgentError | ((c: AgentCall) => Promise<AgentReply>);
/** Scripted adapter: each call consumes one step. Records what it received. */
export function fakeAdapter(script: Step[], id: "claude_code" | "codex" = "claude_code") {
  const calls: AgentCall[] = [];
  const adapter: AgentAdapter = {
    id,
    async call(c) {
      calls.push(c);
      const next = script.shift();
      if (!next) throw new Error("script vazio");
      if (next instanceof AgentError) throw next;
      if (typeof next === "function") return next(c);
      return next;
    },
  };
  return { adapter, calls };
}

export const reply = (body: unknown, u: ReturnType<typeof usage> | null = usage()): AgentReply => ({
  output: typeof body === "string" ? (() => { try { return JSON.parse(body); } catch { return null; } })() : body,
  text: typeof body === "string" ? body : JSON.stringify(body),
  usage: u,
});
