import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plantCompany, removeCompany, uniqueOrg } from "../../test/fixtures";
import { DEDICATED, asOwner, clientAs, hasDedicated, tenantCtx, testForTenant } from "../../test/helpers";
import { describeProduct, plantPolicies } from "../../test/policies";

/**
 * Search by meaning, under the same tenancy rules as everything else: company H (shared
 * tier) has the Harbor policies, company S (dedicated tier) has the Summit policies. The
 * same question must get each company's OWN rule, and never the other's passage.
 * Uses the test embedder (word overlap), so the questions share words with the rules.
 */

const H = uniqueOrg("policy-harbor");
const S = uniqueOrg("policy-summit");
const harbor = tenantCtx({ orgId: H, userId: "hana" });
const summit = tenantCtx({ orgId: S, userId: "sami", ...DEDICATED });

describe.skipIf(!hasDedicated)("search_sales_policy and find_products (needs Neon)", () => {
  beforeAll(async () => {
    await plantCompany(H, "H");
    await plantCompany(S, "S", DEDICATED.database);
    await asOwner(`INSERT INTO tenants (org_id, tier, db_binding) VALUES ($1, 'dedicated', $2)`, [S, DEDICATED.database]);
    await plantPolicies(H, "harbor");
    await plantPolicies(S, "summit", DEDICATED.database);
    await describeProduct(H, "Small refrigerator that keeps drinks, food or medicine cold.");
  });
  afterAll(async () => {
    for (const [org, binding] of [
      [H, "HYPERDRIVE"],
      [S, DEDICATED.database],
    ] as const) {
      await asOwner(`DELETE FROM policy_documents WHERE org_id = $1`, [org], binding); // passages cascade
      await removeCompany(org, binding);
    }
  });

  const question = "How much discount may sales staff give on a single order without approval?";

  it("the same question gets each company's own rule, with a citation", async () => {
    const h = await clientAs(harbor).callTool("search_sales_policy", { question });
    const s = await clientAs(summit).callTool("search_sales_policy", { question });
    expect(h.structuredContent.abstained).toBe(false);
    expect(s.structuredContent.abstained).toBe(false);
    expect(h.structuredContent.passages[0]).toMatchObject({ document: "discounts", line: 3, citation: "discounts, line 3" });
    expect(h.structuredContent.passages[0].text).toContain("15%");
    expect(s.structuredContent.passages[0]).toMatchObject({ document: "discounts", line: 3 });
    expect(s.structuredContent.passages[0].text).toContain("10%");
  });

  it("never returns the other company's passage, whatever the question", async () => {
    const questions = [
      question,
      "Can opened items be returned?",
      "How many days do business customers have to pay invoices?",
      "Public sector customers discount",
      "Assembled furniture returns",
    ];
    for (const q of questions) {
      for (const [ctx, ownCompany] of [
        [harbor, "Harbor"],
        [summit, "Summit"],
      ] as const) {
        const result = await clientAs(ctx).callTool("search_sales_policy", { question: q });
        for (const p of result.structuredContent.passages) expect(p.title, q).toContain(ownCompany);
      }
    }
  });

  it("abstains when the policies don't cover the question", async () => {
    const result = await clientAs(harbor).callTool("search_sales_policy", { question: "What is the office dress code on Fridays?" });
    expect(result.structuredContent).toMatchObject({ abstained: true, passages: [] });
    expect(result.content[0].text).toContain("ABSTAINED");
  });

  it("row-level security covers passages: a query with no WHERE sees only the company's own", async () => {
    for (const ctx of [harbor, summit]) {
      const rows = await testForTenant(ctx, (db) => db.query<{ org_id: string }>(`SELECT DISTINCT org_id FROM policy_passages`));
      expect(rows).toEqual([{ org_id: ctx.orgId }]);
    }
  });

  it("find_products finds by meaning within the company, and abstains on things it doesn't sell", async () => {
    const found = await clientAs(harbor).callTool("find_products", { need: "something to keep medicine cold" });
    expect(found.structuredContent.products.map((p: { name: string }) => p.name)).toEqual(["Matrix Product"]);
    const none = await clientAs(summit).callTool("find_products", { need: "something to keep medicine cold" });
    expect(none.structuredContent.abstained).toBe(true); // Summit's product has no description
    const forklift = await clientAs(harbor).callTool("find_products", { need: "industrial forklift truck" });
    expect(forklift.structuredContent.abstained).toBe(true);
  });

  describe("add_policy_document", () => {
    const doc = "# Shipping rules (Harbor Office Supply)\n\n1. Orders over 200 USD ship free.\n2. Same-day dispatch for orders placed before noon.";

    it("adds a document an admin wrote, and search finds it with the right line", async () => {
      const added = await clientAs(harbor).callTool("add_policy_document", { document_id: "shipping", content: doc });
      expect(added.structuredContent).toMatchObject({ document: "shipping", version: 1, passages: 2 });
      const hit = await clientAs(harbor).callTool("search_sales_policy", { question: "Do orders ship free over 200 USD?" });
      expect(hit.structuredContent.passages[0]).toMatchObject({ document: "shipping", line: 3 });
    });

    it("replacing a document removes the old version's passages", async () => {
      const replaced = await clientAs(harbor).callTool("add_policy_document", {
        document_id: "shipping",
        content: "# Shipping rules (Harbor Office Supply)\n\n1. All orders ship free.",
      });
      expect(replaced.structuredContent).toMatchObject({ version: 2, passages: 1 });
      const rows = await testForTenant(harbor, (db) =>
        db.query(`SELECT line, content FROM policy_passages WHERE org_id = $1 AND document_id = 'shipping'`, [H]),
      );
      expect(rows).toEqual([{ line: 3, content: "All orders ship free." }]);
    });

    it("refuses members, documents with no rules, and documents that are too large", async () => {
      const member = await clientAs({ ...harbor, role: "member" }).callTool("add_policy_document", { document_id: "x", content: doc });
      expect(member.content[0].text).toContain("Forbidden (403)");
      const noRules = await clientAs(harbor).callTool("add_policy_document", { document_id: "x", content: "# Title\n\nJust prose." });
      expect(noRules.content[0].text).toContain("No numbered rules");
      const huge = await clientAs(harbor).callTool("add_policy_document", {
        document_id: "x",
        content: `# Big\n\n${"1. word ".repeat(5000)}`,
      });
      expect(huge.isError).toBe(true);
    });

    it("writes into the company's own database: the dedicated company's document isn't in the shared one", async () => {
      await clientAs(summit).callTool("add_policy_document", { document_id: "shipping", content: "# Shipping (Summit Workspace)\n\n1. Ships in 3 days." });
      expect(await asOwner(`SELECT 1 FROM policy_documents WHERE org_id = $1`, [S])).toEqual([]);
      const inOwn = await asOwner(`SELECT document_id FROM policy_documents WHERE org_id = $1 AND document_id = 'shipping'`, [S], DEDICATED.database);
      expect(inOwn).toEqual([{ document_id: "shipping" }]);
    });
  });
});
