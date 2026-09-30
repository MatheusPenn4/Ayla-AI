// Isolated verification environment of ONE exact version (used by "Verificar entrega aplicada" and by the
// tool-equipped QA). Built by the executor, never by a model:
// - the code comes from `git archive` of a commit of an authorized project (never its working tree), plus —
//   when the version is "commit + patch" or "commit + applied files" — the persisted patch or the applied
//   files, checked by hash; the result is recorded as its own throwaway commit whose tree hash IS the id of
//   the tested version;
// - what runs there is the project's execution settings (project-config.ts), confirmed by the user: its own
//   package manager (npm or pnpm, from the lockfile), in its own folder, with the commands the user saved —
//   command lines run WITHOUT a shell; a check with no command is "não configurado", never a passing check;
// - dependencies come from the lockfile, offline first (local cache/store); the network is used only if that
//   fails, and only for that step (recorded);
// - no personal credentials: AYLA_* and token/key-like variables are dropped, home/AppData folders, the user's
//   .npmrc and global git config are replaced by empty ones inside the environment, the Claude Code / Codex
//   sessions are unreachable; only the variables configured for the project's TEST environment are added;
// - everything the executor starts here is stopped by it (and on cancellation).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ArtifactRef, CommandEvidence, ProjectRunConfig, TestedVersion } from "@/lib/engine/types";
import { resolveGit, type GitDeps } from "./local-git";
import { clientEnv, type BackgroundProcess, type BackgroundSpawner, type EnvVars } from "./proc";
import { parseCommandLine, type CommandKey } from "./project-config";
import { applyPatchInCopy, changedTrackedFiles, materializeCommit, snapshotCopy, type Materialized } from "./worktree";

export type EnvDeps = {
  git: GitDeps; spawnBg: BackgroundSpawner; nodePath: string; signal?: AbortSignal;
  /** Test hook: a controlled stand-in for the package manager named in it (the real one is resolved from PATH otherwise). */
  packageManager?: PackageManager;
};

export type QAEnv = {
  root: string; srcDir: string; hooksDir: string; tmpDir: string; artifactsDir: string; sourceDir: string;
  version: TestedVersion; fileCount: number;
};

/** The confirmed execution settings of the project, plus the decrypted values of its test variables. */
export type ExecPlan = { config: ProjectRunConfig; vars: Record<string, string> };

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

/** The user's real package caches (read by the installs; nothing personal lives there). */
function packageCaches(base: EnvVars) {
  const win = process.platform === "win32";
  const local = base.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return {
    npmCache: base.npm_config_cache ?? (win ? path.join(local, "npm-cache") : path.join(os.homedir(), ".npm")),
    pnpmStore: base.npm_config_store_dir ?? (win ? path.join(local, "pnpm", "store") : path.join(os.homedir(), ".local", "share", "pnpm", "store")),
  };
}

/**
 * What every process of the environment sees: no AYLA_*, no token/key-like variables, no client sessions,
 * home/AppData/.npmrc/global git config replaced by empty ones inside the environment, temp inside the
 * environment — plus ONLY the variables configured for this project's test environment.
 */
