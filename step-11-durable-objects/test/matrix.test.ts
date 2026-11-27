import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SALES_TABLES } from "../src/db";
import { plantCompany, removeCompany, uniqueOrg } from "./fixtures";
import { clientAs, hasDatabase, tenantCtx, inRolledBackTransaction, testForTenant } from "./helpers";

/**
 * THE DATA MATRIX (book lesson 19.12): act as company A against every table and every
 * tool, and find nothing of company B's. Then plant three bugs, each inside a transaction
 * that is always rolled back, and check the matrix catches each one.
 */

const TABLES = [...SALES_TABLES, "staging.flat_sales"];
const A = uniqueOrg("matrix-a");
const B = uniqueOrg("matrix-b");
let refA = "";
let refB = "";

/** The matrix's core check: every row returned belongs to company A. */
const onlyCompanyA = (rows: { org_id: string }[]) => rows.every((r) => r.org_id === A);

describe.skipIf(!hasDatabase)("data matrix: company A can never reach company B (needs Neon)", () => {
  beforeAll(async () => {
    refA = (await plantCompany(A, "A")).orderRef;
    refB = (await plantCompany(B, "B")).orderRef;
  });
  afterAll(async () => {
    await removeCompany(A);
    await removeCompany(B);
  });

  describe("every table, as the Worker's role", () => {
    for (const table of TABLES) {
      it(`${table}: reading sees only A, even with no WHERE clause and when asking for B by name`, async () => {
        const { all, asB } = await testForTenant({ orgId: A }, async (db) => ({
          all: await db.query<{ org_id: string }>(`SELECT org_id FROM ${table}`),
          asB: await db.query<{ org_id: string }>(`SELECT org_id FROM ${table} WHERE org_id = $1`, [B]),
        }));
        expect(all.length).toBeGreaterThan(0);
        expect(onlyCompanyA(all)).toBe(true);
        expect(asB).toEqual([]);
      });
    }

    it("writing a row for company B is refused (WITH CHECK)", async () => {
      await expect(
        testForTenant({ orgId: A }, (db) =>
          db.query(`INSERT INTO orders (org_id, order_ref, customer_id, order_date) VALUES ($1, 'MX-STEAL', 900001, CURRENT_DATE)`, [B]),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("updating or deleting is refused outright: the role only has SELECT and INSERT", async () => {
      for (const sql of [`UPDATE orders SET order_date = CURRENT_DATE`, `DELETE FROM order_items`, `DELETE FROM customers`]) {
        await expect(testForTenant({ orgId: A }, (db) => db.query(sql)), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("with no company set, every table is empty (fails closed)", async () => {
      await inRolledBackTransaction(async (db, asConnector) => {
        await asConnector(null);
        for (const table of TABLES) {
          expect(await db.query(`SELECT 1 FROM ${table} LIMIT 1`), table).toEqual([]);
        }
      });
    });
  });

  describe("every tool, as company A", () => {
    const a = () => clientAs(tenantCtx({ orgId: A }));

    it("get_order: B's order looks exactly like an order that doesn't exist", async () => {
      const theirs = await a().callTool("get_order", { order_ref: refB });
      const missing = await a().callTool("get_order", { order_ref: "MX-NOPE1" });
      expect(theirs.isError).toBe(true);
      expect(theirs.content[0].text.replace(refB, "<ref>")).toBe(missing.content[0].text.replace("MX-NOPE1", "<ref>"));
      expect((await a().callTool("get_order", { order_ref: refA })).isError).toBeFalsy();
    });

    it("list_orders, get_sales_summary and compare_designs show only A's data", async () => {
      const list = await a().callTool("list_orders", { limit: 50 });
      expect(list.structuredContent.orders.map((o: { order_ref: string }) => o.order_ref)).toEqual([refA]);

      for (const group_by of ["month", "product", "customer"]) {
        const summary = await a().callTool("get_sales_summary", { group_by });
        expect(summary.structuredContent.total, group_by).toEqual({ orders: 1, units: 2, revenue: 20 });
      }
      const flat = await a().callTool("compare_designs", { check: "product_catalog" });
      expect(flat.structuredContent.flat).toEqual([{ product: "Matrix Product", order_lines: 1 }]);
    });

    it("describe_schema counts one row per table for A", async () => {
      const schema = await a().callTool("describe_schema", {});
      const counts = schema.structuredContent.tables.map((t: { rowsInYourCompany: number }) => t.rowsInYourCompany);
      expect(counts).toEqual([1, 1, 1, 1, 1]);
    });

    it("create_order can't use B's customer, even by its exact email", async () => {
      const result = await a().callTool("create_order", {
        customer_email: "buyer@b.example.com",
        items: [{ product: "Matrix Product", quantity: 1 }],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No customer with email");
    });
  });

  describe("the role and functions (lesson 19.10)", () => {
    it("the Worker's role can't bypass row-level security or change the schema", async () => {
      const [role] = await testForTenant({ orgId: A }, (db) =>
        db.query<{ rolbypassrls: boolean; rolsuper: boolean; current_user: string }>(
          `SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
        ),
      );
      expect(role).toEqual({ current_user: "mcp_connector", rolbypassrls: false, rolsuper: false });
      await expect(testForTenant({ orgId: A }, (db) => db.query(`CREATE TABLE sneaky (x int)`))).rejects.toThrow(
        /permission denied/,
      );
    });

    it("no SECURITY DEFINER function in our schemas is callable by the Worker's role", async () => {
      const definers = await testForTenant({ orgId: A }, (db) =>
        db.query(
          `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE p.prosecdef AND n.nspname IN ('public', 'staging')
             AND has_function_privilege('mcp_connector', p.oid, 'EXECUTE')`,
        ),
      );
      expect(definers).toEqual([]);
    });
  });

  describe("planted bugs the matrix must catch (each rolled back)", () => {
    it("bug 1: a query with no WHERE clause leaks B's orders once row-level security is off", async () => {
      await inRolledBackTransaction(async (db, asConnector) => {
        await db.query(`ALTER TABLE orders NO FORCE ROW LEVEL SECURITY`);
        await db.query(`ALTER TABLE orders DISABLE ROW LEVEL SECURITY`);
        await asConnector(A);
        const rows = await db.query<{ org_id: string }>(`SELECT org_id FROM orders`); // the buggy tool's query
        expect(onlyCompanyA(rows)).toBe(false); // caught: the matrix sees other companies
      });
      // The same query with row-level security on (the real setup): no leak.
      const rows = await testForTenant({ orgId: A }, (db) => db.query<{ org_id: string }>(`SELECT org_id FROM orders`));
      expect(onlyCompanyA(rows)).toBe(true);
    });

    it("bug 2: a policy without a real WITH CHECK lets A write a row for B", async () => {
      await inRolledBackTransaction(async (db, asConnector) => {
        await db.query(`ALTER POLICY tenant_isolation ON orders WITH CHECK (true)`);
        await asConnector(A);
        // The matrix's write check expects this insert to be refused. Here it succeeds: caught.
        // (No RETURNING: Postgres checks returned rows against the USING policy too, and A
        // can't see B's row, so RETURNING would still fail and hide the bug.)
        await db.query(
          `INSERT INTO orders (org_id, order_ref, customer_id, order_date) VALUES ($1, 'MX-STEAL', 900001, CURRENT_DATE)`,
          [B],
        );
        await db.query("RESET ROLE"); // back to the owner, to look at what was written
        const stolen = await db.query(`SELECT org_id FROM orders WHERE order_ref = 'MX-STEAL'`);
        expect(stolen).toEqual([{ org_id: B }]);
      });
    });

    it("bug 3: a query run outside forTenant (no company set) sees none of A's own data", async () => {
      await inRolledBackTransaction(async (db, asConnector) => {
        await asConnector(null); // the buggy tool forgot forTenant
        const rows = await db.query(`SELECT order_ref FROM orders WHERE org_id = $1`, [A]);
        // The matrix's "A sees its own order" check fails: caught. It fails closed, not open.
        expect(rows).toEqual([]);
      });
    });
  });
});
