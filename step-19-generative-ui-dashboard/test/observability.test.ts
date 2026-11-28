import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brokenForTenant, clientAs, hasDatabase, tenantCtx } from "./helpers";

// Structured logs: each tool call yields an audit line and a span per database
// transaction, all sharing the request id, with no arguments or data in them.
describe("structured logs and spans", () => {
  const lines: string[] = [];
  beforeAll(() => {
    for (const level of ["log", "error", "warn"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });
  afterAll(() => vi.restoreAllMocks());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed log lines
  const entries = (): any[] => lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

  it("a failing database call logs an error span with only the error code, tied to the audit line", async () => {
    const ctx = tenantCtx({ orgId: "obs-broken", requestId: "req-broken" });
    await clientAs(ctx, brokenForTenant).callTool("list_orders", { customer: "secret.person@example.com" });
    const mine = entries().filter((e) => e.requestId === "req-broken");
    expect(mine.find((e) => e.type === "span" && e.span === "db.transaction")).toMatchObject({
      org: "obs-broken",
      outcome: "error",
    });
    expect(mine.find((e) => e.type === "audit")).toMatchObject({ tool: "list_orders", outcome: "tool_error" });
    expect(lines.join("\n")).not.toContain("secret.person@example.com");
  });

  it.skipIf(!hasDatabase)("a successful tool call logs an ok span with its duration", async () => {
    await clientAs(tenantCtx({ orgId: "demo", requestId: "req-ok" })).callTool("list_orders", { limit: 1 });
    const span = entries().find((e) => e.requestId === "req-ok" && e.type === "span");
    expect(span).toMatchObject({ span: "db.transaction", outcome: "ok", org: "demo" });
    expect(typeof span.ms).toBe("number");
  });
});
