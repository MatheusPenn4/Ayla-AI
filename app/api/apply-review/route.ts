import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** "Revisar alterações": everything to check before applying a Developer diff to a local project. Writes nothing. */
export async function GET(request: Request) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const u = new URL(request.url);
  const run = u.searchParams.get("run") ?? "", project = u.searchParams.get("project") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(run) || !/^[A-Za-z0-9-]{4,64}$/.test(project)) return json({ error: { code: "invalid_request", message: "Execução ou projeto inválido." } }, 400);
  const r = await callExecutor(`/v1/apply-review?run=${run}&project=${project}`, { timeoutMs: 60_000 });
  return json(r.body, r.status);
}
