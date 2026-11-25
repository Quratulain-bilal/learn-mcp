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
    // MCP RPC results vary by method; tests narrow each field before use.
    result?: Record<string, any>;
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

describe("learn-mcp-step-03 resources and prompts", () => {
  it(
    "lists the four note tools",
    async () => {
      const payload = await rpc("tools/list", {});
      const names = (payload.result?.tools as { name: string }[])?.map(
        (t) => t.name,
      );
      expect(names).toEqual(
        expect.arrayContaining([
          "list_notes",
          "get_note",
          "create_note",
          "delete_note",
        ]),
      );
    },
    30_000,
  );

  it(
    "lists and reads a note as a resource",
    async () => {
      const created = await callTool("create_note", {
        title: "Resource note",
        body: "This text comes from resources/read",
      });
      const id = (created.structuredContent as { note: { id: string } }).note.id;

      const listed = await rpc("resources/list", {});
      const resources = listed.result?.resources as { uri: string }[];
      expect(resources.some((r) => r.uri === `note://${id}`)).toBe(true);

      const templates = await rpc("resources/templates/list", {});
      expect(
        (templates.result?.resourceTemplates as { uriTemplate: string }[]).some(
          (t) => t.uriTemplate === "note://{id}",
        ),
      ).toBe(true);

      const read = await rpc("resources/read", { uri: `note://${id}` });
      const contents = read.result?.contents as { text: string }[];
      expect(contents[0].text).toContain("This text comes from resources/read");

      await callTool("delete_note", { id });
    },
    30_000,
  );

  it(
    "lists and gets both prompts",
    async () => {
      const listed = await rpc("prompts/list", {});
      const names = (listed.result?.prompts as { name: string }[])?.map(
        (p) => p.name,
      );
      expect(names).toEqual(
        expect.arrayContaining(["summarize_notes", "draft_note_from_meeting"]),
      );

      const summary = await rpc("prompts/get", {
        name: "summarize_notes",
        arguments: { tag: "client" },
      });
      const messages = summary.result?.messages as {
        role: string;
        content: { text: string };
      }[];
      expect(messages[0].role).toBe("user");
      expect(messages[0].content.text).toContain("client");
      expect(messages[0].content.text).toContain("list_notes");

      const draft = await rpc("prompts/get", {
        name: "draft_note_from_meeting",
        arguments: { meeting_text: "We agreed to ship Friday" },
      });
      const draftMessages = draft.result?.messages as {
        content: { text: string };
      }[];
      expect(draftMessages[0].content.text).toContain(
        "We agreed to ship Friday",
      );
    },
    30_000,
  );
});
