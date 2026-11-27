# Step 17 notes: testing, evals and observability

Built on step 16. Tests, CI and the free retrieval eval need no paid account. `npm run evals` is the optional paid tool-choice eval through the Claude API, so it is not run in CI.

## Test plan: what each layer catches

| Layer | Where | Catches | Misses |
| --- | --- | --- | --- |
| **Unit tests** | `tests/tenancy/helpers.test.ts`, `test/embeddings.test.ts`, CSV and passage tests | Logic errors in small pieces: key building, CSV parsing, passage splitting, the test embedder | Wiring, the database, the model |
| **Integration tests over MCP** (Workers runtime, real bindings) | `test/*.test.ts`, `tests/tenancy/*.test.ts` | Every tool, resource, prompt, widget link, skill, Durable Object, queue consumer, Workflow, task and event, through the real MCP handler; RLS and isolation against real Neon; auth with real tokens | Whether a **model** picks the right tool |
| **Isolation suite** | `test/matrix.test.ts`, `tests/tenancy/*` | Any cross-company leak, including planted bugs | Model behaviour |
| **Security tests** | `test/security.test.ts` | Token audience/expiry, injection, input validation, secrets in logs, rate limits | New attack types not modelled |
| **Eval set** | `evals/tool-choice.json` + `EVALS.md`, and `evals/retrieval.json` (step 8) | Wrong tool or screen chosen for a real prompt; descriptions that mislead; policy search quality | Server bugs (the tests catch those) |
| **Observability** | Logs, spans, traces | Problems in production that no test imagined | Nothing before release |

Two users and two companies appear throughout the integration tests (A and B, shared and dedicated tier). The tests prove neither sees the other's orders, customers, settings, passages, imports, reports, tasks or events.

## What's new in step 17

- **Spans** (`src/observability.ts`): every database transaction (`db.transaction`), queue send (`queue.order-imports.sendBatch`, `queue.sales-events.send`) and Workflow call (`workflow.create`, `workflow.get`) logs one JSON line with `requestId`, `org`, `ms` and `outcome` (plus the error code on failure). They share the `requestId` with step 16's audit line for the tool call.
- **Workers Logs and traces** turned on in `wrangler.jsonc` (`logs.invocation_logs`, `traces.enabled`, 100% sampling).
- **`evals/tool-choice.json`**: 30 prompts from managers and staff with the expected tool, arguments and widget. **`EVALS.md`** is the results table for a manual pass in claude.ai, Claude Desktop and ChatGPT.
- **`scripts/eval-tool-choice.ts`**: `npm run evals` checks the model's first MCP tool call through the paid Claude API connector, writes `evals/tool-choice-results.md` and exits 1 when a tool choice fails. It is kept out of CI because it costs money.
- **`test/evals-shape.test.ts`**: a free automated check that every expected tool exists and its widget link matches, so renaming or unlinking breaks the build.
- **`test/observability.test.ts`**: an audit line and a span share a `requestId`, a failure logs only the error code, and no argument value appears in any log line.
- **CI**: `.github/workflows/step-17-tests.yml` runs typecheck and tests on every push touching the step. Step 18's workflow adds staging and production deploys.
- **`OBSERVABILITY.md`**: where to look for each symptom, and useful log filters.

## Paid automated eval

`npm run evals` sends the 30 prompts through the Claude API MCP connector and is left out of CI because it costs money per run. It needs `ANTHROPIC_API_KEY`, `EVAL_MCP_URL`, `EVAL_STAFF_TOKEN` and `EVAL_MANAGER_TOKEN` in `.dev.vars`; use `-- --limit 5` for a cheap smoke run. The manual pass uses your Claude subscription.

## Verification

