/**
 * Applies the numbered SQL files in db/migrations/ to Neon, once each and in order.
 *
 *   npm run db:migrate              # every tenant database: shared + each dedicated one
 *   npm run db:migrate -- --status  # just list what has and hasn't run, per database
 *
 * The SAME numbered files run on every tenant database, so a dedicated company's database
 * always has exactly the shared one's schema and policies. A new dedicated database is
 * brought up to date the same way (npm run tenant:dedicate calls migrateDatabase).
 *
 * Each file runs inside its own transaction together with the row that records it in
 * schema_migrations, so a file either applies completely or not at all, and never twice.
 * Runs on your machine with Node, never inside the Worker.
 */
import { tenantDatabases } from "./env";
import { migrateDatabase } from "./migrations-lib";

async function main() {
  const statusOnly = process.argv.includes("--status");
  for (const { binding, url } of tenantDatabases()) {
    console.log(`${binding} (${new URL(url).pathname.slice(1)}):`);
    await migrateDatabase(url, statusOnly);
  }
}

main().catch((error) => {
  console.error("Migration failed, nothing from the failing file was applied:\n", error.message ?? error);
  process.exit(1);
});
