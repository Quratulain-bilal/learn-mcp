# Eval results: does the model pick the right tool and screen?

The 30 prompts are in `evals/tool-choice.json`, each with the expected first tool, key arguments and widget.

**Automatic part (free, runs in `npm test`):** `test/evals-shape.test.ts` checks that every expected tool still exists and is still linked to (or not linked to) its widget. Renaming a tool or unlinking a widget fails the build.

**Model part (automated, paid, skipped here):** `npm run evals` sends each prompt to the Claude API with the deployed server attached through its MCP connector and checks the first `mcp_tool_use` block. Put `ANTHROPIC_API_KEY`, `EVAL_MCP_URL`, `EVAL_STAFF_TOKEN` and `EVAL_MANAGER_TOKEN` in `.dev.vars` first; get the two access tokens with the MCP Inspector's Quick OAuth Flow. Use `-- --limit 5` for a cheap smoke run. The script writes `evals/tool-choice-results.md` and `evals/tool-choice-results.json`; it exits 1 on any failed tool choice. This fork intentionally does not use Anthropic API credits, so this part was not run; the free `evals-shape` test and the manual client pass below are the proof for this submission.

**Model part (manual, free):** paste each prompt into each client as the right user (staff = member, manager = admin), and record what the model did. This is still needed for widgets and for the expectation notes such as "abstains", "Forbidden (403)" and "confirms first", which the automated tool-choice check records but does not prove.

Pass = the expected tool was called first (or, for "confirms first", the model asked before calling it), with sensible arguments, and the expected widget appeared.

