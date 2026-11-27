import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hasDatabase, LATEST_PROTOCOL, sealedToken, workerRpc } from "../../test/helpers";
import { authPost, connect, signIn, signUp } from "../../test/oauth";

/**
 * The tenant context, end to end through real OAuth tokens: the company comes from the
 * token, membership and role are re-checked on every request, and nothing a caller sends
 * can change the company.
 */

const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const call = (token: string, name: string, args: Record<string, unknown> = {}) =>
  workerRpc("tools/call", { name, arguments: args }, token);
const callLatest = (token: string, name: string, args: Record<string, unknown> = {}) =>
  workerRpc("tools/call", { name, arguments: args }, token, LATEST_PROTOCOL);
const companyName = async (orgId: string) =>
  (await env.AUTH_DB.prepare("SELECT name FROM organization WHERE id = ?").bind(orgId).first<{ name: string }>())!.name;

describe.skipIf(!hasDatabase)("one tenant context per request (needs Neon)", () => {
  it("an admin adds a member, the member works in that company, and removal locks them out on the next call", async () => {
    const owner = await connect(unique("owner"));
    const memberEmail = unique("member");
    await signUp(memberEmail);

    const added = await call(owner.token, "invite_member", { email: memberEmail });
    expect(added.reply?.result.isError).toBeFalsy();

    const member = await connect(memberEmail, { chooseCompany: await companyName(owner.claims.org_id) });
    expect(member.claims.org_id).toBe(owner.claims.org_id);
    const mine = await call(member.token, "list_my_companies");
    const companies = mine.reply?.result.structuredContent.companies;
    expect(companies).toHaveLength(2);
    expect(companies.find((c: { current: boolean }) => c.current).role).toBe("member");

    // A member can read settings but not change them, or manage people.
    expect((await call(member.token, "get_company_settings")).reply?.result.isError).toBeFalsy();
    for (const [tool, args] of [
      ["update_company_settings", { currency: "EUR" }],
      ["invite_member", { email: unique("x") }],
      ["remove_member", { email: unique("x") }],
    ] as const) {
      const denied = await call(member.token, tool, args);
      expect(denied.reply?.result.content[0].text, tool).toContain("Forbidden (403)");
    }

    const first = await callLatest(owner.token, "remove_member", { email: memberEmail });
    expect(first.reply?.result.resultType).toBe("input_required");
    const removed = await callLatest(owner.token, "remove_member", {
      email: memberEmail,
      confirmationToken: sealedToken(first.reply?.result),
    });
    expect(removed.reply?.result.structuredContent.removed).toBe(true);
    const after = await call(member.token, "get_company_settings");
    expect(after.response.status).toBe(403);
  });

  it("a demoted admin loses admin tools on the very next call, with the same token", async () => {
    const owner = await connect(unique("demoted"));
    expect((await call(owner.token, "update_company_settings", { currency: "PKR" })).reply?.result.isError).toBeFalsy();

    await env.AUTH_DB.prepare("UPDATE member SET role = 'member' WHERE organizationId = ? AND userId = ?")
      .bind(owner.claims.org_id, owner.claims.sub)
      .run();
    const denied = await call(owner.token, "update_company_settings", { currency: "EUR" });
    expect(denied.reply?.result.content[0].text).toContain("Forbidden (403)");
  });

  it("can't switch to a company the user doesn't belong to", async () => {
    const other = await connect(unique("other-owner"));
    const outsiderEmail = unique("outsider");
    await signUp(outsiderEmail);
    const session = await signIn(outsiderEmail);
    await expect(authPost(session, "/organization/set-active", { organizationId: other.claims.org_id })).rejects.toThrow(
      /403|not a member|FORBIDDEN/i,
    );
  });

  it("a tool argument naming another company is ignored: the token decides", async () => {
    const a = await connect(unique("a"));
    const b = await connect(unique("b"));
    await call(b.token, "update_company_settings", { currency: "JPY" });

    const reply = await call(a.token, "get_company_settings", { org_id: b.claims.org_id, orgId: b.claims.org_id });
    expect(reply.reply?.result.structuredContent.currency).toBe("USD");
  });

  it("no tool accepts a company or user id as input", async () => {
    const a = await connect(unique("schemas"));
    const { reply } = await workerRpc("tools/list", {}, a.token);
    for (const tool of reply?.result.tools ?? []) {
      const fields = Object.keys(tool.inputSchema.properties ?? {});
      expect(fields.filter((f) => /org|company|tenant|user_?id/i.test(f)), tool.name).toEqual([]);
    }
  });
});
