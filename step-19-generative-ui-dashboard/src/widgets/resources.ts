import type { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { WIDGET_HTML } from "./generated";

/**
 * The widgets, served as MCP Apps UI RESOURCES. A tool points at one of these URIs in its
 * _meta.ui.resourceUri; the host (Claude, ChatGPT) reads the resource, renders the HTML in
 * a sandboxed iframe, and passes the tool's result into it.
 *
 * The version is part of the URI because hosts cache UI resources: a new URI makes them
 * fetch the new widget instead of showing the old one.
 *
 * The HTML is the same for every company and contains no data: the data arrives only
 * through the tool result, which is scoped to the caller's company like every other result.
 */

const VERSION = "v1";
export const WIDGETS = {
  ordersTable: `ui://learn-mcp/orders-table-${VERSION}.html`,
  salesChart: `ui://learn-mcp/sales-chart-${VERSION}.html`,
  orderForm: `ui://learn-mcp/order-form-${VERSION}.html`,
  taskStatus: `ui://learn-mcp/task-status-${VERSION}.html`,
  dashboard: `ui://learn-mcp/dashboard-${VERSION}.html`,
} as const;

const SOURCES: Record<keyof typeof WIDGETS, { html: string; title: string; description: string }> = {
  ordersTable: {
    html: WIDGET_HTML["orders-table"],
    title: "Orders table",
    description: "An interactive table of orders with paging.",
  },
  salesChart: {
    html: WIDGET_HTML["sales-chart"],
    title: "Sales chart",
    description: "A bar chart of sales by month, product or customer.",
  },
  orderForm: {
    html: WIDGET_HTML["order-form"],
    title: "Order form",
    description: "A form to place a new order.",
  },
  dashboard: {
    html: WIDGET_HTML["dashboard"],
    title: "Sales dashboard",
    description: "A dashboard composed from approved blocks: KPI cards, charts, an orders table and a saved report.",
  },
  taskStatus: {
    html: WIDGET_HTML["task-status"],
    title: "Report progress",
    description: "Live progress of a sales report run, then the finished report.",
  },
};

export function registerWidgetResources(server: McpServer): void {
  for (const [key, uri] of Object.entries(WIDGETS) as [keyof typeof WIDGETS, string][]) {
    const { html, title, description } = SOURCES[key];
    registerAppResource(
      server,
      title,
      uri,
      {
        description,
        // Everything is inlined, so the widget needs no outside origins at all: the
        // host's default "block everything" content security policy is what we want.
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
      },
      async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] }),
    );
  }
}
