// Pure rules of the autopilot (lib/engine/autopilot.ts) and of the Architect form defaults it shares with the
// interface (lib/engine/send-defaults.ts). No executor, no process.
import { describe, expect, it } from "vitest";
import { autopilotIneligibility, autopilotTimeline, costRatio, nextAutopilotStep, projectTokens, settledBrake } from "@/lib/engine/autopilot";
import { architectDefaults, defaultPick } from "@/lib/engine/send-defaults";
import type { SourceOptions } from "@/lib/engine/client";
import type { PlanTask, RunRecord, RunStatus } from "@/lib/engine/types";

const task = (id: string, assignee: string, depends_on: string[] = []): PlanTask => ({ id, step_id: "s1", assignee, title: id, scope: "", inputs: "", deliverable: "", acceptance_criteria: ["ok"], depends_on });
const run = (taskId: string, status: RunStatus, over: Partial<RunRecord> = {}): RunRecord => ({
  id: `${taskId}-${status}-0000-0000-000000000000`.slice(0, 36), kind: "architect_task", demandId: "d", agentId: "a", status, parentRunId: "p", taskId,
  connection: "claude_code", model: "", effort: "", createdAt: "", updatedAt: "", startedAt: null, finishedAt: null, leaseUntil: null, attempt: 0, snapshotHash: "h",
  budget: { sheetTokens: 0, estimatedInputTokens: 1000, calls: [], reportedTotalTokens: 4000, exceeded: false }, context: null, result: null, analysis: null, developer: null, qa: null, reviewer: null,
  rejectedDiff: null, localResolution: null, error: null, previousRunId: null, ...over,
});
const TASKS = [task("t1", "architect"), task("t2", "developer", ["t1"]), task("t3", "architect", ["t2"]), task("t4", "qa", ["t2"]), task("t5", "reviewer", ["t4"])];
const policy = { tasks: [{ id: "t1", assignee: "architect" as const, title: "t1" }, { id: "t4", assignee: "qa" as const, title: "t4" }, { id: "t5", assignee: "reviewer" as const, title: "t5" }] };

describe("elegibilidade e linha do tempo", () => {
  it("Desenvolvedor sempre manual; Arquiteto que depende de outra especialidade fica com você", () => {
    expect(autopilotIneligibility(TASKS[1], TASKS)).toContain("Desenvolvedor");
    expect(autopilotIneligibility(TASKS[2], TASKS)).toContain("só aceita dependências que sejam análises do Arquiteto");
    expect(autopilotIneligibility(TASKS[3], TASKS)).toBeNull();
    expect(autopilotTimeline(TASKS, ["t1", "t5"]).map(r => [r.taskId, r.mode])).toEqual([["t1", "auto"], ["t2", "manual"], ["t3", "manual"], ["t4", "excluded"], ["t5", "auto"]]);
  });
});

describe("próximo passo do supervisor", () => {
  const none = () => [];
  it("envia a primeira tarefa apta, espera uma execução em andamento e respeita envios aguardando você", () => {
    expect(nextAutopilotStep(policy, TASKS, none, none)).toMatchObject({ kind: "send", task: { id: "t1" } });
    const busy = (id: string) => (id === "t1" ? [run("t1", "planning")] : []);
    expect(nextAutopilotStep(policy, TASKS, busy, none)).toMatchObject({ kind: "busy", taskId: "t1" });
    const pending = (id: string) => (id === "t1" ? [run("t1", "awaiting_approval")] : []);
    expect(nextAutopilotStep(policy, TASKS, pending, none)).toMatchObject({ kind: "waiting_user", taskIds: ["t1"] });
  });

  it("depois do Arquiteto, aguarda o Desenvolvedor (você); com a implementação pronta, segue para o QA; com tudo pronto, conclui", () => {
    const afterT1 = (id: string) => (id === "t1" ? [run("t1", "analysis_ready")] : []);
    const w = nextAutopilotStep(policy, TASKS, afterT1, none);
    expect(w).toMatchObject({ kind: "waiting_user" });
    expect(w.kind === "waiting_user" && w.taskIds).toContain("t2");
    const afterDev = (id: string) => (id === "t1" ? [run("t1", "analysis_ready")] : id === "t2" ? [run("t2", "implementation_ready", { kind: "developer_task" })] : []);
    expect(nextAutopilotStep(policy, TASKS, afterDev, none)).toMatchObject({ kind: "send", task: { id: "t4" } });
    const all = (id: string) => ({ t1: [run("t1", "analysis_ready")], t2: [run("t2", "implementation_ready")], t4: [run("t4", "review_ready")], t5: [run("t5", "concluded")] } as Record<string, RunRecord[]>)[id] ?? [];
    expect(nextAutopilotStep(policy, TASKS, all, none)).toMatchObject({ kind: "concluded" });
  });

  it("D4: tarefa que já falhou ou foi cancelada não é reenviada", () => {
    const failed = (id: string) => (id === "t1" ? [run("t1", "failed")] : []);
    const s = nextAutopilotStep(policy, TASKS, failed, none);
    expect(s.kind).toBe("waiting_user");
    expect(s.kind === "waiting_user" && s.message).toContain("não é reenviada");
  });
});

