import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/**
 * “Enviar ao QA”, step 1: the executor checks every dependency of the task (transitively, real evidence
 * only) and freezes the exact content, returning it for review. No model is called until the user approves
 * (POST /api/runs/:id/approve).
 */
export async function POST(request: Request) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const text = await request.text();
  if (text.length > 300_000) return json({ error: { code: "too_large", message: "Dados grandes demais." } }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: { code: "invalid_body", message: "Corpo da requisição inválido." } }, 400); }
  const r = await callExecutor("/v1/qa-handoffs", { method: "POST", body, timeoutMs: 45_000 });
  return json(r.body, r.status);
}
