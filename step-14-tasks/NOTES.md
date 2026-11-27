# Step 14 notes: long-running work with MCP Tasks

## What I built

The step 13 `SalesReportWorkflow`, exposed through the **MCP Tasks extension** (`io.modelcontextprotocol/tasks`, SEP-2663, schema `2026-07-28`) in `src/tasks.ts`:

| Message | What the server does |
| --- | --- |
| `initialize` / `server/discover` | Declares `capabilities.extensions["io.modelcontextprotocol/tasks"] = {}` |
| `tools/call generate_sales_report` from a client that opted in (per-request `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` has the Tasks id) | Records the report row, creates the Workflow run, and answers with a **CreateTaskResult**: `resultType: "task"`, `taskId`, `status: "working"`, `statusMessage`, `createdAt`, `lastUpdatedAt`, `ttlMs` (7 days), `pollIntervalMs` (3 s) |
| The same call from a client that didn't opt in | A normal tool result with a `report_id` |
| `tasks/get {taskId}` | `working` with a status message (queued, reading orders, computing totals), or `completed` with `result` (a CallToolResult carrying the report), or `failed` with `error`, or `cancelled` |
| `tasks/cancel {taskId}` | Terminates the Workflow run and marks the report `cancelled`; harmless if repeated or if the run already finished |
| `tasks/update` | Refused (`-32602`): this task never asks for input |

**`taskId` is the report id, which is the Workflow instance id.** Every task method first finds the report in **this company's** `reports` rows (forTenant and RLS). So a task id from another company gets the same `-32602 "Task not found: …"` as an id that doesn't exist (tested for `tasks/get` and `tasks/cancel`).

The task completes when the report is computed and saved. Publishing it (`approve_report`) stays a separate admin decision.

**Migration `0011`** only widens the allowed report stages to include `cancelled`. Step 13, which shares the database, is unaffected.

## The fallback, for clients without Tasks

The [client matrix](https://modelcontextprotocol.io/extensions/client-matrix) shows no client with Tasks support yet. So `start_sales_report` and `get_report_status` stay. `start_sales_report` now shows a **TaskStatus widget** (`ui://learn-mcp/task-status-v1.html`) that:
- polls `get_report_status` every 3 seconds through the host, so each poll is checked against the caller's company;
- shows a progress bar through queued, reading, computing and ready;
- then shows the report, with an "Ask to approve" button that sends a message to the model.

That gives Claude users a live view of the run today.

## Two SDK details that cost time

- The SDK **lifts reserved `io.modelcontextprotocol/*` keys out of `_meta`** into `ctx.mcpReq.envelope`. The opt-in check (`clientWantsTasks`) reads the envelope first. Reading only `_meta` meant the server never saw the opt-in and always answered with a normal result.
- The SDK also lifts `inputResponses` out of request params (that name is reserved for multi-round requests), so `tasks/update`'s schema can't require it.

With both fixed, the CreateTaskResult goes over the wire intact. The SDK adds an empty `content: []` beside it, which clients ignore.

## Tests

`test/tasks.test.ts`, against the real Workflow engine:
- the capability is declared;
- an opted-in call returns a task handle, and `tasks/get` follows it to `completed` with the 145-order report;
- a call that didn't opt in gets a normal result;
- another company's task id is refused exactly like an unknown one;
- `tasks/cancel` terminates the run (Workflow status `terminated`, task `cancelled`), and cancelling twice is harmless;
- `tasks/update` is refused.

## Queues

A Cloudflare queue has exactly one consumer Worker, and step 12 owns `order-imports`. So from step 13 on, each step has its own import queue (`order-imports-step-14` here), and all steps share `order-imports-dlq`, which needs no consumer.

## Test plan

- **MCP Inspector:** connect to `/mcp`, call `generate_sales_report` with the Tasks client capability in `_meta`, then send `tasks/get` until `completed`. Start another and send `tasks/cancel`; `tasks/get` says `cancelled`, and the Workflow run shows **Terminated** in the dashboard.
- **Claude** (no Tasks yet): "Build our 2025 sales report." The progress widget appears and fills in. Then "approve it" as an admin.
- **ChatGPT:** the same prompts; the text answers work even where the widget doesn't render.
