// Real detection check of the official clients (no model call, no login change).
// Usage: pnpm check:clients
// Prints the state the executor would report, plus two isolated scenarios that
// never touch your real login: an empty config folder ("disconnected") and an
// empty PATH ("not installed").
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectClaude, detectCodex, type ClientDeps } from "@/lib/executor/clients";
import { runProcess } from "@/lib/executor/proc";

const work = mkdtempSync(path.join(os.tmpdir(), "ayla-check-"));
const emptyClaude = mkdtempSync(path.join(os.homedir(), ".ayla-check-claude-"));
const emptyCodex = mkdtempSync(path.join(os.homedir(), ".ayla-check-codex-"));
const base: ClientDeps = { runner: runProcess, env: process.env, platform: process.platform, exists: existsSync, cwd: work, nodePath: process.execPath };
const show = (label: string, s: { state: string; version: string | null; account: string | null; message: string; models: unknown[] }) =>
  console.log(`${label.padEnd(34)} ${s.state.padEnd(14)} ${s.version ?? "-"} | ${s.account ?? "-"} | modelos: ${s.models.length} | ${s.message}`);

try {
  show("Claude Code (seu login)", await detectClaude(base));
  show("Codex CLI (seu login)", await detectCodex(base));
  show("Claude Code (config vazia)", await detectClaude({ ...base, env: { ...process.env, CLAUDE_CONFIG_DIR: emptyClaude } }));
  show("Codex CLI (config vazia)", await detectCodex({ ...base, env: { ...process.env, CODEX_HOME: emptyCodex } }));
  show("Claude Code (PATH vazio)", await detectClaude({ ...base, env: { ...process.env, PATH: work, Path: work } }));
  show("Codex CLI (PATH vazio)", await detectCodex({ ...base, env: { ...process.env, PATH: work, Path: work } }));
} finally {
  for (const d of [work, emptyClaude, emptyCodex]) rmSync(d, { recursive: true, force: true });
}
