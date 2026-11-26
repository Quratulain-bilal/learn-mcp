import { env, exports } from "cloudflare:workers";
import type { SqlClient, SqlQuery } from "../src/db-client";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth-options";
import { createMemorySalesStore } from "../src/memory-sales";
import { auditRlsMigration, auditTenantTransaction } from "../src/rls-audit";
import { createNeonSalesStore } from "../src/sales";
import rlsMigration from "../db/migrations/004_row_level_security.sql?raw";
import tenantMigration from "../db/migrations/005_tenant_registry.sql?raw";
import settingsMigration from "../db/migrations/006_company_settings.sql?raw";
import vectorMigration from "../db/migrations/007_pgvector.sql?raw";

const BASE_URL = "https://example.com";
const RESOURCE = `${BASE_URL}/mcp`;
const SECRET = "test-better-auth-secret-change-me";

interface TestIdentity {
  userId: string;
  orgId: string;
  role: string;
}

interface RpcPayload {
  result?: Record<string, unknown>;
  error?: { message?: string; code?: number };
}

async function signUp(email: string) {
  const response = await exports.default.fetch(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: email.split("@")[0],
        email,
        password: "StrongPass123!",
      }),
    }),
  );
  if (!response.ok) throw new Error(`Sign-up failed: ${await response.text()}`);
  const data = (await response.json()) as { user?: { id?: string } };
  const userId = data.user?.id;
  if (!userId) throw new Error("Sign-up did not return a user id");
  return userId;
}

async function identityFor(userId: string): Promise<TestIdentity> {
  const row = await env.AUTH_DB.prepare(
    "SELECT organizationId, role FROM member WHERE userId = ?",
  )
    .bind(userId)
    .first<{ organizationId: string; role: string }>();
  if (!row) throw new Error(`No membership row for ${userId}`);
  return { userId, orgId: row.organizationId, role: row.role };
}

