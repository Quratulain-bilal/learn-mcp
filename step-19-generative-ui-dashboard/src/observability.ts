import type { ForTenant } from "./db";
import { safeDbErrorForLog } from "./db";
import type { TenantContext } from "./tenant";

/**
 * OBSERVABILITY: one structured JSON log line per interesting thing, so Workers Logs can
 * filter, group and chart them, and every line carries the request id that ties a tool
 * call's audit line (audit.ts) to the database, queue and Workflow work it caused.
 *
 *   {"type":"span","span":"db.transaction","requestId":"…","org":"…","ms":42,"outcome":"ok"}
 *
 * Cloudflare's own tracing (observability.traces in wrangler.jsonc) records every
 * outgoing call automatically (Hyperdrive, Queues, Workflows, Workers AI, KV, D1); these
 * spans add OUR names and the company, so a slow tool call can be traced to the step.
 *
 * Never logged: arguments, results, SQL parameters or row data (personal data, secrets).
 */

export type SpanOutcome = "ok" | "error";

export function logSpan(fields: {
  span: string;
  tenant: Pick<TenantContext, "orgId" | "requestId">;
  ms: number;
  outcome: SpanOutcome;
  error?: Record<string, string | undefined>;
}): void {
  console.log(
    JSON.stringify({
      type: "span",
      span: fields.span,
      requestId: fields.tenant.requestId,
      org: fields.tenant.orgId,
      ms: fields.ms,
      outcome: fields.outcome,
      ...(fields.error ? { error: fields.error } : {}),
    }),
  );
}

/** Times `fn` as a named span. Errors are logged (code only) and re-thrown unchanged. */
export async function traced<T>(
  span: string,
  tenant: Pick<TenantContext, "orgId" | "requestId">,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    logSpan({ span, tenant, ms: Date.now() - started, outcome: "ok" });
    return result;
  } catch (error) {
    logSpan({ span, tenant, ms: Date.now() - started, outcome: "error", error: safeDbErrorForLog(error) });
    throw error;
  }
}

/** Every database transaction of this request, as a "db.transaction" span. */
export function traceForTenant(forTenant: ForTenant, tenant: TenantContext): ForTenant {
  return (ctx, fn) => traced("db.transaction", tenant, () => forTenant(ctx, fn));
}

/** Queue sends of this request, as "queue.<name>.send" spans. */
export function traceQueue<Body>(queue: Queue<Body>, name: string, tenant: TenantContext): Queue<Body> {
  return {
    send: (body, options) => traced(`queue.${name}.send`, tenant, () => queue.send(body, options)),
    sendBatch: (messages, options) => traced(`queue.${name}.sendBatch`, tenant, () => queue.sendBatch(messages, options)),
    metrics: () => queue.metrics(),
  } as Queue<Body>;
}

/** Workflow calls of this request, as "workflow.create" / "workflow.get" spans. */
export function traceWorkflow<P>(workflow: Workflow<P>, tenant: TenantContext): Workflow<P> {
  return {
    create: (options) => traced("workflow.create", tenant, () => workflow.create(options)),
    // createBatch is overloaded; pass the argument straight through.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createBatch: (batch: any) => traced("workflow.createBatch", tenant, () => workflow.createBatch(batch)),
    get: (id) => traced("workflow.get", tenant, () => workflow.get(id)),
  } as Workflow<P>;
}
