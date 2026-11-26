import { describe, expect, it } from "vitest";
import { clientAs, tenantCtx } from "./helpers";

// Skills over MCP: no database needed. The skill is the same for every company.
const client = clientAs(tenantCtx({ orgId: "demo" }));
const SKILL = "skill://learn-mcp/monthly-sales-review/SKILL.md";

describe("Skills over MCP (io.modelcontextprotocol/skills)", () => {
  it("declares the extension in its capabilities", async () => {
    const init = await client.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.result.capabilities.extensions).toHaveProperty(["io.modelcontextprotocol/skills"]);
    expect(init.result.capabilities.resources).toBeDefined();
  });

  it("lists the monthly-sales-review skill with every file, its size and digest", async () => {
    const { result } = await client.rpc("skills/list", {});
    expect(result.skills.length).toBeGreaterThanOrEqual(1);
    const [skill] = result.skills.filter((s: { uri: string }) => s.uri === SKILL);
    expect(skill.uri).toBe(SKILL);
    expect(skill.frontmatter.name).toBe("monthly-sales-review");
    expect(skill.frontmatter.description).toMatch(/monthly sales review/i);
    const uris = skill.resources.map((r: { uri: string }) => r.uri).sort();
    expect(uris).toEqual([
      SKILL,
      "skill://learn-mcp/monthly-sales-review/references/review-template.md",
      "skill://learn-mcp/monthly-sales-review/references/widgets.md",
    ]);
    for (const r of skill.resources) expect(r.digest).toMatch(/^sha256:/);
  });

  it("gets the skill and reads its files as resources", async () => {
    const got = await client.rpc("skills/get", { uri: SKILL });
    expect(got.result.skill.frontmatter.name).toBe("monthly-sales-review");
    const md = await client.rpc("resources/read", { uri: SKILL });
    expect(md.result.contents[0].mimeType).toBe("text/markdown");
    expect(md.result.contents[0].text).toContain("# Monthly sales review");
    const ref = await client.rpc("resources/read", {
      uri: "skill://learn-mcp/monthly-sales-review/references/widgets.md",
    });
    expect(ref.result.contents[0].text).toContain("Which widget");
  });

  it("refuses an unknown skill", async () => {
    const missing = await client.rpc("skills/get", { uri: "skill://learn-mcp/nope/SKILL.md" });
    expect(missing.error?.code).toBe(-32602);
  });

  it("offers the same playbook as a prompt, for clients without the extension", async () => {
    const prompt = await client.rpc("prompts/get", { name: "monthly_sales_review", arguments: { month: "2025-11" } });
    const text = prompt.result.messages[0].content.text;
    expect(text).toContain("2025-11");
    expect(text).toContain("## 2. Pull the numbers");
    expect(text).toContain("Which widget for which question");
    expect(text).not.toContain("name: monthly-sales-review"); // frontmatter stripped
  });
});
