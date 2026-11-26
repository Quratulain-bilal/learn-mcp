import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

async function localVar(name: string): Promise<string | undefined> {
  try {
    const localVars = await readFile(path.join(process.cwd(), ".dev.vars"), "utf8");
    const line = localVars
      .split(/\r?\n/)
      .find((entry) => entry.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  } catch {
    return undefined;
  }
}

async function connectionFor(name: string): Promise<string | undefined> {
  return process.env[name] ?? (await localVar(name));
}

const migrationsDir = path.join(process.cwd(), "db", "migrations");
const files = (await readdir(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort();

async function migrateDatabase(label: string, connectionString: string | undefined) {
  if (!connectionString) {
    console.log(`skip ${label}: no connection string`);
    return;
  }
  const sql = neon(connectionString);
  await sql.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const appliedRows = await sql.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  const applied = new Set(appliedRows.map((row) => row.name));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`${label}: skip ${file}`);
      continue;
    }
    const migration = await readFile(path.join(migrationsDir, file), "utf8");
    const statements = migration
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await sql.query(statement);
    }
    await sql.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    console.log(`${label}: applied ${file}`);
  }
}

await migrateDatabase("shared", await connectionFor("NEON_DATABASE_URL"));
await migrateDatabase("enterprise", await connectionFor("ENTERPRISE_NEON_DATABASE_URL"));
