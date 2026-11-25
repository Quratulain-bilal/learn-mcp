import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
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

type Notify = {
  resourcesChanged(): void;
  promptsChanged(): void;
};

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

async function allNotes(env: Env): Promise<Note[]> {
  const list = await env.NOTES.list({ prefix: "note:" });
  const notes = (
    await Promise.all(
      list.keys.map((key) => readNote(env, key.name.slice("note:".length))),
    )
  ).filter((note): note is Note => note !== null);
  notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return notes;
}

function createServer(env: Env, notify: Notify) {
  const server = new McpServer({
    name: "learn-mcp-step-03",
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
      const notes = await allNotes(env);
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
        title: z.string().min(1).max(200).describe("Short title for the note"),
        body: z.string().min(1).max(20_000).describe("Full text of the note"),
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
      notify.resourcesChanged();
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
      notify.resourcesChanged();
      return textResult(`Deleted note "${note.title}".`, {
        id,
        deleted: true,
      });
    },
  );

  const noteTemplate = new ResourceTemplate("note://{id}", {
    list: async () => ({
      resources: (await allNotes(env)).map((note) => ({
        uri: `note://${note.id}`,
        name: note.title,
        description: `Saved note created ${note.createdAt}`,
        mimeType: "text/plain",
      })),
    }),
  });

  server.registerResource(
    "note",
    noteTemplate,
    {
      title: "Saved note",
      description: "A note saved in the notes toolset. The id comes from list_notes.",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const id = Array.isArray(variables.id)
        ? variables.id[0]
        : (variables.id as string | undefined);
      if (!id) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: "Missing note id in URI.",
            },
          ],
        };
      }
      const note = await readNote(env, id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: note
              ? `${note.title}\n\n${note.body}`
              : `No note found with id "${id}".`,
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "summarize_notes",
    {
      title: "Summarize notes",
      description:
        "Create a short summary of the user's saved notes, optionally filtered by a word in the title or body.",
      argsSchema: {
        tag: z
          .string()
          .max(100)
          .optional()
          .describe("Only include notes whose title or body contains this word"),
      },
    },
    ({ tag }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Use list_notes to find the user's saved notes${tag ? ` filtered by "${tag}"` : ""}, then use get_note or read each note:// resource to read them. Write a concise summary with the note titles and the main points. If there are no matching notes, say so clearly.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "draft_note_from_meeting",
    {
      title: "Draft note from meeting",
      description:
        "Turn raw meeting notes into a clean note ready to save with create_note.",
      argsSchema: {
        meeting_text: z
          .string()
          .min(1)
          .max(20_000)
          .describe("Raw meeting text to turn into a note"),
      },
    },
    ({ meeting_text }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Turn this meeting text into a note with a short title and a clear body of decisions and action items. Then ask the user whether to save it with create_note.\n\n${meeting_text}`,
          },
        },
      ],
    }),
  );

  return server;
}

// A fresh handler per request captures this request's env. Its notify controls
// reach only clients listening on this same handler instance, which is fine for
// this step; clients that are not subscribed simply re-list later.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let handler: ReturnType<typeof createMcpHandler>;
    handler = createMcpHandler(() => createServer(env, handler.notify), {
      route: "/mcp",
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
