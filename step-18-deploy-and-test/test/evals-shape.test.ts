import { describe, expect, it } from "vitest";
import evals from "../evals/tool-choice.json";
import { clientAs, tenantCtx } from "./helpers";

// A FREE, automatic check on the eval set: every tool it expects still exists, and every
// widget it expects is still linked to that tool. Renaming a tool or unlinking a widget
// fails here, before anyone runs the manual pass in Claude and ChatGPT.
describe("eval set (evals/tool-choice.json) matches the server", () => {
  it("has 30 prompts, each naming a real tool and, where expected, its linked widget", async () => {
    expect(evals.prompts).toHaveLength(30);
    const { result } = await clientAs(tenantCtx({ orgId: "demo" })).rpc("tools/list", {});
    type Tool = { name: string; _meta?: { ui?: { resourceUri?: string } } };
    const tools = new Map<string, Tool>(result.tools.map((t: Tool) => [t.name, t]));
    for (const p of evals.prompts) {
      const tool = tools.get(p.tool);
      expect(tool, `prompt ${p.id}: ${p.tool}`).toBeDefined();
      if (p.widget) expect(tool?._meta?.ui?.resourceUri, `prompt ${p.id}`).toContain(p.widget);
      else expect(tool?._meta?.ui?.resourceUri, `prompt ${p.id}: ${p.tool} unexpectedly shows a widget`).toBeUndefined();
    }
  });
});
