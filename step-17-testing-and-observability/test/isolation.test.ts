import { describe, expect, it } from "vitest";
import { QUESTION_NAMES } from "../src/questions";
import { clientAs, hasDatabase, tenantCtx } from "./helpers";

// The demo company has the sample data; "empty-co-test" has none. Same user, different company.
const demo = clientAs(tenantCtx({ userId: "ali", orgId: "demo" }));
const other = clientAs(tenantCtx({ userId: "ali", orgId: "empty-co-test" }));

describe.skipIf(!hasDatabase)("company isolation (needs Neon)", () => {
  it("every business question returns nothing for a company with no data", async () => {
    for (const question of QUESTION_NAMES) {
      const theirs = await other.callTool("answer_business_question", { question });
      const rows = theirs.structuredContent.rows;
      // average_order_value always returns one summary row; for an empty company it's all zeros.
      if (question === "average_order_value") expect(rows[0].orders).toBe(0);
      else expect(rows, question).toEqual([]);
    }
  });

  it("the same question gives the demo company its own data", async () => {
    const mine = await demo.callTool("answer_business_question", { question: "top_products", limit: 3 });
    expect(mine.structuredContent.rows).toHaveLength(3);
  });

  it("describe_schema counts only the caller's company rows", async () => {
    const theirs = await other.callTool("describe_schema", {});
    const counts = theirs.structuredContent.tables.map((t: { rowsInYourCompany: number }) => t.rowsInYourCompany);
    expect(counts).toEqual([0, 0, 0, 0, 0]);
    expect(theirs.content[0].text).toContain("--org empty-co-test");
  });
});
