// Local Git projects the executor may work on: the folders listed in AYLA_LOCAL_REPOS plus the ones the user
// registered through the interface (Configurações → Projetos locais). This is the ONLY place a folder path
// coming from the browser is accepted, and only after the executor itself validated it (absolute, an existing
// directory, the real top level of a Git working tree, not a filesystem root). Every other request identifies
// a project by the id returned here — never by a path.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { LocalProject, ProjectRunConfig } from "@/lib/engine/types";
import type { ExecPlan } from "./qa-env";
import { parseOrigin, repoIdentity, runGit, type GitDeps } from "./local-git";
import type { RunStore } from "./store";

export type ProjectDeps = {
  store: RunStore; git: GitDeps; envDirs: string[];
  /** Decrypts a stored test-variable value (SecretBox JSON); only the executor holds the key. */
  decrypt?: (box: string) => string;
};

const win = (deps: GitDeps) => (deps.platform ?? process.platform) === "win32";
/** Canonical form used to compare two folder paths (case-insensitive on Windows, forward slashes, no trailing slash). */
export function canonicalDir(dir: string, windows = process.platform === "win32") {
  const p = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return windows ? p.toLowerCase() : p;
}
const envId = (dir: string) => `env-${createHash("sha256").update(canonicalDir(dir)).digest("hex").slice(0, 12)}`;

async function describe(base: { id: string; source: LocalProject["source"]; dir: string; label: string; createdAt: string | null }, deps: GitDeps): Promise<LocalProject> {
  const out: LocalProject = { ...base, dirName: path.basename(base.dir), owner: null, repo: null, head: null, headSubject: null, branch: null, dirty: null, problem: null };
  if (!existsSync(base.dir)) return { ...out, problem: "A pasta não existe mais neste computador." };
  if (!existsSync(path.join(base.dir, ".git"))) return { ...out, problem: "A pasta não é mais um repositório Git (sem .git)." };
  const id = await repoIdentity(base.dir, deps);
  const o = id.originUrl ? parseOrigin(id.originUrl) : null;
  if (o) { out.owner = o.owner; out.repo = o.repo; }
  if (id.head) { out.head = id.head; out.headSubject = id.subject; }
  out.branch = id.branch;
  const st = await runGit(deps, base.dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], { maxStdoutBytes: 8_000_000 });
  if (st.code === 0) out.dirty = st.stdout.split("\0").filter(x => /^.. /.test(x)).length;
  if (!out.head) out.problem = "Não foi possível ler o commit atual (HEAD) deste repositório.";
  else if (!o) out.problem = "O repositório não tem um remoto “origin” do GitHub; não dá para associá-lo às demandas.";
  return out;
}

type ProjectBase = { id: string; source: LocalProject["source"]; dir: string; label: string; createdAt: string | null };

/** The authorized folders with their ids, without running anything (AYLA_LOCAL_REPOS first, deduplicated by folder). */
async function projectBases(deps: ProjectDeps): Promise<ProjectBase[]> {
  const seen = new Set<string>();
  const out: ProjectBase[] = [];
  const add = (b: ProjectBase) => { const key = canonicalDir(b.dir, win(deps.git)); if (seen.has(key)) return; seen.add(key); out.push(b); };
  for (const dir of deps.envDirs) if (path.isAbsolute(dir)) add({ id: envId(dir), source: "env", dir, label: path.basename(dir), createdAt: null });
  for (const p of await deps.store.listLocalProjects()) add({ id: p.id, source: "ui", dir: p.dir, label: p.label, createdAt: p.createdAt });
  return out;
}

async function describeWithConfig(b: ProjectBase, deps: ProjectDeps) {
  const d = await describe(b, deps.git);
  d.runConfig = await runConfigView(b.id, deps);
  return d;
}

/** Every authorized project (AYLA_LOCAL_REPOS first, then the ones registered in the interface), deduplicated by folder. */
export async function listProjects(deps: ProjectDeps): Promise<LocalProject[]> {
  const out: LocalProject[] = [];
  for (const b of await projectBases(deps)) out.push(await describeWithConfig(b, deps));
  return out;
}

/**
 * Folders the readers/materializers may use: cheap (no git process) — each reader still checks the clone's
 * origin against the demand's repository before reading anything (local-git.ts, apply.ts, qa.ts).
 */
