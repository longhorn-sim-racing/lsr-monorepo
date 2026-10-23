import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit tests: no database, no network. Prisma and Resend are replaced with fakes in each test.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // scripts/: the eval harness's own tests (scripts/jack-eval)
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
    // Some tests import whole module graphs (the tool and job registries, the room's actions), which can
    // take longer than the 5 s default while the full suite runs in parallel
    testTimeout: 20_000,
  },
})
