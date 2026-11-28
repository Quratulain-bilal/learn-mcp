# Step 19 notes: an intent-driven sales dashboard (generative UI)

Built on step 18's code, with step 17's spans and traces. It deploys as **one** Worker (`learn-mcp-step-19`). The staging and production pipeline stays in step 18; a second staging here would compete for queues, since each queue has one consumer. Step 19 has its own KV namespace (`7032515584374218826b72306b8a1045`) and queues (`order-imports-step-19`, `sales-events-step-19`). The free Cloudflare account is at its D1 and Hyperdrive limits, so the deployed Worker shares step 13's auth D1 and Hyperdrive config with step 18's production Worker; isolated Neon databases exist for tests but cannot be bound yet.

## The idea

The user says what they want to know ("how are we doing this year?"), and the **model composes the screen**. This is rung two of book lesson 20.10's ladder:

| Rung | Who decides the screen | Here |
| --- | --- | --- |
| 1. Fixed screens | The developer; the model picks one per request | Step 9: orders table, sales chart, order form, report progress |
| **2. Approved parts** | **The model, from reviewed blocks** | **`show_dashboard`** |
| 3. Open screens | The model writes HTML | Out of scope: impossible to keep safe and on-brand |

## What I built

- **`show_dashboard`** (`src/dashboard.ts`, read-only) takes `{ title, blocks[1..6] }`. Each block is one of:
  - `kpi`: 1–4 headline cards (`revenue`, `orders`, `average_order_value`, `customers`, `top_product`, `top_customer`), with an optional range and `compare_previous` (the same-length period just before);
  - `chart`: revenue bars by month, product or customer;
  - `table`: recent orders, filtered by customer or product;
  - `report`: the latest saved yearly report from the step 13 Workflow.

  The schema is a strict discriminated union. Unknown block types (for example `{type:"html"}`), unknown metrics, more than 6 blocks and bad dates are refused before any query. The server fetches every block in **one** transaction for the caller's company (forTenant and RLS), so all blocks show the same moment. It returns the blocks as `structuredContent` plus a text version (with records fenced as untrusted data, as in step 16) for clients without widgets.
- **A widget library** (`widgets/shared/components.tsx`): `KpiCards`, `BarChart`, `OrdersTableView` and `ReportView`, with consistent props and host theming. React escapes all text. The step 9 **sales chart now uses the library's `BarChart`**.
- **The dashboard widget** (`widgets/dashboard/`) only *renders* the blocks it receives, each with its component; an unknown block is skipped. It is registered as `ui://learn-mcp/dashboard-v1.html`.
- **The `monthly-sales-review` skill** now makes one `show_dashboard` call (KPIs against the previous month, top 5 products, top 5 customers) instead of three separate summary calls. The prompt fallback carries the same text.

## Ten intents and what each needs

| # | Intent | Tool(s) | Screen |
| --- | --- | --- | --- |
| 1 | "How are we doing this year?" | `show_dashboard` | KPIs + chart by month |
| 2 | "March 2025 at a glance" | `show_dashboard` | KPIs (vs February) + chart by product |
| 3 | "Compare last month with the month before" | `show_dashboard` | KPIs with `compare_previous` |
| 4 | "Health check for the board meeting" | `show_dashboard` | KPIs + chart + recent orders |
| 5 | "Overview of Ayesha Khan's business" | `show_dashboard` | KPIs + orders table filtered to her |
| 6 | "Who buys the Ergo Chair?" | `show_dashboard` | Chart by customer + table filtered to the product |
| 7 | "Our 2025 report next to this month" | `show_dashboard` (after `start_sales_report` if none) | Report + KPIs |
| 8 | "Monthly review for November" | skill → `show_dashboard`, then text | KPIs + 2 charts + write-up |
| 9 | "Show the latest orders" | `list_orders` | Orders table (fixed screen) |
| 10 | "I want to enter an order" | `open_order_form` | Order form (fixed screen) |

`evals/dashboard-intents.json` has 20 such intents with the expected tool, widget and block types. `npm run eval:dashboard` validates the set against the real widget keys and writes `evals/dashboard-runbook.md`, a table to fill in while running the prompts in each client. `test/dashboard.test.ts` checks automatically that every expected tool, widget and block type exists.

### Manual run (fill in per client)

| | claude.ai | Claude Desktop | ChatGPT |
| --- | --- | --- | --- |
| Right tool (of 20) | 1 of 20 checked | | 1 of 20 checked |
| Sensible blocks (of the 11 dashboard intents) | 1 of 11 checked | | 1 of 11 checked |
| Notes | prompt 1 rendered the KPI + monthly chart widget; screenshot still needed | | needs a paid plan; prompt 1 called `show_dashboard`, the text fallback was correct (KPIs + monthly chart); screenshot still needed |

