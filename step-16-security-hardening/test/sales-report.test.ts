import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asOwner, clientAs, hasDatabase, LATEST_PROTOCOL, sealedToken, tenantCtx } from "./helpers";

/** Adds a user and their membership to the local D1, so the Workflow's membership check passes. */
async function makeMember(orgId: string, userId: string, role = "admin") {
  const now = new Date().toISOString();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(
      `INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)`,
    ).bind(userId, userId, `${userId}@example.com`, now, now),
    env.AUTH_DB.prepare(`INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`).bind(orgId, orgId, orgId, now),
    env.AUTH_DB.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`).bind(
      crypto.randomUUID(),
      orgId,
      userId,
      role,
      now,
    ),
  ]);
}

const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean, seconds = 60): Promise<T> => {
  for (let i = 0; i < seconds; i++) {
    const v = await read();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for the report");
};

const approve = async (client: ReturnType<typeof clientAs>, report_id: string) => {
  const first = await client.callTool("approve_report", { report_id }, LATEST_PROTOCOL);
  expect(first.resultType).toBe("input_required");
  return client.callTool(
    "approve_report",
    { report_id, confirmationToken: sealedToken(first) },
    LATEST_PROTOCOL,
  );
};

describe.skipIf(!hasDatabase)("generate_sales_report Workflow (needs Neon)", () => {
  // The demo company: 145 orders in 2025, so the Workflow reads two pages (100 + 45).
  const userId = `reporter-${crypto.randomUUID().slice(0, 6)}`;
  const admin = clientAs(tenantCtx({ orgId: "demo", userId }));
  const member = clientAs(tenantCtx({ orgId: "demo", userId, role: "member" }));
  const started: string[] = [];
  beforeAll(() => makeMember("demo", userId));
  afterAll(async () => {
    if (started.length) await asOwner(`DELETE FROM reports WHERE report_id = ANY($1)`, [started]);
  });

  it("builds the report in durable steps, waits for approval, then publishes", { timeout: 180_000 }, async () => {
    const start = await admin.callTool("start_sales_report", { year: 2025 });
    const id = start.structuredContent.report_id;
    started.push(id);

    const ready = await until(
      () => admin.callTool("get_report_status", { report_id: id }),
      (r) => r.structuredContent?.stage === "awaiting_approval",
      120,
    );
    const report = ready.structuredContent.report;
    expect(report.orders).toBe(145);
    expect(report.months).toHaveLength(12);
    // The report agrees with the live summary tool.
    const summary = await admin.callTool("get_sales_summary", { group_by: "month", from: "2025-01-01", to: "2025-12-31" });
    expect(report.revenue).toBe(summary.structuredContent.total.revenue);
    expect(report.topProducts).toHaveLength(5);

    // Only an admin may approve.
    const refused = await member.callTool("approve_report", { report_id: id });
    expect(refused.content[0].text).toContain("Forbidden (403)");

    expect((await approve(admin, id)).structuredContent.approved).toBe(true);
    const published = await until(
      () => admin.callTool("get_report_status", { report_id: id }),
      (r) => r.structuredContent?.stage === "published",
    );
    expect(published.structuredContent.run_status).toBe("complete");
    // Approving twice is refused politely: it's no longer awaiting approval.
    expect((await approve(admin, id)).content[0].text).toContain("not awaiting approval");
  });

  it("another company can't see or approve this company's report", async () => {
    const start = await admin.callTool("start_sales_report", { year: 2024 });
    const id = start.structuredContent.report_id;
    started.push(id);
    const nosy = clientAs(tenantCtx({ orgId: "someone-else", userId }));
    expect((await nosy.callTool("get_report_status", { report_id: id })).content[0].text).toContain("was found in your company");
    expect((await approve(nosy, id)).content[0].text).toContain("was found in your company");
  });

  it("a run started by someone who's no longer a member fails without reading anything", { timeout: 120_000 }, async () => {
    const ghost = clientAs(tenantCtx({ orgId: "demo", userId: "never-a-member" }));
    const start = await ghost.callTool("start_sales_report", { year: 2025 });
    const id = start.structuredContent.report_id;
    started.push(id);
    const failed = await until(
      () => admin.callTool("get_report_status", { report_id: id }),
      (r) => r.structuredContent?.stage === "failed",
      90,
    );
    expect(failed.structuredContent.report).toBeNull();
    expect(failed.structuredContent.run_status).toBe("errored");
    expect(failed.structuredContent.error).toBeTruthy();
  });
});
