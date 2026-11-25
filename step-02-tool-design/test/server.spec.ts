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
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text) as {
    result?: {
      tools?: { name: string; annotations?: Record<string, boolean> }[];
      content?: { type: string; text?: string }[];
      structuredContent?: Record<string, unknown>;
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

describe("learn-mcp-step-02 notes toolset", () => {
  it(
    "lists four notes with correct annotations",
    async () => {
      const payload = await rpc("tools/list", {});
      const tools = payload.result?.tools ?? [];
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "list_notes",
          "get_note",
          "create_note",
          "delete_note",
        ]),
      );
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.list_notes.annotations?.readOnlyHint).toBe(true);
      expect(byName.get_note.annotations?.readOnlyHint).toBe(true);
      expect(byName.delete_note.annotations?.destructiveHint).toBe(true);
    },
    30_000,
  );

  it(
    "creates, lists, reads and deletes a note",
    async () => {
      const created = await callTool("create_note", {
        title: "Test note",
        body: "Remember the MCP Inspector URL",
      });
      const note = created.structuredContent?.note as {
        id: string;
        title: string;
      };
      expect(note.title).toBe("Test note");
      expect(note.id).toMatch(/^note-/);

      const listed = await callTool("list_notes", {});
      expect(listed.structuredContent?.notes).toBeDefined();
      expect(listed.content?.[0]?.text).toContain("Test note");
      expect(listed.content?.[0]?.text).toContain(note.id);

      const got = await callTool("get_note", { id: note.id });
      expect(got.content?.[0]?.text).toContain("Remember the MCP Inspector URL");

      const deleted = await callTool("delete_note", { id: note.id });
      expect(deleted.structuredContent?.deleted).toBe(true);

      const missing = await callTool("get_note", { id: note.id });
      expect(missing.isError).toBe(true);
      expect(missing.content?.[0]?.text).toContain("list_notes");
    },
    30_000,
  );

  it(
    "rejects invalid input with a clear error",
    async () => {
      const payload = await rpc("tools/call", {
        name: "create_note",
        arguments: { title: "", body: "x" },
      });
      expect(payload.result?.isError ?? payload.error).toBeTruthy();
    },
    30_000,
  );

  it(
    "keeps no cross-request state under concurrency",
    async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          callTool("create_note", {
            title: `note_${i}_end`,
            body: `body_${i}_end`,
          }),
        ),
      );
      const ids = results.map(
        (r) => (r.structuredContent?.note as { id: string }).id,
      );
      expect(new Set(ids).size).toBe(20);
      for (let i = 0; i < 20; i++) {
        const got = await callTool("get_note", { id: ids[i] });
        expect(got.content?.[0]?.text).toContain(`note_${i}_end`);
      }
    },
    30_000,
  );
});
