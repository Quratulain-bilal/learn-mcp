import { readFile } from "node:fs/promises";
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
  throw new Error("Set NEON_DATABASE_URL before running npm run grant-connector.");
}

const sql = neon(connectionString);
const grants = await readFile(path.join(process.cwd(), "db", "grants.sql"), "utf8");
for (const statement of grants.split(";").map((entry) => entry.trim()).filter(Boolean)) {
  await sql.query(statement);
}
console.log("Granted connector privileges to learn_mcp_connector");
