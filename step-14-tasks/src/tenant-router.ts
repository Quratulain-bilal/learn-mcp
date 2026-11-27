import { createForTenant, type DbTenant, type ForTenant } from "./db";

/**
 * THE TENANT ROUTER: the one place that turns a tenant context into a database
 * connection. Tools call forTenant(ctx, fn) and never know which tier they're on.
 *
 *   shared tier    -> the shared Hyperdrive config (HYPERDRIVE), row-level security, one
 *                     company per transaction
 *   dedicated tier -> that company's own Hyperdrive config (TENANT_DB_<NAME>) and its own
 *                     Neon database, with the same migrations and the same policies
 *
 * Either way, forTenant still sets app.tenant_id for the transaction, so row-level
 * security guards a dedicated database too.
 */

/** Hyperdrive bindings for dedicated databases must be named like this. */
const DEDICATED_BINDING = /^TENANT_DB_[A-Z0-9_]+$/;

export function connectionStringFor(env: Env, ctx: DbTenant): string {
  if ((ctx.tier ?? "shared") === "shared") return env.HYPERDRIVE.connectionString;

  const name = ctx.database ?? "";
  if (!DEDICATED_BINDING.test(name)) throw new Error(`Invalid dedicated database binding: ${JSON.stringify(name)}`);
  // The binding name comes from our own tenants table, never from tool input.
  const binding = (env as unknown as Record<string, unknown>)[name] as Hyperdrive | undefined;
  if (!binding?.connectionString) {
    // Fail closed: never fall back to the shared database for a dedicated company.
    throw new Error(`No Hyperdrive binding named ${name} in wrangler.jsonc`);
  }
  return binding.connectionString;
}

export function createTenantRouter(env: Env): ForTenant {
  // async, so a routing failure is a rejected promise like any other database error.
  return async (ctx, fn) => createForTenant(connectionStringFor(env, ctx))(ctx, fn);
}
