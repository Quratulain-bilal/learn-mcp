# Which widget for which question

This server's widgets render inside the chat in hosts that support MCP Apps. Where they don't render, the same tools still return a text answer.

| The user wants… | Call | Widget |
| --- | --- | --- |
| An overview: "how are we doing", "March at a glance", a health check | `show_dashboard` with kpi + chart (+ table) blocks | Dashboard (composed from approved blocks) |
| A trend over months, or this month vs last | `get_sales_summary` `group_by: "month"` with a date range | Sales chart (bars by month) |
| Best products or customers | `get_sales_summary` `group_by: "product"` or `"customer"`, `limit: 5` | Sales chart; the user can switch grouping with its buttons |
| To see or check individual orders | `list_orders` with `from`/`to` and optional `customer`/`product` | Orders table, with Load more |
| One order in detail | `get_order` | (text) |
| To place an order with missing details | `open_order_form` | Order form |

Tips:

- One chart per grouping. Two calls (product, then customer) are clearer than one long answer.
- The chart already highlights groups at or above the company's threshold. Don't restate every bar; pick the two or three that matter.
- After showing a widget, your text should add what the picture doesn't say: the change, the reason, the recommendation.
