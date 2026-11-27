import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lookupPlacement, tenantKey } from "../../src/tenant";
import { createTenantRouter } from "../../src/tenant-router";
import { plantCompany, removeCompany, uniqueOrg } from "../../test/fixtures";
import {
  DEDICATED,
  asOwner,
  clientAs,
  hasDedicated,
  inRolledBackTransaction,
  sharedForTenant,
  tenantCtx,
  testForTenant,
} from "../../test/helpers";

/**
 * THE CROSS-TENANT SUITE: two companies, one on the SHARED tier (S) and one on the
 * DEDICATED tier (D, in its own database). Each tries to reach the other through every
 * tool, resource, cache key and database path. Every attempt must fail.
 */

const S = uniqueOrg("tenancy-shared");
const D = uniqueOrg("tenancy-dedicated");
const ctxS = tenantCtx({ orgId: S, userId: "sam" });
const ctxD = tenantCtx({ orgId: D, userId: "dana", ...DEDICATED });
let refS = "";
let refD = "";

describe.skipIf(!hasDedicated)("cross-tenant isolation: shared vs dedicated (needs Neon and a dedicated database)", () => {
  beforeAll(async () => {
    refS = (await plantCompany(S, "S")).orderRef;
    refD = (await plantCompany(D, "D", DEDICATED.database)).orderRef;
    // D lives in its own database: recorded in the SHARED database's tenants table.
    await asOwner(`INSERT INTO tenants (org_id, tier, db_binding) VALUES ($1, 'dedicated', $2)`, [D, DEDICATED.database]);
  });
  afterAll(async () => {
    await removeCompany(S);
    await removeCompany(D, DEDICATED.database);
    await env.TENANT_CACHE.delete(tenantKey({ orgId: D }, "placement"));
  });

  describe("the router", () => {
    it("finds where each company lives from the tenants table", async () => {
      expect(await lookupPlacement(env, S)).toEqual({ tier: "shared", database: "HYPERDRIVE" });
      expect(await lookupPlacement(env, D)).toEqual({ tier: "dedicated", database: "TENANT_DB_ENTERPRISE" });
    });

    it("keeps each company's rows in its own database", async () => {
      const inShared = await asOwner(`SELECT org_id FROM orders WHERE org_id = ANY($1)`, [[S, D]]);
      const inDedicated = await asOwner(`SELECT org_id FROM orders WHERE org_id = ANY($1)`, [[S, D]], DEDICATED.database);
      expect(inShared).toEqual([{ org_id: S }]);
      expect(inDedicated).toEqual([{ org_id: D }]);
    });

    it("runs the same tool code for both tiers", async () => {
      for (const [ctx, ref] of [
        [ctxS, () => refS],
        [ctxD, () => refD],
      ] as const) {
        const list = await clientAs(ctx).callTool("list_orders", {});
        expect(list.structuredContent.orders.map((o: { order_ref: string }) => o.order_ref)).toEqual([ref()]);
      }
    });

    it("fails closed: a dedicated company with an unknown database never falls back to the shared one", async () => {
      const lost = { orgId: D, tier: "dedicated" as const, database: "TENANT_DB_MISSING" };
      await expect(createTenantRouter(env)(lost, (db) => db.query("SELECT 1"))).rejects.toThrow(/No Hyperdrive binding/);
      const bad = { orgId: D, tier: "dedicated" as const, database: "HYPERDRIVE; DROP TABLE orders" };
      await expect(createTenantRouter(env)(bad, (db) => db.query("SELECT 1"))).rejects.toThrow(/Invalid dedicated/);
    });
  });

  for (const [me, them, myRef, theirRef] of [
    ["shared", "dedicated", () => refS, () => refD],
    ["dedicated", "shared", () => refD, () => refS],
  ] as const) {
    describe(`as the ${me} company, reaching for the ${them} one`, () => {
      const ctx = () => (me === "shared" ? ctxS : ctxD);

      it("a guessed order reference reads exactly like one that doesn't exist", async () => {
        const client = clientAs(ctx());
        const theirs = await client.callTool("get_order", { order_ref: theirRef() });
        const missing = await client.callTool("get_order", { order_ref: "MX-NOPE1" });
        expect(theirs.isError).toBe(true);
        expect(theirs.content[0].text.replace(theirRef(), "<ref>")).toBe(missing.content[0].text.replace("MX-NOPE1", "<ref>"));
        expect((await client.callTool("get_order", { order_ref: myRef() })).isError).toBeFalsy();
      });

      it("a guessed resource URI is refused", async () => {
        const client = clientAs(ctx());
        expect((await client.rpc("resources/read", { uri: `order://${theirRef()}` })).error).toBeTruthy();
        const mine = await client.rpc("resources/read", { uri: `order://${myRef()}` });
        expect(mine.result.contents[0].text).toContain(`# Order ${myRef()}`);
      });

      it("summaries and the schema count only its own rows", async () => {
        const client = clientAs(ctx());
        const summary = await client.callTool("get_sales_summary", { group_by: "customer" });
        expect(summary.structuredContent.total).toEqual({ orders: 1, units: 2, revenue: 20 });
        const schema = await client.callTool("describe_schema", {});
        const counts = schema.structuredContent.tables.map((t: { rowsInYourCompany: number }) => t.rowsInYourCompany);
        expect(counts).toEqual([1, 1, 1, 1, 1]);
      });

      it("its own customer is the only one it can order for", async () => {
        const theirEmail = `buyer@${them === "shared" ? "s" : "d"}.example.com`;
        const result = await clientAs(ctx()).callTool("create_order", {
          customer_email: theirEmail,
          items: [{ product: "Matrix Product", quantity: 1 }],
        });
        expect(result.isError).toBe(true);
      });
    });
  }

  describe("settings and cache keys", () => {
    it("one company's settings and cache never reach the other", async () => {
      await clientAs(ctxS).callTool("update_company_settings", { currency: "EUR", sales_threshold: 5 });
      await clientAs(ctxD).callTool("update_company_settings", { currency: "GBP" });

      const s = await clientAs(ctxS).callTool("get_company_settings", {});
      const d = await clientAs(ctxD).callTool("get_company_settings", {});
      expect(s.structuredContent).toMatchObject({ currency: "EUR", sales_threshold: 5 });
      expect(d.structuredContent).toMatchObject({ currency: "GBP", sales_threshold: 1000 });

      // Each company's cache entry sits under its own key and holds its own values.
      const cachedS = await env.TENANT_CACHE.get(tenantKey(ctxS, "settings"), "json");
      const cachedD = await env.TENANT_CACHE.get(tenantKey(ctxD, "settings"), "json");
      expect(cachedS).toMatchObject({ currency: "EUR" });
      expect(cachedD).toMatchObject({ currency: "GBP" });

      // The dedicated company's settings row is in its own database, not the shared one.
      expect(await asOwner(`SELECT org_id FROM company_settings WHERE org_id = $1`, [D])).toEqual([]);
    });

    it("the company's settings change its results: same code, different rules", async () => {
      const s = await clientAs(ctxS).callTool("get_sales_summary", { group_by: "month" });
      expect(s.structuredContent.currency).toBe("EUR");
      expect(s.structuredContent.groups[0].at_or_above_threshold).toBe(true); // 20 >= 5
    });
  });

  describe("with the WHERE clause removed, row-level security still holds in both databases", () => {
    for (const [name, ctx, binding] of [
      ["shared", () => ctxS, "HYPERDRIVE"],
      ["dedicated", () => ctxD, DEDICATED.database],
    ] as const) {
      it(`${name}: a query with no WHERE sees only its own company`, async () => {
        const rows = await testForTenant(ctx(), (db) => db.query<{ org_id: string }>(`SELECT DISTINCT org_id FROM orders`));
        expect(rows).toEqual([{ org_id: ctx().orgId }]);
      });

      it(`${name}: with no company set, nothing at all`, async () => {
        await inRolledBackTransaction(async (db, asConnector) => {
          await asConnector(null);
          expect(await db.query(`SELECT 1 FROM orders LIMIT 1`)).toEqual([]);
        }, binding);
      });
    }

    it("the dedicated company's data is not in the shared database at all, even with the right company set", async () => {
      const rows = await sharedForTenant({ orgId: D }, (db) => db.query(`SELECT 1 FROM orders`));
      expect(rows).toEqual([]);
    });
  });
});
