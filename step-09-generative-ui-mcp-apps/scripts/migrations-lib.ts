import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "db", "migrations");

/** Applies every pending migration to one database. Exported for tenant:dedicate. */
export async function migrateDatabase(url: string, statusOnly = false): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  done     ${file}`);
        continue;
      }
      if (statusOnly) {
        console.log(`  pending  ${file}`);
        continue;
      }
      const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(text); // trusted SQL from our own repo; several statements per file
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`${file}: ${(error as Error).message}`);
      }
      console.log(`  applied  ${file}`);
      ran++;
    }
    if (!statusOnly) console.log(ran ? `Applied ${ran} migration(s).` : "Database is up to date.");
  } finally {
    await client.end();
  }
}
