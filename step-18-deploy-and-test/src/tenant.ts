import { type CompanyRole, lookupRole } from "./auth";
import { createForTenant } from "./db";

/**
 * THE TENANT MODULE: who a request is for, resolved ONCE per request, and the helpers
 * that put the company into every name the server stores or sends.
 *
 * The company comes only from the VERIFIED access token: the user chose it when they
 * connected, and a token speaks for that one company for its whole life. Membership and
 * role are re-read from the database on every request, so a removed member or a demoted
 * admin loses access on their very next call. No tool, resource or prompt ever takes a
 * company or user id as input.
 */

/** Where a company's business data lives (see TENANCY.md). */
export type Tier = "shared" | "dedicated";

export interface TenantContext {
  orgId: string;
  userId: string;
  /** The CURRENT role in this company, read fresh on this request. Decides what a call may do. */
  role: CompanyRole;
  /** Decides which database the company's queries go to. Tools never look at it. */
  tier: Tier;
  /** The Hyperdrive binding for this company's database: HYPERDRIVE, or TENANT_DB_<NAME>. */
  database: string;
  /** The OAuth client (Claude, ChatGPT, …) making the call. */
  clientId: string;
  /** One id per request, carried into logs and background work. */
  requestId: string;
}

/**
 * Carried with every queue message, Workflow run, task and event in later steps. The
 * handler re-checks membership before touching data, because the work may run long after
 * the request that started it (and the member may have been removed since).
 */
export interface TenantEnvelope {
  orgId: string;
  userId: string;
  requestId: string;
}

export const envelope = (ctx: TenantContext): TenantEnvelope => ({
  orgId: ctx.orgId,
  userId: ctx.userId,
  requestId: ctx.requestId,
});

// A key part may not contain ":" (it would let one part pose as two) or be empty.
const KEY_PART = /^[A-Za-z0-9_.@-]{1,128}$/;

/**
 * A KV key (or cache key, or log field) that always starts with the company:
 * tenantKey(ctx, "settings") -> "org:<orgId>:settings". Two companies can never share an
 * entry, and no part can smuggle in another company's prefix.
 */
export function tenantKey(ctx: Pick<TenantContext, "orgId">, ...parts: string[]): string {
  for (const part of [ctx.orgId, ...parts]) {
    if (!KEY_PART.test(part)) throw new Error(`Invalid key part: ${JSON.stringify(part)}`);
  }
  return ["org", ctx.orgId, ...parts].join(":");
}

/**
 * A Durable Object name (step 11 on). Per-user state: "org:<orgId>:user:<userId>";
 * company-wide state: "org:<orgId>". Always from the verified context, never tool input.
 */
export function tenantObjectName(ctx: Pick<TenantContext, "orgId" | "userId">, scope: "user" | "company" = "user"): string {
  return scope === "user" ? tenantKey(ctx, "user", ctx.userId) : tenantKey(ctx);
}

/** Where a company lives. Shared tier is the default for every company. */
export interface Placement {
  tier: Tier;
  database: string;
}
export const SHARED: Placement = { tier: "shared", database: "HYPERDRIVE" };

/** How long a company's placement is cached in KV. 60 s is the shortest KV allows. */
const PLACEMENT_TTL_SECONDS = 60;

/**
 * Looks up which database a company uses, from the `tenants` table in the SHARED
 * database (read under row-level security, as that company), cached in KV.
 */
export async function lookupPlacement(env: Env, orgId: string): Promise<Placement> {
  const key = tenantKey({ orgId }, "placement");
  const cached = await env.TENANT_CACHE.get<Placement>(key, "json");
  if (cached) return cached;

  const rows = await createForTenant(env.HYPERDRIVE.connectionString)({ orgId }, (db) =>
    db.query<{ tier: Tier; db_binding: string | null }>(`SELECT tier, db_binding FROM tenants WHERE org_id = $1`, [orgId]),
  );
  const row = rows[0];
  const placement: Placement =
    row?.tier === "dedicated" && row.db_binding ? { tier: "dedicated", database: row.db_binding } : SHARED;
  await env.TENANT_CACHE.put(key, JSON.stringify(placement), { expirationTtl: PLACEMENT_TTL_SECONDS });
  return placement;
}

/**
 * Builds the tenant context for one request from the verified token's claims. Returns
 * null when the user is no longer a member of the token's company.
 */
export async function resolveTenant(
  env: Env,
  verified: { orgId: string; userId: string; clientId: string },
): Promise<TenantContext | null> {
  const role = await lookupRole(env.AUTH_DB, verified.orgId, verified.userId);
  if (!role) return null;
  const placement = await lookupPlacement(env, verified.orgId);
  return { ...verified, role, ...placement, requestId: crypto.randomUUID() };
}
