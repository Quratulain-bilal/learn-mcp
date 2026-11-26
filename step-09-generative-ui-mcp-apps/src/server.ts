import { McpServer } from "@modelcontextprotocol/server";
import { registerCompanyTools } from "./company-tools";
import type { ForTenant } from "./db";
import type { Embedder } from "./embeddings";
import { registerMemberTools } from "./members";
import { registerOrderTools } from "./order-tools";
import { registerPolicyTools } from "./policy-tools";
import { registerSalesTools } from "./sales-tools";
import { registerSchemaDocs } from "./schema-docs";
import { createSettingsStore } from "./settings";
import { registerWidgetResources } from "./widgets/resources";
import type { TenantContext } from "./tenant";

export interface ServerDeps {
  /** The tenant router: runs queries in one transaction, in the company's own database. */
  forTenant: ForTenant;
  /** D1, for auth data only: members and companies. */
  authDb: D1Database;
  /** Workers KV for per-company caches, always under tenantKey(). */
  cache: KVNamespace;
  /** Who this request is for, resolved once from the verified token (see tenant.ts). */
  tenant: TenantContext;
  /** Turns text into vectors: bge-m3 on Workers AI, or the test embedder in tests. */
  embedder: Embedder;
}

/**
 * Builds a brand-new MCP server for ONE request by ONE user in ONE company. Every tool,
 * resource and prompt gets the same tenant context; none of them takes a company id.
 */
export function createServer({ forTenant, authDb, cache, tenant, embedder }: ServerDeps): McpServer {
  const server = new McpServer({ name: "learn-mcp-step-09", version: "0.9.0" });
  const settings = createSettingsStore(cache, forTenant);

  registerSalesTools(server, forTenant, tenant);
  registerOrderTools(server, forTenant, tenant, settings);
  registerPolicyTools(server, { forTenant, embedder, tenant });
  registerCompanyTools(server, { authDb, settings, tenant });
  registerMemberTools(server, authDb, tenant);
  registerSchemaDocs(server);
  registerWidgetResources(server);
  return server;
}
