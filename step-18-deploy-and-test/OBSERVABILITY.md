# Where to look when something breaks

Everything goes to **Workers Logs** and **Traces** (Cloudflare dashboard → Workers & Pages → `learn-mcp-step-18` → **Observability**; use `learn-mcp-step-18-staging` for staging). `wrangler.jsonc` keeps 100% of requests (`head_sampling_rate: 1`); lower it if volume grows.

## What gets logged

Every line is JSON, so you can filter on any field. Three kinds:

| `type` | When | Fields | Never contains |
| --- | --- | --- | --- |
| `audit` | Every tool call (`src/audit.ts`) | `requestId`, `org`, `user`, `role`, `client`, `tool`, `writes`, `outcome` (`ok` / `tool_error` / `exception`), `ms` | arguments, results |
| `span` | Every database transaction, queue send and Workflow call (`src/observability.ts`) | `span` (`db.transaction`, `queue.order-imports.sendBatch`, `queue.sales-events.send`, `workflow.create`, `workflow.get`), `requestId`, `org`, `ms`, `outcome`, `error` (code, constraint, table) | SQL parameters, rows |
| plain messages | Background work and errors | `database error` (code only), `tenant lookup failed`, `import batch` / `import batch failed`, `events recorded` / `events not recorded` | row data |

**One `requestId` ties a tool call's audit line to its spans.** Find a slow or failed call by its audit line, then filter `requestId = <that id>` to see which database transaction or queue send took the time or failed.

Cloudflare's **automatic traces** (`observability.traces`) record every request and its outgoing calls (Hyperdrive, Queues, Workflows, Workers AI, KV, D1, Durable Objects) with timings, so you also get a waterfall without writing code.

## Symptoms and where to look

| Symptom | Look at | Likely cause |
| --- | --- | --- |
| Claude says "the sales database couldn't be reached" | `span = db.transaction`, `outcome = error`, the `error.code` | Neon asleep or down (`ECONNRESET`, `57P01`); Hyperdrive misconfigured; a migration not applied (`42P01` = table missing) |
| Every call fails with 503 | `tenant lookup failed` | The shared database (tenants table) is unreachable |
| A user gets 403 | `audit` lines for that `user`; D1 `member` table | Removed from the company, or a member calling an admin tool (expected) |
| "Rate limit reached" | `audit` with `outcome = tool_error` and many calls in a minute | Expected protection; check whether one client is looping |
| Imports never finish | `import batch failed` lines; Queues → `order-imports-step-18` (or `-staging`) backlog; `order-imports-dlq` | Database errors (retrying), or messages exhausted retries (dead-letter queue) |
| Events missing | `events not recorded`; `sales-events-dlq` | Same as imports |
| A report is stuck | Workflows → `learn-mcp-step-18-sales-report` (or `-staging`) → the run's steps | Waiting for approval (normal), or a step retrying |
| Slow tool | Trace waterfall for the request; `ms` on its spans | A slow query (add an index), Workers AI embedding time, or a cold Neon compute |
| A widget is blank in the chat | The client's iframe console (not our logs) | CSP block or an old cached widget: bump `VERSION` in `src/widgets/resources.ts` |

## Useful filters

- All failures in the last hour: `outcome = "exception" OR outcome = "error"`
- One company: `org = "<orgId>"`
- Slowest tools: group `type = "audit"` by `tool`, average `ms`
- A single request end to end: `requestId = "<id>"`
- One environment: check the Worker name (`learn-mcp-step-18` or `learn-mcp-step-18-staging`) and `ENVIRONMENT` on `/version`

## Tests

`npm test` runs every suite in the Workers runtime. `test/observability.test.ts` checks that a tool call produces an audit line and a span with the same `requestId`, and that no argument value appears in any log line.
