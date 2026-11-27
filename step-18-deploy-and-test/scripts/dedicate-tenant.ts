/**
 * Gives a company its OWN database: the "dedicated" (enterprise) tier from TENANCY.md.
 *
 *   npm run tenant:dedicate -- --name enterprise                 # create the database only
 *   npm run tenant:dedicate -- --name enterprise --org <orgId>   # ...and move a company onto it
 *   npm run tenant:dedicate -- --name enterprise --database step08_tenant_enterprise  # pick the database name
 *
 * What it does, as the owner role:
 *   1. Creates the database tenant_<name> on the same Neon branch (if it doesn't exist).
 *      Roles belong to the branch, so mcp_connector can already log in to it.
 *   2. Applies every migration to it: same schema, same row-level security.
 *   3. Writes its two connection strings into .env:
 *        MIGRATION_DATABASE_URL_TENANT_DB_<NAME>                      (owner, for scripts)
 *        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_TENANT_DB_<NAME> (connector, local stand-in
 *        for the TENANT_DB_<NAME> Hyperdrive binding in wrangler.jsonc)
 *   4. With --org: records the company in the SHARED database's tenants table as
 *      dedicated, using binding TENANT_DB_<NAME>.
 *
 * It does NOT copy the company's existing rows from the shared database: moving a live
 * company is a planned migration of its own. Seed the new database with
 *   npm run db:seed -- --org <orgId> --database TENANT_DB_<NAME>
 * The router caches a company's placement in KV for up to 60 seconds.
 */
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { ENV_FILE, loadDatabaseUrl, loadLocalEnv } from "./env";
import { migrateDatabase } from "./migrations-lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function setEnvLine(env: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(env) ? env.replace(pattern, line) : `${env.trimEnd()}\n${line}\n`;
}

async function main() {
  const name = (arg("name") ?? "").toLowerCase();
  const orgId = arg("org");
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(name) || (orgId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(orgId))) {
    console.error("Usage: npm run tenant:dedicate -- --name <lowercase_name> [--org <company id>]");
    process.exit(1);
  }
  const binding = `TENANT_DB_${name.toUpperCase()}`;
  // The database name defaults to tenant_<name>; --database lets two course steps on the
  // same Neon branch keep separate dedicated databases.
  const database = arg("database") ?? `tenant_${name}`;
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(database)) {
    console.error("--database must be lowercase letters, digits and underscores.");
    process.exit(1);
  }

  const sharedOwnerUrl = loadDatabaseUrl();
  loadLocalEnv();
  const sharedConnectorUrl = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? "";
  if (!sharedConnectorUrl.includes("mcp_connector")) {
    console.error("Run npm run db:migrate and npm run db:connector first.");
    process.exit(1);
  }

  // 1. Create the database (CREATE DATABASE can't run in a transaction or take parameters;
  //    the name was checked against a strict pattern above).
  const shared = new pg.Client({ connectionString: sharedOwnerUrl });
  await shared.connect();
  try {
    const exists = await shared.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (exists.rowCount === 0) {
      await shared.query(`CREATE DATABASE ${database}`);
      console.log(`Created database ${database}.`);
    } else {
      console.log(`Database ${database} already exists.`);
    }
  } finally {
    await shared.end();
  }

  // Same host and role, different database.
  const withDatabase = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${database}`;
    return u.toString();
  };
  const ownerUrl = withDatabase(sharedOwnerUrl);
  const connectorUrl = withDatabase(sharedConnectorUrl);

  // 2. Same migrations as every other tenant database.
  console.log(`Migrating ${database}:`);
  await migrateDatabase(ownerUrl);

  // 3. Connection strings for scripts, wrangler dev and the tests.
  let env = readFileSync(ENV_FILE, "utf8");
  env = setEnvLine(env, `MIGRATION_DATABASE_URL_${binding}`, ownerUrl);
  env = setEnvLine(env, `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`, connectorUrl);
  writeFileSync(ENV_FILE, env);
  console.log(`Wrote MIGRATION_DATABASE_URL_${binding} and the local ${binding} connection string to ${ENV_FILE}.`);

  // 4. Point the company at it.
  if (orgId) {
    const client = new pg.Client({ connectionString: sharedOwnerUrl });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO tenants (org_id, tier, db_binding) VALUES ($1, 'dedicated', $2)
         ON CONFLICT (org_id) DO UPDATE SET tier = 'dedicated', db_binding = $2`,
        [orgId, binding],
      );
    } finally {
      await client.end();
    }
    console.log(`Company ${orgId} now uses ${binding} (${database}).`);
  }

  const config = readFileSync("wrangler.jsonc", "utf8");
  if (!config.includes(`"${binding}"`)) {
    console.log(`\nAdd a Hyperdrive binding named ${binding} to wrangler.jsonc before deploying.`);
  }
  console.log(
    `For production: create a Hyperdrive config for ${database} as mcp_connector with caching off, ` +
      `and put its id on the ${binding} binding in wrangler.jsonc.`,
  );
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
