import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for pure logic (storage migration, profiles, integration payload).
// Kept separate from vite.config.ts so the Cloudflare/vinext plugins are not loaded.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)) } },
  // Several suites spawn real git/tar/node processes and isolated copies; running those files in parallel on
  // Windows makes individual tests race the default 5 s timeout. Files run one after another; tests keep a
  // generous per-test limit instead of silently hanging.
  test: { include: ["tests/**/*.test.ts"], environment: "node", fileParallelism: false, testTimeout: 20_000 },
});
