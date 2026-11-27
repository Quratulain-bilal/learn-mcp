import { describe, expect, it } from "vitest";
import { QUESTION_NAMES } from "../src/questions";
import { brokenForTenant, clientAs, hasDatabase, tenantCtx } from "./helpers";

const demo = clientAs(tenantCtx({ orgId: "demo" }));

describe("tool definitions (no database needed)", () => {
  it("lists every tool, with only the write tools marked as writing", async () => {
    const { result } = await demo.rpc("tools/list", {});
    const names = result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "add_policy_document",
      "add_to_draft",
      "answer_business_question",
      "bulk_import_orders",
      "clear_draft",
      "compare_designs",
      "create_order",
      "describe_schema",
      "find_products",
      "get_company_settings",
      "get_import_status",
      "get_order",
      "get_sales_summary",
      "invite_member",
      "list_company_members",
      "list_my_companies",
      "list_orders",
      "open_order_form",
      "remove_member",
      "search_sales_policy",
      "submit_draft",
      "update_company_settings",
      "view_draft",
    ]);
    const writers = [
      "add_policy_document",
      "add_to_draft",
      "bulk_import_orders",
      "clear_draft",
      "create_order",
      "invite_member",
      "remove_member",
      "submit_draft",
      "update_company_settings",
    ];
    for (const tool of result.tools) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(!writers.includes(tool.name));
    }
  });

  it("never accepts SQL: an unknown question is rejected, and no tool has a sql or query field", async () => {
    const bad = await demo.callTool("answer_business_question", { question: "DROP TABLE orders" });
    expect(bad.isError).toBe(true);
    const { result } = await demo.rpc("tools/list", {});
    const schemas = JSON.stringify(result.tools.map((t: { inputSchema: unknown }) => t.inputSchema));
    expect(schemas).not.toMatch(/"sql"|"query"/);
  });

  it("explains a database outage instead of throwing", async () => {
    const offline = clientAs(tenantCtx({ orgId: "demo" }), brokenForTenant);
    const result = await offline.callTool("answer_business_question", { question: "monthly_revenue" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("couldn't be reached");
  });

  it("serves the ER diagram resource and the tour prompt", async () => {
    const read = await demo.rpc("resources/read", { uri: "sales://schema/er-diagram" });
    expect(read.result.contents[0].text).toContain("erDiagram");
    const prompt = await demo.rpc("prompts/get", { name: "tour_sales_database", arguments: { question: "top_products" } });
    expect(prompt.result.messages[0].content.text).toContain("top_products");
  });
});

describe.skipIf(!hasDatabase)("sales tools on Neon (demo company)", () => {
  it("describe_schema shows the five tables, composite keys and row counts", async () => {
    const result = await demo.callTool("describe_schema", {});
    const tables = result.structuredContent.tables;
    expect(tables.map((t: { name: string }) => t.name)).toEqual([
      "customers",
      "categories",
      "products",
      "orders",
      "order_items",
    ]);
    const items = tables.find((t: { name: string }) => t.name === "order_items");
    expect(items.rowsInYourCompany).toBe(289);
    const pk = items.constraints.find((c: { kind: string }) => c.kind === "primary key");
    expect(pk.definition).toBe("PRIMARY KEY (org_id, order_id, line_no)");
    const fks = items.constraints.filter((c: { kind: string }) => c.kind === "foreign key");
    expect(fks).toHaveLength(2);
    for (const fk of fks) expect(fk.definition).toMatch(/^FOREIGN KEY \(org_id, /);
  });

  it("answers all ten business questions", async () => {
    for (const question of QUESTION_NAMES) {
      const result = await demo.callTool("answer_business_question", { question, year: 2025 });
      expect(result.isError, question).toBeFalsy();
      expect(result.structuredContent.rows.length, question).toBeGreaterThan(0);
    }
  });

  it("monthly revenue covers the twelve months of 2025", async () => {
    const result = await demo.callTool("answer_business_question", { question: "monthly_revenue", year: 2025 });
    expect(result.structuredContent.rows).toHaveLength(12);
  });

  it("finds the product nobody has bought yet", async () => {
    const result = await demo.callTool("answer_business_question", { question: "products_never_sold" });
    // Monitor Arm (step 5) and the Compact Desk Fridge added in step 8 haven't sold yet.
    expect(result.structuredContent.rows.map((r: { product: string }) => r.product)).toEqual([
      "Compact Desk Fridge",
      "Monitor Arm",
    ]);
  });

  it("compare_designs shows Ayesha's two cities in the flat sheet and one in customers", async () => {
    const result = await demo.callTool("compare_designs", { check: "customer_city" });
    const { flat, normalized } = result.structuredContent;
    expect(flat).toEqual([{ customer: "ayesha.khan@example.com", cities: "Karachi, Lahore", city_count: 2 }]);
    expect(normalized).toEqual([{ customer: "ayesha.khan@example.com", cities: "Karachi", city_count: 1 }]);
  });

  it("runs every comparison", async () => {
    for (const check of ["customer_city", "category_names", "revenue_by_category", "product_catalog"]) {
      const result = await demo.callTool("compare_designs", { check });
      expect(result.isError, check).toBeFalsy();
      expect(result.structuredContent.explanation.length, check).toBeGreaterThan(20);
    }
  });
});
