// Runs the operations a tool-equipped QA asked for, inside its isolated environment, and turns every result
// into numbered evidence authored by the executor. Nothing here edits the tested code: reads are confined to
// the version's own tracked files (real path checked), commands are catalog scripts, the browser is the
// controlled one (qa-browser.ts). An operation whose tool is missing becomes a failed evidence with the
// concrete reason, so QA classifies it as not_verified instead of guessing.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { OperationRequest } from "@/lib/engine/qa-tooled-schema";
import type { QAEvidence, QAToolingStatus } from "@/lib/engine/types";
import { relPathProblem } from "./apply";
import { findBrowser, loadPlaywright, runScenario, type AppFixture, type BrowserStep } from "./qa-browser";
import { CHECK_LABEL, checkCatalog, resolvePackageManager, runEnvCommand, startApp, writeArtifact, type EnvDeps, type PackageManager, type QAEnv, type RunningApp } from "./qa-env";
import { canonicalDir } from "./projects";

export type OpsContext = {
  env: QAEnv;
  pm: PackageManager;
  deps: EnvDeps;
  tracked: string[];
  fixture: AppFixture | null;
  tooling: QAToolingStatus;
  versionLabel: string;
  nextId: () => string;
  /** Started once, on the first browser operation; stopped by the caller. */
  app: { current: RunningApp | null; error: string | null };
};

const TEXT_EXT = /\.(tsx?|jsx?|mjs|cjs|json|md|css|scss|html|ya?ml|txt|toml|sql|sh|ps1|env\.example)$/i;

