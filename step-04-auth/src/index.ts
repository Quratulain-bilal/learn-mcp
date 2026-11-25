import { requireMcpAuth } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { getMigrations } from "better-auth/db/migration";
import { z } from "zod";
import { createAuth, createAuthOptions } from "./auth-options";

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

interface Env {
  AUTH_DB: D1Database;
  NOTES: KVNamespace;
  BETTER_AUTH_SECRET: string;
  MIGRATION_TOKEN?: string;
}

interface Identity {
  userId: string;
  orgId: string;
  role: string;
  requestId: string;
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

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function notePrefix(identity: Identity) {
  return `org:${identity.orgId}:user:${identity.userId}:note:`;
}

function noteKey(identity: Identity, id: string) {
  return `${notePrefix(identity)}${id}`;
}

async function readNote(env: Env, identity: Identity, id: string): Promise<Note | null> {
  return (await env.NOTES.get<Note>(noteKey(identity, id), "json")) ?? null;
}

async function writeNote(env: Env, identity: Identity, note: Note): Promise<void> {
  await env.NOTES.put(noteKey(identity, note.id), JSON.stringify(note));
}

async function allNotes(env: Env, identity: Identity): Promise<Note[]> {
  const prefix = notePrefix(identity);
  const list = await env.NOTES.list({ prefix });
  const notes = (
    await Promise.all(
      list.keys.map((key) => readNote(env, identity, key.name.slice(prefix.length))),
    )
  ).filter((note): note is Note => note !== null);
  notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return notes;
}

function createServer(env: Env, identity: Identity, notify: Notify) {
  const server = new McpServer({
    name: "learn-mcp-step-04",
    version: "0.0.1",
  });

  server.registerTool(
    "list_notes",
    {
      description:
        "List the signed-in user's saved notes in their company. Use when the user asks what notes exist or wants to find a note by title. Returns ids, titles and creation times; does not return note bodies.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const notes = await allNotes(env, identity);
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
        "Read the full text of one of the signed-in user's saved notes by its exact id. Use after list_notes identifies the note the user wants. If the id is unknown or belongs to another user, the error tells you to call list_notes.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_-]+$/, "Use only letters, numbers, underscores and hyphens")
          .describe("Exact note id, for example note-123"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ id }) => {
      const note = await readNote(env, identity, id);
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
        "Create a new note for the signed-in user. Use when the user asks to save, remember or add a note. Returns the new note id.",
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
      await writeNote(env, identity, note);
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
        "Permanently delete one of the signed-in user's saved notes by its exact id. Use only when the user clearly asks to delete or remove a note. Confirm the id with list_notes first.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_-]+$/, "Use only letters, numbers, underscores and hyphens")
          .describe("Exact id of the note to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id }) => {
      const note = await readNote(env, identity, id);
      if (!note) {
        return errorResult(
          `No note found with id "${id}". Call list_notes to see valid ids.`,
          { id, deleted: false },
        );
      }
      await env.NOTES.delete(noteKey(identity, id));
      notify.resourcesChanged();
      return textResult(`Deleted note "${note.title}".`, {
        id,
        deleted: true,
      });
    },
  );

  server.registerTool(
    "list_company_members",
    {
      description:
        "List the people and roles in the signed-in user's company. Use only when an admin asks who belongs to their company. Members and users from other companies are not allowed.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      if (identity.role !== "admin") {
        return errorResult("Forbidden: the admin role is required to list company members.", {
          allowed: false,
          role: identity.role,
        });
      }
      const result = await env.AUTH_DB.prepare(
        "SELECT u.id, u.name, u.email, m.role FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY m.createdAt ASC",
      )
        .bind(identity.orgId)
        .all<{ id: string; name: string; email: string; role: string }>();
      const members = result.results;
      return textResult(`Found ${members.length} member(s) in your company.`, {
        members,
      });
    },
  );

  const noteTemplate = new ResourceTemplate("note://{id}", {
    list: async () => ({
      resources: (await allNotes(env, identity)).map((note) => ({
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
      description: "A note saved by the signed-in user. The id comes from list_notes.",
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
      const note = await readNote(env, identity, id);
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
        "Create a short summary of the signed-in user's saved notes, optionally filtered by a word in the title or body.",
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
            text: `Use list_notes to find the signed-in user's notes${tag ? ` filtered by "${tag}"` : ""}, then use get_note or read each note:// resource to read them. Write a concise summary with the note titles and the main points. If there are no matching notes, say so clearly.`,
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

function authContext(request: Request, env: Env) {
  const baseURL = new URL(request.url).origin;
  const resource = `${baseURL}/mcp`;
  return {
    baseURL,
    resource,
    auth: createAuth({
      baseURL,
      resource,
      secret: env.BETTER_AUTH_SECRET,
      database: env.AUTH_DB,
    }),
  };
}

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Learn MCP</title><style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem}form{border:1px solid #ddd;border-radius:.5rem;padding:1rem;margin:1rem 0}label{display:block;margin:.5rem 0}input{width:100%;padding:.5rem;box-sizing:border-box}button{padding:.5rem 1rem}</style></head><body>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function signInPage(oauthQuery: string) {
  const hidden = oauthQuery
    ? `<input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}">`
    : "";
  return html(`<h1>Sign in to Learn MCP</h1>
<p>Your connector needs access to your notes. Sign in or create an account, then approve the request.</p>
<form method="post" action="/api/auth/sign-in/email">
  <h2>Sign in</h2>${hidden}
  <label>Email <input type="email" name="email" required autocomplete="email"></label>
  <label>Password <input type="password" name="password" required autocomplete="current-password"></label>
  <button type="submit">Sign in</button>
</form>
<form method="post" action="/api/auth/sign-up/email">
  <h2>Create an account</h2>${hidden}
  <label>Name <input type="text" name="name" required autocomplete="name"></label>
  <label>Email <input type="email" name="email" required autocomplete="email"></label>
  <label>Password <input type="password" name="password" minlength="8" required autocomplete="new-password"></label>
  <button type="submit">Create account</button>
</form>`);
}

function consentPage(oauthQuery: string, scope: string) {
  const hidden = `<input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}">`;
  return html(`<h1>Allow connector access?</h1>
<p>The connector is asking to use your signed-in identity.</p>
<p>Requested scopes: <code>${escapeHtml(scope || "default scopes")}</code></p>
<form method="post" action="/api/auth/oauth2/consent">${hidden}
  <button type="submit" name="accept" value="true">Allow</button>
</form>
<form method="post" action="/api/auth/oauth2/consent">${hidden}
  <button type="submit" name="accept" value="false">Deny</button>
</form>`);
}

function isAuthPath(pathname: string) {
  return (
    pathname === "/jwks" ||
    pathname === "/userinfo" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/.well-known/") ||
    pathname.startsWith("/oauth2/") ||
    pathname.startsWith("/device/")
  );
}

async function migrate(request: Request, env: Env) {
  if (
    request.method !== "POST" ||
    !env.MIGRATION_TOKEN ||
    new URL(request.url).searchParams.get("token") !== env.MIGRATION_TOKEN
  ) {
    return json({ error: "Not found" }, 404);
  }
  const context = authContext(request, env);
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
    createAuthOptions({
      baseURL: context.baseURL,
      resource: context.resource,
      secret: env.BETTER_AUTH_SECRET,
      database: env.AUTH_DB,
    }),
  );
  await runMigrations();
  return json({
    created: toBeCreated.map((table) => table.table),
    added: toBeAdded.map((table) => table.table),
  });
}

async function protectedMcp(request: Request, env: Env) {
  const context = authContext(request, env);
  const handler = requireMcpAuth(
    context.auth,
    async (authorizedRequest, claims) => {
      const userId = stringClaim(claims, "sub");
      const orgId = stringClaim(claims, "org_id");
      if (!userId || !orgId) {
        return json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "Token is missing tenant identity" },
          },
          403,
        );
      }
      const membership = await env.AUTH_DB.prepare(
        "SELECT role FROM member WHERE organizationId = ? AND userId = ?",
      )
        .bind(orgId, userId)
        .first<{ role: string }>();
      if (!membership) {
        return json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "Your company membership is no longer active" },
          },
          403,
        );
      }
      const identity: Identity = {
        userId,
        orgId,
        role: membership.role,
        requestId: crypto.randomUUID(),
      };
      let mcpHandler: ReturnType<typeof createMcpHandler>;
      mcpHandler = createMcpHandler(
        () => createServer(env, identity, mcpHandler.notify),
        { route: "/mcp" },
      );
      return mcpHandler.fetch(authorizedRequest);
    },
    { issuer: context.baseURL, resource: context.resource },
  );
  return handler(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true });
    if (url.pathname === "/__migrate") return migrate(request, env);

    const context = authContext(request, env);

    if (url.pathname === "/sign-in") {
      return signInPage(url.searchParams.get("oauth_query") ?? "");
    }

    if (url.pathname === "/consent" && request.method === "GET") {
      const oauthQuery = url.searchParams.toString();
      const valid = await verifyOAuthQueryParams(oauthQuery, env.BETTER_AUTH_SECRET);
      if (!valid) return html("<h1>Invalid consent request</h1>", 400);
      return consentPage(oauthQuery, url.searchParams.get("scope") ?? "");
    }

    if (url.pathname === "/mcp") return protectedMcp(request, env);
    if (isAuthPath(url.pathname)) return context.auth.handler(request);
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
