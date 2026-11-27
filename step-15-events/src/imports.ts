import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { lookupRole } from "./auth";
import { type Db, type ForTenant, safeDbErrorForLog } from "./db";
import { insertOrder } from "./order-tools";
import { type TenantContext, type TenantEnvelope, envelope, lookupPlacement } from "./tenant";
import { createTenantRouter } from "./tenant-router";
import { READ_ONLY, dbError, toolError } from "./tool-helpers";

/**
 * BULK ORDER IMPORTS with Cloudflare Queues.
 *
 *   bulk_import_orders (tool)  checks the CSV, records the import, sends the rows to the
 *                              order-imports queue in batches of 50, answers at once
 *   queue consumer (Worker)    handles each batch in the background, retrying on failure;
 *                              a message that keeps failing goes to order-imports-dlq
 *   get_import_status (tool)   rows done, rows failed and why, finished or not
 *
 * Every message carries the TENANT ENVELOPE (company, user, request id). The consumer
 * runs long after the tool call, so it trusts nothing: it re-checks that the user is
 * still a member, that the import belongs to that company, and writes through the tenant
 * router, so row-level security applies exactly as in a tool call.
 */

export const CSV_HEADER = ["order_date", "customer_email", "product", "quantity"] as const;
export const MAX_ROWS = 2000;
export const MAX_CSV_CHARS = 200_000;
export const BATCH_ROWS = 50;

export interface ImportRow {
  row: number;
  order_date: string;
  customer_email: string;
  product: string;
  quantity: string;
}
export interface ImportMessage {
  envelope: TenantEnvelope;
  importId: string;
  rows: ImportRow[];
}

/** A small CSV reader: commas, double-quoted fields ("a, b" and "" for a quote), CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** The order reference an import row gets: the same on every delivery of the message. */
export const importOrderRef = (importId: string, row: number) =>
  `IMP-${importId.replace(/-/g, "").slice(0, 8).toUpperCase()}-${row}`;

// ---------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------

