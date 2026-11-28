# Dashboard intent runbook

Use a fresh conversation in each client for every prompt. Paste the prompt once, record `yes` or `no` for the tool and the screen, and save a screenshot for at least two different intents producing two different widgets in both Claude and ChatGPT.

The expected screen is the widget URI key from `src/widgets/resources.ts`. `text only` means the tool has no MCP Apps widget and must still return a useful text answer.

| # | Prompt | Expected tool | Expected screen | claude.ai | Claude Desktop | ChatGPT |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | How are we doing this year? | `show_dashboard` | `dashboard (kpi, chart)` | yes / yes |  | yes / text only |
| 2 | Give me March 2025 at a glance. | `show_dashboard` | `dashboard (kpi, chart)` |  |  |  |
| 3 | Compare last month with the month before. | `show_dashboard` | `dashboard (kpi)` |  |  |  |
| 4 | Quick health check of sales for the board meeting. | `show_dashboard` | `dashboard (kpi, chart, table)` |  |  |  |
| 5 | Show revenue, our best product and best customer for Q2 2025. | `show_dashboard` | `dashboard (kpi)` |  |  |  |
| 6 | Overview of Ayesha Khan's business with us. | `show_dashboard` | `dashboard (kpi, table)` |  |  |  |
| 7 | Dashboard for the Ergo Chair: who buys it and how much. | `show_dashboard` | `dashboard (chart, table)` |  |  |  |
| 8 | Put our 2025 report next to this month's numbers. | `show_dashboard` | `dashboard (report, kpi)` |  |  |  |
| 9 | Which customers should I call this week? Show me the numbers. | `show_dashboard` | `dashboard (chart, table)` |  |  |  |
| 10 | Make me a one-screen summary of December. | `show_dashboard` | `dashboard (kpi, chart)` |  |  |  |
| 11 | Show me the latest orders. | `list_orders` | `orders-table` | yes / yes |  |  |
| 12 | Revenue by month for 2025, as a chart. | `get_sales_summary` | `sales-chart` |  |  |  |
| 13 | What is in order SO-0142? | `get_order` | `text only` |  |  |  |
| 14 | I want to enter a new order. | `open_order_form` | `order-form` |  |  |  |
| 15 | Build the 2025 sales report. | `start_sales_report` | `task-status` |  |  |  |
| 16 | Do our monthly sales review for November 2025. | `show_dashboard` | `dashboard (kpi, chart)` |  |  |  |
| 17 | What is our average order value? | `answer_business_question` | `text only` |  |  |  |
| 18 | Top 5 products by revenue. | `get_sales_summary` | `sales-chart` |  |  |  |
| 19 | Can I give 12% off without approval? | `search_sales_policy` | `text only` |  |  |  |
| 20 | Everything about sales in 2024 on one screen. | `show_dashboard` | `dashboard (kpi, chart, report)` |  |  |  |

## Notes

- Tool choice: did the client call the expected tool without being told its name?
- Screen choice: for `show_dashboard`, did it choose blocks that answer the question?
- Tenant scope: did every number come from the connected company only?
- Fallback: in a client without MCP Apps, did the tool return readable text?
