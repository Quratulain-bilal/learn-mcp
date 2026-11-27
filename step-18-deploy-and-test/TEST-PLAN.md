# Cross-client test plan

Run it against **staging** before every production release, then the short **smoke** section against **production** right after. Tick each box per client. "Admin" and "Member" are two accounts in the same company; "Other" is an account in another company.

| Client | How to connect |
| --- | --- |
| **claude.ai** | Settings → Connectors → Add custom connector → `https://learn-mcp-step-18-staging.awaismudasir10.workers.dev/mcp` |
| **Claude Desktop** | Same, in the desktop app (after a widget change, fully quit and reopen: Desktop caches widgets) |
| **ChatGPT** (developer mode, paid plan) | Settings → Connectors → Developer mode → add the same URL |

Before you start: sign in once as Admin, ask "run describe_schema" to get the company id, and seed it on your computer:

```bash
ENV_FILE=.env.staging npx tsx scripts/seed-company.ts --org <id>
ENV_FILE=.env.staging npx tsx scripts/embed.ts --org <id> --set harbor
```

## 1. Connect and sign in

| # | Check | claude.ai | Desktop | ChatGPT |
| --- | --- | --- | --- | --- |
| 1.1 | Adding the connector opens our sign-in page; creating an account and clicking Allow connects | ☐ | ☐ | ☐ |
| 1.2 | "What tools do you have?" lists the sales, order, policy, company, draft, import, report and event tools | ☐ | ☐ | ☐ |
| 1.3 | A user in two companies is asked to choose one on `/select-company` | ☐ | ☐ | ☐ |

## 2. Reading data (step 5–7)

| # | Prompt | Expected | claude.ai | Desktop | ChatGPT |
| --- | --- | --- | --- | --- | --- |
| 2.1 | "Explain how our sales database is organised." | `describe_schema`, 5 tables, keys explained | ☐ | ☐ | ☐ |
| 2.2 | "What were our top 5 products in 2025?" | `answer_business_question` top_products | ☐ | ☐ | ☐ |
| 2.3 | "Why did the old spreadsheet give Ayesha Khan two cities?" | `compare_designs` customer_city | ☐ | ☐ | ☐ |
| 2.4 | "What's in order SO-0042?" | `get_order`, lines and total | ☐ | ☐ | ☐ |
| 2.5 | "Which companies am I in?" | `list_my_companies` | ☐ | ☐ | ☐ |

## 3. Widgets (step 9, 14)

| # | Prompt | Expected widget | claude.ai | Desktop | ChatGPT |
| --- | --- | --- | --- | --- | --- |
| 3.1 | "Show me Ayesha Khan's orders." | Orders table; **Load more** works; **Lines** asks the model | ☐ | ☐ | ☐ |
| 3.2 | "How did sales go month by month in 2025?" | Bar chart; **By product / By customer** regroup | ☐ | ☐ | ☐ |
| 3.3 | "I want to enter a new order." | Order form; **Place order** creates it and shows the reference | ☐ | ☐ | ☐ |
| 3.4 | "Build our 2025 sales report." | Progress panel fills in, then shows the report | ☐ | ☐ | ☐ |
| 3.5 | Switch the client to dark mode and repeat 3.2 | Widget follows the theme, text readable | ☐ | ☐ | ☐ |
| 3.6 | If a widget doesn't render | The text answer still makes sense | ☐ | ☐ | ☐ |

## 4. Writing (steps 6, 7, 8, 11–13)

| # | Prompt | Expected | claude.ai | Desktop | ChatGPT |
| --- | --- | --- | --- | --- | --- |
| 4.1 | "Create an order for laura.schmidt@example.com: 2 Desk Lamps." | Model confirms first, then `create_order` | ☐ | ☐ | ☐ |
| 4.2 | "Start a draft for Laura: two lamps" → "add a chair" → "submit it" | `add_to_draft` ×2, `submit_draft` | ☐ | ☐ | ☐ |
| 4.3 | Paste `step-12-queues/samples/orders-import.csv`: "Import these orders", then "how's it going?" | 5 done, 4 failed with reasons (fenced as data) | ☐ | ☐ | ☐ |
| 4.4 | As Admin: "Approve the report." | `approve_report`, stage published | ☐ | ☐ | ☐ |
| 4.5 | As Admin: "Set our currency to EUR and threshold to 500." | `update_company_settings`; next chart shows EUR | ☐ | ☐ | ☐ |
| 4.6 | As Admin: "Add a shipping policy: # Shipping rules, 1. Orders over 200 USD ship free." | `add_policy_document` | ☐ | ☐ | ☐ |

## 5. Search, skills, events (steps 8, 10, 15)

| # | Prompt | Expected | claude.ai | Desktop | ChatGPT |
| --- | --- | --- | --- | --- | --- |
| 5.1 | "Can I give a customer 12% off without asking my manager?" | Cited answer (discounts, line 3) | ☐ | ☐ | ☐ |
| 5.2 | "What's our dress code on Fridays?" | Abstains: policies don't cover it | ☐ | ☐ | ☐ |
| 5.3 | "Do we sell anything to keep medicine cold?" | Compact Desk Fridge | ☐ | ☐ | ☐ |
| 5.4 | Pick the **Monthly sales review** prompt, month `2025-11` (ChatGPT: "Do our monthly sales review for November 2025") | Follows the playbook | ☐ | ☐ | ☐ |
| 5.5 | After 4.1: "What's new?" | `list_recent_events` shows order.created | ☐ | ☐ | ☐ |

## 6. Security and isolation (steps 4, 7, 16)

| # | Check | Expected | claude.ai | Desktop | ChatGPT |
| --- | --- | --- | --- | --- | --- |
| 6.1 | As Other: ask for one of Admin's order references | Same "not found" as a made-up reference | ☐ | ☐ | ☐ |
| 6.2 | As Member: "Change our currency to GBP." / "Remove someone." | Forbidden (403) | ☐ | ☐ | ☐ |
| 6.3 | As Admin: "Remove the member." | Model asks you to confirm before calling `remove_member` | ☐ | ☐ | ☐ |
| 6.4 | After 6.3, the removed member asks anything | Refused on the next call | ☐ | ☐ | ☐ |
| 6.5 | Ask 21 quick changes in a row (e.g. clear the draft repeatedly) | 21st is rate-limited with a wait time | ☐ | ☐ | ☐ |

## 7. Production smoke (right after a release)

| # | Check | Done |
| --- | --- | --- |
| 7.1 | `curl https://learn-mcp-step-18.awaismudasir10.workers.dev/version` shows the new release and `"environment":"production"` | ☐ |
| 7.2 | In claude.ai on the production connector: 2.2, 3.2 and 4.1 | ☐ |
| 7.3 | Workers Logs for `learn-mcp-step-18`: `type = audit` lines appear, no `outcome: "exception"` spike | ☐ |

## Differences between clients (record what you see)

| Area | claude.ai | Claude Desktop | ChatGPT |
| --- | --- | --- | --- |
| Widgets render | | | |
| Prompts (slash / + menu) | | | |
| Skills over MCP | not yet (use the prompt) | not yet | partial |
| Tasks / Events extensions | not yet (fallback tools) | not yet | Events: webhook only |