export function sandboxEnv(base: EnvVars, env: Pick<QAEnv, "tmpDir" | "sourceDir">, vars: Record<string, string> = {}): EnvVars {
  const out: EnvVars = {};
  for (const [k, v] of Object.entries(clientEnv(base))) {
    if (v === undefined || /^AYLA_/i.test(k) || SECRETISH.test(k) || /^(npm|pnpm)_config_/i.test(k)) continue;
    out[k] = v;
  }
  const caches = packageCaches(base);
  mkdirSync(env.tmpDir, { recursive: true });
  const home = path.join(env.tmpDir, "home");
  for (const d of ["", "AppData/Roaming", "AppData/Local"]) mkdirSync(path.join(home, ...d.split("/").filter(Boolean)), { recursive: true });
  const emptyRc = path.join(env.tmpDir, "vazio.npmrc"), emptyGit = path.join(env.tmpDir, "vazio.gitconfig");
  if (!existsSync(emptyRc)) writeFileSync(emptyRc, "");
  if (!existsSync(emptyGit)) writeFileSync(emptyGit, "");
  out.TEMP = env.tmpDir; out.TMP = env.tmpDir; out.TMPDIR = env.tmpDir;
  out.HOME = home; out.USERPROFILE = home; out.APPDATA = path.join(home, "AppData", "Roaming"); out.LOCALAPPDATA = path.join(home, "AppData", "Local");
  // The user's .npmrc may hold registry tokens; git's global config may hold credential helpers.
  out.NPM_CONFIG_USERCONFIG = emptyRc; out.npm_config_cache = caches.npmCache; out.npm_config_store_dir = caches.pnpmStore;
  out.GIT_CONFIG_GLOBAL = emptyGit; out.GIT_CONFIG_NOSYSTEM = "1"; out.GIT_TERMINAL_PROMPT = "0";
  // Empty folders instead of the user's Claude Code / Codex logins: nothing run here can reach those sessions.
  out.CLAUDE_CONFIG_DIR = path.join(env.tmpDir, "sem-sessao-claude");
  out.CODEX_HOME = path.join(env.tmpDir, "sem-sessao-codex");
  out.CI = "1"; out.NO_COLOR = "1"; out.BROWSER = "none"; out.FORCE_COLOR = "0";
  // Setor IA keeps its pnpm store inside the checkout (pnpm-workspace.yaml: storeDir ${SITES_PNPM_SHARED_STORE:-...}).
  const store = path.join(env.sourceDir, ".sites-runtime", "pnpm-store");
  if (existsSync(store)) out.SITES_PNPM_SHARED_STORE = store;
  for (const [k, v] of Object.entries(vars)) out[k] = v;
  return out;
}

// ---- tools (package manager, npx, node) ---------------------------------------------------------------

export type PackageManager = { ok: true; name: string; command: string; prefix: string[]; detail: string } | { ok: false; name: string; detail: string };
export type ToolName = "npm" | "pnpm" | "npx" | "node";

