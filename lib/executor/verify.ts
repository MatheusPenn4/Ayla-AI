// "Verificar entrega aplicada": the step between "aplicado" and "validado". An application only says the files
// were written; this runs the project's own checks on EXACTLY that version (the target's HEAD plus the applied
// files, each checked by hash) in an isolated environment — never in the user's checkout — and only when every
// check passed it records the validated TaskCompletion (kind applied_run_result, linked to the application and
// to the original Developer run). Results are recorded either way; nothing is committed or published.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ApplicationRecord, ApplicationVerification, CommandEvidence, TestedVersion, Verification } from "@/lib/engine/types";
import { buildEnv, destroyEnv, prepareDependencies, projectChecks, resolvePackageManager, runEnvCommand, type EnvDeps, type QAEnv } from "./qa-env";
import { COMMAND_LABEL, parseCommandLine } from "./project-config";
import { getProject, loadExecPlan, type ProjectDeps } from "./projects";
import type { RunStore } from "./store";

export type VerifyDeps = { store: RunStore; projects: ProjectDeps; envDeps: EnvDeps; workRoot: string; artifactsRoot: string };

export function applicationVersion(app: ApplicationRecord, dirName: string): TestedVersion {
  return { kind: "commit_plus_files", projectId: app.projectId, dirName, commit: app.head, applicationId: app.id, files: app.files.map(f => ({ path: f.path, sha256: f.afterSha256 })), treeHash: null, label: `HEAD ${app.head.slice(0, 8)} + arquivos aplicados pela interface` };
}

