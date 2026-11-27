import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ImportMessage, consumeImports, importOrderRef, parseCsv } from "../src/imports";
import { plantCompany, removeCompany, uniqueOrg } from "./fixtures";
import { asOwner, clientAs, hasDatabase, tenantCtx, testForTenant } from "./helpers";

describe("CSV handling (no database needed)", () => {
  it("reads quoted fields, escaped quotes and CRLF line ends", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n1,2')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", "2"],
    ]);
  });

  it("refuses a CSV with the wrong header, before anything is queued", async () => {
    const client = clientAs(tenantCtx({ orgId: uniqueOrg("csv") }));
    const bad = await client.callTool("bulk_import_orders", { csv: "date,email,item,qty\n2025-01-01,a@b.co,X,1" });
    expect(bad.content[0].text).toContain("The first line must be exactly: order_date,customer_email,product,quantity");
  });
});

/** Adds a user and their membership to the local D1, so the consumer's membership check passes. */
async function makeMember(orgId: string, userId: string) {
  const now = new Date().toISOString();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(
      `INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)`,
    ).bind(userId, userId, `${userId}@example.com`, now, now),
    env.AUTH_DB.prepare(`INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`).bind(
      orgId,
      orgId,
      orgId,
      now,
    ),
    env.AUTH_DB.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'admin', ?)`).bind(
      crypto.randomUUID(),
      orgId,
      userId,
      now,
    ),
  ]);
}

describe.skipIf(!hasDatabase)("bulk imports through the queue (needs Neon)", () => {
  const org = uniqueOrg("imports");
  const userId = `importer-${crypto.randomUUID().slice(0, 6)}`;
  const ctx = tenantCtx({ orgId: org, userId });
  let email = "";
  beforeAll(async () => {
    email = (await plantCompany(org, "I")).email;
    await makeMember(org, userId);
  });
  afterAll(async () => {
    await asOwner(`DELETE FROM imports WHERE org_id = $1`, [org]); // rows cascade
    await removeCompany(org);
  });

  const csv = () =>
    [
      "order_date,customer_email,product,quantity",
      `2025-03-01,${email},Matrix Product,2`,
      `2025-03-02,${email},"Matrix Product",1`,
      `03/04/2025,${email},Matrix Product,1`, // bad date
      `2025-03-05,${email},Flux Capacitor,1`, // unknown product
      `2025-03-06,${email},Matrix Product,0`, // bad quantity
    ].join("\n");

  it("imports in the background: the tool answers at once, the consumer does the work, status reports it", { timeout: 120_000 }, async () => {
    const client = clientAs(ctx);
    const started = await client.callTool("bulk_import_orders", { csv: csv() });
    expect(started.structuredContent).toMatchObject({ rows: 5, batches: 1 });
    const id = started.structuredContent.import_id;

    // The local queue delivers to the Worker's consumer; wait for it to finish.
    let status;
    for (let i = 0; i < 40; i++) {
      status = (await client.callTool("get_import_status", { import_id: id })).structuredContent;
      if (status.finished) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!status?.finished) throw new Error(`Import didn't finish: ${JSON.stringify(status)}`);
    expect(status).toMatchObject({ total_rows: 5, done: 2, failed: 3, pending: 0, finished: true });
    expect(status.failures.map((f: { row: number }) => f.row)).toEqual([3, 4, 5]);
    expect(status.failures[1].error).toContain("aren't in your company's catalog");

    const dates = await testForTenant(ctx, (db) =>
      db.query(`SELECT order_ref, to_char(order_date, 'YYYY-MM-DD') AS d FROM orders WHERE order_ref LIKE 'IMP-%' ORDER BY 1`),
    );
    expect(dates).toEqual([
      { order_ref: importOrderRef(id, 1), d: "2025-03-01" },
      { order_ref: importOrderRef(id, 2), d: "2025-03-02" },
    ]);
  });

  it("a message delivered twice creates each order only once", async () => {
    const importId = crypto.randomUUID();
    await asOwner(`INSERT INTO imports (org_id, import_id, created_by, total_rows) VALUES ($1, $2, $3, 1)`, [org, importId, userId]);
    const body: ImportMessage = {
      envelope: { orgId: org, userId, requestId: "r1" },
      importId,
      rows: [{ row: 1, order_date: "2025-04-01", customer_email: email, product: "Matrix Product", quantity: "1" }],
    };
    for (const attempt of [1, 2]) {
      const batch = createMessageBatch<ImportMessage>("order-imports", [
        { id: `m${attempt}`, timestamp: new Date(), attempts: attempt, body },
      ]);
      const ctxExec = createExecutionContext();
      await consumeImports(batch, env);
      const result = await getQueueResult(batch, ctxExec);
      expect(result.explicitAcks).toEqual([`m${attempt}`]);
    }
    const orders = await testForTenant(ctx, (db) =>
      db.query(`SELECT 1 FROM orders WHERE order_ref = $1`, [importOrderRef(importId, 1)]),
    );
    expect(orders).toHaveLength(1);
  });

  it("drops a message whose user is no longer a member, or whose import belongs to another company", async () => {
    const importId = crypto.randomUUID();
    await asOwner(`INSERT INTO imports (org_id, import_id, created_by, total_rows) VALUES ($1, $2, $3, 1)`, [org, importId, userId]);
    const row = { row: 1, order_date: "2025-05-01", customer_email: email, product: "Matrix Product", quantity: "1" };
    const otherOrg = uniqueOrg("other");
    await makeMember(otherOrg, userId);
    for (const envelope of [
      { orgId: org, userId: "not-a-member", requestId: "r2" },
      { orgId: otherOrg, userId, requestId: "r3" }, // a real member of ANOTHER company naming org's import
    ]) {
      const batch = createMessageBatch<ImportMessage>("order-imports", [
        { id: "x", timestamp: new Date(), attempts: 1, body: { envelope, importId, rows: [row] } },
      ]);
      await consumeImports(batch, env);
      expect((await getQueueResult(batch, createExecutionContext())).explicitAcks).toEqual(["x"]);
    }
    const handled = await testForTenant(ctx, (db) => db.query(`SELECT 1 FROM import_rows WHERE import_id = $1`, [importId]));
    expect(handled).toEqual([]);
  });

  it("another company can't read this company's import status", async () => {
    const started = await clientAs(ctx).callTool("bulk_import_orders", { csv: csv() });
    const theirs = await clientAs(tenantCtx({ orgId: uniqueOrg("nosy") })).callTool("get_import_status", {
      import_id: started.structuredContent.import_id,
    });
    expect(theirs.content[0].text).toContain("was found in your company");
  });
});
