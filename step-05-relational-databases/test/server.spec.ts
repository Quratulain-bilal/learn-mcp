import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth-options";
import { createNeonSalesStore, type SqlClient } from "../src/sales";

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

describe("step 05 sales tools and tenant isolation", () => {
  it("rejects MCP requests without a bearer token", async () => {
    const { response, payload } = await rpc("tools/list", {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeTruthy();
    expect(payload.error).toBeTruthy();
  });

  it("lists the three read-only sales tools", async () => {
    const user = await createUser();
    const { payload } = await rpc("tools/list", {}, user.token);
    const names = (payload.result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "describe_schema",
        "answer_business_question",
        "compare_designs",
      ]),
    );
  });

  it("scopes business answers to the signed-in company", async () => {
    const owner = await createUser();
    const other = await createUser();

    const ownerResult = await callTool(
      "answer_business_question",
      { question: "monthly_revenue" },
      owner.token,
    );
    const otherResult = await callTool(
      "answer_business_question",
      { question: "monthly_revenue" },
      other.token,
    );

    expect(JSON.stringify(ownerResult)).toContain(owner.orgId);
    expect(JSON.stringify(ownerResult)).not.toContain(other.orgId);
    expect(JSON.stringify(otherResult)).toContain(other.orgId);
    expect(JSON.stringify(otherResult)).not.toContain(owner.orgId);
  });

  it("compares flat and normalized designs", async () => {
    const user = await createUser();
    const result = await callTool(
      "compare_designs",
      { question: "top_products" },
      user.token,
    );
    const structured = result.structuredContent as {
      flat: { source: string }[];
      normalized: { source: string }[];
    };
    expect(structured.flat[0].source).toBe("flat");
    expect(structured.normalized[0].source).toBe("normalized");
  });

  it("lists the schema prompt for signed-in users", async () => {
    const user = await createUser();
    const listed = await rpc("prompts/list", {}, user.token);
    const names = (listed.payload.result?.prompts as { name: string }[]).map(
      (prompt) => prompt.name,
    );
    expect(names).toContain("explain_sales_schema");
  });
});

describe("fixed SQL sales store", () => {
  it("passes the company id as a parameter and never accepts model SQL", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const sql: SqlClient = {
      async query<T>(text: string, params?: unknown[]) {
        calls.push({ text, params });
        return [] as readonly T[];
      },
    };
    const store = createNeonSalesStore(sql);
    const orgId = "org-123";

    await store.answer(orgId, "best_customers");

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([orgId]);
    expect(calls[0].text).toContain("WHERE o.org_id = $1");
    expect(calls[0].text).toContain("JOIN customers");
  });
});
