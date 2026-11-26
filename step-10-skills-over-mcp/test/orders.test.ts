import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plantCompany, removeCompany, uniqueOrg } from "./fixtures";
import { asOwner, clientAs, hasDatabase, tenantCtx, testForTenant } from "./helpers";

const demo = clientAs(tenantCtx({ orgId: "demo" }));

describe.skipIf(!hasDatabase)("list, get and summarize orders (demo company, needs Neon)", () => {
  it("pages through all orders with a cursor, newest first, with no repeats", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await demo.callTool("list_orders", { limit: 50, ...(cursor ? { cursor } : {}) });
      seen.push(...page.structuredContent.orders.map((o: { order_ref: string }) => o.order_ref));
      cursor = page.structuredContent.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((ref) => ref.startsWith("SO-"))).toHaveLength(145);
    expect(seen[0]).toBe("SO-0141"); // Ayesha's late-December order is the newest sample order
  });

  it("filters by customer, product and dates", async () => {
    const ayesha = await demo.callTool("list_orders", { customer: "ayesha", limit: 50 });
    expect(ayesha.structuredContent.orders.every((o: { customer: string }) => o.customer === "Ayesha Khan")).toBe(true);
    const kit = await demo.callTool("list_orders", { product: "cable organizer" });
    expect(kit.structuredContent.orders.map((o: { order_ref: string }) => o.order_ref)).toEqual(["SO-0145"]);
    const march = await demo.callTool("list_orders", { from: "2025-03-01", to: "2025-03-31", limit: 50 });
    expect(march.structuredContent.orders.every((o: { order_date: string }) => o.order_date.startsWith("2025-03"))).toBe(
      true,
    );
  });

  it("treats % and _ in a search as plain text", async () => {
    const result = await demo.callTool("list_orders", { customer: "%%" });
    expect(result.structuredContent.orders).toEqual([]);
  });

  it("rejects a forged cursor with a recoverable error", async () => {
    const result = await demo.callTool("list_orders", { cursor: "not-a-cursor" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("without `cursor`");
  });

  it("get_order shows every line of an order with the price paid", async () => {
    const order = await demo.callTool("get_order", { order_ref: "so-0142" });
    expect(order.structuredContent.lines.map((l: { product: string }) => l.product)).toEqual([
      "Desk Lamp",
      "LED Bulb Pack",
    ]);
    expect(order.structuredContent.total).toBe(45);
  });

  it("get_sales_summary by month gives twelve months whose total matches the grand total", async () => {
    const summary = await demo.callTool("get_sales_summary", { group_by: "month", from: "2025-01-01", to: "2025-12-31" });
    const { groups, total } = summary.structuredContent;
    expect(groups).toHaveLength(12);
    const sum = groups.reduce((s: number, g: { revenue: number }) => s + g.revenue, 0);
    expect(Math.round(sum * 100) / 100).toBe(total.revenue);
  });
});

describe.skipIf(!hasDatabase)("create_order (needs Neon)", () => {
  const org = uniqueOrg("orders-test");
  const client = clientAs(tenantCtx({ orgId: org }));
  let email = "";

  beforeAll(async () => {
    email = (await plantCompany(org, "T")).email;
    // A catalog price that differs from the planted order's old price of 10.00.
    await asOwner(`UPDATE products SET list_price = 12.50 WHERE org_id = $1`, [org]);
  });
  afterAll(() => removeCompany(org));

  const countOrders = () =>
    testForTenant({ orgId: org }, (db) => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders`)).then(
      (r) => r[0]!.n,
    );

  it("creates an order and its lines in one go, copying today's catalog price", async () => {
    const result = await client.callTool("create_order", {
      customer_email: email.toUpperCase(),
      items: [{ product: "matrix product", quantity: 3 }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.lines).toEqual([
      { line_no: 1, product: "Matrix Product", quantity: 3, unit_price: 12.5, line_total: 37.5 },
    ]);
    const fetched = await client.callTool("get_order", { order_ref: result.structuredContent.order_ref });
    expect(fetched.structuredContent.total).toBe(37.5);
  });

  it("refuses unknown customers, unknown products and duplicate lines, and saves nothing", async () => {
    const before = await countOrders();
    const cases = [
      [{ customer_email: "nobody@example.com", items: [{ product: "Matrix Product", quantity: 1 }] }, "No customer"],
      [{ customer_email: email, items: [{ product: "Flux Capacitor", quantity: 1 }] }, "aren't in your company's catalog"],
      [
        {
          customer_email: email,
          items: [
            { product: "Matrix Product", quantity: 1 },
            { product: "MATRIX PRODUCT", quantity: 2 },
          ],
        },
        "appears twice",
      ],
      [{ customer_email: email, items: [] }, ""],
      [{ customer_email: email, items: [{ product: "Matrix Product", quantity: 0 }] }, ""],
    ] as const;
    for (const [args, message] of cases) {
      const result = await client.callTool("create_order", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.content[0].text).toContain(message);
    }
    expect(await countOrders()).toBe(before);
  });

  it("is all or nothing: a failure after the order row is written rolls it back", async () => {
    const before = await countOrders();
    await expect(
      testForTenant({ orgId: org }, async (db) => {
        await db.query(
          `INSERT INTO orders (org_id, order_ref, customer_id, order_date) VALUES ($1, 'MX-HALF1', 900001, CURRENT_DATE)`,
          [org],
        );
        throw new Error("something failed before the order lines were written");
      }),
    ).rejects.toThrow("something failed");
    expect(await countOrders()).toBe(before);
  });
});