/** Detects, for real, what a tool-equipped QA can use on this computer (git, the package manager, a browser + playwright-core). */
export async function detectQATooling(deps: EnvDeps, projectDir: string | null, reproducible: boolean): Promise<QAToolingStatus> {
  const gitOk = !!deps.git && (await import("./local-git")).resolveGit(deps.git) !== null;
  const pm = resolvePackageManager(deps, projectDir);
  const browser = findBrowser(deps.git.env as NodeJS.ProcessEnv);
  const pw = await loadPlaywright();
  let hasDev = false;
  if (projectDir) { try { hasDev = !!JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")).scripts?.dev; } catch { /* no package.json */ } }
  const browserOk = !!browser && !!pw;
  const why = !reproducible ? "a versão entregue não pôde ser identificada/reproduzida (ex.: diff cortado ou redigido)" : "";
  return {
    checkedAt: new Date().toISOString(),
    git: { ok: gitOk, detail: gitOk ? "git encontrado no PATH do executor" : "git não encontrado" },
    packageManager: { ok: pm.ok, name: pm.name, detail: pm.detail },
    browser: { ok: browserOk, detail: browserOk ? `${browser!.name} instalado, controlado por playwright-core ${pw!.version} (sem baixar navegador)` : !pw ? "playwright-core não disponível para o executor" : "nenhum Edge/Chrome instalado encontrado", engine: pw ? `playwright-core ${pw.version}` : null, executable: browser?.executable ?? null },
    operations: [
      { id: "read", label: "Ler arquivos da versão testada", available: reproducible && gitOk, how: reproducible && gitOk ? "Leitura pelo executor, só dos arquivos versionados da versão testada (caminho real conferido)." : why || "git indisponível" },
      { id: "search", label: "Buscar texto nos arquivos", available: reproducible && gitOk, how: reproducible && gitOk ? "Busca literal pelo executor nos arquivos versionados." : why || "git indisponível" },
      { id: "commands", label: "Rodar verificações do projeto", available: reproducible && gitOk && pm.ok, how: !reproducible ? why : !pm.ok ? pm.detail : "Scripts do próprio projeto (tipos, lint, testes, build) pelo pnpm, no ambiente isolado, com log, duração e código de saída." },
      { id: "browser", label: "Navegador automatizado", available: reproducible && gitOk && pm.ok && browserOk && hasDev, how: !reproducible ? why : !pm.ok ? pm.detail : !browserOk ? (!pw ? "playwright-core não disponível" : "nenhum Edge/Chrome instalado") : !hasDev ? "o projeto não tem script dev para subir a aplicação" : `Aplicação em teste subida no ambiente isolado e usada num ${browser!.name} headless com perfil temporário, só na origem da aplicação, com dados simulados somente leitura.` },
    ],
  };
}

const available = (ctx: OpsContext, id: QAToolingStatus["operations"][number]["id"]) => ctx.tooling.operations.find(o => o.id === id);

function base(ctx: OpsContext, op: OperationRequest, round: number, method: QAEvidence["method"]): Omit<QAEvidence, "steps" | "command" | "observed" | "ok" | "artifacts"> {
  return { id: ctx.nextId(), method, criteria: op.criteria.filter(n => n > 0 && n < 50), purpose: op.purpose || op.type, requestedBy: "qa", round, version: ctx.versionLabel, author: "executor", origin: `Operação ${op.id || op.type} pedida pelo QA na rodada ${round}, executada pelo executor local no ambiente isolado.` };
}

function readConfined(ctx: OpsContext, rel: string): { text: string } | { error: string } {
  const bad = relPathProblem(rel);
  if (bad) return { error: `caminho recusado: ${bad}` };
  if (!ctx.tracked.includes(rel)) return { error: "o arquivo não existe na versão testada (não está entre os arquivos versionados)" };
  const abs = path.join(ctx.env.srcDir, ...rel.split("/"));
  if (!existsSync(abs)) return { error: "o arquivo não existe na cópia isolada" };
  const real = realpathSync.native(abs);
  if (!(canonicalDir(real) + "/").startsWith(canonicalDir(realpathSync.native(ctx.env.srcDir)) + "/")) return { error: "o caminho resolve para fora da versão testada" };
  if (statSync(real).size > 2_000_000) return { error: "arquivo grande demais para leitura (mais de 2 MB)" };
  return { text: readFileSync(real, "utf8") };
}

/** Automatic orientation evidence (executor-authored, checks no criterion): what each control of the first screen opens. Null when the browser is unavailable. */
export async function runOrientation(ctx: OpsContext): Promise<QAEvidence | null> {
  if (!available(ctx, "browser")?.available || !ctx.pm.ok || !ctx.tooling.browser.executable || !ctx.fixture) return null;
  const b = { id: ctx.nextId(), method: "browser" as const, criteria: [], purpose: "Orientação da interface: o que cada clicável da tela inicial abre (não verifica nenhum critério; serve para montar os caminhos dos cenários)", requestedBy: "executor" as const, round: 0, version: ctx.versionLabel, author: "executor" as const, origin: "Produzida automaticamente pelo executor antes da primeira chamada ao QA (orientação, não verificação)." };
  if (!ctx.app.current && !ctx.app.error) {
    try { ctx.app.current = await startApp(ctx.env, ctx.pm, ctx.deps); }
    catch (e) { ctx.app.error = (e as Error).message; }
  }
  if (!ctx.app.current) return { ...b, steps: [], command: null, ok: false, artifacts: [], observed: `A aplicação em teste não subiu: ${ctx.app.error}` };
  const res = await runScenario({ appUrl: ctx.app.current.url, name: "orientacao", steps: [], explore: { maxClicks: 24 }, fixture: ctx.fixture, artifactsDir: ctx.env.artifactsDir, executable: ctx.tooling.browser.executable, signal: ctx.deps.signal, evidenceId: b.id });
  return { ...b, steps: ["abrir / e, para cada clicável da tela inicial, recarregar, clicar e registrar o que abriu"], command: null, ok: res.ok, artifacts: res.artifacts, observed: `Navegador ${ctx.tooling.browser.detail.split(",")[0]} ${res.browserVersion}, perfil temporário, aplicação em ${ctx.app.current.url}.\n${res.steps[0]?.observed ?? res.observed}\nRequisições /api: ${res.api.servedFromFixture} atendidas por dados simulados, ${res.api.blocked} bloqueadas (escrita/execução), ${res.api.notFound} sem dado simulado; ${res.api.externalBlocked} requisição(ões) a outras origens bloqueada(s).` };
}

export async function runOperation(ctx: OpsContext, op: OperationRequest, round: number): Promise<QAEvidence> {
  const unavailable = (method: QAEvidence["method"], id: "read" | "search" | "commands" | "browser"): QAEvidence => ({
    ...base(ctx, op, round, method), steps: [`${op.type} pedido`], command: null, ok: false, artifacts: [],
    observed: `Ferramenta indisponível nesta execução: ${available(ctx, id)?.how ?? "não verificada"}. Nada foi executado.`,
  });
  if (op.type === "read_file") {
    if (!available(ctx, "read")?.available) return unavailable("inspection", "read");
    const r = readConfined(ctx, op.path);
    const b = base(ctx, op, round, "inspection");
    if ("error" in r) return { ...b, steps: [`ler ${op.path}`], command: null, ok: false, artifacts: [], observed: `Leitura recusada: ${r.error}.` };
    const lines = r.text.replace(/\r\n/g, "\n").split("\n");
    const from = Math.max(1, op.start_line || 1), to = Math.min(lines.length, op.end_line || lines.length);
    let body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}| ${l}`).join("\n");
    const cut = body.length > 16_000;
    if (cut) body = body.slice(0, 16_000);
    const art = writeArtifact(ctx.env.artifactsDir, `${b.id}-${op.path.replace(/\//g, "_")}.txt`, body, "text", `Trecho lido: ${op.path} (linhas ${from}-${to})`);
    return { ...b, steps: [`ler ${op.path} linhas ${from}-${to} (de ${lines.length})`], command: null, ok: true, artifacts: [art], observed: `${op.path}, linhas ${from}-${to} de ${lines.length}${cut ? " (cortado em 16.000 caracteres)" : ""}:\n${body}` };
  }
  if (op.type === "search") {
    if (!available(ctx, "search")?.available) return unavailable("inspection", "search");
    const b = base(ctx, op, round, "inspection");
    const hits: string[] = [];
    for (const f of ctx.tracked) {
      if (!TEXT_EXT.test(f) || hits.length >= 60) continue;
      const r = readConfined(ctx, f);
      if ("error" in r) continue;
      r.text.replace(/\r\n/g, "\n").split("\n").forEach((l, i) => { if (hits.length < 60 && l.includes(op.query)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 200)}`); });
    }
    const art = writeArtifact(ctx.env.artifactsDir, `${b.id}-busca.txt`, hits.join("\n") || "(nenhuma ocorrência)", "text", `Busca por “${op.query}”`);
    return { ...b, steps: [`buscar “${op.query}” nos arquivos versionados`], command: null, ok: true, artifacts: [art], observed: hits.length ? `${hits.length}${hits.length >= 60 ? "+" : ""} ocorrência(s):\n${hits.join("\n")}` : "Nenhuma ocorrência." };
  }
  if (op.type === "run_check" || op.type === "run_tests") {
    if (!available(ctx, "commands")?.available || !ctx.pm.ok) return unavailable("command", "commands");
    const b = base(ctx, op, round, "command");
    let args: string[] | null = null, label = "";
    if (op.type === "run_check") {
      const c = checkCatalog(ctx.env.srcDir).find(x => x.id === op.check);
      if (c) { args = c.args; label = CHECK_LABEL[c.id]; }
    } else {
      const bad = op.test_files.filter(f => relPathProblem(f) || !ctx.tracked.includes(f) || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
      if (!bad.length && checkCatalog(ctx.env.srcDir).some(x => x.id === "test")) { args = ["run", "test", ...op.test_files]; label = `Testes: ${op.test_files.join(", ")}`; }
      else return { ...b, steps: [`rodar testes ${op.test_files.join(", ")}`], command: null, ok: false, artifacts: [], observed: `Recusado: ${bad.length ? `arquivo(s) de teste inexistente(s) na versão testada ou fora do padrão *.test/*.spec: ${bad.join(", ")}` : "o projeto não tem script de testes"}.` };
    }
    if (!args) return { ...b, steps: [`rodar ${op.check}`], command: null, ok: false, artifacts: [], observed: `O projeto não tem a verificação “${op.check}” (package.json).` };
    const { evidence, artifact } = await runEnvCommand(ctx.env, ctx.pm, label, args, `${b.id}-${op.type}.log`, 900_000, ctx.deps);
    return { ...b, steps: [evidence.command], command: evidence, ok: evidence.exitCode !== null && !evidence.timedOut && !evidence.canceled, artifacts: [artifact], observed: `Código de saída ${evidence.exitCode}${evidence.timedOut ? " (tempo esgotado)" : ""}. Final da saída:\n${evidence.tail}` };
  }
  // browser
  if (!available(ctx, "browser")?.available || !ctx.pm.ok || !ctx.tooling.browser.executable) return unavailable("browser", "browser");
  const b = base(ctx, op, round, "browser");
  if (!ctx.fixture) return { ...b, steps: [], command: null, ok: false, artifacts: [], observed: "Sem dados simulados para a aplicação em teste: o navegador não foi aberto (nada seria mostrado sem chamar o executor real)." };
  if (!ctx.app.current && !ctx.app.error) {
    try { ctx.app.current = await startApp(ctx.env, ctx.pm, ctx.deps); }
    catch (e) { ctx.app.error = (e as Error).message; }
  }
  if (!ctx.app.current) return { ...b, steps: [], command: null, ok: false, artifacts: [], observed: `A aplicação em teste não subiu: ${ctx.app.error}` };
  const steps = op.steps as BrowserStep[];
  const res = await runScenario({ appUrl: ctx.app.current.url, name: op.scenario_name || op.id || "cenario", steps, fixture: ctx.fixture, artifactsDir: ctx.env.artifactsDir, executable: ctx.tooling.browser.executable, signal: ctx.deps.signal, evidenceId: b.id });
  return {
    ...b, steps: res.steps.map(s => `${s.index}. ${s.action} ${s.args}`.trim()), command: null, ok: res.ok, artifacts: res.artifacts,
    observed: `Navegador ${ctx.tooling.browser.detail.split(",")[0]} ${res.browserVersion}, perfil temporário, aplicação em ${ctx.app.current.url}.\n${res.observed}\nRequisições /api: ${res.api.servedFromFixture} atendidas por dados simulados, ${res.api.blocked} bloqueadas (escrita/execução), ${res.api.notFound} sem dado simulado; ${res.api.externalBlocked} requisição(ões) a outras origens bloqueada(s).${res.consoleErrors.length ? `\nErros de console: ${res.consoleErrors.slice(0, 6).join(" | ")}` : ""}`,
  };
}
