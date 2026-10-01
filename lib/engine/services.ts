// The processes of the application under test, from a project's execution settings. Pure (no Node imports): used by
// the executor and by the settings editor in the browser.
import type { ProjectRunConfig, ProjectService } from "./types";

/**
 * Settings saved before multi-process support have no `services`: they mean ONE process made of `commands.dev` +
 * `app`, run in the package folder — so nothing has to be configured again. When `services` exists it is
 * authoritative (possibly empty = no application to start).
 */
export function servicesOf(c: Pick<ProjectRunConfig, "services" | "commands" | "app" | "workDir">): ProjectService[] {
  if (c.services) return c.services;
  if (!c.commands.dev.trim()) return [];
  return [{ id: "app", label: "Aplicação", dir: c.workDir, install: "", command: c.commands.dev, host: c.app.host, port: c.app.port, readyPath: c.app.readyPath, readyText: c.app.readyText, timeoutSec: c.app.timeoutSec, browser: true }];
}

export const mainServiceOf = (c: Pick<ProjectRunConfig, "services" | "commands" | "app" | "workDir" | "mainService">): ProjectService | null => {
  const list = servicesOf(c);
  return list.find(x => x.id === c.mainService) ?? list[0] ?? null;
};
