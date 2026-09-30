// Isolated verification environment of ONE exact version (used by "Verificar entrega aplicada" and by the
// tool-equipped QA). Built by the executor, never by a model:
// - the code comes from `git archive` of a commit of an authorized project (never its working tree), plus —
//   when the version is "commit + patch" or "commit + applied files" — the persisted patch or the applied
//   files, checked by hash; the result is recorded as its own throwaway commit whose tree hash IS the id of
//   the tested version;
// - dependencies are prepared by the project's own package manager from its lockfile (frozen), offline first
//   from the local store; the network is used only if that fails, and only for that step (recorded);
// - commands are the project's own package scripts, chosen by name from a fixed catalog (never a free
//   command line), with directory, duration, exit code and full log recorded;
// - no credentials: AYLA_* variables, tokens, keys, provider sessions (Claude Code / Codex config folders)
//   and the executor's own .dev.vars never reach it; temp files go to the environment's own tmp folder;
// - everything the executor starts here is stopped by it (and on cancellation).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ArtifactRef, CommandEvidence, TestedVersion } from "@/lib/engine/types";
import { resolveGit, type GitDeps } from "./local-git";
import { clientEnv, type BackgroundProcess, type BackgroundSpawner, type EnvVars } from "./proc";
import { applyPatchInCopy, changedTrackedFiles, materializeCommit, snapshotCopy, type Materialized } from "./worktree";

export type EnvDeps = {
  git: GitDeps; spawnBg: BackgroundSpawner; nodePath: string; signal?: AbortSignal;
  /** Test hook: a controlled stand-in for the package manager (the real one is resolved from PATH otherwise). */
  packageManager?: PackageManager;
};

export type QAEnv = {
  root: string; srcDir: string; hooksDir: string; tmpDir: string; artifactsDir: string; sourceDir: string;
  version: TestedVersion; fileCount: number;
};

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

// ---- artifacts -------------------------------------------------------------------------------------

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const safeArtifactName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 100) || "artefato";
export const isArtifactName = (s: string) => ARTIFACT_NAME.test(s) && !s.includes("..");

export function writeArtifact(dir: string, name: string, content: string | Buffer, kind: ArtifactRef["kind"], label: string): ArtifactRef {
  mkdirSync(dir, { recursive: true });
  let n = safeArtifactName(name);
  for (let i = 2; existsSync(path.join(dir, n)); i++) n = safeArtifactName(name.replace(/(\.[A-Za-z0-9]+)?$/, `-${i}$1`));
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  writeFileSync(path.join(dir, n), buf);
  return { name: n, kind, bytes: buf.length, sha256: sha(buf), label };
}

// ---- environment variables ---------------------------------------------------------------------------

const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY|SESSION|COOKIE)/i;

/** What every process of the environment sees: no AYLA_*, no token/key-like variables, no client sessions, temp inside the environment. */
export function sandboxEnv(base: EnvVars, env: Pick<QAEnv, "tmpDir" | "sourceDir">): EnvVars {
  const out: EnvVars = {};
  for (const [k, v] of Object.entries(clientEnv(base))) {
    if (v === undefined || /^AYLA_/i.test(k) || SECRETISH.test(k)) continue;
    out[k] = v;
  }
  mkdirSync(env.tmpDir, { recursive: true });
  out.TEMP = env.tmpDir; out.TMP = env.tmpDir; out.TMPDIR = env.tmpDir;
  // Empty folders instead of the user's Claude Code / Codex logins: nothing run here can reach those sessions.
  out.CLAUDE_CONFIG_DIR = path.join(env.tmpDir, "sem-sessao-claude");
  out.CODEX_HOME = path.join(env.tmpDir, "sem-sessao-codex");
  out.CI = "1"; out.NO_COLOR = "1"; out.BROWSER = "none"; out.FORCE_COLOR = "0";
  // This project keeps its pnpm store inside the checkout (pnpm-workspace.yaml: storeDir ${SITES_PNPM_SHARED_STORE:-...}).
  const store = path.join(env.sourceDir, ".sites-runtime", "pnpm-store");
  if (existsSync(store)) out.SITES_PNPM_SHARED_STORE = store;
  return out;
}

// ---- package manager ---------------------------------------------------------------------------------

export type PackageManager = { ok: true; name: "pnpm"; command: string; prefix: string[]; detail: string } | { ok: false; name: string; detail: string };

