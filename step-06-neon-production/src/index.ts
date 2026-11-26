import { requireMcpAuth } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { getMigrations } from "better-auth/db/migration";
import { z } from "zod";
import { createAuth, createAuthOptions, OAUTH_SCOPES } from "./auth-options";
import { createPgClient } from "./db-client";
import { createMemorySalesStore } from "./memory-sales";
import { BUSINESS_QUESTIONS, createNeonSalesStore, type SalesStore } from "./sales";
import { connectionString, type HyperdriveLike } from "./tenant";

interface Env {
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET: string;
  HYPERDRIVE?: HyperdriveLike;
  MIGRATION_TOKEN?: string;
  NEON_DATABASE_URL?: string;
  SALES_STORE?: string;
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

function dataResult(text: string, structured: unknown) {
  return {
    content: [{ type: "text" as const, text: `${text}\n${JSON.stringify(structured)}` }],
    structuredContent: structured,
  };
}

function errorResult(text: string, structured?: unknown) {
  return { ...textResult(text, structured), isError: true };
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const idSchema = z.string().regex(ID_PATTERN, "Use 2-64 letters, numbers, underscores or hyphens.");
const dateSchema = z.string().regex(DATE_PATTERN, "Use YYYY-MM-DD.").refine(
  (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
  "Use a real calendar date.",
);

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
<p>Your connector needs access to your company's sales data. Sign in or create an account, then approve the request.</p>
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
  const hidden = `<input type="hidden" id="oauth_query" value="${escapeHtml(oauthQuery)}"><input type="hidden" id="scope" value="${escapeHtml(scope)}">`;
  return html(`<h1>Allow connector access?</h1>
<p>The connector is asking to use your signed-in identity to read your company's sales data.</p>
<p>Requested scopes: <code>${escapeHtml(scope || "default scopes")}</code></p>
${hidden}
<p><button type="button" onclick="submitConsent(true)">Allow</button>
<button type="button" onclick="submitConsent(false)">Deny</button></p>
<p id="status"></p>
<script>
async function submitConsent(accept) {
  const status = document.getElementById("status");
  status.textContent = "Sending...";
  const response = await fetch("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      accept: accept,
      oauth_query: document.getElementById("oauth_query").value,
      scope: document.getElementById("scope").value || undefined
    })
  });
  const data = await response.json();
  if (response.ok && (data.url || data.redirect)) {
    window.location.href = data.url || data.redirect;
    return;
  }
  status.textContent = JSON.stringify(data);
}
</script>`);
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

export function createSalesStore(env: Env): SalesStore {
  if (env.SALES_STORE === "memory") return createMemorySalesStore();
  return createNeonSalesStore(createPgClient(connectionString(env)));
}

export function createServer(env: Env, identity: Identity, notify: Notify, store: SalesStore) {
  const server = new McpServer({
    name: "learn-mcp-step-06",
    version: "0.0.1",
  });

  server.registerTool(
    "describe_schema",
    {
      description:
        "Describe the sales tables, columns and keys. Use this before answering questions so the model can explain the normalized design.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const schema = await store.describeSchema();
        const names = schema.tables.map((table) => `${table.schema}.${table.name}`).join(", ");
        return dataResult(`Found ${schema.tables.length} tables: ${names}`, schema);
      } catch (error) {
        return errorResult(`Could not describe the schema: ${String(error)}`, {
          error: String(error),
        });
      }
    },
  );

  server.registerTool(
    "answer_business_question",
    {
      description:
        "Answer one of ten fixed business questions about the signed-in company's sales data using reviewed, parameterized SQL. Never accepts SQL from the model.",
      inputSchema: {
        question: z
          .enum(BUSINESS_QUESTIONS)
          .describe("The named business question to answer from the normalized sales tables."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ question }) => {
      try {
        const answer = await store.answer(identity.orgId, question);
        const rowCount = answer.rows.length;
        return dataResult(
          `Answered ${question} with ${rowCount} row(s) from your company's normalized sales data.`,
          answer,
        );
      } catch (error) {
        return errorResult(`Could not answer ${question}: ${String(error)}`, {
          error: String(error),
        });
      }
    },
  );

  server.registerTool(
    "compare_designs",
    {
      description:
        "Compare one named business question against the flat staging spreadsheet and the normalized tables, then explain the anomalies the flat design causes.",
      inputSchema: {
        question: z
          .enum(BUSINESS_QUESTIONS)
          .describe("The named question to run against both the flat and normalized designs."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ question }) => {
      try {
        const comparison = await store.compare(identity.orgId, question);
        return dataResult(
          `Compared ${question}: flat design returned ${comparison.flat.length} row(s), normalized design returned ${comparison.normalized.length} row(s). ${comparison.anomalies.join(" ")}`,
          comparison,
        );
      } catch (error) {
        return errorResult(`Could not compare designs for ${question}: ${String(error)}`, {
          error: String(error),
        });
      }
    },
  );

  server.registerTool(
    "list_orders",
    {
      description:
        "List orders for the signed-in company with filters and cursor pagination. Use this for browsing orders; keep responses small by paging.",
      inputSchema: {
        from: dateSchema.optional().describe("Earliest order date, inclusive, as YYYY-MM-DD."),
        to: dateSchema.optional().describe("Latest order date, inclusive, as YYYY-MM-DD."),
        customerId: idSchema.optional().describe("Only orders for this customer id."),
        productId: idSchema.optional().describe("Only orders containing this product id."),
        cursor: z.string().max(64).optional().describe("Opaque pagination cursor from a previous page."),
        limit: z.number().int().min(1).max(50).default(20).describe("Page size, from 1 to 50."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ from, to, customerId, productId, cursor, limit }) => {
      if (from && to && from > to) {
        return errorResult("The from date must be on or before the to date.", {
          error: "Invalid date range",
        });
      }
      try {
        const result = await store.listOrders(identity.orgId, {
          from,
          to,
          customerId,
          productId,
          cursor,
          limit,
        });
        return dataResult(
          `Returned ${result.orders.length} order(s)${result.nextCursor ? `; next cursor ${result.nextCursor}` : "."}`,
          result,
        );
      } catch (error) {
        return errorResult(`Could not list orders: ${String(error)}`, { error: String(error) });
      }
    },
  );

  server.registerTool(
    "get_sales_summary",
    {
      description:
        "Return compact sales totals for the signed-in company grouped by month, product or customer.",
      inputSchema: {
        groupBy: z
          .enum(["month", "product", "customer"])
          .describe("How to group the totals. Use month for trends, product or customer for rankings."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ groupBy }) => {
      try {
        const result = await store.getSalesSummary(identity.orgId, groupBy);
        return dataResult(`Summarized ${result.rows.length} group(s) by ${groupBy}.`, result);
      } catch (error) {
        return errorResult(`Could not summarize sales: ${String(error)}`, { error: String(error) });
      }
    },
  );

  server.registerTool(
    "create_order",
    {
      description:
        "Create one order and its order lines for the signed-in company in a single transaction. This writes to the business database; confirm the details with the user before calling it.",
      inputSchema: {
        orderId: idSchema.describe("A unique order id for this company."),
        customerId: idSchema.describe("The customer id that must already exist in this company."),
        orderDate: dateSchema.describe("The order date as YYYY-MM-DD."),
        items: z
          .array(
            z.object({
              productId: idSchema.describe("A product id that must already exist in this company."),
              quantity: z.number().int().min(1).max(1000).describe("Quantity, from 1 to 1000."),
            }),
          )
          .min(1)
          .max(20)
          .refine(
            (items) => new Set(items.map((item) => item.productId)).size === items.length,
            "Each product may appear only once in one order.",
          )
          .describe("The order lines. Product ids must be unique."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ orderId, customerId, orderDate, items }) => {
      try {
        const result = await store.createOrder(identity.orgId, {
          orderId,
          customerId,
          orderDate,
          items,
        });
        return textResult(
          `Created order ${result.orderId} with ${result.itemCount} line(s), total ${result.total}.`,
          result,
        );
      } catch (error) {
        return errorResult(`Could not create the order: ${String(error)}`, { error: String(error) });
      }
    },
  );

  server.registerPrompt(
    "explain_sales_schema",
    {
      title: "Explain the sales schema",
      description:
        "Ask the model to describe the sales tables and explain why the normalized design avoids the flat spreadsheet's anomalies.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Use describe_schema to inspect the sales tables, then explain the primary keys, foreign keys, 1NF, 2NF and 3NF. Mention why unit_price is kept on order_items on purpose.",
          },
        },
      ],
    }),
  );

  notify.resourcesChanged();
  return server;
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
  const store = createSalesStore(env);
  const handler = requireMcpAuth(
    context.auth,
    async (authorizedRequest, claims) => {
      const userId = typeof claims.sub === "string" ? claims.sub : "";
      const orgId = typeof claims.org_id === "string" ? claims.org_id : "";
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
        () => createServer(env, identity, mcpHandler.notify, store),
        { route: "/mcp" },
      );
      return mcpHandler.fetch(authorizedRequest);
    },
    {
      issuer: `${context.baseURL}/api/auth`,
      resource: context.resource,
      challengeScopes: [...OAUTH_SCOPES],
    },
  );
  return handler(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({ ok: true, database: env.HYPERDRIVE ? "hyperdrive" : "direct" });
    }
    if (url.pathname === "/__migrate") return migrate(request, env);

    const context = authContext(request, env);
    if (isAuthPath(url.pathname)) return context.auth.handler(request);

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
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