export function registerImportTools(
  server: McpServer,
  deps: { forTenant: ForTenant; tenant: TenantContext; queue: Queue<ImportMessage> },
): void {
  const { forTenant, tenant, queue } = deps;

  server.registerTool(
    "bulk_import_orders",
    {
      title: "Import orders from CSV",
      description:
        `Import many orders at once from CSV text with the header ${CSV_HEADER.join(",")} (one single-product order per row, ` +
        `order_date as YYYY-MM-DD, up to ${MAX_ROWS} rows). The import runs in the background: this returns an import_id at once, ` +
        "and get_import_status reports progress, finished rows and failed rows with reasons. Confirm with the user before importing.",
      inputSchema: z.object({
        csv: z
          .string()
          .min(10)
          .max(MAX_CSV_CHARS, `CSV is limited to ${MAX_CSV_CHARS} characters; split it into several imports.`)
          .describe("The CSV text, header row first."),
      }),
      outputSchema: z.object({ import_id: z.string(), rows: z.number(), batches: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ csv }) => {
      const [header, ...lines] = parseCsv(csv);
      const got = (header ?? []).map((h) => h.trim().toLowerCase());
      if (got.join(",") !== CSV_HEADER.join(",")) {
        return toolError(
          `The first line must be exactly: ${CSV_HEADER.join(",")}. It was: ${got.join(",") || "(empty)"}. Fix the header and try again.`,
        );
      }
      if (lines.length === 0) return toolError("The CSV has a header but no rows.");
      if (lines.length > MAX_ROWS) return toolError(`That's ${lines.length} rows; the limit is ${MAX_ROWS} per import.`);

      const rows: ImportRow[] = lines.map((f, i) => ({
        row: i + 1, // row 1 is the first line after the header
        order_date: (f[0] ?? "").trim(),
        customer_email: (f[1] ?? "").trim().toLowerCase(),
        product: (f[2] ?? "").trim(),
        quantity: (f[3] ?? "").trim(),
      }));
      const importId = crypto.randomUUID();
      try {
        await forTenant(tenant, (db) =>
          db.query(`INSERT INTO imports (org_id, import_id, created_by, total_rows) VALUES ($1, $2, $3, $4)`, [
            tenant.orgId,
            importId,
            tenant.userId,
            rows.length,
          ]),
        );
        const messages: { body: ImportMessage }[] = [];
        for (let i = 0; i < rows.length; i += BATCH_ROWS) {
          messages.push({ body: { envelope: envelope(tenant), importId, rows: rows.slice(i, i + BATCH_ROWS) } });
        }
        // sendBatch takes at most 100 messages; 2,000 rows / 50 = 40, well within it.
        await queue.sendBatch(messages);
        const text =
          `Import ${importId} started: ${rows.length} rows in ${messages.length} batch(es), running in the background. ` +
          "Check progress with get_import_status.";
        return { content: [{ type: "text", text }], structuredContent: { import_id: importId, rows: rows.length, batches: messages.length } };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  server.registerTool(
    "get_import_status",
    {
      title: "Import status",
      description:
        "How a bulk order import is going: rows done, rows failed (with the first few reasons) and whether it has finished. " +
        "Use the import_id that bulk_import_orders returned.",
      inputSchema: z.object({ import_id: z.string().uuid().describe("The import_id from bulk_import_orders.") }),
      outputSchema: z.object({
        import_id: z.string(),
        total_rows: z.number(),
        done: z.number(),
        failed: z.number(),
        pending: z.number(),
        finished: z.boolean(),
        failures: z.array(z.object({ row: z.number(), error: z.string() })),
      }),
      annotations: READ_ONLY,
    },
    async ({ import_id }) => {
      try {
        const status = await forTenant(tenant, async (db) => {
          const [imp] = await db.query<{ total_rows: number }>(
            `SELECT total_rows FROM imports WHERE org_id = $1 AND import_id = $2`,
            [tenant.orgId, import_id],
          );
          if (!imp) return null;
          const [counts] = await db.query<{ done: number; failed: number }>(
            `SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status = 'failed')::int AS failed
             FROM import_rows WHERE org_id = $1 AND import_id = $2`,
            [tenant.orgId, import_id],
          );
          // Only the first 10 failures: enough to see the pattern, small enough for the context.
          const failures = await db.query<{ row: number; error: string }>(
            `SELECT row_no AS row, error FROM import_rows
             WHERE org_id = $1 AND import_id = $2 AND status = 'failed' ORDER BY row_no LIMIT 10`,
            [tenant.orgId, import_id],
          );
          return { total_rows: imp.total_rows, done: counts!.done, failed: counts!.failed, failures };
        });
        // The same answer for "no such import" and "another company's import".
        if (!status) return toolError(`No import ${import_id} was found in your company.`);
        const pending = status.total_rows - status.done - status.failed;
        const finished = pending === 0;
        const text =
          `Import ${import_id}: ${status.done} done, ${status.failed} failed, ${pending} pending of ${status.total_rows}` +
          (finished ? " (finished)." : " (still running).") +
          (status.failures.length
            ? `\nFirst failures:\n${status.failures.map((f) => `- row ${f.row}: ${f.error}`).join("\n")}` +
              (status.failed > status.failures.length ? `\n…and ${status.failed - status.failures.length} more.` : "")
            : "");
        return {
          content: [{ type: "text", text }],
          structuredContent: { import_id, ...status, pending, finished },
        };
      } catch (error) {
        return dbError(error);
      }
    },
  );
}

// ---------------------------------------------------------------------------------------
// Queue consumer
// ---------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks a row's fields; returns the problem, or null if it can be tried. */
function checkRow(r: ImportRow): string | null {
  if (!DATE.test(r.order_date) || Number.isNaN(Date.parse(r.order_date))) return `order_date "${r.order_date}" isn't YYYY-MM-DD.`;
  if (!EMAIL.test(r.customer_email)) return `customer_email "${r.customer_email}" isn't an email address.`;
  if (!r.product || r.product.length > 120) return "product is empty or too long.";
  const q = Number(r.quantity);
  if (!Number.isInteger(q) || q < 1 || q > 1000) return `quantity "${r.quantity}" must be a whole number from 1 to 1000.`;
  return null;
}

/**
 * Handles one row inside the batch's transaction. Returns what happened, for the log.
 *
 * Idempotent: a row already in import_rows was handled by an earlier delivery, so it's
 * skipped. Otherwise the order (if the row is valid) and the row's result are written in
 * the same transaction, so they're kept or lost together. If two deliveries race, the
 * second one's INSERT hits the primary key, its message is retried, and on the retry the
 * row is skipped. (This needs only INSERT on import_rows, never UPDATE: least privilege.)
 */
async function handleRow(db: Db, orgId: string, importId: string, r: ImportRow): Promise<"done" | "failed" | "skipped"> {
  const [seen] = await db.query(`SELECT 1 FROM import_rows WHERE org_id = $1 AND import_id = $2 AND row_no = $3`, [
    orgId,
    importId,
    r.row,
  ]);
  if (seen) return "skipped";

  // A savepoint per row: a row whose order fails validation in the database rolls back only itself.
  await db.query("SAVEPOINT row_start");
  const problem = checkRow(r);
  const result = problem
    ? { error: problem }
    : await insertOrder(db, orgId, r.customer_email, [{ product: r.product, quantity: Number(r.quantity) }], {
        orderRef: importOrderRef(importId, r.row),
        orderDate: r.order_date,
      });
  if ("error" in result) {
    await db.query("ROLLBACK TO SAVEPOINT row_start");
    await db.query(
      `INSERT INTO import_rows (org_id, import_id, row_no, status, error) VALUES ($1, $2, $3, 'failed', $4)`,
      [orgId, importId, r.row, result.error.slice(0, 500)],
    );
    return "failed";
  }
  await db.query("RELEASE SAVEPOINT row_start");
  await db.query(
    `INSERT INTO import_rows (org_id, import_id, row_no, status, order_ref) VALUES ($1, $2, $3, 'done', $4)`,
    [orgId, importId, r.row, result.order_ref],
  );
  return "done";
}

/**
 * The Worker's queue handler for order-imports. Per message:
 *   - membership revoked, or the import isn't this company's -> ack (retrying won't help)
 *   - a database or network error -> retry the message (up to max_retries, then the DLQ);
 *     rows that were already committed are skipped on the retry
 *   - bad rows are recorded as failed and are NOT a reason to retry
 */
export async function consumeImports(batch: MessageBatch<ImportMessage>, env: Env): Promise<void> {
  const router = createTenantRouter(env);
  for (const message of batch.messages) {
    const { envelope: who, importId, rows } = message.body;
    try {
      const role = await lookupRole(env.AUTH_DB, who.orgId, who.userId);
      if (!role) {
        console.warn("import dropped: user no longer a member", { org: who.orgId, requestId: who.requestId });
        message.ack();
        continue;
      }
      const placement = await lookupPlacement(env, who.orgId);
      const ctx = { orgId: who.orgId, ...placement };
      const outcome = await router(ctx, async (db) => {
        const [mine] = await db.query(`SELECT 1 FROM imports WHERE org_id = $1 AND import_id = $2`, [who.orgId, importId]);
        if (!mine) return null; // not this company's import: RLS hides it
        const tally = { done: 0, failed: 0, skipped: 0 };
        for (const r of rows) tally[await handleRow(db, who.orgId, importId, r)]++;
        return tally;
      });
      if (!outcome) console.warn("import dropped: not this company's import", { org: who.orgId, requestId: who.requestId });
      else console.log("import batch", { org: who.orgId, requestId: who.requestId, ...outcome });
      message.ack();
    } catch (error) {
      console.error("import batch failed, will retry", { org: who.orgId, requestId: who.requestId, attempt: message.attempts, ...safeDbErrorForLog(error) });
      message.retry({ delaySeconds: Math.min(60, 5 * message.attempts) });
    }
  }
}
