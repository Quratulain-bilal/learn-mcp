import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  testTimeout: 30_000,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: "test-better-auth-secret-change-me",
          MIGRATION_TOKEN: "test-migration-token",
          NEON_DATABASE_URL: "postgresql://user:password@localhost/learn_mcp_test",
          SALES_STORE: "memory",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