| # | Prompt (short) | Expected | claude.ai | Desktop | ChatGPT | Notes / description fix |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | latest orders | list_orders + table | PASS | | PASS | claude.ai ne latest orders table dikhaya; ChatGPT ne 10 recent orders diye, sabse naye 27 Nov 2026 ke Daniela Rossi (Milan) aur Fatima Zahra (Casablanca) the |
| 2 | Ayesha's orders | list_orders(customer) + table | PASS | | PASS | claude.ai aur ChatGPT dono ne 11 orders filter karke diye; sab Karachi, 8 Feb 2025 se 6 Jan 2026 tak, recent IMP-F73E7D7F-4 aur largest SO-0105 |
| 3 | cable organizer orders | list_orders(product) + table | PASS | | PASS | claude.ai me SO-0145 mila; ChatGPT ne bhi sirf SO-0145 (Kwame Mensah, Accra, 15 Dec 2025, 76) diya; table dikhayi gayi |
| 4 | order SO-0042 | get_order | PASS | | PASS | claude.ai aur ChatGPT dono ne Julia Novak, 16 Apr 2025, LED Bulb Pack line aur total 26 sahi diye; ChatGPT ne 4 × 6.50 bhi bataya |
| 5 | month by month 2025 | get_sales_summary(month) + chart | PASS | | PASS | Chart rendered in Claude and ChatGPT; 145 orders, 719 units, 89,838.50 USD; Sep/June highest, Dec/Feb lowest |
| 6 | five biggest customers | get_sales_summary(customer, 5) + chart | PASS | | PASS | claude.ai ne 2026 me sirf Fatima Zahra (1 order, 1,497 USD) aur 2025 ka option diya; ChatGPT ne 2026 ke 5 customers (Fatima 1,497, Ayesha 499, Chen Wei 269, Julia Novak 190, Daniela Rossi 149) aur sales chart sahi diye |
| 7 | top revenue products | get_sales_summary(product) + chart | PASS | | PASS | claude.ai ne all-time top 10 diye (Standing Desk 32,934 USD pehle); ChatGPT ne 2026 product chart diya, Standing Desk 4 units / 1,996 USD pehle aur key finding sahi |
| 8 | average order value | answer_business_question | PASS | | PASS | claude.ai ne all-time AOV 625.59 USD (146 orders / 91,335.50 USD) aur 2025-only 619.58 USD bataye; ChatGPT ne 2026 AOV 398.14 USD (7 orders / 2,787 USD) sahi diya |
| 9 | never sold | answer_business_question | PASS | | PASS | claude.ai ne Compact Desk Fridge aur Monitor Arm all-time unsold mile; ChatGPT ne 2026 me 8 unsold products diye aur sahi caveat bataya ke historical sales alag ho sakti hain |
| 10 | repeat customers | answer_business_question | PASS | | PASS | claude.ai ne all-time 15 repeat customers diye (Fatima Zahra 11 orders); ChatGPT ne 2026 me 0 repeat customers sahi bataye. Emeka Obi ki last order date claude.ai ne 2025-11-10 likhi, sahi 2025-11-13 hai |
| 11 | how data is organised | describe_schema | PASS | | PASS | claude.ai ne 5 normalized tables, keys/relations aur historical unit_price sahi samjhaye; ChatGPT ne 15 customers / 152 orders / 296 order_items / 14 products / 5 categories ke saath same schema diya |
| 12 | two cities | compare_designs | PASS | | PASS | claude.ai ne Ayesha Khan Karachi/Lahore update anomaly aur 3NF fix sahi samjhaya; ChatGPT ne ayesha.khan@example.com ka old spreadsheet Karachi/Lahore aur normalized DB Karachi dikhaya |
| 13 | 12% off new customer | search_sales_policy (cites) | PASS | | PASS | claude.ai ne line 3 aur line 5 cite kiye; ChatGPT ne line 3 (up to 15% no approval), line 4 (15–25% approval) aur line 5 (welcome discount max 10%) cite karke 12% regular discount allow kiya lekin 12% welcome discount reject kiya |
| 14 | opened box return | search_sales_policy (cites) | PASS | | PASS | claude.ai ne line 3/4/5 aur assembled furniture exception sahi diye; ChatGPT ne line 3–4 cite karke 14 din, resaleable condition aur 10% restocking fee bataya |
| 15 | dress code | search_sales_policy (abstains) | PASS | | PASS | claude.ai aur ChatGPT dono ne Friday dress code policy na milne par abstain kiya aur manager se poochhne ka kaha |
| 16 | keep medicine cold | find_products | PASS | | PASS | claude.ai aur ChatGPT dono ne Compact Desk Fridge (149) mila; ChatGPT ne medicine ke liye suitable bataya |
| 17 | order for Laura | create_order (confirms first) | PASS | | PASS | claude.ai aur ChatGPT dono ne pehle confirmation manga aur koi order create nahi kiya; ChatGPT ne 2 Desk Lamps × 24.00 = 48.00 preview diya |
| 18 | enter a new order | open_order_form + form | PASS | | PASS | claude.ai ne form khola (15 customers, 14 products); ChatGPT ne bhi interactive order form widget dikhaya aur customer/products/quantities select karne ka option bataya |
| 19 | start a draft | add_to_draft | PASS | | PASS | claude.ai ne Laura ke liye 2 Desk Lamps ka draft banaya; ChatGPT ne pehle se maujood draft me 2 already hone ka pata karke 4 karne se roka aur correction propose ki, real order nahi hua |
| 20 | what's in my draft | view_draft | PASS | | PASS | claude.ai ne Desk Lamp x2 dikhaya; ChatGPT ne current draft Laura / Desk Lamp / quantity 4 sahi dikhaya aur koi real order nahi hona bataya |
| 21 | import CSV | bulk_import_orders (confirms) | PASS | | PASS | claude.ai me 9 rows me 5 valid aur 4 invalid pehle bataye, confirmation par import chal gaya: 5 done, 4 failed. ChatGPT me bhi actual CSV se 5 valid / 4 invalid validation table aur confirmation screen sahi dikhaya; import confirm nahi kiya gaya |
| 22 | import progress | get_import_status | PASS | | PASS | claude.ai aur ChatGPT dono ne import f73e7d7f-ac5c-4039-8ef8-f989603d7471 ka finished status diya: 5 done, 4 failed, 0 pending; failed rows wahi 4 the (date, unknown customer, unknown product, qty 0) |
| 23 | 2025 report | start_sales_report + progress | PASS | | PASS | claude.ai me report ef44b854-6069-4747-b2f7-d9723af3c3ed start hui; ChatGPT me report 02504a21-9477-4ac7-940a-c0ac2fbb1a6c ban gayi aur approval stage tak pohonchi (145 orders / 89,838.50 USD, monthly chart + top 5 products/customers) |
| 24 | approve report | approve_report | PASS | | PASS | claude.ai me ef44b854-6069-4747-b2f7-d9723af3c3ed approve/publish hui; ChatGPT me pehle awaiting_approval bataya, phir confirmation par 02504a21-9477-4ac7-940a-c0ac2fbb1a6c approve aur publish ho gayi |
| 25 | currency EUR (manager) | update_company_settings | PASS | | PASS | Company-wide setting thi, isliye dono clients ne pehle confirmation manga. claude.ai me confirm nahi kiya gaya tha aur USD reh gayi; ChatGPT me confirm karne par currency USD se EUR ho gayi, fiscal year January aur threshold 1,000 unchanged, historical amounts convert nahi hue |
| 26 | currency EUR (staff) | update_company_settings → 403 | PASS | | PASS | claude.ai aur ChatGPT dono me staff connector se sahi 403 mili: "your account has the member role, and only company admins can change company settings". Pehle do galat admin attempts the; final staff attempt ne verify kar diya ke role-based block kaam karta hai |
| 27 | who's in my company | list_company_members | PASS | | PASS | claude.ai aur ChatGPT dono me 2 members aur roles sahi dikhe: Step15 Learner admin aur Step17 Staff member |
| 28 | remove Sara | remove_member (asks first) | PASS | | PASS | Dono clients me Sara member nahi thi, koi removal nahi hua aur clean "not found / no changes were made" response diya; kisi member ko remove karne se pehle confirmation mangi gayi |
| 29 | what's new | list_recent_events | PASS | | PASS | 2 recent events returned in Claude and ChatGPT, both from order WEB-F2B10B5C |
| 30 | which companies | list_my_companies | PASS | | PASS | claude.ai aur ChatGPT dono me staff connector ne sirf Step15 Learner's company aur `member` role sahi bataya; switching ka sahi tarika disconnect/reconnect bataya gaya |

**Pass rate:** claude.ai 30/30 · ChatGPT 30/30 · Desktop 0/30 (full manual pass complete in Claude and ChatGPT; Desktop still pending)

**claude.ai result:** Full 30/30 manual pass complete, including #26 staff 403 aur #30 single-company `member` result. ChatGPT ke do gaps connector-selection ki wajah se hain; jab tak `Learn MCP Step 17 Staff` se dobara test na ho, ye FAIL hi reh gaye hain.

## When a prompt fails

Change the **tool description**, not the prompt. Say what the tool is for and when to prefer it over its neighbour (see how `list_orders` and `get_sales_summary` point at each other). Re-run the failing prompts and the ones whose tools you touched.