Use `evals/dashboard-runbook.md` to record each prompt. Prompt 1 ("How are we doing this year?") was checked in claude.ai and ChatGPT after the tool description was strengthened: the right tool ran and the numbers were correct. claude.ai rendered the dashboard widget with KPI cards and a monthly chart; ChatGPT showed the text fallback. The other prompts are still unchecked.

Client support: the official MCP extension matrix currently lists no MCP Apps support in ChatGPT, so ChatGPT can only show `show_dashboard`'s text fallback; a real widget must be verified in Claude Desktop or claude.ai. A text-only answer is not a widget pass, even when the numbers are right.

## Where generative UI worked well, and where a fixed screen is better

**Generative UI worked well for:**
- **Overview questions with many valid answers.** "How are we doing", "a health check" or "March at a glance" each want a different mix of numbers, and one fixed dashboard would show too much or the wrong thing. Choosing two to four blocks is easy for the model.
- **Combining views that used to take several tool calls.** The monthly review went from three calls and three widgets to one screen.
- **Following the user's framing.** "Next to", "compared with" and "for this customer" map directly to block options.

**A fixed screen is better for:**
- **Doing, not looking.** Order entry, approvals and anything that writes. The order form is fixed and reviewed, and the dashboard never writes.
- **Things people do every day the same way**, like the orders table with Load more, where predictability beats novelty.
- **Exact, repeatable layouts** for reports that are compared week to week, or sent to people outside the chat.

**Guardrails that made it safe:**
- Parts only, no HTML.
- A strict schema, at most 6 blocks.
- Data fetched by the server, for the caller's company only.
- Text fallback with untrusted data fenced.
- Escaping in every component.

## Tests

`test/dashboard.test.ts`:
- the tool is linked to the dashboard widget;
- free HTML, too many blocks, unknown metrics, empty and bad dates are refused;
- the 20-intent eval set names real tools and block types;
- with real data, KPI revenue and orders **match `get_sales_summary`**, the chart is sorted, the table filter holds, and a missing report says so;
- `compare_previous` returns the previous period;
- another company's dashboard shows only its own (empty) data.

`test/skills.test.ts` checks the updated skill text. `test/widgets.test.ts` checks that `show_dashboard` points at the dashboard resource like the other widget tools. `npm run preview:widgets` now has a dashboard sample with KPIs, a chart, an orders table and a saved report, so the composed screen can be reviewed in light and dark themes without a client.

Local verification in this fork: `npm run typecheck` passes, `npm test -- --maxWorkers=1 --silent` passes 55 tests with 98 database tests skipped because this step has no `.env` pointing at a step-19 Neon branch, and `npm run eval:retrieval -- --embedder test` is at the step 17 baseline (100% found in top 3, 100% correct abstentions). `npm run eval:dashboard` validates the 20 prompts and writes `evals/dashboard-runbook.md`. The live Worker is `https://learn-mcp-step-19.learn-mcp-step-01.workers.dev`. Smoke test: `/version` returns `{"name":"learn-mcp-step-19","release":"1.0.0","environment":"production"}`, `/mcp` returns `401` without a token, `/sign-in` returns `200`, and `/api/auth/jwks` returns `200`.

Live authorization failed in Claude because step 19 shares step 18's auth D1 but had a new `BETTER_AUTH_SECRET`: the shared `jwks` row's private key was encrypted with step 18's secret, so step 19 could not sign OAuth tokens. Fixed by giving the JWT plugin a step-19-only keyring in the new `step19_jwks` table (`migrations/0002_step19_jwks.sql`); the shared `jwks` row is untouched, so steps 13 to 18 keep working. Reconnect the connector after redeploy so it receives a token signed by the new key. Live scripted OAuth smoke after the fix: `/api/auth/oauth2/token` returned `200`, the access token audience contained the step-19 `/mcp` URL, and `POST /mcp` with that token returned `200` with `tools`.

A ChatGPT run of "How are we doing this year?" returned prose and the `monthly-sales-review` skill as text, without a `show_dashboard` call. Strengthened the tool description ("FIRST CHOICE", "renders the dashboard widget") and the skill so overview, health-check and year prompts call `show_dashboard` before answering; `get_sales_summary` no longer claims "how are we doing" questions. The server cannot force a host model to call a tool, so the widget still has to be verified where MCP Apps are supported.