async function addMember(userId: string, orgId: string, role: string) {
  const now = Date.now();
  await env.AUTH_DB.prepare(
    "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(`member-${crypto.randomUUID()}`, orgId, userId, role, now)
    .run();
}

async function tokenFor(identity: TestIdentity) {
  const auth = createAuth({
    baseURL: BASE_URL,
    resource: RESOURCE,
    secret: SECRET,
    database: env.AUTH_DB,
  });
  const result = (await auth.api.signJWT({
    body: {
      payload: {
        sub: identity.userId,
        org_id: identity.orgId,
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

async function createUser(role: "admin" | "member" = "admin", join?: TestIdentity) {
  const email = `user-${crypto.randomUUID()}@example.com`;
  const userId = await signUp(email);
  const personal = await identityFor(userId);
  if (join) {
    await addMember(userId, join.orgId, role);
    return {
      userId,
      orgId: join.orgId,
      role,
      token: await tokenFor({ userId, orgId: join.orgId, role }),
    };
  }
  return {
    userId,
    orgId: personal.orgId,
    role: personal.role,
    token: await tokenFor(personal),
  };
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

describe("step 08 tools and tenant isolation", () => {
  it("rejects MCP requests without a bearer token", async () => {
    const { response, payload } = await rpc("tools/list", {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeTruthy();
    expect(payload.error).toBeTruthy();
  });

  it("lists the read and write production tools", async () => {
    const user = await createUser();
    const { payload } = await rpc("tools/list", {}, user.token);
    const names = (payload.result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "describe_schema",
        "answer_business_question",
        "compare_designs",
        "list_orders",
        "get_sales_summary",
        "create_order",
        "list_my_companies",
        "get_company_settings",
        "update_company_settings",
        "invite_member",
        "remove_member",
        "search_sales_policy",
        "find_products",
        "add_policy_document",
      ]),
    );
  });

  it("pages orders and keeps another company's orders out", async () => {
    const owner = await createUser();
    const other = await createUser();
    const ownerResult = await callTool("list_orders", { limit: 2 }, owner.token);
    const otherResult = await callTool("list_orders", { limit: 2 }, other.token);
    expect(JSON.stringify(ownerResult)).toContain(owner.orgId);
    expect(JSON.stringify(ownerResult)).not.toContain(other.orgId);
    expect(JSON.stringify(otherResult)).toContain(other.orgId);
    expect(JSON.stringify(otherResult)).not.toContain(owner.orgId);
    const ownerText = (ownerResult.content as { text: string }[])[0].text;
    expect(ownerText).toContain("next cursor");
    expect(ownerText).toContain(owner.orgId);
  });

  it("summarizes sales by month and product", async () => {
    const user = await createUser();
    const monthly = await callTool("get_sales_summary", { groupBy: "month" }, user.token);
    const products = await callTool("get_sales_summary", { groupBy: "product" }, user.token);
    expect(JSON.stringify(monthly)).toContain(user.orgId);
    expect(JSON.stringify(products)).toContain(user.orgId);
    expect((monthly.content as { text: string }[])[0].text).toContain(user.orgId);
  });

  it("creates an order for the signed-in company", async () => {
    const user = await createUser();
    const orderId = `ORD-${crypto.randomUUID().slice(0, 8)}`;
    const result = await callTool(
      "create_order",
      {
        orderId,
        customerId: "cust-ayesha",
        orderDate: "2026-07-01",
        items: [{ productId: "prod-laptop", quantity: 2 }],
      },
      user.token,
    );
    expect(JSON.stringify(result)).toContain(orderId);
  });

  it("compares designs and lists the schema prompt", async () => {
    const user = await createUser();
    const compared = await callTool("compare_designs", { question: "top_products" }, user.token);
    expect(compared.structuredContent).toBeTruthy();
    const listed = await rpc("prompts/list", {}, user.token);
    const names = (listed.payload.result?.prompts as { name: string }[]).map(
      (prompt) => prompt.name,
    );
    expect(names).toContain("explain_sales_schema");
  });

  it("uses qualified table names in the schema key query", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const store = createNeonSalesStore(fakeSql(calls));
    await store.describeSchema();
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain("tc.table_name = 'flat_sales'");
  });
});

describe("data matrix", () => {
  it("checks every read tool from two companies against each other's rows", async () => {
    const store = createMemorySalesStore();
    const orgA = "org-matrix-a";
    const orgB = "org-matrix-b";
    const orderId = "ORD-MATRIX-1";

    await store.createOrder(orgA, {
      orderId,
      customerId: "cust-ayesha",
      orderDate: "2026-07-02",
      items: [{ productId: "prod-mouse", quantity: 1 }],
    });

    for (const [org, other] of [[orgA, orgB], [orgB, orgA]] as const) {
      const orders = JSON.stringify(await store.listOrders(org, { limit: 50 }));
      const summary = JSON.stringify(await store.getSalesSummary(org, "month"));
      const answer = JSON.stringify(await store.answer(org, "monthly_revenue"));
      const compared = JSON.stringify(await store.compare(org, "top_products"));
      for (const result of [orders, summary, answer, compared]) {
        expect(result).not.toContain(other);
      }
      expect(orders).toContain(org);
      expect(summary).toContain(org);
    }

    expect(JSON.stringify(await store.listOrders(orgB, { limit: 50 }))).not.toContain(orderId);
  });
});

describe("row-level security and tenant transactions", () => {
  it("forces a USING and WITH CHECK policy on every business table", async () => {
    expect(auditRlsMigration(rlsMigration)).toEqual([]);
  });

  it("protects the tenant registry, company settings and retrieval tables too", async () => {
    expect(auditRlsMigration(tenantMigration, ["public.tenants"])).toEqual([]);
    expect(auditRlsMigration(settingsMigration, ["public.company_settings"])).toEqual([]);
    expect(
      auditRlsMigration(vectorMigration, [
        "public.policy_documents",
        "public.policy_passages",
      ]),
    ).toEqual([]);
  });

  it("catches planted missing FORCE, missing WITH CHECK and missing policy bugs", async () => {
    const missingForce = auditRlsMigration(
      rlsMigration.replaceAll("FORCE ROW LEVEL SECURITY", "NO FORCE ROW LEVEL SECURITY"),
    );
    const missingCheck = auditRlsMigration(
      rlsMigration.replaceAll("WITH CHECK (org_id = current_setting('app.tenant_id', true))", ""),
    );
    const missingPolicy = auditRlsMigration(
      rlsMigration.replaceAll("CREATE POLICY tenant_isolation", "CREATE POLICY wrong_policy"),
    );
    expect(missingForce.some((finding) => finding.issue.includes("forced"))).toBe(true);
    expect(missingCheck.some((finding) => finding.issue.includes("WITH CHECK"))).toBe(true);
    expect(missingPolicy.some((finding) => finding.issue.includes("policy"))).toBe(true);
  });

  it("sets app.tenant_id before every sales query", async () => {
    const store = createNeonSalesStore(fakeSql([]));
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const guardedStore = createNeonSalesStore(fakeSql(calls));
    expect(store).toBeTruthy();

    await guardedStore.answer("org-123", "monthly_revenue");
    expect(auditTenantTransaction(calls)).toEqual([]);
    expect(calls[0].params).toEqual(["org-123"]);

    calls.length = 0;
    await guardedStore.listOrders("org-123", { limit: 10 });
    expect(auditTenantTransaction(calls)).toEqual([]);
    expect(calls[0].params).toEqual(["org-123"]);

    calls.length = 0;
    await guardedStore.getSalesSummary("org-123", "product");
    expect(auditTenantTransaction(calls)).toEqual([]);

    calls.length = 0;
    await guardedStore.compare("org-123", "top_products");
    expect(auditTenantTransaction(calls)).toEqual([]);

    calls.length = 0;
    await guardedStore.createOrder("org-123", {
      orderId: "ORD-TEST-1",
      customerId: "cust-ayesha",
      orderDate: "2026-07-01",
      items: [{ productId: "prod-laptop", quantity: 1 }],
    }).catch(() => undefined);
    expect(auditTenantTransaction(calls)).toEqual([]);
  });

  it("catches a planted query outside forTenant", async () => {
    expect(
      auditTenantTransaction([{ text: "SELECT * FROM orders WHERE org_id = $1" }]),
    ).toContain("The query ran outside forTenant; app.tenant_id was not set first.");
  });
});
