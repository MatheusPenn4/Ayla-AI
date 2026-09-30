import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for pure logic (storage migration, profiles, integration payload).
// Kept separate from vite.config.ts so the Cloudflare/vinext plugins are not loaded.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)) } },
  // Several suites spawn real git/tar/npm/node processes and isolated copies (~80–100 ms per process on
  // Windows). Files run one after another so those processes do not compete; the default 5 s per test stays,
  // and only the integration suites that really build repositories/copies declare their own measured limit
  // (describe(..., { timeout })), so a genuinely stuck test still fails fast everywhere else.
  test: { include: ["tests/**/*.test.ts"], environment: "node", fileParallelism: false },
});
