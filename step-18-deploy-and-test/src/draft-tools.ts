import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ForTenant } from "./db";
import { insertOrder } from "./order-tools";
import type { TenantContext } from "./tenant";
import { READ_ONLY, dbError, markdownTable, toolError } from "./tool-helpers";
import type { Draft, UserState } from "./user-state";

/**
 * DRAFT ORDERS, built over several messages ("add two chairs… and a lamp… for Laura…
 * ok, submit"). The draft lives in the user's UserState Durable Object, not in Neon:
 * it's personal, short-lived and must be exact between calls. submit_draft turns it into
 * a real order in Neon with the same validation as create_order.
 */

const email = z.string().trim().toLowerCase().email().max(254);

const draftSchema = z.object({
  customer_email: z.string().nullable(),
  lines: z.array(z.object({ product: z.string(), quantity: z.number() })),
  version: z.number(),
});

const show = (d: Draft | null) => ({
  customer_email: d?.customerEmail ?? null,
  lines: d?.lines ?? [],
  version: d?.version ?? 0,
});

function describeDraft(d: Draft | null): string {
  if (!d || d.lines.length === 0) return "The draft is empty.";
  return (
    `Draft for ${d.customerEmail ?? "(no customer yet)"}:\n\n` +
    markdownTable(d.lines.map((l) => ({ product: l.product, quantity: l.quantity })))
  );
}

export function registerDraftTools(
  server: McpServer,
  deps: {
    userState: DurableObjectStub<UserState>;
    forTenant: ForTenant;
    tenant: TenantContext;
    /** Called after an order is saved (step 15: queues an order.created event). */
    onOrderCreated?: (order: { order_ref: string; order_date: string; total: number; customer_name: string }) => Promise<void>;
  },
): void {
  const { userState, forTenant, tenant, onOrderCreated } = deps;

  server.registerTool(
    "add_to_draft",
    {
      title: "Add to the draft order",
      description:
        "Add a product to the user's draft order (or more of a product already in it), and optionally set the draft's customer. " +
        "The draft is kept between messages until it's submitted or cleared, or for 24 hours without changes. " +
        "Use it when the user builds an order step by step; use create_order when they give everything at once.",
      inputSchema: z.object({
        product: z.string().trim().min(1).max(120).describe('Exact catalog product name, e.g. "Ergo Chair".'),
        quantity: z.number().int().min(1).max(1000).default(1).describe("How many to add. Defaults to 1."),
        customer_email: email.optional().describe("The customer's email, if the user has said who the order is for."),
      }),
      outputSchema: draftSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ product, quantity, customer_email }) => {
      const result = await userState.addToDraft({ product, quantity }, customer_email);
      if ("error" in result) return toolError(result.error);
      return { content: [{ type: "text", text: describeDraft(result.draft) }], structuredContent: show(result.draft) };
    },
  );

  server.registerTool(
    "view_draft",
    {
      title: "View the draft order",
      description:
        "Show the user's current draft order: its customer and products. Nothing is saved as an order until submit_draft.",
      inputSchema: z.object({}),
      outputSchema: draftSchema,
      annotations: READ_ONLY,
    },
    async () => {
      const draft = await userState.getDraft();
      return { content: [{ type: "text", text: describeDraft(draft) }], structuredContent: show(draft) };
    },
  );

  server.registerTool(
    "clear_draft",
    {
      title: "Clear the draft order",
      description: "Throw away the user's draft order. Confirm with the user first.",
      inputSchema: z.object({
        confirm: z.literal(true).describe("Set to true ONLY after the user has explicitly confirmed throwing the draft away."),
      }),
      outputSchema: z.object({ cleared: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const cleared = await userState.clearDraft();
      return {
        content: [{ type: "text", text: cleared ? "The draft was cleared." : "There was no draft to clear." }],
        structuredContent: { cleared },
      };
    },
  );

  server.registerTool(
    "submit_draft",
    {
      title: "Submit the draft order",
      description:
        "Turn the user's draft into a real order, dated today, at today's catalog prices. " +
        "The draft is cleared only after the order is saved. Confirm the customer and products with the user first.",
      inputSchema: z.object({
        customer_email: email.optional().describe("Set or change the customer before submitting, if the draft has none."),
      }),
      outputSchema: z.object({ order_ref: z.string(), customer: z.string(), total: z.number(), lines: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ customer_email }) => {
      let draft = await userState.getDraft();
      if (customer_email && draft) draft = await userState.setDraftCustomer(customer_email);
      if (!draft || draft.lines.length === 0) return toolError("The draft is empty. Add products with add_to_draft first.");
      if (!draft.customerEmail) {
        return toolError("The draft has no customer yet. Ask the user who the order is for, then pass customer_email.");
      }
      const { customerEmail, lines, version } = draft;
      try {
        const result = await forTenant(tenant, (db) => insertOrder(db, tenant.orgId, customerEmail, lines));
        if ("error" in result) return toolError(`${result.error} The draft was kept, so it can be fixed.`);
        // Only now, with the order saved, clear the draft, and only the version we saved.
        await userState.clearDraft(version);
        await onOrderCreated?.({
          order_ref: result.order_ref,
          order_date: result.order_date,
          total: result.total,
          customer_name: result.customer,
        });
        const text = `Submitted the draft as order ${result.order_ref} for ${result.customer}, total ${result.total}. The draft is now empty.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            order_ref: result.order_ref,
            customer: result.customer,
            total: result.total,
            lines: result.lines.length,
          },
        };
      } catch (error) {
        return dbError(error);
      }
    },
  );
}
