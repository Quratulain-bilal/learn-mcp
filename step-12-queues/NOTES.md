# Step 12 notes: background bulk imports with Queues

## What I built

- **`bulk_import_orders`** (write): takes CSV text with the header `order_date,customer_email,product,quantity` (one single-product order per row, at most 2,000 rows or 200,000 characters).
  - It checks the header, records an import in the new `imports` table, splits the rows into **batches of 50**, and sends them to the **`order-imports`** queue.
  - Each message is wrapped in the step 7 **tenant envelope** (`orgId`, `userId`, `requestId`).
  - It returns the `import_id` straight away.
- **The queue consumer** (`queue()` in `src/index.ts`, logic in `src/imports.ts`), in the same Worker that serves `/mcp`. For each message it:
  1. re-checks in D1 that the envelope's user is **still a member** of the company;
  2. looks up where the company lives and writes **through the tenant router**, so row-level security applies exactly as in a tool call;
  3. checks the import belongs to that company (RLS hides other companies' imports);
  4. handles each row: skips it if it's already in `import_rows`, otherwise validates it, creates the order with the existing `insertOrder` (reference `IMP-<import>-<row>`, the CSV's date), and records `done` or `failed` with a reason.
- **`get_import_status`** (read-only): rows done, failed and pending, whether it's finished, and the first 10 failures with reasons. Another company's import reads exactly like a missing one.
- **Migration `0009`**: `imports` and `import_rows`, under forced RLS. The connector may only `SELECT` and `INSERT` them.

## Queues in plain words

- **Producer and consumer:** the tool *produces* messages and answers at once. Cloudflare delivers them to the Worker's `queue()` handler (the *consumer*) in **batches**: up to 10 messages, or whatever has arrived after 5 seconds.
- **At least once:** a message can be delivered more than once, for example after a timeout. So every write must be **idempotent**.
- **Retries and the dead-letter queue:** `message.retry()` hands it back with a delay. After `max_retries: 3`, a failing message goes to **`order-imports-dlq`** to be inspected, not lost.

## Why a retry never duplicates an order

Each row's order and its `import_rows` record are written in the **same transaction**, keyed by `(org_id, import_id, row_no)`. A row already in `import_rows` is skipped.

If two deliveries race, the second's insert hits the primary key, that message's transaction rolls back and is retried, and on the retry the row is skipped. The order reference is derived from the import and row (`IMP-…-<row>`), so even a retry that slipped through would hit the `UNIQUE (org_id, order_ref)` constraint. This needs only `INSERT` on `import_rows`, never `UPDATE`.

Tested: the same message consumed twice gives exactly one order.

## What retries, and what doesn't

| What happened | What the consumer does | Why |
| --- | --- | --- |
| A row is invalid (bad date, unknown product, quantity 0) | Records it as **failed**, acks | Retrying won't fix the data |
| The user was removed from the company | Logs and **acks**; nothing is written | They may no longer act for the company |
| The import isn't this company's | Logs and **acks**; nothing is written | A forged or misrouted envelope |
| Database or network error | **Retries** the whole message, with a growing delay, then the DLQ | Probably temporary; committed rows are skipped next time |

Logs carry the company id, the request id and the error code, never row contents.

## Setup

```bash
npx wrangler queues create order-imports
npx wrangler queues create order-imports-dlq
npm run db:migrate          # adds 0009 to the shared and dedicated databases
npm test
npm run deploy
```

Queues are on the Workers free plan (with a daily operations allowance). Like steps 9–11, step 12 shares step 8's databases and Hyperdrive configs; migration 0009 only adds tables.

## Tests

`test/imports.test.ts`:
- CSV parsing (quotes, escaped quotes, CRLF) and the header check;
- **a real end-to-end import:** the tool queues it, the local queue delivers it to the Worker's consumer, and `get_import_status` reports 2 done, 3 failed with the right rows and reasons;
- a duplicate delivery makes one order;
- messages for a removed member, or naming another company's import, are acked and write nothing;
- another company can't read the status.

## Try it

Paste `samples/orders-import.csv` and ask: "Import these orders." Then "How's the import going?" until it's finished. In a company seeded with the demo data (`npm run db:seed`), expect 5 done and 4 failed:

| Row | Why it fails |
| --- | --- |
| 5 | date `06/01/2026` isn't YYYY-MM-DD |
| 6 | the customer doesn't exist |
| 7 | the product doesn't exist |
| 8 | quantity is 0 |

To see the queues: **Workers & Pages → Queues → order-imports** (messages, backlog, consumer) and **order-imports-dlq** (anything that failed every retry).
