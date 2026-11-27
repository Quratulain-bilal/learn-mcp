/**
 * Gives the least-privilege role `mcp_connector` (created by migration 0005) a fresh
 * random password and lets it log in, then writes its connection string into .env as
 * CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE.
 *
 *   npm run db:connector
 *
 * Run it after `npm run db:migrate`, and again whenever you want to rotate the password
 * (then update Hyperdrive too: npx wrangler hyperdrive update <id> --password ...).
 * The password is never printed and never goes into git.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { loadDatabaseUrl } from "./env";

const ROLE = "mcp_connector";
const ENV_KEY = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";

async function main() {
  const ownerUrl = loadDatabaseUrl();
  const password = randomBytes(24).toString("hex");

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = $1",
      [ROLE],
    );
    if (rows.length === 0) throw new Error(`Role ${ROLE} doesn't exist yet. Run npm run db:migrate first.`);
    if (rows[0]!.rolbypassrls) throw new Error(`Role ${ROLE} has BYPASSRLS. Refusing: it must not skip row-level security.`);
    // DDL can't take $1 parameters, so format() quotes the password safely (%L = literal).
    const [{ sql }] = (
      await client.query<{ sql: string }>("SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS sql", [
        ROLE,
        password,
      ])
    ).rows as [{ sql: string }];
    await client.query(sql);
  } finally {
    await client.end();
  }

  // Same host and database as the owner, but the connector's name and password, and the
  // DIRECT host: Hyperdrive does its own pooling, so it shouldn't sit on Neon's pooler.
  const url = new URL(ownerUrl);
  url.username = ROLE;
  url.password = password;
  url.hostname = url.hostname.replace("-pooler.", ".");

  const env = readFileSync(".env", "utf8");
  const line = `${ENV_KEY}=${url.toString()}`;
  const updated = env.match(new RegExp(`^${ENV_KEY}=.*$`, "m"))
    ? env.replace(new RegExp(`^${ENV_KEY}=.*$`, "m"), line)
    : `${env.trimEnd()}\n${line}\n`;
  writeFileSync(".env", updated);
  console.log(`${ROLE} can now log in. Its connection string is in .env as ${ENV_KEY}.`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
