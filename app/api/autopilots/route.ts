import { executionGate, json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/**
 * “Ativar piloto automático”, step 1: the executor validates the plan, the tasks and the sheets, and freezes the
 * policy (with its hash) for the user to confirm. Nothing is sent here (POST /api/autopilots/:id/approve).
 */
export async function POST(request: Request) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const text = await request.text();
  if (text.length > 400_000) return json({ error: { code: "too_large", message: "Dados grandes demais." } }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: { code: "invalid_body", message: "Corpo da requisição inválido." } }, 400); }
  const r = await callExecutor("/v1/autopilots", { method: "POST", body, timeoutMs: 30_000 });
  return json(r.body, r.status);
}

/** Policies of a plan (?plan=id) or of demands (?demands=a,b), newest first, plus the observed usage history. */
export async function GET(request: Request) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const q = new URL(request.url).searchParams;
  const plan = q.get("plan") ?? "";
  if (plan && !/^[0-9a-f-]{36}$/.test(plan)) return json({ error: { code: "invalid_request", message: "Plano inválido." } }, 400);
  const ids = (q.get("demands") ?? "").split(",").map(s => s.trim()).filter(s => /^[A-Za-z0-9_-]{1,64}$/.test(s)).slice(0, 200);
  const r = await callExecutor(plan ? `/v1/autopilots?plan=${plan}` : `/v1/autopilots?demands=${ids.join(",")}`);
  return json(r.body, r.status);
}
