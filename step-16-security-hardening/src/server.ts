import { McpServer } from "@modelcontextprotocol/server";
import { registerCompanyTools } from "./company-tools";
import { registerDraftTools } from "./draft-tools";
import { type OrderCreatedMessage, orderCreatedEmitter, registerEvents } from "./events";
import { type ImportMessage, registerImportTools } from "./imports";
import { auditToolCalls } from "./audit";
import { createConfirmationGate } from "./confirmation";
import { rateLimitWriteTools } from "./rate-limit";
import type { ForTenant } from "./db";
import type { Embedder } from "./embeddings";
import { registerMemberTools } from "./members";
import { registerOrderTools } from "./order-tools";
import { registerPolicyTools } from "./policy-tools";
import { type ReportParams, registerReportTools } from "./sales-report";
import { registerSalesTools } from "./sales-tools";
import { registerSchemaDocs } from "./schema-docs";
import { createSettingsStore } from "./settings";
import { registerSkills } from "./skills/catalog";
import { registerTasks } from "./tasks";
import { registerWidgetResources } from "./widgets/resources";
import type { TenantContext } from "./tenant";
import { AI_RATE_LIMIT, type UserState } from "./user-state";

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
  /** The signed-in user's Durable Object (org:<orgId>:user:<userId>): draft order and rate limit. */
  userState: DurableObjectStub<UserState>;
  /** Producer for the order-imports queue (bulk imports run in the background). */
  importQueue: Queue<ImportMessage>;
  /** The generate_sales_report Workflow (durable, multi-step report runs). */
  reports: Workflow<ReportParams>;
  /** Producer for the sales-events queue (order.created, then sales.threshold_reached). */
  eventQueue: Queue<OrderCreatedMessage>;
  /** HMAC key for sealed destructive-action confirmations. */
  confirmationSecret: string;
}

/**
 * Builds a brand-new MCP server for ONE request by ONE user in ONE company. Every tool,
 * resource and prompt gets the same tenant context; none of them takes a company id.
 */
export function createServer({ forTenant, authDb, cache, tenant, embedder, userState, importQueue, reports, eventQueue, confirmationSecret }: ServerDeps): McpServer {
  const confirmation = createConfirmationGate(confirmationSecret, tenant);
  const server = new McpServer(
    { name: "learn-mcp-step-16", version: "0.16.0" },
    { requestState: { verify: (state, ctx) => confirmation.codec.verify(state, ctx) } },
  );
  // FIRST, before any tool exists: every write tool gets the per-user rate limit.
  rateLimitWriteTools(
    server,
    () => userState.takeWriteSlot(),
    () => userState.takeSlot("ai", AI_RATE_LIMIT),
  );
  // Then the audit wraps everything, so it also records calls the rate limit refused.
  auditToolCalls(server, tenant);
  const settings = createSettingsStore(cache, forTenant);

  registerSalesTools(server, forTenant, tenant);
  const onOrderCreated = orderCreatedEmitter(eventQueue, tenant);
  registerOrderTools(server, forTenant, tenant, settings, onOrderCreated);
  registerDraftTools(server, { userState, forTenant, tenant, onOrderCreated, confirmation });
  registerEvents(server, { forTenant, tenant });
  registerImportTools(server, { forTenant, tenant, queue: importQueue });
  registerReportTools(server, { forTenant, tenant, workflow: reports, confirmation });
  registerTasks(server, { forTenant, tenant, workflow: reports });
  registerPolicyTools(server, { forTenant, embedder, tenant });
  registerCompanyTools(server, { authDb, settings, tenant, confirmation });
  registerMemberTools(server, authDb, tenant);
  registerSchemaDocs(server);
  registerWidgetResources(server);
  registerSkills(server);
  return server;
}
