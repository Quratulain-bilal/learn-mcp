import { describe, expect, it } from "vitest";
import { dashboardIntentErrors } from "../evals/dashboard-evals";
import intents from "../evals/dashboard-intents.json";
import { WIDGETS } from "../src/widgets/resources";
import { clientAs, hasDatabase, tenantCtx } from "./helpers";

const demo = clientAs(tenantCtx({ orgId: "demo" }));

describe("show_dashboard: approved parts only (no database needed)", () => {
  it("is linked to the dashboard widget and served as an MCP App", async () => {
    const { result } = await demo.rpc("tools/list", {});
    const tool = result.tools.find((t: { name: string }) => t.name === "show_dashboard");
    expect(tool._meta.ui.resourceUri).toBe(WIDGETS.dashboard);
    expect(tool.description).toContain("FIRST CHOICE");
    expect(tool.description).toContain("renders the dashboard widget");
    const read = await demo.rpc("resources/read", { uri: WIDGETS.dashboard });
    expect(read.result.contents[0].text).toContain('<div id="root"></div>');
  });

  for (const [why, args] of [
    ["an unknown block type (free HTML)", { title: "Hack", blocks: [{ type: "html", html: "<script>alert(1)</script>" }] }],
    ["more than 6 blocks", { title: "Too much", blocks: Array.from({ length: 7 }, () => ({ type: "kpi", metrics: ["revenue"] })) }],
    ["an unknown metric", { title: "Bad metric", blocks: [{ type: "kpi", metrics: ["profit_margin"] }] }],
    ["no blocks", { title: "Empty", blocks: [] }],
    ["a bad date", { title: "Bad date", blocks: [{ type: "chart", group_by: "month", from: "March" }] }],
  ] as const) {
    it(`refuses ${why}`, async () => {
      const result = await demo.callTool("show_dashboard", args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain("couldn't be reached");
    });
  }

  it("the 20-intent eval set names real tools, widgets and valid block types", async () => {
    const { result } = await demo.rpc("tools/list", {});
    const names = new Set(result.tools.map((t: { name: string }) => t.name));
    const summary = result.tools.find((t: { name: string }) => t.name === "get_sales_summary");
    expect(summary.description).toContain("show_dashboard");
    const widgetUris: Record<string, string> = {
      dashboard: WIDGETS.dashboard,
      "orders-table": WIDGETS.ordersTable,
      "sales-chart": WIDGETS.salesChart,
      "order-form": WIDGETS.orderForm,
      "task-status": WIDGETS.taskStatus,
    };
    expect(dashboardIntentErrors(intents)).toEqual([]);
    for (const p of intents.prompts) {
      expect(names.has(p.tool), `${p.id}: ${p.tool}`).toBe(true);
      if (p.widget !== "none") expect(widgetUris[p.widget], `${p.id}: ${p.widget}`).toBeTruthy();
      for (const b of p.blocks) expect(["kpi", "chart", "table", "report"], `${p.id}`).toContain(b);
    }
  });
});

describe.skipIf(!hasDatabase)("show_dashboard with real data (needs Neon)", () => {
  it("fills every block for the caller's company, consistent with the other tools", async () => {
    const result = await demo.callTool("show_dashboard", {
      title: "2025 at a glance",
      blocks: [
        { type: "kpi", metrics: ["revenue", "orders", "average_order_value", "top_product"], from: "2025-01-01", to: "2025-12-31" },
        { type: "chart", group_by: "product", from: "2025-01-01", to: "2025-12-31", limit: 3 },
        { type: "table", customer: "ayesha", limit: 5 },
        { type: "report", year: 2001 },
      ],
    });
    expect(result.isError, result.content?.[0]?.text).toBeFalsy();
    const [kpi, chart, table, report] = result.structuredContent.blocks;

    const summary = await demo.callTool("get_sales_summary", { group_by: "month", from: "2025-01-01", to: "2025-12-31" });
    const card = (m: string) => kpi.cards.find((c: { metric: string }) => c.metric === m).value;
    expect(card("revenue")).toBe(summary.structuredContent.total.revenue);
    expect(card("orders")).toBe(summary.structuredContent.total.orders);
    expect(typeof card("top_product")).toBe("string");

    expect(chart.groups).toHaveLength(3);
    expect(chart.groups[0].revenue).toBeGreaterThanOrEqual(chart.groups[1].revenue);
    expect(table.orders.length).toBeGreaterThan(0);
    expect(table.orders.every((o: { customer: string }) => o.customer === "Ayesha Khan")).toBe(true);
    expect(report.report).toBeNull();
    expect(result.content[0].text).toContain("# 2025 at a glance");
  });

  it("compares with the previous period when asked", async () => {
    const result = await demo.callTool("show_dashboard", {
      title: "Q2 vs Q1",
      blocks: [{ type: "kpi", metrics: ["revenue"], from: "2025-04-01", to: "2025-06-30", compare_previous: true }],
    });
    const [card] = result.structuredContent.blocks[0].cards;
    expect(typeof card.previous).toBe("number");
    expect(card.previous).toBeGreaterThan(0);
  });

  it("another company's dashboard shows only its own (empty) data", async () => {
    const other = clientAs(tenantCtx({ orgId: "dashboard-empty-co" }));
    const result = await other.callTool("show_dashboard", {
      title: "Empty",
      blocks: [{ type: "kpi", metrics: ["revenue", "orders", "top_customer"] }, { type: "table" }],
    });
    const [kpi, table] = result.structuredContent.blocks;
    expect(kpi.cards.map((c: { value: unknown }) => c.value)).toEqual([0, 0, null]);
    expect(table.orders).toEqual([]);
  });
});