/** pnpm, resolved without a shell (the .cmd shim is never executed: its JS entry is run by node directly). */
export function resolvePackageManager(deps: EnvDeps, projectDir: string | null): PackageManager {
  if (deps.packageManager) return deps.packageManager;
  const win = (deps.git.platform ?? process.platform) === "win32";
  if (projectDir && !existsSync(path.join(projectDir, "pnpm-lock.yaml"))) return { ok: false, name: "desconhecido", detail: "O projeto não tem pnpm-lock.yaml; nesta versão só o pnpm (com lockfile) é suportado." };
  const dirs = (deps.git.env.PATH ?? deps.git.env.Path ?? "").split(win ? ";" : ":").map(d => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const d of dirs) {
    for (const entry of ["node_modules/pnpm/bin/pnpm.mjs", "node_modules/pnpm/bin/pnpm.cjs"]) {
      const p = path.join(d, ...entry.split("/"));
      if (existsSync(path.join(d, win ? "pnpm.cmd" : "pnpm")) && existsSync(p)) return { ok: true, name: "pnpm", command: deps.nodePath, prefix: [p], detail: `pnpm via ${p}` };
    }
    if (!win && existsSync(path.join(d, "pnpm"))) return { ok: true, name: "pnpm", command: path.join(d, "pnpm"), prefix: [], detail: `pnpm em ${d}` };
  }
  return { ok: false, name: "pnpm", detail: "pnpm não encontrado no PATH do executor." };
}

// ---- building the environment ------------------------------------------------------------------------

/**
 * Materializes `version` from `sourceDir` into `root/src` and records it. `patch` is the persisted diff for a
 * commit_plus_patch version; `files` the applied contents for commit_plus_files (each checked by hash).
 */
export async function buildEnv(opts: { root: string; artifactsDir: string; sourceDir: string; version: TestedVersion; patch?: string; files?: { path: string; content: Buffer }[] }, deps: EnvDeps): Promise<QAEnv> {
  const { root, version } = opts;
  rmSync(root, { recursive: true, force: true });
  const srcDir = path.join(root, "src"), tmpDir = path.join(root, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const m: Materialized = await materializeCommit({ sourceDir: opts.sourceDir, commit: version.commit, workDir: srcDir }, deps.git);
  if (version.kind === "commit_plus_patch") {
    if (!opts.patch || sha(opts.patch) !== version.patchSha256) throw new Error("O diff entregue não corresponde ao hash registrado para esta versão.");
    await applyPatchInCopy(m, opts.patch, deps.git);
  } else if (version.kind === "commit_plus_files") {
    for (const f of version.files) {
      const given = opts.files?.find(x => x.path === f.path);
      const dest = path.join(srcDir, ...f.path.split("/"));
      if (f.sha256 === null) { rmSync(dest, { force: true }); continue; }
      if (!given || sha(given.content) !== f.sha256) throw new Error(`O conteúdo de ${f.path} não é mais o que foi aplicado (hash diferente): a versão aplicada não pode ser reproduzida.`);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, given.content);
    }
  }
  const treeHash = await snapshotCopy(m, `versão testada (${version.label})`, deps.git);
  return { root, srcDir, hooksDir: m.hooksDir, tmpDir, artifactsDir: opts.artifactsDir, sourceDir: opts.sourceDir, version: { ...version, treeHash }, fileCount: m.fileCount };
}

export async function deliveryChanges(env: QAEnv, deps: EnvDeps) {
  return changedTrackedFiles({ workDir: env.srcDir, hooksDir: env.hooksDir }, deps.git);
}

export function destroyEnv(env: Pick<QAEnv, "root"> | null) {
  if (!env) return "nenhum ambiente criado";
  for (let i = 0; i < 3; i++) {
    try { rmSync(env.root, { recursive: true, force: true, maxRetries: 3 }); return "ambiente isolado removido"; } catch { /* retried below */ }
  }
  return `não foi possível remover totalmente ${env.root} (arquivos em uso); removido na próxima limpeza`;
}

// ---- commands ----------------------------------------------------------------------------------------

export type CheckId = "typecheck" | "lint" | "test" | "build";
export const CHECK_LABEL: Record<CheckId, string> = { typecheck: "Tipos (TypeScript)", lint: "Lint", test: "Testes automatizados", build: "Build" };

/** The project's own verification commands, by name, from package.json (never a free command line). */
export function checkCatalog(srcDir: string): { id: CheckId; args: string[] }[] {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(readFileSync(path.join(srcDir, "package.json"), "utf8")); } catch { return []; }
  const s = pkg.scripts ?? {};
  const out: { id: CheckId; args: string[] }[] = [];
  if (s.typecheck) out.push({ id: "typecheck", args: ["run", "typecheck"] });
  else if (existsSync(path.join(srcDir, "tsconfig.json")) && (pkg.devDependencies?.typescript || pkg.dependencies?.typescript)) out.push({ id: "typecheck", args: ["exec", "tsc", "--noEmit"] });
  for (const id of ["lint", "test", "build"] as const) if (s[id]) out.push({ id, args: ["run", id] });
  return out;
}

