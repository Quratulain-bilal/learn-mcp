import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

async function getConnectionString() {
  if (process.env.NEON_DATABASE_URL) return process.env.NEON_DATABASE_URL;
  const localVars = await readFile(path.join(process.cwd(), ".dev.vars"), "utf8");
  const line = localVars
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("NEON_DATABASE_URL="));
  return line?.slice("NEON_DATABASE_URL=".length).trim();
}

const connectionString = await getConnectionString();
if (!connectionString) {
  throw new Error("Set NEON_DATABASE_URL before running npm run migrate.");
}

const sql = neon(connectionString);
const migrationsDir = path.join(process.cwd(), "db", "migrations");

await sql.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);

const appliedRows = await sql.query<{ name: string }>(
  "SELECT name FROM schema_migrations ORDER BY name",
);
const applied = new Set(appliedRows.map((row) => row.name));
const files = (await readdir(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort();

for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip ${file}`);
    continue;
  }
  const statement = await readFile(path.join(migrationsDir, file), "utf8");
  await sql.query(statement);
  await sql.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
  console.log(`applied ${file}`);
}
