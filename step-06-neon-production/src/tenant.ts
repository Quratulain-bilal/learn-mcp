import type { SqlClient, SqlQuery } from "./db-client";

export interface HyperdriveLike {
  connectionString: string;
}

export interface DatabaseEnv {
  HYPERDRIVE?: HyperdriveLike;
  NEON_DATABASE_URL?: string;
}

export const TENANT_TABLES = [
  "staging.flat_sales",
  "customers",
  "categories",
  "products",
  "orders",
  "order_items",
] as const;

export function connectionString(env: DatabaseEnv): string {
  const value = env.HYPERDRIVE?.connectionString ?? env.NEON_DATABASE_URL;
  if (!value) {
    throw new Error("Set HYPERDRIVE or NEON_DATABASE_URL before using the sales database.");
  }
  return value;
}

export async function forTenant<T>(
  sql: SqlClient,
  orgId: string,
  build: (txn: SqlClient) => readonly SqlQuery<T>[],
): Promise<readonly (readonly T[])[]> {
  const results = await sql.transaction((txn) => [
    txn.query<Record<string, unknown>>("SELECT set_config('app.tenant_id', $1, true)", [orgId]) as SqlQuery<T>,
    ...build(txn),
  ]);
  return results.slice(1);
}
