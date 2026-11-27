import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRAFT_TTL_MS, MAX_DRAFT_LINES, RATE_LIMIT, type UserState, userStateFor } from "../src/user-state";
import { plantCompany, removeCompany, uniqueOrg } from "./fixtures";
import { clientAs, hasDatabase, tenantCtx, testForTenant } from "./helpers";

// A fresh user (and so a fresh Durable Object) per test, so counters and drafts don't mix.
const freshUser = (orgId = uniqueOrg("ds")) => tenantCtx({ orgId, userId: `u-${crypto.randomUUID().slice(0, 8)}` });

describe("UserState Durable Object (no database needed)", () => {
  it("the same user id in two companies gets two separate objects", async () => {
    const userId = "same-user";
    const inA = clientAs(tenantCtx({ orgId: uniqueOrg("acme"), userId }));
    const inB = clientAs(tenantCtx({ orgId: uniqueOrg("globex"), userId }));
    await inA.callTool("add_to_draft", { product: "Ergo Chair", quantity: 2, customer_email: "a@acme.example.com" });
    const b = await inB.callTool("view_draft", {});
    expect(b.structuredContent).toEqual({ customer_email: null, lines: [], version: 0 });
    const a = await inA.callTool("view_draft", {});
    expect(a.structuredContent.lines).toEqual([{ product: "Ergo Chair", quantity: 2 }]);
  });

  it("adds up a product added twice, and caps a draft at 20 products", async () => {
    const user = freshUser();
    const client = clientAs(user);
    await client.callTool("add_to_draft", { product: "Desk Lamp", quantity: 1 });
    const again = await client.callTool("add_to_draft", { product: "desk lamp", quantity: 2 });
    expect(again.structuredContent.lines).toEqual([{ product: "Desk Lamp", quantity: 3 }]);
    // Fill the draft straight through the object (the tools would hit the rate limit first).
    const stub = userStateFor(env.USER_STATE, user);
    for (let i = 1; i < MAX_DRAFT_LINES; i++) await stub.addToDraft({ product: `P${i}`, quantity: 1 });
    const tooMany = await client.callTool("add_to_draft", { product: "One too many" });
    expect(tooMany.content[0].text).toContain(`at most ${MAX_DRAFT_LINES} products`);
  });

  it(`allows ${RATE_LIMIT} write calls a minute per user, then refuses with a retry time; reads still work`, async () => {
    const client = clientAs(freshUser());
    for (let i = 0; i < RATE_LIMIT; i++) expect((await client.callTool("clear_draft", {})).isError).toBeFalsy();
    const refused = await client.callTool("add_to_draft", { product: "Ergo Chair" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/Rate limit reached.*Try this again in \d+ second/);
    expect((await client.callTool("view_draft", {})).isError).toBeFalsy(); // read-only: not limited
    // Another user is unaffected.
    expect((await clientAs(freshUser()).callTool("clear_draft", {})).isError).toBeFalsy();
  });

  it("the alarm deletes a draft untouched for 24 hours, and keeps a recently touched one", async () => {
    const user = freshUser();
    await clientAs(user).callTool("add_to_draft", { product: "Bookshelf" });
    const stub = userStateFor(env.USER_STATE, user);

    await runInDurableObject(stub, async (object, state) => {
      const instance = object as UserState;
      const draft = await instance.getDraft();
      await state.storage.put("draft", { ...draft, updatedAt: Date.now() - 1000 }); // touched just now
      await instance.alarm();
      expect(await instance.getDraft()).not.toBeNull();
      expect(await state.storage.getAlarm()).not.toBeNull(); // re-armed for later

      await state.storage.put("draft", { ...draft, updatedAt: Date.now() - DRAFT_TTL_MS - 1000 }); // a day old
      await instance.alarm();
      expect(await instance.getDraft()).toBeNull();
    });
  });
});

describe.skipIf(!hasDatabase)("submit_draft (needs Neon)", () => {
  const org = uniqueOrg("draft-orders");
  let email = "";
  beforeAll(async () => {
    email = (await plantCompany(org, "D")).email;
  });
  afterAll(() => removeCompany(org));

  it("turns the draft into an order in Neon, then clears it", async () => {
    const client = clientAs(freshUser(org));
    await client.callTool("add_to_draft", { product: "Matrix Product", quantity: 2 });
    await client.callTool("add_to_draft", { product: "Matrix Product", quantity: 1, customer_email: email });
    const submitted = await client.callTool("submit_draft", {});
    expect(submitted.isError).toBeFalsy();
    expect(submitted.structuredContent).toMatchObject({ total: 30, lines: 1 });
    const saved = await testForTenant({ orgId: org }, (db) =>
      db.query(`SELECT quantity FROM order_items i JOIN orders o USING (org_id, order_id) WHERE o.order_ref = $1`, [
        submitted.structuredContent.order_ref,
      ]),
    );
    expect(saved).toEqual([{ quantity: 3 }]);
    expect((await client.callTool("view_draft", {})).structuredContent.lines).toEqual([]);
  });

  it("keeps the draft when the order can't be saved", async () => {
    const client = clientAs(freshUser(org));
    await client.callTool("add_to_draft", { product: "Flux Capacitor", customer_email: email });
    const failed = await client.callTool("submit_draft", {});
    expect(failed.content[0].text).toContain("The draft was kept");
    expect((await client.callTool("view_draft", {})).structuredContent.lines).toHaveLength(1);
  });

  it("asks for a customer when the draft has none", async () => {
    const client = clientAs(freshUser(org));
    await client.callTool("add_to_draft", { product: "Matrix Product" });
    const noCustomer = await client.callTool("submit_draft", {});
    expect(noCustomer.content[0].text).toContain("no customer yet");
  });
});
