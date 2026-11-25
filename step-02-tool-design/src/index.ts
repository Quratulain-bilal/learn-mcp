import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

interface Env {
  NOTES: KVNamespace;
}

function textResult(text: string, structured?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
  };
}

function errorResult(text: string, structured?: unknown) {
  return { ...textResult(text, structured), isError: true };
}

async function readNote(env: Env, id: string): Promise<Note | null> {
  return (await env.NOTES.get<Note>(`note:${id}`, "json")) ?? null;
}

async function writeNote(env: Env, note: Note): Promise<void> {
  await env.NOTES.put(`note:${note.id}`, JSON.stringify(note));
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "learn-mcp-step-02",
    version: "0.0.1",
  });

  server.registerTool(
    "list_notes",
    {
      description:
        "List saved notes. Use when the user asks what notes exist or wants to find a note by title. Returns ids, titles and creation times; does not return note bodies.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const list = await env.NOTES.list({ prefix: "note:" });
      const notes = (
        await Promise.all(
          list.keys.map((key) => readNote(env, key.name.slice("note:".length))),
        )
      ).filter((note): note is Note => note !== null);
      notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const summary =
        notes.length === 0
          ? "No notes saved yet. Use create_note to add one."
          : `Found ${notes.length} note(s):\n${notes
              .map(
                ({ id, title, createdAt }) =>
                  `- id: ${id} | title: ${title} | created: ${createdAt}`,
              )
              .join("\n")}\nCall get_note with an id to read the full text.`;
      return textResult(summary, {
        notes: notes.map(({ id, title, createdAt }) => ({
          id,
          title,
          createdAt,
        })),
      });
    },
  );

  server.registerTool(
    "get_note",
    {
      description:
        "Read the full text of one saved note by its exact id. Use after list_notes identifies the note the user wants. If the id is unknown, the error tells you to call list_notes.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(200)
          .describe("Exact note id, for example note-123"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ id }) => {
      const note = await readNote(env, id);
      if (!note) {
        return errorResult(
          `No note found with id "${id}". Call list_notes to see valid ids.`,
          { id, found: false },
        );
      }
      return textResult(`Note "${note.title}": ${note.body}`, {
        note,
        found: true,
      });
    },
  );

  server.registerTool(
    "create_note",
    {
      description:
        "Create a new note with a title and body. Use when the user asks to save, remember or add a note. Returns the new note id.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(200)
          .describe("Short title for the note"),
        body: z
          .string()
          .min(1)
          .max(20_000)
          .describe("Full text of the note"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title, body }) => {
      const note: Note = {
        id: `note-${crypto.randomUUID()}`,
        title,
        body,
        createdAt: new Date().toISOString(),
      };
      await writeNote(env, note);
      return textResult(`Created note "${title}" with id ${note.id}.`, {
        note,
        created: true,
      });
    },
  );

  server.registerTool(
    "delete_note",
    {
      description:
        "Permanently delete one saved note by its exact id. Use only when the user clearly asks to delete or remove a note. Confirm the id with list_notes first.",
      inputSchema: {
        id: z.string().min(1).max(200).describe("Exact id of the note to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id }) => {
      const note = await readNote(env, id);
      if (!note) {
        return errorResult(
          `No note found with id "${id}". Call list_notes to see valid ids.`,
          { id, deleted: false },
        );
      }
      await env.NOTES.delete(`note:${id}`);
      return textResult(`Deleted note "${note.title}".`, {
        id,
        deleted: true,
      });
    },
  );

  return server;
}

// A fresh handler per request captures this request's env (KV binding).
// This is valid for ordinary tools; module-level handler is only needed for
// notification subscriptions, which this step does not use.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handler = createMcpHandler(() => createServer(env), {
      route: "/mcp",
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