/** A tool resolved without a shell: .cmd shims are never executed, their JS entry is run by node directly. */
export function resolveTool(name: ToolName, deps: EnvDeps): PackageManager {
  if (deps.packageManager && deps.packageManager.name === name) return deps.packageManager;
  if (name === "node") return { ok: true, name, command: deps.nodePath, prefix: [], detail: `node ${process.version}` };
  const win = (deps.git.platform ?? process.platform) === "win32";
  const dirs = (deps.git.env.PATH ?? deps.git.env.Path ?? "").split(win ? ";" : ":").map(d => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const pkg = name === "pnpm" ? "pnpm" : "npm";
  const entries = name === "pnpm" ? ["node_modules/pnpm/bin/pnpm.mjs", "node_modules/pnpm/bin/pnpm.cjs"] : [`node_modules/npm/bin/${name}-cli.js`];
  for (const d of dirs) {
    for (const entry of entries) {
      const p = path.join(d, ...entry.split("/"));
      if (existsSync(path.join(d, win ? `${name}.cmd` : name)) && existsSync(p)) return { ok: true, name, command: deps.nodePath, prefix: [p], detail: `${name} via ${p}` };
    }
    if (!win && existsSync(path.join(d, name))) return { ok: true, name, command: path.join(d, name), prefix: [], detail: `${name} em ${d}` };
  }
  return { ok: false, name, detail: `${name} não encontrado no PATH do executor (instale ${pkg} neste computador).` };
}

/** The package manager of a configured project, or why it cannot be used. */
export function resolvePackageManager(deps: EnvDeps, plan: ExecPlan | null): PackageManager {
  if (!plan) return { ok: false, name: "—", detail: "O projeto ainda não tem configuração de execução confirmada (Configurações → Conexões de IA → Projetos locais → Configurar execução)." };
  return resolveTool(plan.config.packageManager, deps);
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
export const CHECK_IDS: CheckId[] = ["typecheck", "lint", "test", "build"];
export const CHECK_LABEL: Record<CheckId, string> = { typecheck: "Tipos", lint: "Lint", test: "Testes automatizados", build: "Build" };

/** The folder the project's commands run in (the configured package folder of the isolated copy). */
export function execDir(env: Pick<QAEnv, "srcDir">, plan: ExecPlan) { return path.join(env.srcDir, ...plan.config.workDir.split("/").filter(Boolean)); }

/** The project's configured checks; the missing ones are returned apart ("não configurado", never passing). */
export function projectChecks(plan: ExecPlan | null): { configured: { id: CheckId; label: string; command: string }[]; notConfigured: CheckId[] } {
  if (!plan) return { configured: [], notConfigured: [...CHECK_IDS] };
  const configured = CHECK_IDS.filter(id => plan.config.commands[id].trim()).map(id => ({ id, label: CHECK_LABEL[id], command: plan.config.commands[id].trim() }));
  return { configured, notConfigured: CHECK_IDS.filter(id => !plan.config.commands[id].trim()) };
}

export function commandArgv(plan: ExecPlan, key: CommandKey, port?: number): string[] {
  const p = parseCommandLine(plan.config.commands[key], { manager: plan.config.packageManager, allowPort: key === "dev" });
  if (!p.ok) throw new Error(`Comando de ${key} inválido: ${p.error}`);
  return port === undefined ? p.argv : p.argv.map(a => a.replaceAll("{port}", String(port)));
}

/** Runs one command line (already split, first word = tool) in the project's folder of the environment; records everything. */
export async function runEnvCommand(env: QAEnv, plan: ExecPlan, label: string, argv: string[], logName: string, timeoutMs: number, deps: EnvDeps): Promise<{ evidence: CommandEvidence; artifact: ArtifactRef }> {
  const started = Date.now();
  const cwd = execDir(env, plan);
  const tool = resolveTool(argv[0] as ToolName, deps);
  const shown = argv.join(" ");
  const res = tool.ok
    ? await deps.git.runner({ command: tool.command, args: [...tool.prefix, ...argv.slice(1)], cwd, env: sandboxEnv(deps.git.env, env, plan.vars), timeoutMs, signal: deps.signal, maxStdoutBytes: 12_000_000, maxStderrBytes: 2_000_000 })
    : { code: null, stdout: "", stderr: tool.detail, timedOut: false, aborted: false, spawnError: tool.detail };
  const durationMs = Date.now() - started;
  const log = [
    `$ ${shown}`, `diretório: ${cwd}`, `versão: ${env.version.label} (árvore ${env.version.treeHash ?? "?"})`,
    `variáveis do ambiente de teste: ${Object.keys(plan.vars).join(", ") || "nenhuma"} (valores não registrados)`,
    `início: ${new Date(started).toISOString()}  duração: ${durationMs} ms  código de saída: ${res.code}${res.timedOut ? "  (tempo esgotado)" : ""}${res.aborted ? "  (cancelado)" : ""}${res.spawnError ? `  erro ao iniciar: ${res.spawnError}` : ""}`,
    "", "--- stdout ---", redact(res.stdout, plan.vars), "", "--- stderr ---", redact(res.stderr, plan.vars),
  ].join("\n");
  const artifact = writeArtifact(env.artifactsDir, logName, log, "log", `Log completo: ${label}`);
  const tail = redact(`${res.stdout}\n${res.stderr}`, plan.vars).replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-3000);
  return {
    artifact,
    evidence: { label, command: shown, cwd, exitCode: res.code, durationMs, startedAt: new Date(started).toISOString(), timedOut: res.timedOut, canceled: res.aborted, logArtifact: artifact.name, tail },
  };
}

/** Configured values never reach a log, even if the project prints them. */
function redact(text: string, vars: Record<string, string>) {
  let t = text;
  for (const v of Object.values(vars)) if (v.length >= 4) t = t.split(v).join("[valor de variável configurada omitido]");
  return t;
}

const isDefaultInstall = (argv: string[]) => argv.join(" ") === "npm ci" || argv.join(" ") === "pnpm install --frozen-lockfile";

/**
 * Installs dependencies with the configured command, from the lockfile. For the standard frozen installs
 * (npm ci / pnpm install --frozen-lockfile) it tries offline first, from the local cache/store; the network is
 * used only when that fails, and only here — never while the tests run. Then the optional test-data step.
 */
export async function prepareDependencies(env: QAEnv, plan: ExecPlan, deps: EnvDeps): Promise<{ evidence: CommandEvidence; artifacts: ArtifactRef[]; network: string; seed: { evidence: CommandEvidence; artifact: ArtifactRef } | null }> {
  const argv = commandArgv(plan, "install");
  const cache = plan.config.packageManager === "npm" ? "cache local do npm" : "store local do pnpm";
  let out: { evidence: CommandEvidence; artifacts: ArtifactRef[]; network: string };
  if (isDefaultInstall(argv)) {
    const off = await runEnvCommand(env, plan, "Preparação das dependências (lockfile, offline)", [...argv, "--offline"], "deps-install-offline.log", 600_000, deps);
    if (off.evidence.exitCode === 0 || off.evidence.canceled) out = { evidence: off.evidence, artifacts: [off.artifact], network: `Dependências instaladas sem rede, do ${cache}, pelo lockfile.` };
    else {
      const on = await runEnvCommand(env, plan, "Preparação das dependências (lockfile, com rede)", [...argv, "--prefer-offline"], "deps-install-network.log", 900_000, deps);
      out = { evidence: on.evidence, artifacts: [off.artifact, on.artifact], network: "A instalação sem rede falhou; a rede foi usada somente nesta etapa de preparação (registro de pacotes), pelo lockfile." };
    }
  } else {
    const r = await runEnvCommand(env, plan, "Preparação das dependências (comando configurado)", argv, "deps-install.log", 900_000, deps);
    out = { evidence: r.evidence, artifacts: [r.artifact], network: "Comando de instalação configurado pelo usuário (pode usar a rede nesta etapa)." };
  }
  let seed: { evidence: CommandEvidence; artifact: ArtifactRef } | null = null;
  if (out.evidence.exitCode === 0 && plan.config.commands.seed.trim() && !deps.signal?.aborted) seed = await runEnvCommand(env, plan, "Preparação dos dados de teste", commandArgv(plan, "seed"), "dados-de-teste.log", 600_000, deps);
  return { ...out, seed };
}

// ---- the application under test ------------------------------------------------------------------------

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); const p = typeof a === "object" && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}