- `npm run typecheck` passes, including widget and skill assets.
- Full suite without a real `.env` passes: 13 files, 49 tests; 7 files and 95 database-dependent tests skip as intended.
- `npm run eval:retrieval -- --embedder test` passes at the recorded baseline: found in top 3 100%, correct abstentions 100%.
- The first full run found a CRLF bug in the skill prompt's frontmatter stripper; `body()` in `src/skills/catalog.ts` now accepts `\r\n`, and `test/skills.test.ts` passes 5/5.
- `npm run evals` was intentionally not run: this fork completes step 17 without Anthropic API credits. The free `evals-shape` test inside `npm test` plus `npm run eval:retrieval -- --embedder test` cover the automated part; the 30-prompt client pass in `EVALS.md` is the remaining proof.
- Manual client pass so far: claude.ai 30/30, ChatGPT 28 PASS / 2 FAIL, Desktop 0/30. Prompts 1–25 and 27–29 pass in ChatGPT; prompts 1–25, 27, 28 and 29 pass in both claude.ai and ChatGPT. Prompt #21 in ChatGPT first used the literal placeholder, then passed with the real CSV: it showed 5 valid and 4 invalid rows and asked for confirmation. Prompts #26 and #30 were run with the admin connector in ChatGPT on both attempts, so they failed: #30 showed `Admin` instead of `member`, and #26 asked for confirmation instead of returning 403. Remote D1 confirms `step17.staff@example.com` is a `member` of Step15 Learner's company; they must be rerun with `Learn MCP Step 17 Staff`. Import id `f73e7d7f-ac5c-4039-8ef8-f989603d7471` was verified live in the shared database with 5 done, 4 failed and 0 pending. In ChatGPT prompt #25 was confirmed, so Step15 Learner's company currency is now EUR; historical amounts were not converted. Claude's #25 stopped at the confirmation screen, where currency stayed USD. `get_sales_summary(month)` returned the expected 2025 totals and the chart rendered in both clients; `list_recent_events` returned the two expected events for order WEB-F2B10B5C. Prompt #21 passed the confirmation check (5 valid and 4 invalid CSV rows found before import), #22 confirmed the finished import with 5 done, 4 failed and 0 pending, and #24 approved/published the 2025 report. Prompt #26 failed on the first attempt because the staff user selected its personal company, where it is admin; the target company stayed untouched. That personal membership, its sessions and its settings row were removed. On a fresh staff connection the model called `update_company_settings` and got the expected 403 because the verified role was `member`, so #26 now passes. Prompt #27 returned the correct two members and roles, #28 was a safe no-op because Sara is not a member, #30 listed only Step15 Learner's company with the correct reconnect rule, and prompts #1 and #2 returned the expected filtered order tables. The full three-client manual pass is still pending for ChatGPT and Desktop.
- claude.ai and ChatGPT manual passes are both complete at 30/30. The two earlier ChatGPT failures were connector-selection errors: #30 was rerun with `Learn MCP Step 17 Staff` and correctly showed one company with the `member` role, then #26 was rerun with the same staff connector and returned the expected 403. Desktop remains 0/30.
- CI lives at `.github/workflows/step-17-tests.yml` at the fork root. It runs typecheck, the full test suite without a real `.env` and the free retrieval eval on every push touching this step. The fork needs repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` because the Workers test pool resolves the account once.
- Deployed Worker: `https://learn-mcp-step-17.learn-mcp-step-01.workers.dev`, version `4b694ce0-a06f-4123-83dc-6af395fe8428`. An unauthenticated `tools/list` returns HTTP 401 with the MCP resource-metadata header; `/.well-known/oauth-protected-resource/mcp` and `/api/auth/.well-known/oauth-authorization-server` both return HTTP 200.

## Infrastructure

Like steps 9–16: the deployed Hyperdrive configs and auth D1 from step 13, plus this step's own KV namespace `be93701e355b4560a9ae1fa37c480678` and queues `order-imports-step-17` and `sales-events-step-17`. The initial deploy failed on stale IDs; `wrangler.jsonc` now pins the IDs returned by `wrangler hyperdrive list`, `wrangler d1 list` and `wrangler kv namespace create LEARN_MCP_STEP_17_SETTINGS`.
