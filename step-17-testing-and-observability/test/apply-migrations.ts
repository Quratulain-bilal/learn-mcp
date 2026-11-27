import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Create the Better Auth tables in the test D1 database before any test runs.
await applyD1Migrations(env.AUTH_DB, env.TEST_MIGRATIONS);
