import type { CallToolResult } from "@modelcontextprotocol/server";

/** Sample tool inputs and results, shaped exactly like the real tools' structuredContent. */

const orders = Array.from({ length: 8 }, (_, i) => ({
  order_ref: `SO-${String(145 - i).padStart(4, "0")}`,
  order_date: `2025-12-${String(28 - i * 2).padStart(2, "0")}`,
  customer: ["Ayesha Khan", "Laura Schmidt", "Chen Wei", "Omar Farooq"][i % 4]!,
  city: ["Karachi", "Berlin", "Singapore", "Karachi"][i % 4]!,
  lines: 1 + (i % 3),
  total: Math.round((80 + i * 137.5) * 100) / 100,
}));

const result = (structuredContent: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: "(text fallback)" }],
  structuredContent,
});

const summary = (group_by: string) => {
  const labels =
    group_by === "month"
      ? ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"]
      : group_by === "product"
        ? ["Standing Desk", "Ergo Chair", "Bookshelf", "Noise-Cancelling Headphones", "Mechanical Keyboard"]
        : ["Ayesha Khan", "Laura Schmidt", "Chen Wei", "Omar Farooq"];
  const groups = labels.map((label, i) => {
    const revenue = 4200 - i * 650;
    return { [group_by]: label, orders: 12 - i, units: 30 - i * 3, revenue, at_or_above_threshold: revenue >= 2500 };
  });
  return {
    group_by,
    groups,
    total: { orders: 45, units: 120, revenue: groups.reduce((s, g) => s + g.revenue, 0) },
    moreGroups: false,
    currency: "EUR",
    threshold: 2500,
  };
};

export const SAMPLE_RESULTS = {
  "orders-table": { input: { customer: "a" }, result: result({ orders, nextCursor: "c1" }) },
  "sales-chart": { input: { group_by: "month", from: "2025-01-01" }, result: result(summary("month")) },
  "order-form": {
    input: {},
    result: result({
      customers: [
        { name: "Ayesha Khan", email: "ayesha.khan@example.com", city: "Karachi" },
        { name: "Laura Schmidt", email: "laura.schmidt@example.com", city: "Berlin" },
      ],
      products: [
        { name: "Desk Lamp", category: "Lighting", list_price: 24 },
        { name: "Ergo Chair", category: "Furniture", list_price: 269 },
      ],
      currency: "EUR",
    }),
  },
} as const;

/** Answers the widgets' callServerTool calls the way the server would. */
export function SAMPLE_CALLS(name: string, args: Record<string, unknown>): CallToolResult {
  if (name === "list_orders") {
    return result({ orders: orders.map((o, i) => ({ ...o, order_ref: `SO-${String(100 - i).padStart(4, "0")}` })), nextCursor: null });
  }
  if (name === "get_sales_summary") return result(summary(String(args.group_by)));
  if (name === "create_order") {
    return result({ order_ref: "WEB-1A2B3C4D", order_date: "2026-11-26", customer: "Ayesha Khan", lines: [], total: 317 });
  }
  return { isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] };
}
