import { existsSync } from "node:fs";

/**
 * Local settings for scripts: .env holds the database connection strings (see .env.example).
 * ENV_FILE picks another file per environment, e.g. ENV_FILE=.env.staging npm run db:migrate.
 */
export const ENV_FILE = process.env.ENV_FILE ?? ".env";
export function loadLocalEnv(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

const isRealUrl = (url: string | undefined): url is string =>
  !!url && /^postgres(ql)?:\/\//.test(url) && !url.includes("replace-me");

/** The OWNER connection string for the SHARED database, for migrations and seeding. */
export function loadDatabaseUrl(): string {
  loadLocalEnv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!isRealUrl(url)) {
    console.error("Set MIGRATION_DATABASE_URL in .env to your Neon owner connection string first (see .env.example).");
    process.exit(1);
  }
  return url;
}

/**
 * Every tenant database, as { binding, url } with the OWNER role: the shared one
 * (binding HYPERDRIVE) plus each dedicated one, found as MIGRATION_DATABASE_URL_TENANT_DB_<NAME>
 * in .env (written by `npm run tenant:dedicate`).
 */
export function tenantDatabases(): { binding: string; url: string }[] {
  const all = [{ binding: "HYPERDRIVE", url: loadDatabaseUrl() }];
  for (const [key, url] of Object.entries(process.env)) {
    const match = key.match(/^MIGRATION_DATABASE_URL_(TENANT_DB_[A-Z0-9_]+)$/);
    if (match && isRealUrl(url)) all.push({ binding: match[1]!, url });
  }
  return all;
}

/** The owner URL for one database binding (HYPERDRIVE = shared). */
export function ownerUrlFor(binding: string): string {
  const found = tenantDatabases().find((d) => d.binding === binding);
  if (!found) {
    console.error(`No MIGRATION_DATABASE_URL_${binding} in .env. Run npm run tenant:dedicate first.`);
    process.exit(1);
  }
  return found.url;
}
