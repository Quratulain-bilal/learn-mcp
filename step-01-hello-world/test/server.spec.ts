import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function rpc(method: string, params: Record<string, unknown>) {
  const response = await exports.default.fetch("http://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line: string) => line.startsWith("data: "));
  return JSON.parse(
    dataLine ? dataLine.slice("data: ".length) : text,
  ) as {
    result?: {
      tools?: { name: string }[];
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    error?: { message: string };
  };
}

async function callTool(name: string, args: Record<string, unknown>) {
  const payload = await rpc("tools/call", { name, arguments: args });
  if (!payload.result) {
    throw new Error(`tool call failed: ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

describe("learn-mcp-step-01", () => {
  it("lists greet and get_time", async () => {
    const payload = await rpc("tools/list", {});
    const names = payload.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("greet");
    expect(names).toContain("get_time");
  });

  it("greet returns the requested name", async () => {
    const result = await callTool("greet", { name: "Ada" });
    expect(result.content?.[0]?.text).toContain("Ada");
  });

  it("keeps no cross-request state under concurrency", async () => {
    // Distinct names that are not substrings of each other.
    const names = Array.from({ length: 20 }, (_, i) => `name_${i}_end`);
    const results = await Promise.all(
      names.map((name) => callTool("greet", { name })),
    );
    results.forEach((result, i) => {
      const text = result.content?.[0]?.text ?? "";
      expect(text).toContain(names[i]);
      const others = names.filter((n) => n !== names[i]);
      for (const other of others) {
        expect(text).not.toContain(other);
      }
    });
  });

  it("get_time accepts a timezone and rejects a bad one recoverably", async () => {
    const ok = await callTool("get_time", { timezone: "Asia/Karachi" });
    expect(ok.content?.[0]?.text).toContain("Asia/Karachi");

    const bad = await callTool("get_time", { timezone: "Not/AZone" });
    expect(bad.isError).toBe(true);
    expect(bad.content?.[0]?.text).toContain("Invalid timezone");
  });
});
