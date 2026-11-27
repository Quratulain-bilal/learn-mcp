import { env } from "cloudflare:workers";
import { createMessageBatch, getQueueResult, createExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENTS_EXTENSION, type OrderCreatedMessage, consumeEvents } from "../src/events";
import { plantCompany, removeCompany, uniqueOrg } from "./fixtures";
import { asOwner, clientAs, hasDatabase, tenantCtx, testForTenant } from "./helpers";

describe("Events extension wiring (no database needed)", () => {
  const client = clientAs(tenantCtx({ orgId: "demo" }));

  it("declares the extension and lists both event types with poll delivery", async () => {
    const init = await client.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.capabilities.extensions).toHaveProperty([EVENTS_EXTENSION]);
    const list = await client.rpc("events/list", {});
    expect(list.result.events.map((e: { name: string }) => e.name)).toEqual(["order.created", "sales.threshold_reached"]);
    for (const e of list.result.events) expect(e.delivery).toEqual(["poll"]);
  });

  it("rejects an unknown event type and a forged cursor", async () => {
    expect((await client.rpc("events/poll", { name: "payroll.run", cursor: null })).error?.code).toBe(-32602);
    expect((await client.rpc("events/poll", { name: "order.created", cursor: "'; DROP" })).error?.code).toBe(-32602);
  });
});

describe.skipIf(!hasDatabase)("events through the queue (needs Neon)", () => {
  const A = uniqueOrg("events-a");
  const B = uniqueOrg("events-b");
  const a = clientAs(tenantCtx({ orgId: A, userId: `ev-${crypto.randomUUID().slice(0, 6)}` }));
  const b = clientAs(tenantCtx({ orgId: B }));
  let email = "";
  beforeAll(async () => {
    email = (await plantCompany(A, "E")).email;
    await plantCompany(B, "F");
    // A low threshold, so one order of 30 reaches it.
    await asOwner(`INSERT INTO company_settings (org_id, sales_threshold, updated_by) VALUES ($1, 25, 'test')`, [A]);
  });
  afterAll(async () => {
    for (const org of [A, B]) await asOwner(`DELETE FROM event_log WHERE org_id = $1`, [org]);
    await removeCompany(A);
    await removeCompany(B);
  });

  const poll = (client: typeof a, name: string, cursor: string | null) =>
    client.rpc("events/poll", { name, cursor }).then((r) => r.result);
  const waitFor = async (name: string, cursor: string, count: number) => {
    for (let i = 0; i < 40; i++) {
      const r = await poll(a, name, cursor);
      if (r.events.length >= count) return r;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error(`no ${name} event arrived`);
  };

  it("a new order produces order.created, and the month crossing the threshold produces one sales.threshold_reached", { timeout: 120_000 }, async () => {
    const start = await poll(a, "order.created", null); // "from now"
    expect(start.events).toEqual([]);

    const order = await a.callTool("create_order", { customer_email: email, items: [{ product: "Matrix Product", quantity: 3 }] });
    const ref = order.structuredContent.order_ref;

    const created = await waitFor("order.created", start.cursor, 1);
    expect(created.events[0]).toMatchObject({ eventId: `order.created:${ref}`, name: "order.created", data: { order_ref: ref, total: 30 } });
    expect(created.events[0].data).not.toHaveProperty("customer_email"); // payloads stay minimal

    const month = order.structuredContent.order_date.slice(0, 7);
    const reached = await waitFor("sales.threshold_reached", start.cursor, 1);
    expect(reached.events[0]).toMatchObject({ eventId: `sales.threshold_reached:${month}`, data: { month, threshold: 25 } });

    // A second order the same month: another order.created, but no second threshold event.
    await a.callTool("create_order", { customer_email: email, items: [{ product: "Matrix Product", quantity: 1 }] });
    await waitFor("order.created", start.cursor, 2);
    expect((await poll(a, "sales.threshold_reached", start.cursor)).events).toHaveLength(1);

    // Polling again from the returned cursor gives nothing new.
    expect((await poll(a, "order.created", created.cursor)).events.length).toBeLessThanOrEqual(1);
  });

  it("one company never receives another company's events", async () => {
    for (const name of ["order.created", "sales.threshold_reached"]) {
      expect((await poll(b, name, "0")).events, name).toEqual([]);
    }
    expect((await b.callTool("list_recent_events", {})).structuredContent.events).toEqual([]);
    expect((await a.callTool("list_recent_events", {})).structuredContent.events.length).toBeGreaterThanOrEqual(2);
  });

  it("a duplicate delivery is stored once", async () => {
    const body: OrderCreatedMessage = {
      kind: "order.created",
      envelope: { orgId: A, userId: "u", requestId: "dup" },
      order: { order_ref: "MX-DUP1", order_date: "2025-06-01", total: 1, customer_name: "Matrix Buyer E" },
    };
    for (const id of ["d1", "d2"]) {
      const batch = createMessageBatch<OrderCreatedMessage>("sales-events-step-15", [{ id, timestamp: new Date(), attempts: 1, body }]);
      await consumeEvents(batch, env);
      expect((await getQueueResult(batch, createExecutionContext())).explicitAcks).toEqual([id]);
    }
    const rows = await testForTenant({ orgId: A }, (db) =>
      db.query(`SELECT 1 FROM event_log WHERE event_id = 'order.created:MX-DUP1'`),
    );
    expect(rows).toHaveLength(1);
  });
});
