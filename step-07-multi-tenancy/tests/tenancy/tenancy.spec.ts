import { env, exports } from "cloudflare:workers";
import type { SqlClient, SqlQuery } from "../../src/db-client";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth-options";
import { createNeonSalesStore } from "../../src/sales";
import {
  resolveTenant,
  tenantEnvelope,
  tenantKey,
  tenantObjectName,
  type TenantContext,
} from "../../src/tenant";
import { auditTenantTransaction } from "../../src/rls-audit";

const BASE_URL = "https://example.com";
const RESOURCE = `${BASE_URL}/mcp`;
const SECRET = "test-better-auth-secret-change-me";

interface RpcPayload {
  result?: {
    isError?: boolean;
    content?: { text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  error?: { message?: string; code?: number };
}

function fakeSql(calls: Array<{ text: string; params?: unknown[] }>): SqlClient {
  const query = async <T>(text: string, params?: readonly unknown[]) => {
    calls.push({ text, params: params as unknown[] | undefined });
    return [] as readonly T[];
  };
  const txn: SqlClient = {
    query,
    transaction: () => {
      throw new Error("Nested transactions are not supported.");
    },
    end: async () => undefined,
  };
  return {
    query,
    async transaction<T>(build: (client: SqlClient) => readonly SqlQuery<T>[]) {
      const pending = build(txn);
      const results: Array<readonly T[]> = [];
      for (const promise of pending) results.push(await promise);
      return results;
    },
    end: async () => undefined,
  };
}

async function signUp(email: string) {
  const response = await exports.default.fetch(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: email.split("@")[0], email, password: "StrongPass123!" }),
    }),
  );
  if (!response.ok) throw new Error(`Sign-up failed: ${await response.text()}`);
  const data = (await response.json()) as { user?: { id?: string } };
  if (!data.user?.id) throw new Error("Sign-up did not return a user id");
  return data.user.id;
}

async function personalOrg(userId: string) {
  const row = await env.AUTH_DB.prepare(
    "SELECT organizationId, role FROM member WHERE userId = ?",
  )
    .bind(userId)
    .first<{ organizationId: string; role: string }>();
  if (!row) throw new Error("No membership row");
  return row;
}

