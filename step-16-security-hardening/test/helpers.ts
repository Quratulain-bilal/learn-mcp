import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { exports, env } from "cloudflare:workers";
import type { TenantContext } from "../src/tenant";
import { createTenantRouter } from "../src/tenant-router";
import { testEmbedder } from "../src/embeddings";
import { userStateFor } from "../src/user-state";
import { Client } from "pg";
import { createForTenant, hasDatabaseUrl, type Db, type ForTenant } from "../src/db";
import { createServer } from "../src/server";

const PROTOCOL_VERSION = "2025-06-18";
export const LATEST_PROTOCOL = "2026-07-28";
let nextId = 1;

// JSON-RPC replies are loose JSON here; `any` keeps the test assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RpcReply = { result?: any; error?: any };

export function mcpRequest(method: string, params: unknown, token?: string, protocolVersion = PROTOCOL_VERSION): Request {
  const modern = protocolVersion >= LATEST_PROTOCOL;
  const wireParams =
    modern && params && typeof params === "object" && !Array.isArray(params)
      ? {
          ...params,
          _meta: {
            ...((params as Record<string, unknown>)._meta as Record<string, unknown> | undefined),
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
            [CLIENT_INFO_META_KEY]: { name: "learn-mcp-tests", version: "1.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {
              elicitation: { form: {}, url: {} },
            },
          },
        }
      : params;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      // Real clients always send Host; the handler rejects requests without it (DNS-rebinding protection).
      host: "localhost",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      ...(modern ? { "mcp-method": method } : {}),
      ...(modern && typeof (params as { name?: unknown } | undefined)?.name === "string"
        ? { "mcp-name": (params as { name: string }).name }
        : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: wireParams }),
  });
}

/** Reads a JSON-RPC reply sent either as plain JSON or as a one-event SSE stream. */
export async function readRpc(response: Response): Promise<RpcReply> {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find((line) => line.length > 0);
    return JSON.parse(data ?? "{}");
  }
  return JSON.parse(text);
}

/**
 * A client for the MCP server as ONE given user, WITHOUT the OAuth layer, for fast tests
 * of the tools themselves. The OAuth layer is tested end to end in auth.test.ts.
 */
export function clientAs(tenant: TenantContext, forTenant: ForTenant = testForTenant) {
  const handler = createMcpHandler(() =>
    createServer({
      forTenant,
      authDb: env.AUTH_DB,
      cache: env.TENANT_CACHE,
      tenant,
      embedder: testEmbedder(),
      userState: userStateFor(env.USER_STATE, tenant),
      importQueue: env.ORDER_IMPORTS,
      reports: env.SALES_REPORT,
      eventQueue: env.SALES_EVENTS,
      confirmationSecret: env.CONFIRMATION_SECRET,
    }),
  );
  const rpc = async (method: string, params: unknown, protocolVersion?: string) =>
    readRpc(await handler.fetch(mcpRequest(method, params, undefined, protocolVersion)));
  return {
    rpc,
    callTool: (name: string, args: Record<string, unknown>, protocolVersion?: string) =>
      rpc("tools/call", { name, arguments: args }, protocolVersion).then((r) => r.result),
  };
}

export function sealedToken(result: unknown): string {
  const value = result as { requestState?: unknown } | undefined;
  if (typeof value?.requestState !== "string") throw new Error("No sealed requestState in the first response");
  return value.requestState;
}

/** A tenant context as tenant.ts would build it. Shared tier unless overridden. */
export const tenantCtx = (overrides: Partial<TenantContext> = {}): TenantContext => ({
  userId: "user-a",
  orgId: "org-1",
  role: "admin",
  tier: "shared",
  database: "HYPERDRIVE",
  clientId: "test-client",
  requestId: crypto.randomUUID(),
  ...overrides,
});

/** A company that lives in the dedicated test database. */
export const DEDICATED = { tier: "dedicated", database: "TENANT_DB_ENTERPRISE" } as const;

/** Calls the real Worker (with the OAuth layer) the way Claude or ChatGPT would. */
export async function workerRpc(method: string, params: unknown, token?: string, protocolVersion = PROTOCOL_VERSION) {
  const response = await exports.default.fetch(mcpRequest(method, params, token, protocolVersion));
  const text = await response.clone().text();
  return { response, text, reply: response.status === 200 ? await readRpc(response) : undefined };
}

/** True when .env points the HYPERDRIVE binding and the owner role at a real Neon branch. */
export const hasDatabase =
  hasDatabaseUrl(env.HYPERDRIVE?.connectionString) &&
  env.HYPERDRIVE.connectionString.includes("mcp_connector") &&
  hasDatabaseUrl(env.TEST_OWNER_DATABASE_URL);

/** True when .env also has the dedicated test database (npm run tenant:dedicate -- --name enterprise). */
export const hasDedicated =
  hasDatabase &&
  hasDatabaseUrl(env.TENANT_DB_ENTERPRISE?.connectionString) &&
  env.TENANT_DB_ENTERPRISE.connectionString.includes("mcp_connector") &&
  hasDatabaseUrl(env.TEST_DEDICATED_OWNER_DATABASE_URL);

/** Exactly what the Worker uses: the tenant router, the connector role, one transaction per company. */
export const testForTenant: ForTenant = (ctx, fn) => createTenantRouter(env)(ctx, fn);

/** The shared database only, bypassing the router (for tests about the shared database itself). */
export const sharedForTenant: ForTenant = (ctx, fn) => createForTenant(env.HYPERDRIVE.connectionString)(ctx, fn);

/** The owner URL for a tenant database binding. */
const ownerUrl = (binding: string) =>
  binding === "HYPERDRIVE" ? env.TEST_OWNER_DATABASE_URL : env.TEST_DEDICATED_OWNER_DATABASE_URL;

/** A database that is always down, to test the error path without Neon. */
export const brokenForTenant: ForTenant = async () => {
  throw new Error("connection refused (simulated)");
};

/**
 * Runs `fn` as the OWNER role inside a transaction that is ALWAYS rolled back, so a test
 * can change a policy or plant data, look at the effect, and leave nothing behind.
 * `asConnector` switches to the Worker's role (and company) for the rest of the transaction.
 */
export async function inRolledBackTransaction<T>(
  fn: (db: Db, asConnector: (orgId: string | null) => Promise<void>) => Promise<T>,
  binding = "HYPERDRIVE",
): Promise<T> {
  const client = new Client({ connectionString: ownerUrl(binding) });
  await client.connect();
  try {
    await client.query("BEGIN");
    const db: Db = { query: async (text, params = []) => (await client.query(text, params)).rows };
    return await fn(db, async (orgId) => {
      await client.query("SET LOCAL ROLE mcp_connector");
      if (orgId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [orgId]);
    });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

/** Runs one statement as the owner of a tenant database, committed (to plant and clean up test rows). */
export async function asOwner(text: string, params: unknown[] = [], binding = "HYPERDRIVE"): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: ownerUrl(binding) });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}