describe("freios ao terminar e custo", () => {
  it("cada estado final vira o freio certo; concluída com uso informado segue", () => {
    expect(settledBrake(run("t1", "failed"), "architect")?.code).toBe("failed");
    expect(settledBrake(run("t1", "canceled"), "architect")?.code).toBe("canceled_by_user");
    expect(settledBrake(run("t1", "awaiting_clarification"), "architect")?.code).toBe("clarification");
    expect(settledBrake(run("t1", "analysis_ready", { budget: { sheetTokens: 0, estimatedInputTokens: 10, calls: [], reportedTotalTokens: null, exceeded: false } }), "architect")?.code).toBe("usage_unknown");
    expect(settledBrake(run("t1", "analysis_ready"), "architect")).toBeNull();
    expect(settledBrake(run("t1", "queued"), "architect")).toBeNull();
  });

  it("razão real/estimado: mediana do histórico, padrão 4, limitada a [1, 20]", () => {
    expect(costRatio([])).toEqual({ ratio: 4, samples: 0 });
    const h = (r: number) => ({ budget: { sheetTokens: 0, estimatedInputTokens: 1000, calls: [], reportedTotalTokens: r, exceeded: false } });
    expect(costRatio([h(3000), h(5000), h(4000)])).toEqual({ ratio: 4, samples: 3 });
    expect(costRatio([h(100_000)]).ratio).toBe(20);
    expect(projectTokens(1000, 3.5)).toBe(3500);
  });
});

describe("padrões do envio ao Arquiteto (iguais no formulário e no supervisor)", () => {
  const opts = (over: Partial<SourceOptions> = {}): SourceOptions => ({
    directorCommit: "a".repeat(40), owner: "o", repo: "r", dependencies: [], localRepos: [], comparisons: [], previous: null,
    proposed: { via: "github", commit: "a".repeat(40), why: "Commit que o Diretor leu." }, suggestedFiles: [], ...over,
  });
  it("commit do Diretor: sem motivo; commit proposto diferente: exige motivo (D1)", () => {
    expect(architectDefaults(opts())).toMatchObject({ source: { via: "github", commit: "a".repeat(40) }, changedFromDirector: false });
    expect(architectDefaults(opts({ proposed: { via: "local_git", commit: "b".repeat(40), why: "análise de t1" } }))).toMatchObject({ changedFromDirector: true, why: "análise de t1" });
  });
  it("arquivos sugeridos dentro dos limites; novo envio parte do anterior", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ ref: `src/f${i}.ts`, reason: "x" }));
    expect(architectDefaults(opts({ suggestedFiles: many })).files).toHaveLength(10);
    expect(Object.keys(defaultPick(["a.ts#A", "a.ts#B", "b.ts"]))).toEqual(["a.ts#A", "a.ts#B", "b.ts"]);
    const prev = { runId: "r".repeat(36), status: "failed", revision: 2, commit: "c".repeat(40), via: "local_git" as const, files: ["x.ts", "y.ts#Y"] };
    expect(architectDefaults(opts({ previous: prev }))).toMatchObject({ source: { via: "local_git", commit: "c".repeat(40) }, files: ["x.ts", "y.ts#Y"], changedFromDirector: true });
  });
});
