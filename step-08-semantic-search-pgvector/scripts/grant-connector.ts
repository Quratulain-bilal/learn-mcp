import { readFile } from "node:fs/promises";
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

const grants = await readFile(path.join(process.cwd(), "db", "grants.sql"), "utf8");
const statements = grants.split(";").map((entry) => entry.trim()).filter(Boolean);

for (const [label, name] of [
  ["shared", "NEON_DATABASE_URL"],
  ["enterprise", "ENTERPRISE_NEON_DATABASE_URL"],
] as const) {
  const connectionString = process.env[name] ?? (await localVar(name));
  if (!connectionString) {
    console.log(`skip ${label}: no connection string`);
    continue;
  }
  const sql = neon(connectionString);
  for (const statement of statements) {
    await sql.query(statement);
  }
  console.log(`granted connector privileges on ${label}`);
}
