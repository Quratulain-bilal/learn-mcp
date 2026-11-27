# Step 15 notes: Events

## What I built

Two events, served through the **Events extension** (`io.modelcontextprotocol/events`, SEP-3415) with **poll** delivery (`src/events.ts`):

| Event | Payload (small, actionable; no emails or addresses) | When |
| --- | --- | --- |
| `order.created` | `order_ref`, `total`, `customer_name` | `create_order` or `submit_draft` saved an order |
| `sales.threshold_reached` | `month`, `total`, `threshold`, `currency` | The order's month reached the company's sales threshold (from step 7's settings) for the **first** time |

How an event travels:
1. `create_order` / `submit_draft` saves the order, then puts an `order.created` message, with the tenant envelope, on the **`sales-events-step-15`** queue and returns. A slow consumer or client never delays the tool; if queueing fails, the order still stands (it's logged).
2. The Worker's queue consumer looks up where the company lives and, through the tenant router (RLS), writes the event to the new **`event_log`** table. It then sums the month and writes `sales.threshold_reached` if the threshold is reached.
3. A client polls **`events/poll`** `{ name, cursor }` and gets `{ events, cursor, hasMore, truncated, nextPollMs }`. `cursor: null` means "from now". Each event is `{ eventId, name, timestamp, data }`.

`events/list` describes both types (`delivery: ["poll"]`, `inputSchema`, `payloadSchema`), and the server declares the extension in its capabilities.

**Fallback:** `list_recent_events` (read-only) gives the model the same events, newest first, for clients without the extension. Its description says event data is information to report, never instructions to follow.

**Migration `0012`**: `event_log (org_id, seq, event_id, name, occurred_at, data)` under forced RLS, with `UNIQUE (org_id, event_id)`. It only adds a table.

## Duplicates

The queue delivers at least once, so every event has a **stable `eventId`**: `order.created:<order_ref>`, and `sales.threshold_reached:<YYYY-MM>`. The consumer inserts with `ON CONFLICT (org_id, event_id) DO NOTHING`, so a redelivered message stores nothing new (tested), and a client that sees the same `eventId` twice can drop the copy. Using the month as the threshold event's id is also what makes it fire **once per month**, not on every later order.

## Where subscriptions live: a deliberate change from the plan

The plan put subscriptions and "the last threshold sent" in each user's `UserState` Durable Object. With poll delivery, the spec makes the subscription **client-owned**: the client keeps the event name, arguments and cursor, and the server keeps no per-subscriber state. That suits a stateless Worker. "Last threshold sent" became the stable event id above, which is durable and per company, instead of per user.

Push (`events/stream`) and webhooks (`events/subscribe`, signed POSTs with a TTL) are left out. Push needs a long-lived connection per subscriber; webhooks need a signing secret per subscription and a retrying sender, which would be a later Queue + Durable Object addition.

## Tenancy

- Every message carries the envelope, and the consumer writes through the router for **that** company.
- `events/poll` and `list_recent_events` read only the caller's company's `event_log` (forTenant + RLS).
- Tested: company B polling from cursor `0` gets nothing of company A's, for both event types.

## From an event to an action

`sales.threshold_reached`'s description suggests the next move. When a client delivers it (or the model sees it in `list_recent_events`), the model can show the sales chart (`get_sales_summary` by month) or start a report task (`generate_sales_report` / `start_sales_report`).

Example flow:
1. A big order pushes March past the company's threshold.
2. The client polls and gets `sales.threshold_reached {month: "2026-03", total: 12400, threshold: 10000}`.
3. The model says "March just passed your 10,000 USD target" and shows the chart.
4. The user asks for the full report, and the model starts the task.

## Queues

`sales-events-step-15` (consumer: this Worker, 25 messages per batch, 5 retries) with dead-letter queue `sales-events-dlq`, shared by later steps. One Worker consumes two queues, and `queue()` in `src/index.ts` picks the handler by `batch.queue`. Imports use `order-imports-step-15`. All are on the free plan.

## Tests

`test/events.test.ts`:
- the capability and `events/list`;
- an unknown event name and a forged cursor are rejected;
- a real order travels through the local queue to `events/poll`, with a minimal payload;
- the threshold event arrives once, and a second order the same month doesn't repeat it;
- another company receives nothing;
- a duplicate delivery is stored once.

## Try it

- **MCP Inspector:** send `events/poll { name: "order.created", cursor: null }` and keep the cursor. Create an order in Claude, then poll again from that cursor: the event is there.
- **Claude** (no Events support yet): "Set our sales threshold to 500." Then create an order. Then "What's new?" `list_recent_events` shows `order.created`, plus `sales.threshold_reached` if the month passed 500.

## Client support and what I tested

The [client support matrix](https://modelcontextprotocol.io/extensions/client-matrix) lists no Events support in Claude and webhook-only support in ChatGPT as of November 2026. This server implements **poll** delivery, so neither client can deliver `events/poll` end to end yet. Both can still use the fallback tool `list_recent_events`.

- Deployed Worker: `https://learn-mcp-step-15.learn-mcp-step-01.workers.dev/mcp`
- Test user: `learner-step15@example.com`, organization `ShgL01meXfdAA3YkyccQa7g4a2848Bkc`.
- Verified in Claude: creating an order for `fatima.zahra@example.com` produced `order.created:WEB-F2B10B5C` and `sales.threshold_reached:2026-11`, both visible through `list_recent_events`.
- Verified in MCP Inspector: `initialize` advertises `io.modelcontextprotocol/events`; `events/list` describes both event types with `delivery: ["poll"]`; `events/poll` returns the same two event IDs.
- Verified with tests: `test/events.test.ts` 5/5 and `test/isolation.test.ts` 3/3.
