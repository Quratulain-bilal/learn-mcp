# Eval results: does the model pick the right tool and screen?

The 30 prompts are in `evals/tool-choice.json`, each with the expected first tool, key arguments and widget.

**Automatic part (free, runs in `npm test`):** `test/evals-shape.test.ts` checks that every expected tool still exists and is still linked to (or not linked to) its widget. Renaming a tool or unlinking a widget fails the build.

**Model part (automated, paid, skipped here):** `npm run evals` sends each prompt to the Claude API with the deployed server attached through its MCP connector and checks the first `mcp_tool_use` block. Put `ANTHROPIC_API_KEY`, `EVAL_MCP_URL`, `EVAL_STAFF_TOKEN` and `EVAL_MANAGER_TOKEN` in `.dev.vars` first; get the two access tokens with the MCP Inspector's Quick OAuth Flow. Use `-- --limit 5` for a cheap smoke run. The script writes `evals/tool-choice-results.md` and `evals/tool-choice-results.json`; it exits 1 on any failed tool choice. This fork intentionally does not use Anthropic API credits, so this part was not run; the free `evals-shape` test and the manual client pass below are the proof for this submission.

**Model part (manual, free):** paste each prompt into each client as the right user (staff = member, manager = admin), and record what the model did. This is still needed for widgets and for the expectation notes such as "abstains", "Forbidden (403)" and "confirms first", which the automated tool-choice check records but does not prove.

**Step 18 note:** these 30 prompts were carried forward from step 17, where they passed 30/30 in claude.ai and ChatGPT. Step 18 must repeat them against the staging server before production and the production server after release; this document is not yet a Step 18 pass.

Pass = the expected tool was called first (or, for "confirms first", the model asked before calling it), with sensible arguments, and the expected widget appeared.

| # | Prompt (short) | Expected | claude.ai | Desktop | ChatGPT | Notes / description fix |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | latest orders | list_orders + table | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 2 | Ayesha's orders | list_orders(customer) + table | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 3 | cable organizer orders | list_orders(product) + table | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 4 | order SO-0042 | get_order | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 5 | month by month 2025 | get_sales_summary(month) + chart | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 6 | five biggest customers | get_sales_summary(customer, 5) + chart | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 7 | top revenue products | get_sales_summary(product) + chart | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 8 | average order value | answer_business_question | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 9 | never sold | answer_business_question | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 10 | repeat customers | answer_business_question | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 11 | how data is organised | describe_schema | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 12 | two cities | compare_designs | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 13 | 12% off new customer | search_sales_policy (cites) | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 14 | opened box return | search_sales_policy (cites) | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 15 | dress code | search_sales_policy (abstains) | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 16 | keep medicine cold | find_products | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 17 | order for Laura | create_order (confirms first) | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 18 | enter a new order | open_order_form + form | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 19 | start a draft | add_to_draft | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 20 | what's in my draft | view_draft | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 21 | import CSV | bulk_import_orders (confirms) | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 22 | import progress | get_import_status | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 23 | 2025 report | start_sales_report + progress | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 24 | approve report | approve_report | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 25 | currency EUR (manager) | update_company_settings | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 26 | currency EUR (staff) | update_company_settings → 403 | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 27 | who's in my company | list_company_members | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 28 | remove Sara | remove_member (asks first) | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 29 | what's new | list_recent_events | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |
| 30 | which companies | list_my_companies | carried over | | carried over | Step 17 passed; rerun against Step 18 staging/production. |

**Pass rate:** not yet measured for Step 18. The step 17 baseline was claude.ai 30/30 and ChatGPT 30/30; Desktop was 0/30 there too.

## When a prompt fails

Change the **tool description**, not the prompt. Say what the tool is for and when to prefer it over its neighbour (see how `list_orders` and `get_sales_summary` point at each other). Re-run the failing prompts and the ones whose tools you touched.
