import { executionGate, json, readGate } from "@/lib/server/access";
import { callExecutor } from "@/lib/server/executor-client";

export const dynamic = "force-dynamic";

const badId = () => json({ error: { code: "not_found", message: "Projeto não encontrado." } }, 404);

/** The project's execution settings (variable names only, never values) plus what the executor detects in it. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = readGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) return badId();
  const wd = new URL(request.url).searchParams.get("workDir");
  const q = wd !== null && wd.length <= 200 ? `?workDir=${encodeURIComponent(wd)}` : "";
  const r = await callExecutor(`/v1/projects/${id}/config${q}`, { timeoutMs: 30_000 });
  return json(r.body, r.status);
}

/** Saves them; the executor validates every command and folder, requires the acknowledgement and encrypts the values. */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = executionGate(request);
  if (!gate.ok) return json({ error: { code: "forbidden", message: gate.reason } }, gate.status);
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) return badId();
  const text = await request.text();
  if (text.length > 100_000) return json({ error: { code: "too_large", message: "Dados grandes demais." } }, 413);
  let body: unknown;
  try { body = JSON.parse(text || "{}"); } catch { return json({ error: { code: "invalid_body", message: "Corpo da requisição inválido." } }, 400); }
  const r = await callExecutor(`/v1/projects/${id}/config`, { method: "PUT", body, timeoutMs: 30_000 });
  return json(r.body, r.status);
}