export async function runVerification(appId: string, deps: VerifyDeps): Promise<ApplicationVerification> {
  const { store } = deps;
  const app = await store.getApplication(appId);
  if (!app) throw new Error("Aplicação não encontrada.");
  const started = new Date().toISOString();
  let v: ApplicationVerification = { status: "running", startedAt: started, finishedAt: null, version: null, checks: [], message: "Montando o ambiente isolado da versão aplicada…", completionId: null };
  const save = async (patch: Partial<ApplicationVerification>) => { v = { ...v, ...patch }; await store.setApplicationVerification(appId, v); return v; };
  await save({});
  let env: QAEnv | null = null;
  const artifactsDir = path.join(deps.artifactsRoot, appId);
  try {
    const project = await getProject(app.projectId, deps.projects);
    if (!project || project.problem) return await save({ status: "error", finishedAt: new Date().toISOString(), message: `Projeto indisponível: ${project?.problem ?? "não está mais autorizado no executor"}.` });
    const exec = await loadExecPlan(app.projectId, deps.projects);
    if (!exec) return await save({ status: "error", finishedAt: new Date().toISOString(), message: "Nada foi verificado: o projeto ainda não tem configuração de execução confirmada (Configurações → Conexões de IA → Projetos locais → Configurar execução)." });
    const { configured, notConfigured } = projectChecks(exec);
    const missing = notConfigured.map(id => COMMAND_LABEL[id]);
    await save({ notConfigured: missing });
    if (!configured.length) return await save({ status: "error", finishedAt: new Date().toISOString(), message: "Nada foi verificado: nenhuma verificação (tipos, lint, testes, build) está configurada para este projeto. Sem comando não há verificação — nada é dado como aprovado." });
    const version = applicationVersion(app, project.dirName);
    const files = app.files.filter(f => f.afterSha256).map(f => ({ path: f.path, content: readFileSync(path.join(project.dir, ...f.path.split("/"))) }));
    env = await buildEnv({ root: path.join(deps.workRoot, `verify-${appId}`), artifactsDir, sourceDir: project.dir, version, files }, deps.envDeps);
    await save({ version: env.version, message: `Ambiente pronto (árvore ${env.version.treeHash}); preparando dependências…` });
    const pm = resolvePackageManager(deps.envDeps, exec);
    if (!pm.ok) return await save({ status: "error", finishedAt: new Date().toISOString(), message: pm.detail });
    const prep = await prepareDependencies(env, exec, deps.envDeps);
    const checks: CommandEvidence[] = [prep.evidence, ...(prep.seed ? [prep.seed.evidence] : [])];
    await save({ checks: [...checks], message: prep.evidence.exitCode === 0 ? "Dependências prontas; rodando as verificações do projeto…" : "A preparação das dependências falhou." });
    if (deps.envDeps.signal?.aborted) return await save({ status: "canceled", finishedAt: new Date().toISOString(), message: "Verificação cancelada por você; os processos iniciados por ela foram encerrados." });
    if (prep.evidence.exitCode !== 0) return await save({ status: "failed", finishedAt: new Date().toISOString(), message: "A preparação das dependências falhou; nenhuma verificação foi rodada." });
    if (prep.seed && prep.seed.evidence.exitCode !== 0) return await save({ status: "failed", finishedAt: new Date().toISOString(), message: "A preparação dos dados de teste falhou; nenhuma verificação foi rodada." });
    const byId: Partial<Record<string, CommandEvidence>> = {};
    for (const chk of configured) {
      if (deps.envDeps.signal?.aborted) return await save({ status: "canceled", finishedAt: new Date().toISOString(), message: "Verificação cancelada por você; os processos iniciados por ela foram encerrados." });
      await save({ message: `Rodando ${chk.label}…` });
      const argv = parseCommandLine(chk.command, { manager: exec.config.packageManager });
      if (!argv.ok) return await save({ status: "error", finishedAt: new Date().toISOString(), message: `Comando de ${chk.label} inválido: ${argv.error}` });
      const r = await runEnvCommand(env, exec, chk.label, argv.argv, `verificacao-${chk.id}.log`, 900_000, deps.envDeps);
      byId[chk.id] = r.evidence;
      checks.push(r.evidence);
      await save({ checks: [...checks] });
    }
    if (deps.envDeps.signal?.aborted) return await save({ status: "canceled", finishedAt: new Date().toISOString(), message: "Verificação cancelada por você; os processos iniciados por ela foram encerrados." });
    const failed = checks.filter(c => c.exitCode !== 0);
    const nc = missing.length ? ` Não configurado (não conta como aprovado): ${missing.join(", ")}.` : "";
    if (failed.length) return await save({ status: "failed", finishedAt: new Date().toISOString(), message: `Falhou: ${failed.map(c => `${c.label} (código ${c.exitCode})`).join(", ")}. A entrega continua aplicada, mas NÃO validada.${nc}` });
    // Every check passed: the validated delivery is recorded, linked to this application and to the original run.
    const run = await store.get(app.runId);
    const plan = await store.get(app.planId);
    const toCheck = (c?: CommandEvidence): Verification["typecheck"] => (c ? { ran: true, command: c.command, result: `código de saída ${c.exitCode} em ${Math.round(c.durationMs / 1000)} s (log ${c.logArtifact}, ambiente isolado da árvore ${env!.version.treeHash?.slice(0, 12)})`, at: c.startedAt } : null);
    const completion = await store.recordTaskCompletion({
      demandId: plan?.demandId ?? run?.demandId ?? "", parentRunId: app.planId, taskId: app.taskId, kind: "applied_run_result", sourceRunId: app.runId,
      commit: app.head, files: app.files.map(f => f.path),
      verification: { typecheck: toCheck(byId.typecheck), lint: toCheck(byId.lint), tests: toCheck(byId.test), build: toCheck(byId.build) },
      note: `Diff da execução ${app.runId} aplicado pela interface ao projeto ${project.label} (aplicação ${app.id}, sem commit: o commit ${app.head.slice(0, 12)} é o HEAD do projeto no momento da aplicação) e verificado pelo executor num ambiente isolado dessa versão exata (HEAD + arquivos aplicados, conferidos por SHA-256; árvore ${env.version.treeHash}). Verificações configuradas do projeto: ${checks.slice(prep.seed ? 2 : 1).map(c => `${c.label} → código ${c.exitCode}`).join("; ")}.${nc}`,
      validatedBy: "orchestrator", validatedAt: new Date().toISOString(), applicationId: app.id,
    });
    return await save({ status: "passed", finishedAt: new Date().toISOString(), completionId: completion.id, message: `Todas as verificações configuradas passaram (${configured.length}). Entrega registrada como validada.${nc}` });
  } catch (e) {
    return await save({ status: deps.envDeps.signal?.aborted ? "canceled" : "error", finishedAt: new Date().toISOString(), message: deps.envDeps.signal?.aborted ? "Verificação cancelada por você; os processos iniciados por ela foram encerrados." : `Falha ao verificar: ${(e as Error).message}` });
  } finally {
    destroyEnv(env);
  }
}
