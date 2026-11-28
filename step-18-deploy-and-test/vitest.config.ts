import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig, type ViteUserConfig } from "vitest/config";

// Runs the tests inside the real Workers runtime (workerd), using wrangler.jsonc.
// .env holds the local database connection strings (see .env.example). Loading it here lets
// Wrangler find CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE, the local stand-in
// for the HYPERDRIVE binding.
const ENV_FILE = process.env.ENV_FILE ?? ".env";
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2];
  }
}
// Without a .env, Wrangler refuses to start a Worker that has a Hyperdrive binding. A
// placeholder lets the tests that don't need a database run; the rest are skipped.
for (const binding of ["HYPERDRIVE", "TENANT_DB_ENTERPRISE"]) {
  process.env[`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`] ??=
    "postgresql://replace-me:replace-me@localhost:5432/replace-me";
}

export default defineConfig(async () => {
  // The auth schema, applied to a fresh local D1 before the tests (see test/apply-migrations.ts).
  const migrations = await readD1Migrations("./migrations");
  const config: ViteUserConfig = {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Tests embed with the deterministic test embedder: no network, no Workers AI usage.
            EMBEDDINGS: "test",
            // A throwaway secret for tests only; real ones live in .dev.vars / wrangler secrets.
            BETTER_AUTH_SECRET: "test-only-secret-not-used-anywhere-else-0123456789",
            // Database tests act as mcp_connector through the HYPERDRIVE binding. A few also
            // need the owner role (to clean up test orders and to plant bugs inside a
            // rolled-back transaction). Without these settings those tests are skipped.
            TEST_OWNER_DATABASE_URL: process.env.MIGRATION_DATABASE_URL ?? "",
            // The dedicated tenant database (npm run tenant:dedicate -- --name enterprise).
            TEST_DEDICATED_OWNER_DATABASE_URL: process.env.MIGRATION_DATABASE_URL_TENANT_DB_ENTERPRISE ?? "",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // The first request compiles the Worker inside workerd, which can take a while locally.
      testTimeout: 60_000,
      // Test setup plants and removes rows over several fresh connections to Neon.
      hookTimeout: 60_000,
      // When a test closes a database connection, workerd cancels the socket's pending read
      // and pg-cloudflare leaves that rejection unhandled. The real runtime ignores it
      // (checked with wrangler dev); the test runner would report it. Ignore exactly that one.
      onUnhandledError: (error) => !String(error.message).includes("Stream was cancelled"),
      // Test-runner quirk only: pg is CommonJS that require()s ESM-flavoured helpers
      // (pg-protocol, pg-cloudflare), which the Workers test runner can't load one file at a
      // time. Pre-bundling pg fixes that, the same way Wrangler bundles it for dev and deploy.
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: ["pg"],
            rolldownOptions: { platform: "node" as const, external: [...builtinModules, /^node:/, /^cloudflare:/] },
          },
        },
      },
    },
  };
  return config;
});
