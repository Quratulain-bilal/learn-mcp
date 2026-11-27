# Step 13 notes: durable jobs with Cloudflare Workflows

## What I built

**`SalesReportWorkflow`** (`src/sales-report.ts`), bound as `SALES_REPORT` in the same Worker that serves `/mcp`. One run per report, as named, durable steps:

| Step | What it does | Why it's safe to retry |
| --- | --- | --- |
| `check membership` | Re-checks in D1 that the user who started it is still in the company; if not, a `NonRetryableError` ends the run. Moves the report to `reading`. | A read, plus setting the same stage again |
| `read orders page N` | Reads 100 orders of the year (keyset paging on `order_id`) and adds them to a **copy** of the running totals; the step's saved result is the new totals | A retried page reads exactly the same 100 orders and starts from the same saved totals |
| `compute totals` | Turns the totals into the report: revenue, orders, 12 months, top 5 products, top 5 customers | Pure computation over saved input |
| `save report` | `UPDATE reports SET summary = …, stage = 'awaiting_approval'` for this run's own row | Writing the same row twice writes the same thing |
| `wait for approval` | `step.waitForEvent("approval", { timeout: "7 days" })` | Waiting uses no CPU; on timeout the report is marked `expired` |
| `publish` | `stage = 'published'`, `approved_by` | Same as save |

If any step fails every retry, a final `mark failed` step records `failed` for `get_report_status`.

**Tools:**
- `start_sales_report` (`year`): records the report row (stage `queued`), then creates the Workflow instance with the report id and the **tenant envelope** as params. Returns the `report_id` at once.
- `get_report_status`: the stage from our table, the run's own status (`queued`, `running`, `waiting`, `complete`, `errored`) and error, and the report once it's ready.
- `approve_report` (admins only): only for `awaiting_approval`. Sends the `approval` event to that run.

**Migration `0010`**: `reports` under forced RLS. Like steps 9–12, it shares step 8's databases; the migration only adds a table.

## Workflows in plain words

- **Durable execution:** each `step.do(name, fn)` result is saved when it finishes. If the Worker restarts or a later step fails, the run resumes after the last finished step, and finished steps aren't re-run.
- **Retries:** a step that throws is retried on its own (with backoff), not the whole job. `NonRetryableError` stops it at once, for problems a retry can't fix.
- **`step.sleep` / `step.waitForEvent`:** the run pauses for a time or until an event, for minutes or days, without using CPU or holding a connection.
- **The instance id** is our `report_id`, so the tools can find the run (`workflow.get(id)`), and ownership is checked in our own table first. Another company's id reads like a missing one.

## Tenancy

- The params carry the envelope (`orgId`, `userId`, `requestId`).
- Every step that touches data looks up where the company lives and runs through the tenant router, so RLS applies, and a dedicated-tier company's report reads its own database.
- The first step re-checks membership, because a run can start or resume long after the request.
- `get_report_status` and `approve_report` first find the report in **this company's** `reports` rows. A guessed id from another company gets "No report … was found in your company" and is never touched.

## Tests

`test/sales-report.test.ts`, against the real Workflow engine in the test runtime:
- **A full run over the demo company's 145 orders in 2025:** two pages of reads, a report whose revenue matches `get_sales_summary`'s total, 12 months and a top 5. A member's approval is refused; the admin's approval publishes it (run status `complete`); approving twice is refused politely.
- Another company can't see or approve the report.
- A run started by a user who's no longer a member ends `failed` / `errored` without reading any orders.

## Try it in Claude and ChatGPT

1. "Build our 2025 sales report." Then "Is the report ready?" (repeat until it says awaiting approval)
2. As an admin: "Approve it." Then "Show me the report."
3. Dashboard: **Workers & Pages → learn-mcp-step-13 → Workflows → learn-mcp-step-13-sales-report** lists every run with its steps, outputs, retries and the event it's waiting for.

To see a retry: temporarily throw on the first attempt of `read orders page 1` (e.g. when a module-level flag isn't set), start a report, and watch the step's attempts in the dashboard.

Workflows are on the Workers free plan.
