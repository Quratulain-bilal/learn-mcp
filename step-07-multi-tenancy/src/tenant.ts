import type { SqlClient, SqlQuery } from "./db-client";

export interface HyperdriveLike {
  connectionString: string;
}

export interface DatabaseEnv {
  HYPERDRIVE?: HyperdriveLike;
  ENTERPRISE_HYPERDRIVE?: HyperdriveLike;
  NEON_DATABASE_URL?: string;
  ENTERPRISE_NEON_DATABASE_URL?: string;
}

export type TenantTier = "shared" | "enterprise";

export interface TenantContext {
  orgId: string;
  userId: string;
  role: string;
  tier: TenantTier;
  databaseBinding: string;
  requestId: string;
}

export interface TenantEnvelope {
  orgId: string;
  userId: string;
  requestId: string;
}

export const TENANT_TABLES = [
  "staging.flat_sales",
  "customers",
  "categories",
  "products",
  "orders",
  "order_items",
] as const;

export const NEW_TENANT_TABLES = ["public.tenants", "public.company_settings"] as const;

export function connectionString(env: DatabaseEnv, tier: TenantTier = "shared"): string {
  const value =
    tier === "enterprise"
      ? env.ENTERPRISE_HYPERDRIVE?.connectionString ?? env.ENTERPRISE_NEON_DATABASE_URL
      : env.HYPERDRIVE?.connectionString ?? env.NEON_DATABASE_URL;
  if (!value) {
    throw new Error(
      tier === "enterprise"
        ? "Set ENTERPRISE_HYPERDRIVE or ENTERPRISE_NEON_DATABASE_URL before using a dedicated tenant database."
        : "Set HYPERDRIVE or NEON_DATABASE_URL before using the shared sales database.",
    );
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

function safePart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function tenantKey(ctx: TenantContext, ...parts: readonly string[]): string {
  return ["org", safePart(ctx.orgId), ...parts.map(safePart)].join(":");
}

export function tenantObjectName(ctx: TenantContext, ...parts: readonly string[]): string {
  return tenantKey(ctx, "object", ...parts);
}

export function tenantEnvelope(ctx: TenantContext): TenantEnvelope {
  return { orgId: ctx.orgId, userId: ctx.userId, requestId: ctx.requestId };
}

export function tierFromMetadata(metadata: string | null): TenantTier {
  try {
    const parsed = JSON.parse(metadata ?? "{}") as { tier?: unknown };
    return parsed.tier === "enterprise" ? "enterprise" : "shared";
  } catch {
    return "shared";
  }
}

export function databaseBindingFromMetadata(metadata: string | null): string {
  try {
    const parsed = JSON.parse(metadata ?? "{}") as { databaseBinding?: unknown };
    return typeof parsed.databaseBinding === "string" && parsed.databaseBinding
      ? parsed.databaseBinding
      : tierFromMetadata(metadata) === "enterprise"
        ? "ENTERPRISE_HYPERDRIVE"
        : "HYPERDRIVE";
  } catch {
    return "HYPERDRIVE";
  }
}

export async function resolveTenant(
  database: D1Database,
  userId: string,
  orgId: string,
  requestId = crypto.randomUUID(),
): Promise<TenantContext | null> {
  const row = await database
    .prepare(
      `SELECT m.role AS role, o.metadata AS metadata
       FROM member m JOIN organization o ON o.id = m.organizationId
       WHERE m.organizationId = ? AND m.userId = ?`,
    )
    .bind(orgId, userId)
    .first<{ role: string; metadata: string | null }>();
  if (!row) return null;
  const metadata = row.metadata;
  return {
    orgId,
    userId,
    role: row.role,
    tier: tierFromMetadata(metadata),
    databaseBinding: databaseBindingFromMetadata(metadata),
    requestId,
  };
}
