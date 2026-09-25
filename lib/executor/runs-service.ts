// Validation of input and assembly of a run, done by the executor (never
// trusted from the browser). Sheets live in the browser today, so their data is
// accepted as *configuration* only: it cannot choose who runs (only the
// Director in this phase), hand-offs are restricted to the submitted team, and
// run state belongs to the executor.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunBudget, RunDetail, StartRunRequest } from "@/lib/engine/types";
import type { NewRun } from "./store";

const s = (max: number) => z.string().max(max);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const MemberZ = z.object({
  id, name: s(40), role: s(50), specialty: s(2000),
  connection: z.enum(["claude_code", "codex", "none"]),
  modelName: z.string().max(80).regex(/^[A-Za-z0-9._\-[\]]*$/, "nome de modelo com caracteres inválidos"),
  effort: z.string().max(12).regex(/^[a-z]*$/, "nível de esforço inválido"),
  budget: z.number().finite(), handoffTo: z.array(id).max(20), returnTo: z.array(z.string().max(64)).max(20),
  maxCycles: z.number().int().min(1).max(10).nullable(), tools: z.record(z.boolean()),
  brief: s(40000), playbook: z.record(s(12000)), limits: s(8000), deliverable: s(8000), rules: s(8000),
});

const StartZ = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/),
  directorId: id,
  previousRunId: z.string().uuid().optional(),
  answers: z.array(z.object({ question: s(2000), answer: s(4000) })).max(10).optional(),
  team: z.array(MemberZ).min(1).max(16),
  demand: z.object({
    id, title: s(200).min(1), description: s(20000), acceptanceCriteria: z.array(s(2000)).max(30), project: s(120),
    priority: z.enum(["baixa", "normal", "alta"]), source: z.enum(["github", "folder", "none"]),
    repo: z.object({ url: s(300), owner: s(60), repo: s(120), branch: s(200) }).optional(),
    folder: z.object({ name: s(200), fileCount: z.number().int().min(0), totalBytes: z.number().min(0), topExtensions: z.array(z.tuple([s(40), z.number()])).max(10), hasPackageJson: z.boolean(), hasGitDir: z.boolean() }).optional(),
  }),
});

export type Validated = { ok: true; value: StartRunRequest } | { ok: false; errors: string[] };

export function parseStartRequest(body: unknown): Validated {
  const r = StartZ.safeParse(body);
  if (!r.success) return { ok: false, errors: r.error.issues.slice(0, 10).map(i => `${i.path.join(".")}: ${i.message}`) };
  const v = r.data as StartRunRequest;
  if (!v.team.some(m => m.id === v.directorId)) return { ok: false, errors: ["O Diretor não está na equipe enviada."] };
  if (!v.demand.title.trim()) return { ok: false, errors: ["A demanda precisa de um título."] };
  const director = v.team.find(m => m.id === v.directorId)!;
  if (director.connection === "none") return { ok: false, errors: ["Escolha a conexão do Diretor na ficha (aba Perfil): Claude via Claude Code ou ChatGPT Business via Codex."] };
  if (!EXECUTABLE_AGENTS.includes(v.directorId)) return { ok: false, errors: ["Nesta fase só o Diretor inicia execuções. O Arquiteto executa apenas uma tarefa do Diretor aprovada por você; Desenvolvedor, QA e Revisor aparecem apenas como responsáveis propostos."] };
  return { ok: true, value: v };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Collaborators that start runs by themselves in this phase (the Architect runs only through an approved hand-off). */
export const EXECUTABLE_AGENTS = ["director"];

/** Freezes what the Director will receive; later sheet edits never change this run. */
export function buildNewRun(req: StartRunRequest): NewRun {
  const teamIds = req.team.map(m => m.id);
  const director = { ...req.team.find(m => m.id === req.directorId)! };
  director.handoffTo = director.handoffTo.filter(t => teamIds.includes(t) && t !== director.id);
  const budget: RunBudget = { sheetTokens: Math.max(0, Math.floor(director.budget)), estimatedInputTokens: null, calls: [], reportedTotalTokens: null, exceeded: false };
  const demand = { ...req.demand };
  const snapshot: RunDetail["snapshot"] = {
    director,
    team: req.team.map(({ id, name, role, specialty, connection }) => ({ id, name, role, specialty, connection })),
    demand,
    answers: req.answers?.length ? req.answers : null,
  };
  return {
    id: randomUUID(), demandId: demand.id, agentId: director.id, idempotencyKey: req.idempotencyKey,
    connection: director.connection as NewRun["connection"],
    model: director.modelName.trim(), effort: director.effort.trim(),
    snapshotHash: sha256(JSON.stringify(snapshot)), snapshot, budget, previousRunId: req.previousRunId ?? null,
  };
}
