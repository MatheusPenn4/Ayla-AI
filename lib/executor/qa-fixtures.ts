// Read-only fixture the QA browser serves INSTEAD of the real executor when the application under test is the
// Setor IA itself: the records of this one demand (plan, task runs, validated completions, applications),
// frozen from the store at execution time, plus the demand in the office's own localStorage format so the
// page can open it. Status says execution is disabled; the browser layer (qa-browser.ts) answers every
// non-GET with 403 anyway, so nothing in the QA browser can reach an agent.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DirectorSnapshot, EngineStatus } from "@/lib/engine/types";
import type { AppFixture } from "./qa-browser";
import type { RunStore } from "./store";

export const QA_FIXTURE_NOTE = "Ambiente de QA isolado: ações que executariam ou aprovariam agentes estão bloqueadas; os dados mostrados são uma cópia somente leitura dos registros desta demanda.";

/** The office's storage key, read from the tested version itself (so a renamed key is noticed, not assumed). */
function officeStorageKey(srcDir: string): string | null {
  const f = path.join(srcDir, "lib", "office", "storage.ts");
  if (!existsSync(f)) return null;
  const m = /STORAGE_V2\s*=\s*"([^"]+)"/.exec(readFileSync(f, "utf8"));
  return m ? m[1] : null;
}

export async function buildSetorIaFixture(store: RunStore, planId: string, srcDir: string): Promise<AppFixture | null> {
  const key = officeStorageKey(srcDir);
  const plan = await store.detail(planId);
  if (!key || !plan) return null;
  const snap = plan.snapshot as DirectorSnapshot;
  const d = snap.demand;
  const demand = {
    id: d.id, title: d.title, description: d.description, acceptanceCriteria: d.acceptanceCriteria, project: d.project, priority: d.priority,
    recipient: "director", source: d.source, sourceLabel: d.repo?.url ?? d.folder?.name ?? "", fileCount: d.folder?.fileCount ?? 0,
    ...(d.repo ? { repo: d.repo } : {}), status: "prepared", createdAt: plan.createdAt,
  };
  const runs = await store.listForDemands([d.id]);
  const api: Record<string, unknown> = {};
  api["GET /api/runs"] = { runs };
  for (const r of runs) {
    const det = await store.detail(r.id);
    if (det) api[`GET /api/runs/${r.id}`] = { run: det };
    if (r.kind === "director_plan") {
      api[`GET /api/runs/${r.id}/completions`] = { completions: await store.taskCompletionsForPlan(r.id) };
      api[`GET /api/runs/${r.id}/applications`] = { applications: await store.applicationsForPlan(r.id) };
    }
  }
  const status: EngineStatus = {
    executor: { reachable: true, message: null, version: "ambiente de QA" },
    executionEnabled: false, disabledReason: QA_FIXTURE_NOTE,
    store: { ok: true, kind: "fixture", path: null, message: null },
    connections: {}, apiConnections: [], github: { mode: "public-only", tokenConfigured: false },
    limits: { maxRunsPerHour: 0, maxConcurrentRuns: 0, callTimeoutMs: 0 },
    executableAgents: ["director"], handoffTargets: [], readOnly: {}, localRepos: [], projects: [],
  };
  api["GET /api/engine/status"] = status;
  return { localStorage: { [key]: JSON.stringify({ version: 2, agents: [], demands: [demand] }) }, api, note: QA_FIXTURE_NOTE };
}