async function portInUse(port: number) {
  return new Promise<boolean>(resolve => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(false)));
  });
}

export type RunningApp = { url: string; proc: BackgroundProcess; stop: () => Promise<string> };

/** Starts the configured dev server and waits until the configured readiness condition holds. */
export async function startApp(env: QAEnv, plan: ExecPlan, deps: EnvDeps): Promise<RunningApp> {
  const a = plan.config.app;
  if (!plan.config.commands.dev.trim()) throw new Error("O projeto não tem servidor de desenvolvimento configurado.");
  const port = a.port ?? await freePort();
  if (a.port && await portInUse(a.port)) throw new Error(`A porta configurada ${a.port} já está em uso neste computador; a aplicação em teste não foi iniciada (feche o que a usa ou deixe a porta vazia para uma porta livre).`);
  const argv = commandArgv(plan, "dev", port);
  const tool = resolveTool(argv[0] as ToolName, deps);
  if (!tool.ok) throw new Error(tool.detail);
  const proc = deps.spawnBg({ command: tool.command, args: [...tool.prefix, ...argv.slice(1)], cwd: execDir(env, plan), env: { ...sandboxEnv(deps.git.env, env, plan.vars), PORT: String(port) }, signal: deps.signal });
  const url = `http://${a.host}:${port}`;
  const started = Date.now();
  const limit = a.timeoutSec * 1000;
  let exited = false, last = "sem resposta";
  void proc.exited.then(() => { exited = true; });
  while (Date.now() - started < limit) {
    if (deps.signal?.aborted) { await proc.stop(); throw new Error("Cancelado."); }
    if (exited) break;
    try {
      const r = await fetch(url + a.readyPath, { signal: AbortSignal.timeout(20_000) });
      const body = a.readyText ? await r.text() : "";
      last = `HTTP ${r.status}${a.readyText && !body.includes(a.readyText) ? ` sem o texto “${a.readyText}”` : ""}`;
      if (r.status < 400 && (!a.readyText || body.includes(a.readyText))) break;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 700));
  }
  if (exited || Date.now() - started >= limit) {
    const out = redact(proc.output(), plan.vars);
    writeArtifact(env.artifactsDir, "app-server.log", out, "log", "Saída do servidor da aplicação em teste (não ficou pronto)");
    await proc.stop();
    throw new Error(`A aplicação em teste não ficou pronta em ${url}${a.readyPath} (${exited ? "o processo terminou" : `tempo esgotado em ${a.timeoutSec} s`}; última resposta: ${last}). Saída: ${out.slice(-600)}`);
  }
  return {
    url, proc,
    stop: async () => {
      writeArtifact(env.artifactsDir, "app-server.log", redact(proc.output(), plan.vars), "log", "Saída do servidor da aplicação em teste");
      await proc.stop();
      return `servidor da aplicação em teste (porta ${port}) encerrado`;
    },
  };
}

/** Has git in PATH (for the tooling status). */
export const gitAvailable = (deps: GitDeps) => !!resolveGit(deps);
