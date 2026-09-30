import { executionGate, json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

/** Authorized local projects (AYLA_LOCAL_REPOS + the ones registered here). */
export async function GET(request: Request) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const r = await callExecutor("/v1/projects");
  return json(r.body, r.status);
}

/** Registers a folder typed by the user; the executor validates it (absolute, the real top level of a Git repository) and returns an id. */
export async function POST(request: Request) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const text = await request.text();
  if (text.length > 100_000) return json({ error: { code: "too_large", message: "Dados grandes demais." } }, 413);
  let body: unknown;
  try { body = JSON.parse(text || "{}"); } catch { return json({ error: { code: "invalid_body", message: "Corpo da requisição inválido." } }, 400); }
  const r = await callExecutor("/v1/projects", { method: "POST", body, timeoutMs: 30_000 });
  return json(r.body, r.status);
}
