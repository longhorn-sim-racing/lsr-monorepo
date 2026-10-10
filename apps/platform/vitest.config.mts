import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit tests: no database, no network. Prisma and Resend are replaced with fakes in each test.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
  },
})
