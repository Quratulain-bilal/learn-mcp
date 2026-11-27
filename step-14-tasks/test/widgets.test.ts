import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WIDGETS } from "../src/widgets/resources";
import { plantCompany, removeCompany, uniqueOrg } from "./fixtures";
import { clientAs, hasDatabase, tenantCtx } from "./helpers";

const any = clientAs(tenantCtx({ orgId: "demo" }));

describe("MCP Apps wiring (no database needed)", () => {
  it("links each widget tool to its ui:// resource, in both the current and the older _meta form", async () => {
    const { result } = await any.rpc("tools/list", {});
    const byName = Object.fromEntries(result.tools.map((t: { name: string }) => [t.name, t]));
    for (const [tool, uri] of [
      ["list_orders", WIDGETS.ordersTable],
      ["get_sales_summary", WIDGETS.salesChart],
      ["open_order_form", WIDGETS.orderForm],
    ]) {
      expect(byName[tool!]._meta.ui.resourceUri, tool).toBe(uri);
      expect(byName[tool!]._meta["ui/resourceUri"], tool).toBe(uri);
    }
  });

  it("serves every widget as a self-contained MCP App resource", async () => {
    for (const uri of Object.values(WIDGETS)) {
      const read = await any.rpc("resources/read", { uri });
      const [content] = read.result.contents;
      expect(content.mimeType, uri).toBe(RESOURCE_MIME_TYPE);
      expect(content.text, uri).toContain('<div id="root"></div>');
      // Nothing is loaded from outside: the sandbox's CSP would block it anyway.
      expect(content.text, uri).not.toMatch(/<script[^>]+src=|<link[^>]+href="http/);
    }
  });
});

describe.skipIf(!hasDatabase)("widget tools return only the caller's company data (needs Neon)", () => {
  const A = uniqueOrg("widget-a");
  const B = uniqueOrg("widget-b");
  beforeAll(async () => {
    await plantCompany(A, "A");
    await plantCompany(B, "B");
  });
  afterAll(async () => {
    await removeCompany(A);
    await removeCompany(B);
  });

  it("open_order_form lists only this company's customers and products", async () => {
    const form = await clientAs(tenantCtx({ orgId: A })).callTool("open_order_form", {});
    expect(form.structuredContent.customers).toEqual([
      { name: "Matrix Buyer A", email: "buyer@a.example.com", city: "Testville" },
    ]);
    expect(form.structuredContent.products.map((p: { name: string }) => p.name)).toEqual(["Matrix Product"]);
    expect(form.structuredContent.currency).toBe("USD");
  });

  it("every widget tool still returns a text answer, for hosts without MCP Apps", async () => {
    const client = clientAs(tenantCtx({ orgId: A }));
    for (const [tool, args] of [
      ["list_orders", {}],
      ["get_sales_summary", { group_by: "month" }],
      ["open_order_form", {}],
    ] as const) {
      const result = await client.callTool(tool, args);
      expect(result.content[0].type, tool).toBe("text");
      expect(result.content[0].text.length, tool).toBeGreaterThan(20);
    }
  });
});
