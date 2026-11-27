import { Client, type DatabaseError } from "pg";

/**
 * The connection to Neon, the business database, through Cloudflare HYPERDRIVE.
 *
 * Hyperdrive keeps a pool of warm connections to Neon close to the database. Our Worker
 * still opens a "connection" per tool call, but it's to Hyperdrive, nearby and cheap; the
 * slow TLS handshake to Neon happens once per pooled connection, not once per call. It
 * also stops many short-lived Workers from running Neon out of connections.
 *
 * We connect as `mcp_connector`, the least-privilege role (db/migrations/0005), which
 * row-level security applies to (0006).
 */

export type Row = Record<string, string | number | boolean | null>;

/** The one thing tools can do with the database: run a fixed, parameterized query. */
export interface Db {
  query<T extends object = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Who the queries are for. Only ever built from the VERIFIED token (see tenant.ts).
 * tier and database tell the tenant router which database to use; forTenant itself only
 * needs the company.
 */
export interface DbTenant {
  orgId: string;
  tier?: "shared" | "dedicated";
  database?: string;
}

/**
 * THE way tools reach the database (book lesson 19.9): one transaction, for one company.
 *
 *   BEGIN
 *   SELECT set_config('app.tenant_id', <orgId>, true)   -- true = this transaction only
 *   ...the tool's queries...                             -- row-level security filters them
 *   COMMIT                                               -- or ROLLBACK if anything failed
 *
 * Because the setting is transaction-local, a pooled connection that Hyperdrive hands to
 * the next request never carries this company with it. The company is a query PARAMETER,
 * never pasted into SQL. If `fn` throws, nothing it wrote is kept.
 */
export type ForTenant = <T>(ctx: DbTenant, fn: (db: Db) => Promise<T>) => Promise<T>;

export function createForTenant(connectionString: string): ForTenant {
  return async (ctx, fn) => {
    if (!ctx.orgId) throw new Error("forTenant needs a company (orgId).");
    const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.orgId]);
      const result = await fn({
        query: async <T extends object>(text: string, params: unknown[] = []) =>
          (await client.query<T>(text, params)).rows,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  };
}

/**
 * What we may LOG about a database error (book lesson 19.10: no rows in logs). Postgres
 * error details can quote row values ("Key (org_id, email)=(acme, ali@…) already exists"),
 * so we keep only the error code and the constraint or table name.
 */
export function safeDbErrorForLog(error: unknown): Record<string, string | undefined> {
  const e = error as Partial<DatabaseError>;
  return { code: e.code, constraint: e.constraint, table: e.table, name: e.name };
}

/** True when a connection string looks like a real Postgres URL. */
export function hasDatabaseUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^postgres(ql)?:\/\//.test(url) && !url.includes("replace-me");
}

/** The tables the tools may describe, in the order they're shown. */
export const SALES_TABLES = ["customers", "categories", "products", "orders", "order_items"] as const;
export type SalesTable = (typeof SALES_TABLES)[number];
