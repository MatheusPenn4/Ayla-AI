import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for pure logic (storage migration, profiles, integration payload).
// Kept separate from vite.config.ts so the Cloudflare/vinext plugins are not loaded.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
