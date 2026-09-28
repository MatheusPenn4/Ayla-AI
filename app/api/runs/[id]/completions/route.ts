import { json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** Every validated task-completion of one plan (evidence dependencyEvidence() accepts as "done"). */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: { code: "not_found", message: "Execução não encontrada." } }, 404);
  const r = await callExecutor(`/v1/runs/${id}/completions`);
  return json(r.body, r.status);
}