export async function runEnvCommand(env: QAEnv, pm: Extract<PackageManager, { ok: true }>, label: string, args: string[], logName: string, timeoutMs: number, deps: EnvDeps): Promise<{ evidence: CommandEvidence; artifact: ArtifactRef }> {
  const started = Date.now();
  const res = await deps.git.runner({ command: pm.command, args: [...pm.prefix, ...args], cwd: env.srcDir, env: sandboxEnv(deps.git.env, env), timeoutMs, signal: deps.signal, maxStdoutBytes: 12_000_000, maxStderrBytes: 2_000_000 });
  const durationMs = Date.now() - started;
  const log = [
    `$ ${pm.name} ${args.join(" ")}`, `diretório: ${env.srcDir}`, `versão: ${env.version.label} (árvore ${env.version.treeHash ?? "?"})`,
    `início: ${new Date(started).toISOString()}  duração: ${durationMs} ms  código de saída: ${res.code}${res.timedOut ? "  (tempo esgotado)" : ""}${res.aborted ? "  (cancelado)" : ""}${res.spawnError ? `  erro ao iniciar: ${res.spawnError}` : ""}`,
    "", "--- stdout ---", res.stdout, "", "--- stderr ---", res.stderr,
  ].join("\n");
  const artifact = writeArtifact(env.artifactsDir, logName, log, "log", `Log completo: ${label}`);
  const tail = `${res.stdout}\n${res.stderr}`.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-3000);
  return {
    artifact,
    evidence: { label, command: `${pm.name} ${args.join(" ")}`, cwd: env.srcDir, exitCode: res.code, durationMs, startedAt: new Date(started).toISOString(), timedOut: res.timedOut, canceled: res.aborted, logArtifact: artifact.name, tail },
  };
}

/**
 * Installs dependencies from the lockfile (frozen), offline from the local store first. Network is used only
 * when the offline attempt fails, and only here — never while the tests run.
 */
export async function prepareDependencies(env: QAEnv, pm: Extract<PackageManager, { ok: true }>, deps: EnvDeps): Promise<{ evidence: CommandEvidence; artifacts: ArtifactRef[]; network: string }> {
  const off = await runEnvCommand(env, pm, "Preparação das dependências (lockfile, offline)", ["install", "--frozen-lockfile", "--offline"], "deps-install-offline.log", 600_000, deps);
  if (off.evidence.exitCode === 0 || off.evidence.canceled) return { evidence: off.evidence, artifacts: [off.artifact], network: "Dependências instaladas sem rede, do store local do pnpm, pelo lockfile congelado." };
  const on = await runEnvCommand(env, pm, "Preparação das dependências (lockfile, com rede)", ["install", "--frozen-lockfile", "--prefer-offline"], "deps-install-network.log", 900_000, deps);
  return { evidence: on.evidence, artifacts: [off.artifact, on.artifact], network: "A instalação sem rede falhou; a rede foi usada somente nesta etapa de preparação (registro do pacote), pelo lockfile congelado." };
}

// ---- the application under test ------------------------------------------------------------------------

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); const p = typeof a === "object" && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}

export type RunningApp = { url: string; proc: BackgroundProcess; stop: () => Promise<string> };

/** Starts the project's own "dev" script on a free port and waits until it answers. */
export async function startApp(env: QAEnv, pm: Extract<PackageManager, { ok: true }>, deps: EnvDeps): Promise<RunningApp> {
  let pkg: { scripts?: Record<string, string> } = {};
  try { pkg = JSON.parse(readFileSync(path.join(env.srcDir, "package.json"), "utf8")); } catch { /* checked below */ }
  if (!pkg.scripts?.dev) throw new Error("O projeto não tem script “dev” para subir a aplicação em teste.");
  const port = await freePort();
  const proc = deps.spawnBg({ command: pm.command, args: [...pm.prefix, "run", "dev", "--port", String(port)], cwd: env.srcDir, env: sandboxEnv(deps.git.env, env), signal: deps.signal });
  const url = `http://localhost:${port}`;
  const started = Date.now();
  let exited = false;
  void proc.exited.then(() => { exited = true; });
  while (Date.now() - started < 120_000) {
    if (deps.signal?.aborted) { await proc.stop(); throw new Error("Cancelado."); }
    if (exited) break;
    try { const r = await fetch(url + "/", { signal: AbortSignal.timeout(20_000) }); if (r.status < 500) break; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 700));
  }
  if (exited || Date.now() - started >= 120_000) {
    const out = proc.output();
    await proc.stop();
    throw new Error(`A aplicação em teste não respondeu (${exited ? "o processo terminou" : "tempo esgotado"}). Saída: ${out.slice(-600)}`);
  }
  return {
    url, proc,
    stop: async () => {
      writeArtifact(env.artifactsDir, "app-server.log", proc.output(), "log", "Saída do servidor da aplicação em teste");
      await proc.stop();
      return `servidor da aplicação em teste (porta ${port}) encerrado`;
    },
  };
}

/** Has git in PATH (for the tooling status). */
export const gitAvailable = (deps: GitDeps) => !!resolveGit(deps);
