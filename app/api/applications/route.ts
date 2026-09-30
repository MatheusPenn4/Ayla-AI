import { executionGate, json } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** "Aplicar ao projeto local": the user's confirmation of one review (ids + review token + idempotency key only). */
export async function POST(request: Request) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const text = await request.text();
  if (text.length > 100_000) return json({ error: { code: "too_large", message: "Dados grandes demais." } }, 413);
  let body: unknown;
  try { body = JSON.parse(text || "{}"); } catch { return json({ error: { code: "invalid_body", message: "Corpo da requisição inválido." } }, 400); }
  const r = await callExecutor("/v1/applications", { method: "POST", body, timeoutMs: 90_000 });
  return json(r.body, r.status);
}