async function addMember(userId: string, orgId: string, role: string) {
  await env.AUTH_DB.prepare(
    "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(`member-${crypto.randomUUID()}`, orgId, userId, role, Date.now())
    .run();
}

async function setTier(orgId: string, tier: "shared" | "enterprise") {
  await env.AUTH_DB.prepare("UPDATE organization SET metadata = ? WHERE id = ?")
    .bind(
      JSON.stringify({
        tier,
        databaseBinding: tier === "enterprise" ? "ENTERPRISE_HYPERDRIVE" : "HYPERDRIVE",
      }),
      orgId,
    )
    .run();
}

async function tokenFor(userId: string, orgId: string) {
  const auth = createAuth({ baseURL: BASE_URL, resource: RESOURCE, secret: SECRET, database: env.AUTH_DB });
  const result = (await auth.api.signJWT({
    body: {
      payload: {
        sub: userId,
        org_id: orgId,
        azp: "test-client",
        aud: RESOURCE,
        iss: `${BASE_URL}/api/auth`,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    },
  })) as { token: string };
  return result.token;
}

async function rpc(method: string, params: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await exports.default.fetch(
    new Request(`${BASE_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine ? dataLine.slice("data: ".length) : text) as RpcPayload;
  return { response, payload };
}

async function callTool(name: string, args: Record<string, unknown>, token: string) {
  const { payload } = await rpc("tools/call", { name, arguments: args }, token);
  if (!payload.result) throw new Error(`tool call failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function newUser(orgId?: string, role = "admin") {
  const userId = await signUp(`tenant-${crypto.randomUUID()}@example.com`);
  const personal = await personalOrg(userId);
  const targetOrg = orgId ?? personal.organizationId;
  if (orgId) await addMember(userId, orgId, role);
  return { userId, orgId: targetOrg, token: await tokenFor(userId, targetOrg) };
}

describe("tenant helpers", () => {
  it("builds private keys, object names and envelopes from the company", () => {
    const ctx: TenantContext = {
      orgId: "org-a",
      userId: "user-a",
      role: "admin",
      tier: "enterprise",
      databaseBinding: "ENTERPRISE_HYPERDRIVE",
      requestId: "req-1",
    };
    expect(tenantKey(ctx, "settings")).toBe("org:org-a:settings");
    expect(tenantObjectName(ctx, "draft")).toBe("org:org-a:object:draft");
    expect(tenantEnvelope(ctx)).toEqual({ orgId: "org-a", userId: "user-a", requestId: "req-1" });
  });

  it("rejects a query that runs outside forTenant", () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const store = createNeonSalesStore(fakeSql(calls));
    expect(store).toBeTruthy();
    expect(auditTenantTransaction([{ text: "SELECT * FROM orders" }])).toContain(
      "The query ran outside forTenant; app.tenant_id was not set first.",
    );
  });
});

describe("two companies, two databases", () => {
  it("resolves tier from the token's company and refuses removed members", async () => {
    const owner = await newUser();
    await setTier(owner.orgId, "enterprise");
    const resolved = await resolveTenant(env.AUTH_DB, owner.userId, owner.orgId, "req-test");
    expect(resolved?.tier).toBe("enterprise");
    expect(resolved?.databaseBinding).toBe("ENTERPRISE_HYPERDRIVE");

    const member = await newUser(owner.orgId, "member");
    expect((await resolveTenant(env.AUTH_DB, member.userId, owner.orgId))?.role).toBe("member");
    await env.AUTH_DB.prepare("DELETE FROM member WHERE userId = ? AND organizationId = ?")
      .bind(member.userId, owner.orgId)
      .run();
    expect(await resolveTenant(env.AUTH_DB, member.userId, owner.orgId)).toBeNull();

    const { response } = await rpc("tools/list", {}, member.token);
    expect(response.status).toBe(403);
  });

  it("reports the tier and database binding to each company without mixing rows", async () => {
    const shared = await newUser();
    await setTier(shared.orgId, "shared");
    const enterprise = await newUser();
    await setTier(enterprise.orgId, "enterprise");

    const sharedResult = await callTool("list_orders", { limit: 2 }, shared.token);
    const enterpriseResult = await callTool("list_orders", { limit: 2 }, enterprise.token);
    const sharedData = sharedResult.structuredContent as Record<string, unknown>;
    const enterpriseData = enterpriseResult.structuredContent as Record<string, unknown>;

    expect(sharedData.orgId).toBe(shared.orgId);
    expect(sharedData.tier).toBe("shared");
    expect(sharedData.databaseBinding).toBe("HYPERDRIVE");
    expect(enterpriseData.orgId).toBe(enterprise.orgId);
    expect(enterpriseData.tier).toBe("enterprise");
    expect(enterpriseData.databaseBinding).toBe("ENTERPRISE_HYPERDRIVE");
    expect(JSON.stringify(sharedData)).not.toContain(enterprise.orgId);
    expect(JSON.stringify(enterpriseData)).not.toContain(shared.orgId);
  });

  it("rejects tool arguments that name a company or user", async () => {
    const user = await newUser();
    const withOrg = await callTool("list_orders", { limit: 1, orgId: "org-other" }, user.token);
    const withUser = await callTool("get_company_settings", { userId: "user-other" }, user.token);
    expect(withOrg.isError).toBe(true);
    expect(withUser.isError).toBe(true);
  });

  it("refuses a token that names a company the user does not belong to", async () => {
    const user = await newUser();
    const other = await newUser();
    const forged = await tokenFor(user.userId, other.orgId);
    const { response } = await rpc("tools/list", {}, forged);
    expect(response.status).toBe(403);
  });

  it("refuses an admin tool after the member is demoted", async () => {
    const admin = await newUser();
    const before = await callTool(
      "update_company_settings",
      { currency: "USD", fiscalYearStart: 1, salesThreshold: "1000.00" },
      admin.token,
    );
    expect(before.isError).toBeFalsy();
    await env.AUTH_DB.prepare("UPDATE member SET role = ? WHERE organizationId = ? AND userId = ?")
      .bind("member", admin.orgId, admin.userId)
      .run();
    const after = await callTool(
      "update_company_settings",
      { currency: "EUR", fiscalYearStart: 2, salesThreshold: "2000.00" },
      admin.token,
    );
    expect(after.isError).toBe(true);
    expect((after.content as { text: string }[])[0].text).toContain("admin role");
  });

  it("keeps company settings private in the KV cache", async () => {
    const first = await newUser();
    const second = await newUser();
    await callTool(
      "update_company_settings",
      { currency: "PKR", fiscalYearStart: 7, salesThreshold: "500.00" },
      first.token,
    );
    const firstRead = await callTool("get_company_settings", {}, first.token);
    const secondRead = await callTool("get_company_settings", {}, second.token);
    expect(JSON.stringify(firstRead)).toContain("PKR");
    expect(JSON.stringify(secondRead)).not.toContain("PKR");
    expect((firstRead.structuredContent as { cacheKey: string }).cacheKey).toBe(
      tenantKey(
        {
          orgId: first.orgId,
          userId: first.userId,
          role: "admin",
          tier: "shared",
          databaseBinding: "HYPERDRIVE",
          requestId: "req",
        },
        "settings",
      ),
    );
  });
});
