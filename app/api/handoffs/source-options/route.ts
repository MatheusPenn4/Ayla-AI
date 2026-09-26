import { json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/**
 * Before “Enviar ao Arquiteto”: commits (the Director's, the dependency analyses', the authorized local
 * clone's HEAD) and suggested files, with a file-by-file comparison. Read-only: nothing is recorded.
 */
export async function GET(request: Request) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const url = new URL(request.url);
  const plan = url.searchParams.get("plan") ?? "", task = url.searchParams.get("task") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(plan) || !/^[A-Za-z0-9_-]{1,64}$/.test(task)) return json({ error: { code: "invalid_request", message: "Plano ou tarefa inválidos." } }, 400);
  const r = await callExecutor(`/v1/handoffs/source-options?plan=${plan}&task=${encodeURIComponent(task)}`, { timeoutMs: 30_000 });
  return json(r.body, r.status);
}
