// Server-only configuration of the web app. The only secret is the local
// executor token (in .dev.vars, gitignored), read from process.env and never
// returned to the browser. Account logins are never here: they stay inside the
// official clients on this computer.
import "server-only";

export function serverConfig() {
  const env = process.env;
  return {
    executor: {
      url: env.AYLA_EXECUTOR_URL?.trim() || "http://127.0.0.1:4317",
      token: env.AYLA_EXECUTOR_TOKEN?.trim() || "",
    },
  };
}

/** True only in a development server (vinext/Vite dev or `next dev`). Production builds are always false. */
export function isDevServer() {
  const viteDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  return viteDev || process.env.NODE_ENV === "development";
}
