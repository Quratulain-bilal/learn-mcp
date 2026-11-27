import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hasDatabase, workerRpc } from "./helpers";
import { connect, signUp } from "./oauth";

const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}@example.com`;

describe("OAuth protection of /mcp", () => {
  it("rejects a request with no token: 401 with a pointer to the discovery metadata", async () => {
    const { response } = await workerRpc("tools/list", {});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("serves protected-resource and authorization-server metadata", async () => {
    const prmRes = await exports.default.fetch("http://localhost/.well-known/oauth-protected-resource/mcp");
    const prm = await prmRes.json<Record<string, unknown>>();
    expect(prm.resource).toBe("http://localhost/mcp");
    expect(prm.scopes_supported).toContain("sales");

    const asRes = await exports.default.fetch("http://localhost/.well-known/oauth-authorization-server/api/auth");
    const as = await asRes.json<Record<string, unknown>>();
    expect(as.registration_endpoint).toBe("http://localhost/api/auth/oauth2/register");
    expect(as.code_challenge_methods_supported).toContain("S256");
  });

  it("rejects a tampered token", async () => {
    const { token } = await connect(unique("tamper"));
    const { response } = await workerRpc("tools/list", {}, token.slice(0, -2) + "xx");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

// Every MCP call now resolves the company's placement in Neon, so these need the database.
describe.skipIf(!hasDatabase)("sign-in, companies and roles (end to end)", () => {
  it("a new user gets a personal company, as admin, and a token bound to /mcp and that company", async () => {
    const { token, claims } = await connect(unique("ali"));
    expect(claims.aud).toContain("http://localhost/mcp");
    expect(claims.org_id).toBeTruthy();

    const { reply } = await workerRpc("tools/call", { name: "list_company_members", arguments: {} }, token);
    expect(reply?.result.isError).toBeFalsy();
    expect(reply?.result.structuredContent.members).toHaveLength(1);
    expect(reply?.result.structuredContent.members[0].role).toBe("admin");
  });

  it.skipIf(!hasDatabase)("sales tools use the company from the token, never the demo company", async () => {
    const ali = await connect(unique("ali"));
    const { reply } = await workerRpc("tools/call", { name: "describe_schema", arguments: {} }, ali.token);
    // A brand-new personal company has no sales rows, and the reply names that company.
    expect(reply?.result.structuredContent.tables.every((t: { rowsInYourCompany: number }) => t.rowsInYourCompany === 0)).toBe(true);
    expect(reply?.result.content[0].text).toContain(`--org ${ali.claims.org_id}`);
  });

  it("a member of another company can choose it but can't use the admin tool, and removal is immediate", async () => {
    const memberEmail = unique("member");
    const owner = await connect(unique("owner"));
    await signUp(memberEmail);

    // Add the member to the owner's company (as an admin would through an invitation).
    const memberRow = await env.AUTH_DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind(memberEmail)
      .first<{ id: string }>();
    await env.AUTH_DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)",
    )
      .bind(crypto.randomUUID(), owner.claims.org_id, memberRow!.id, Date.now())
      .run();
    const company = await env.AUTH_DB.prepare("SELECT name FROM organization WHERE id = ?")
      .bind(owner.claims.org_id)
      .first<{ name: string }>();

    // The member now belongs to two companies, so they pick one on /select-company.
    const member = await connect(memberEmail, { chooseCompany: company!.name });
    expect(member.claims.org_id).toBe(owner.claims.org_id);

    const denied = await workerRpc("tools/call", { name: "list_company_members", arguments: {} }, member.token);
    expect(denied.reply?.result.isError).toBe(true);
    expect(denied.reply?.result.content[0].text).toContain("403");

    // Removing them takes effect on the very next request, with the same token.
    await env.AUTH_DB.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?")
      .bind(owner.claims.org_id, memberRow!.id)
      .run();
    const removed = await workerRpc("tools/list", {}, member.token);
    expect(removed.response.status).toBe(403);
  });
});
