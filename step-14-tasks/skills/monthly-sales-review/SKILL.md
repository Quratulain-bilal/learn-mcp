---
name: monthly-sales-review
description: Prepare a monthly sales review for the signed-in company - pull the month's numbers with get_sales_summary and list_orders, show them in the right widgets, compare with the month before, and write a short narrative with recommendations. Use when the user asks for a monthly review, a month-end summary, or "how did we do in <month>".
---

# Monthly sales review

You are preparing a short, decision-ready review of ONE month of sales for the user's company. Everything comes from this server's tools; never invent numbers.

## 1. Pin down the month

- If the user named a month, use it. If they said "last month", use the calendar month before today.
- Work out the first and last day (YYYY-MM-DD). Also work out the PREVIOUS month: you will compare against it.
- If the company has no data for that month, say so plainly and stop. Offer the most recent month that has data (call `get_sales_summary` with `group_by: "month"` and no dates to find it).

## 2. Pull the numbers (in this order)

1. `get_sales_summary` with `group_by: "month"`, `from` = first day of the PREVIOUS month, `to` = last day of the review month.
   This gives both months' revenue and orders in one call, and shows the chart widget.
2. `get_sales_summary` with `group_by: "product"` for the review month only, `limit: 5`.
3. `get_sales_summary` with `group_by: "customer"` for the review month only, `limit: 5`.
4. `list_orders` for the review month, `limit: 10`, only if the user wants to see individual orders or if one customer or product dominates and you need to see why.

Don't page through every order to compute totals: the summaries already have them.

## 3. Show it

Read [references/widgets.md](references/widgets.md) for which widget fits which question. In short: the chart for trends and rankings, the table for individual orders. Don't repeat a whole table in text when a widget already shows it; refer to it.

## 4. Write the review

Use the structure in [references/review-template.md](references/review-template.md). Keep it under 200 words. Rules:

- Lead with the one number that matters most: revenue for the month and the change from the month before, as an amount AND a percentage.
- Use the company's currency from the summary results (`currency`).
- Name the top product and top customer, with their share of the month's revenue.
- Groups flagged `at_or_above_threshold` are above the company's own threshold; mention them as such.
- Recommendations must follow from the numbers you showed (e.g. "Ergo Chair is 31% of revenue: check stock before next month"). No generic advice.
- If a recommendation touches discounts, returns or credit terms, check the company's policy first with `search_sales_policy` and cite it, or say the policies don't cover it.

## 5. What not to do

- Don't create orders, change settings or add documents during a review; it is read-only.
- Don't compare with other companies or industry figures: you only have this company's data.
- If a tool returns an error, tell the user what failed and continue with what you have.
