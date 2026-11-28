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

const dashboard = {
  title: "2025 at a glance",
  blocks: [
    {
      type: "kpi",
      range: { from: "2025-01-01", to: "2025-12-31" },
      currency: "EUR",
      cards: [
        { metric: "revenue", value: 49350, previous: 44120 },
        { metric: "orders", value: 45, previous: 39 },
        { metric: "average_order_value", value: 1096.67, previous: 1131.28 },
        { metric: "top_product", value: "Standing Desk", previous: null },
      ],
    },
    {
      type: "chart",
      group_by: "product",
      range: { from: "2025-01-01", to: "2025-12-31" },
      currency: "EUR",
      threshold: 2500,
      groups: [
        { label: "Standing Desk", orders: 12, revenue: 4200 },
        { label: "Ergo Chair", orders: 10, revenue: 3550 },
        { label: "Bookshelf", orders: 8, revenue: 2900 },
        { label: "Mechanical Keyboard", orders: 6, revenue: 1800 },
      ],
    },
    {
      type: "table",
      currency: "EUR",
      filters: { customer: "Ayesha Khan", product: null },
      orders: orders.slice(0, 4).map(({ order_ref, order_date, customer, total }) => ({ order_ref, order_date, customer, total })),
    },
    {
      type: "report",
      year: 2025,
      currency: "EUR",
      report: {
        report_id: "report-2025-1",
        stage: "complete",
        summary: {
          year: 2025,
          orders: 45,
          revenue: 49350,
          topProducts: [
            { product: "Standing Desk", revenue: 4200 },
            { product: "Ergo Chair", revenue: 3550 },
          ],
          topCustomers: [
            { customer: "Ayesha Khan", revenue: 12800 },
            { customer: "Laura Schmidt", revenue: 9700 },
          ],
        },
      },
    },
  ],
};

export const SAMPLE_RESULTS = {
  "orders-table": { input: { customer: "a" }, result: result({ orders, nextCursor: "c1" }) },
  "sales-chart": { input: { group_by: "month", from: "2025-01-01" }, result: result(summary("month")) },
  dashboard: {
    input: {
      title: dashboard.title,
      blocks: [
        { type: "kpi", metrics: ["revenue", "orders", "average_order_value", "top_product"], from: "2025-01-01", to: "2025-12-31" },
        { type: "chart", group_by: "product", from: "2025-01-01", to: "2025-12-31", limit: 4 },
        { type: "table", customer: "Ayesha Khan", limit: 4 },
        { type: "report", year: 2025 },
      ],
    },
    result: result(dashboard),
  },
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
