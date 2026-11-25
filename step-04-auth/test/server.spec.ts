import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth-options";

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

async function rpc(
  method: string,
  params: Record<string, unknown>,
  token?: string,
) {
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
  const dataLine = text
    .split("\n")
    .find((line: string) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine ? dataLine.slice("data: ".length) : text) as RpcPayload;
  return { response, payload };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  token: string,
) {
  const { payload } = await rpc("tools/call", { name, arguments: args }, token);
  if (!payload.result) {
    throw new Error(`tool call failed: ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

async function createUser(role: "admin" | "member" = "admin", join?: TestIdentity) {
  const email = `user-${crypto.randomUUID()}@example.com`;
  const userId = await signUp(email);
  const personal = await identityFor(userId);
  if (join) {
    await addMember(userId, join.orgId, role);
    return { userId, orgId: join.orgId, role, token: await tokenFor({ userId, orgId: join.orgId, role }) };
  }
  return { userId, orgId: personal.orgId, role: personal.role, token: await tokenFor(personal) };
}

describe("step 04 auth and tenant isolation", () => {
  it("rejects MCP requests without a bearer token", async () => {
    const { response, payload } = await rpc("tools/list", {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeTruthy();
    expect(payload.error).toBeTruthy();
  });

  it("lists tools including the admin tool", async () => {
    const user = await createUser();
    const { payload } = await rpc("tools/list", {}, user.token);
    const names = (payload.result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_notes",
        "get_note",
        "create_note",
        "delete_note",
        "list_company_members",
      ]),
    );
  });

  it("keeps notes and resources private to one user", async () => {
    const owner = await createUser();
    const other = await createUser("member", owner);

    const created = await callTool(
      "create_note",
      { title: "Private note", body: "Only the owner may read this" },
      owner.token,
    );
    const structured = created.structuredContent as { note: { id: string } };
    const id = structured.note.id;

    const listed = await callTool("list_notes", {}, owner.token);
    expect(JSON.stringify(listed)).toContain(id);

    const otherList = await callTool("list_notes", {}, other.token);
    expect(JSON.stringify(otherList)).not.toContain(id);

    const foreignRead = await rpc("tools/call", { name: "get_note", arguments: { id } }, other.token);
    expect(foreignRead.payload.result?.isError).toBe(true);

    const resources = await rpc("resources/list", {}, owner.token);
    const items = resources.payload.result?.resources as { uri: string }[];
    expect(items.some((item) => item.uri === `note://${id}`)).toBe(true);

    const read = await rpc("resources/read", { uri: `note://${id}` }, owner.token);
    const contents = read.payload.result?.contents as { text: string }[];
    expect(contents[0].text).toContain("Only the owner may read this");
  });

  it("allows admins to list company members and blocks members", async () => {
    const admin = await createUser();
    const member = await createUser("member", admin);

    const allowed = await callTool("list_company_members", {}, admin.token);
    const allowedData = allowed.structuredContent as {
      members: { id: string; role: string }[];
    };
    expect(allowedData.members.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([admin.userId, member.userId]),
    );

    const blocked = await callTool(
      "list_company_members",
      {},
      member.token,
    );
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked)).toContain("admin role");
  });

  it("lists and gets prompts for signed-in users", async () => {
    const user = await createUser();
    const listed = await rpc("prompts/list", {}, user.token);
    const names = (listed.payload.result?.prompts as { name: string }[]).map(
      (prompt) => prompt.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(["summarize_notes", "draft_note_from_meeting"]),
    );

    const prompt = await rpc(
      "prompts/get",
      { name: "summarize_notes", arguments: { tag: "client" } },
      user.token,
    );
    const messages = prompt.payload.result?.messages as {
      content: { text: string };
    }[];
    expect(messages[0].content.text).toContain("client");
  });
});