export async function authorizedDirs(deps: ProjectDeps): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...deps.envDirs, ...(await deps.store.listLocalProjects()).map(p => p.dir)]) {
    const key = canonicalDir(dir, win(deps.git));
    if (!path.isAbsolute(dir) || seen.has(key) || !existsSync(path.join(dir, ".git"))) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** The saved settings as the interface may see them: variable NAMES and whether a value is set — never the values. */
async function runConfigView(id: string, deps: ProjectDeps): Promise<ProjectRunConfig | null> {
  const saved = await deps.store.getProjectConfig(id);
  if (!saved) return null;
  return { ...saved.config, env: saved.config.env.map(e => ({ name: e.name, external: e.external, set: !!saved.secrets[e.name] })) };
}

/** What the isolated environments run for this project; null until the user confirmed the settings. */
export async function loadExecPlan(projectId: string, deps: ProjectDeps): Promise<ExecPlan | null> {
  const saved = await deps.store.getProjectConfig(projectId);
  if (!saved || !saved.config.acknowledgedAt) return null;
  const vars: Record<string, string> = {};
  for (const e of saved.config.env) {
    const box = saved.secrets[e.name];
    if (!box) continue;
    if (!deps.decrypt) throw new Error("Este executor não consegue ler as variáveis protegidas do projeto.");
    vars[e.name] = deps.decrypt(box);
  }
  return { config: saved.config, vars };
}

export async function getProject(id: string, deps: ProjectDeps): Promise<LocalProject | null> {
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{4,64}$/.test(id)) return null;
  // Only the requested project is described (describing every authorized folder costs git processes each).
  const b = (await projectBases(deps)).find(p => p.id === id);
  return b ? describeWithConfig(b, deps) : null;
}

export class ProjectRefused extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/**
 * Validates and registers a folder typed by the user. Refuses anything that is not the real top level of a
 * Git working tree: relative paths, missing folders, files, a filesystem root, a subfolder of a repository
 * (the top level is required so a path inside the diff can never climb above it) and links (the stored path
 * is the resolved real path, so a later change of a link cannot redirect the authorization).
 */
export async function registerProject(input: { dir?: unknown; label?: unknown }, deps: ProjectDeps): Promise<{ project: LocalProject; created: boolean }> {
  const raw = typeof input.dir === "string" ? input.dir.trim().replace(/^"(.*)"$/, "$1") : "";
  if (!raw || raw.length > 400 || raw.includes("\0")) throw new ProjectRefused(400, "invalid_dir", "Informe o caminho completo da pasta do projeto.");
  if (!path.isAbsolute(raw)) throw new ProjectRefused(400, "not_absolute", "Use o caminho completo (absoluto) da pasta, por exemplo C:\\Users\\voce\\Documents\\projeto.");
  let real: string;
  try {
    const st = statSync(raw);
    if (!st.isDirectory()) throw new ProjectRefused(400, "not_directory", "O caminho informado não é uma pasta.");
    real = realpathSync.native(raw);
  } catch (e) {
    if (e instanceof ProjectRefused) throw e;
    throw new ProjectRefused(404, "not_found", "A pasta informada não existe neste computador.");
  }
  if (path.parse(real).root.replace(/[\\/]+$/, "") === real.replace(/[\\/]+$/, "")) throw new ProjectRefused(400, "root_dir", "A raiz de um disco não pode ser cadastrada como projeto.");
  if (!existsSync(path.join(real, ".git"))) throw new ProjectRefused(400, "not_git", "A pasta não é a raiz de um repositório Git (não há .git nela).");
  const top = await runGit(deps.git, real, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new ProjectRefused(400, "not_git", "O Git não reconhece esta pasta como repositório.");
  if (canonicalDir(top.stdout.trim(), win(deps.git)) !== canonicalDir(real, win(deps.git))) throw new ProjectRefused(400, "not_toplevel", `Cadastre a raiz do repositório (${top.stdout.trim()}), não uma subpasta dela.`);
  const existing = (await listProjects(deps)).find(p => canonicalDir(p.dir, win(deps.git)) === canonicalDir(real, win(deps.git)));
  if (existing) return { project: existing, created: false };
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 80) : path.basename(real);
  const id = randomUUID();
  await deps.store.addLocalProject({ id, dir: real, label });
  const project = (await listProjects(deps)).find(p => p.id === id)!;
  return { project, created: true };
}

/** Only projects registered in the interface can be removed there (AYLA_LOCAL_REPOS is edited in .dev.vars). */
export async function removeProject(id: string, deps: ProjectDeps): Promise<boolean> {
  const p = await getProject(id, deps);
  if (!p || p.source !== "ui") return false;
  return deps.store.removeLocalProject(id);
}
