import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { createAuth } from "./auth";
import { safeDbErrorForLog } from "./db";
import { chooseEmbedder } from "./embeddings";
import { authScript, consentPage, selectCompanyPage, signInPage } from "./pages";
import { createServer } from "./server";
import { type TenantContext, resolveTenant } from "./tenant";
import { createTenantRouter } from "./tenant-router";
import { userStateFor } from "./user-state";
import { type ImportMessage, consumeImports } from "./imports";
import { type OrderCreatedMessage, consumeEvents } from "./events";

// Durable Object classes must be exported from the Worker's main module.
export { UserState } from "./user-state";
export { SalesReportWorkflow } from "./sales-report";

/**
 * The MCP handler is created ONCE. For every request it calls the factory, which builds
 * a fresh McpServer for that one request, user and company. The TENANT CONTEXT arrives
 * through `authInfo`, set below only AFTER the access token has been verified and the
 * membership re-checked.
 *
 * Each tool call runs its queries through the tenant router (tenant-router.ts): one
 * short transaction, in the company's own database (shared or dedicated). Nothing is
 * kept in the Worker's memory between requests.
 */
const mcpHandler = createMcpHandler(
  ({ authInfo }) => {
    const tenant = authInfo?.extra?.tenant as TenantContext | undefined;
    // Defence in depth: the factory refuses to build a server without a verified tenant.
    if (!tenant) throw new Error("Unauthenticated request reached the MCP server factory.");
    return createServer({
      forTenant: createTenantRouter(workerEnv),
      authDb: workerEnv.AUTH_DB,
      cache: workerEnv.TENANT_CACHE,
      tenant,
      embedder: chooseEmbedder(workerEnv),
      userState: userStateFor(workerEnv.USER_STATE, tenant),
      importQueue: workerEnv.ORDER_IMPORTS,
      reports: workerEnv.SALES_REPORT,
      eventQueue: workerEnv.SALES_EVENTS,
    });
  },
  { route: "/mcp" },
);

/** The only scope the sales tools need. Clients learn it from the 401 challenge. */
const SALES_SCOPE = "sales";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const auth = createAuth(env, url.origin);

    // Better Auth: its API, plus the discovery documents MCP clients fetch first:
    //   /.well-known/oauth-protected-resource[/mcp]           (RFC 9728, from mcp())
    //   /.well-known/oauth-authorization-server[/api/auth]    (RFC 8414)
    //   /.well-known/openid-configuration[/api/auth]          (OIDC)
    if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/.well-known/")) {
      return auth.handler(request);
    }

    if (url.pathname === "/mcp") {
      // CORS preflight carries no token; let the MCP handler answer it.
      if (request.method === "OPTIONS") return mcpHandler(request, env, ctx);

      // Verifies the bearer token's signature, issuer, expiry, audience (our /mcp URL)
      // and the "sales" scope. Without a valid token it returns 401 with a
      // WWW-Authenticate header pointing at our protected-resource metadata.
      const protectedMcp = requireMcpAuth(
        auth,
        async (req, claims) => {
          const userId = typeof claims.sub === "string" ? claims.sub : undefined;
          const orgId = typeof claims.org_id === "string" ? claims.org_id : undefined;
          const clientId = typeof claims.azp === "string" ? claims.azp : "unknown";
          if (!userId || !orgId) {
            return forbidden("This token isn't linked to a company. Disconnect and reconnect the connector.");
          }
          // ONE tenant context per request. Membership and role are re-checked on EVERY
          // request, so removal or demotion takes effect on the very next call, not when
          // the token expires. The tier says which database the company's data is in.
          let tenant: TenantContext | null;
          try {
            tenant = await resolveTenant(env, { orgId, userId, clientId });
          } catch (error) {
            console.error("tenant lookup failed", { org: orgId, ...safeDbErrorForLog(error) });
            return unavailable();
          }
          if (!tenant) return forbidden("You are no longer a member of this company.");

          const token = req.headers.get("authorization")?.replace(/^\S+\s+/, "") ?? "";
          return mcpHandler.fetch(req, {
            authInfo: { token, clientId, scopes: String(claims.scope ?? "").split(" "), extra: { tenant } },
          });
        },
        { resource: `${url.origin}/mcp`, requiredScopes: [SALES_SCOPE] },
      );
      return protectedMcp(request);
    }

    // The sign-in flow's pages (see pages.ts).
    if (request.method === "GET") {
      switch (url.pathname) {
        case "/sign-in":
          return signInPage();
        case "/select-company":
          return selectCompanyPage();
        case "/consent":
          return consentPage();
        case "/auth.js":
          return authScript();
        case "/":
          return new Response("learn-mcp-step-17 is running. Connect your MCP client to /mcp.\n", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
      }
    }

    return new Response("Not found", { status: 404 });
  },

  // Background work. One Worker consumes two queues; batch.queue says which one.
  //   sales-events-*   order.created messages -> event_log (see events.ts)
  //   order-imports-*  batches of CSV rows from bulk_import_orders (see imports.ts)
  async queue(batch, env): Promise<void> {
    if (batch.queue.startsWith("sales-events")) await consumeEvents(batch as MessageBatch<OrderCreatedMessage>, env);
    else await consumeImports(batch as MessageBatch<ImportMessage>, env);
  },
} satisfies ExportedHandler<Env, ImportMessage | OrderCreatedMessage>;

/** A JSON-RPC style 403 for a valid token whose user may not use this company. */
function forbidden(message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32003, message }, id: null }, { status: 403 });
}

/** The tenant lookup couldn't reach the database: a server problem, worth retrying. */
function unavailable(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32603, message: "The server's database is unavailable. Try again shortly." }, id: null },
    { status: 503 },
  );
}
