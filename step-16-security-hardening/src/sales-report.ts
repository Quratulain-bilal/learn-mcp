import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { lookupRole } from "./auth";
import type { ConfirmationGate } from "./confirmation";
import type { Db, ForTenant } from "./db";
import { type TenantContext, type TenantEnvelope, envelope, lookupPlacement } from "./tenant";
import { createTenantRouter } from "./tenant-router";
import { READ_ONLY, dbError, markdownTable, toolError } from "./tool-helpers";
import { WIDGETS } from "./widgets/resources";

/**
 * GENERATE SALES REPORT, a Cloudflare WORKFLOW: one job, run as named, DURABLE steps.
 * Each step's result is saved when it finishes; a failed step is retried on its own; if
 * the Worker restarts, the run continues from the last finished step instead of starting
 * over. While it waits for approval it uses no CPU at all, for up to a week.
 *
 *   check membership -> read orders (page by page) -> compute totals -> save report
 *     -> wait for the "approval" event (step.waitForEvent) -> publish
 *
 * Every run carries the tenant envelope as its params, and every step re-reads the
 * company's placement and runs its queries through the tenant router (row-level security).
 */

export interface ReportParams {
  envelope: TenantEnvelope;
  year: number;
}

/** Running totals one page adds to: small enough to save as a step result (limit 1 MiB). */
interface Totals {
  orders: number;
  revenue: number;
  byMonth: Record<string, number>;
  byProduct: Record<string, number>;
  byCustomer: Record<string, number>;
}

export interface ReportSummary {
  year: number;
  orders: number;
  revenue: number;
  months: { month: string; revenue: number }[];
  topProducts: { product: string; revenue: number }[];
  topCustomers: { customer: string; revenue: number }[];
}

const PAGE = 100; // orders per read step
export const APPROVAL_EVENT = "approval";
export const APPROVAL_TIMEOUT = "7 days";

const round = (x: number) => Math.round(x * 100) / 100;
const top = (m: Record<string, number>, n: number) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);

/** Moves the report row to a stage. Idempotent: setting the same stage twice changes nothing. */
const setStage = (db: Db, orgId: string, reportId: string, stage: string) =>
  db.query(`UPDATE reports SET stage = $3, updated_at = now() WHERE org_id = $1 AND report_id = $2`, [orgId, reportId, stage]);

export class SalesReportWorkflow extends WorkflowEntrypoint<Env, ReportParams> {
  override async run(event: WorkflowEvent<ReportParams>, step: WorkflowStep): Promise<ReportSummary> {
    const { envelope: who, year } = event.payload;
    const reportId = event.instanceId;
    const env = this.env;
    const router = createTenantRouter(env);
    // Re-read where the company lives in each step that needs it (cached in KV).
    const forCompany = async <T>(fn: (db: Db) => Promise<T>) =>
      router({ orgId: who.orgId, ...(await lookupPlacement(env, who.orgId)) }, fn);

    try {
      // 1. The run may start (or resume) long after the tool call: is the user still in the company?
      await step.do("check membership", async () => {
        const role = await lookupRole(env.AUTH_DB, who.orgId, who.userId);
        if (!role) throw new NonRetryableError("The user who started this report is no longer a member of the company.");
        await forCompany((db) => setStage(db, who.orgId, reportId, "reading"));
        return role;
      });

      // 2. Read the year's orders a page at a time. Each page is its own step, so a failure
      //    on page 7 retries page 7, not pages 1-6. Pages are keyed by the last order id
      //    seen (keyset paging), so a retried page reads exactly the same orders: idempotent.
      let totals: Totals = { orders: 0, revenue: 0, byMonth: {}, byProduct: {}, byCustomer: {} };
      let afterId = "0";
      for (let page = 1; ; page++) {
        const result = await step.do(`read orders page ${page}`, async () => {
          const rows = await forCompany((db) =>
            db.query<{ order_id: string; month: string; customer: string; product: string; amount: number }>(
              `WITH page AS (
                 SELECT order_id FROM orders
                 WHERE org_id = $1 AND extract(year FROM order_date) = $2 AND order_id > $3::bigint
                 ORDER BY order_id LIMIT $4)
               SELECT o.order_id::text AS order_id, to_char(o.order_date, 'YYYY-MM') AS month, cu.name AS customer,
                      p.name AS product, (i.quantity * i.unit_price)::float8 AS amount
               FROM page JOIN orders o ON o.org_id = $1 AND o.order_id = page.order_id
               JOIN customers cu ON cu.org_id = o.org_id AND cu.customer_id = o.customer_id
               JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
               JOIN products p ON p.org_id = i.org_id AND p.product_id = i.product_id
               ORDER BY o.order_id`,
              [who.orgId, year, afterId, PAGE],
            ),
          );
          // Add this page to a COPY of the totals so far: the step's saved result is the new totals.
          const next: Totals = structuredClone(totals);
          const seen = new Set<string>();
          for (const r of rows) {
            if (!seen.has(r.order_id)) {
              seen.add(r.order_id);
              next.orders++;
            }
            next.revenue += r.amount;
            next.byMonth[r.month] = (next.byMonth[r.month] ?? 0) + r.amount;
            next.byProduct[r.product] = (next.byProduct[r.product] ?? 0) + r.amount;
            next.byCustomer[r.customer] = (next.byCustomer[r.customer] ?? 0) + r.amount;
          }
          return { totals: next, lastId: rows.at(-1)?.order_id ?? null, ordersInPage: seen.size };
        });
        totals = result.totals;
        if (!result.lastId || result.ordersInPage < PAGE) break;
        afterId = result.lastId;
      }

      // 3. Pure computation over the saved totals: same input, same output, safe to retry.
      const summary = await step.do("compute totals", async (): Promise<ReportSummary> => ({
        year,
        orders: totals.orders,
        revenue: round(totals.revenue),
        months: Object.entries(totals.byMonth)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, revenue]) => ({ month, revenue: round(revenue) })),
        topProducts: top(totals.byProduct, 5).map(([product, revenue]) => ({ product, revenue: round(revenue) })),
        topCustomers: top(totals.byCustomer, 5).map(([customer, revenue]) => ({ customer, revenue: round(revenue) })),
      }));

      // 4. Save it. An UPDATE of this run's own row: running it twice writes the same thing.
      await step.do("save report", async () => {
        await forCompany((db) =>
          db.query(
            `UPDATE reports SET summary = $3, stage = 'awaiting_approval', updated_at = now()
             WHERE org_id = $1 AND report_id = $2`,
            [who.orgId, reportId, JSON.stringify(summary)],
          ),
        );
      });

      // 5. Wait for a person. The instance sleeps (no CPU, no cost) until approve_report
      //    sends the event, or the timeout passes, which throws.
      let approval: { payload: { approvedBy: string } };
      try {
        approval = (await step.waitForEvent<{ approvedBy: string }>("wait for approval", {
          type: APPROVAL_EVENT,
          timeout: APPROVAL_TIMEOUT,
        })) as { payload: { approvedBy: string } };
      } catch {
        await step.do("mark expired", () => forCompany((db) => setStage(db, who.orgId, reportId, "expired")));
        return summary;
      }

      // 6. Publish.
      await step.do("publish", async () => {
        await forCompany((db) =>
          db.query(
            `UPDATE reports SET stage = 'published', approved_by = $3, updated_at = now() WHERE org_id = $1 AND report_id = $2`,
            [who.orgId, reportId, approval.payload.approvedBy],
          ),
        );
      });
      return summary;
    } catch (error) {
      // A step that failed every retry (or a NonRetryableError): record it for get_report_status.
      await step.do("mark failed", () => forCompany((db) => setStage(db, who.orgId, reportId, "failed")));
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------

/**
 * Starts a report run for the caller's company: records the report row first (so the
 * owner is known before any step runs), then creates the Workflow instance with the
 * tenant envelope. Used by start_sales_report and by the task-based generate_sales_report.
 */
export async function startReport(
  forTenant: ForTenant,
  tenant: TenantContext,
  workflow: Workflow<ReportParams>,
  year: number,
): Promise<{ reportId: string } | { error: ReturnType<typeof dbError> }> {
  const id = crypto.randomUUID();
  try {
    await forTenant(tenant, (db) =>
      db.query(`INSERT INTO reports (org_id, report_id, created_by, year, stage) VALUES ($1, $2, $3, $4, 'queued')`, [
        tenant.orgId,
        id,
        tenant.userId,
        year,
      ]),
    );
    await workflow.create({ id, params: { envelope: envelope(tenant), year } });
    return { reportId: id };
  } catch (error) {
    return { error: dbError(error) };
  }
}

export function registerReportTools(
  server: McpServer,
  deps: { forTenant: ForTenant; tenant: TenantContext; workflow: Workflow<ReportParams>; confirmation: ConfirmationGate },
): void {
  const { forTenant, tenant, workflow, confirmation } = deps;

  /** This company's report row, or null (missing and another company's look the same). */
  const findReport = (reportId: string) =>
    forTenant(tenant, (db) =>
      db.query<{ year: number; stage: string; summary: ReportSummary | null; approved_by: string | null }>(
        `SELECT year, stage, summary, approved_by FROM reports WHERE org_id = $1 AND report_id = $2`,
        [tenant.orgId, reportId],
      ),
    ).then((rows) => rows[0] ?? null);

  const reportId = z
    .string()
    .regex(/^[a-z0-9-]{8,64}$/, "Use the report_id that start_sales_report returned.")
    .describe("The report_id from start_sales_report.");

  // The fallback for apps without MCP Tasks. Where MCP Apps render, the TaskStatus
  // widget follows the run (polling get_report_status) and shows the report when ready.
  registerAppTool(
    server,
    "start_sales_report",
    {
      title: "Start a yearly sales report",
      description:
        "Start building the company's sales report for one calendar year, in the background (it reads every order, so it can take a while). " +
        "Returns a report_id at once and shows a live progress panel; check it with get_report_status. " +
        "A finished report waits for an admin to approve it with approve_report before it's published.",
      _meta: { ui: { resourceUri: WIDGETS.taskStatus } },
      inputSchema: z.object({ year: z.number().int().min(2000).max(2100).describe("The calendar year, e.g. 2025.") }),
      outputSchema: z.object({ report_id: z.string(), year: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ year }) => {
      const started = await startReport(forTenant, tenant, workflow, year);
      if ("error" in started) return started.error;
      const text = `Started the ${year} sales report (report_id ${started.reportId}). It runs in the background; check it with get_report_status.`;
      return { content: [{ type: "text", text }], structuredContent: { report_id: started.reportId, year } };
    },
  );

  server.registerTool(
    "get_report_status",
    {
      title: "Sales report status",
      description:
        "Where a sales report run is (queued, reading, computing, awaiting_approval, published, expired, failed), any error, and the report itself once it's ready.",
      inputSchema: z.object({ report_id: reportId }),
      outputSchema: z.object({
        report_id: z.string(),
        stage: z.string(),
        run_status: z.string(),
        error: z.string().nullable(),
        report: z.unknown().nullable(),
      }),
      annotations: READ_ONLY,
    },
    async ({ report_id }) => {
      try {
        const row = await findReport(report_id);
        if (!row) return toolError(`No report ${report_id} was found in your company.`);
        // The Workflow's own view of the run: queued, running, waiting, complete, errored...
        const status = await (await workflow.get(report_id)).status();
        const error = status.error?.message ?? null;
        const report = row.summary;
        const text =
          `Report ${report_id} (${row.year}): stage ${row.stage}, run ${status.status}.` +
          (error ? ` Error: ${error}` : "") +
          (report
            ? `\n\n${report.orders} orders, revenue ${report.revenue}.\nTop products:\n${markdownTable(report.topProducts)}`
            : "") +
          (row.stage === "awaiting_approval" ? "\n\nAn admin can publish it with approve_report." : "");
        return {
          content: [{ type: "text", text }],
          structuredContent: { report_id, stage: row.stage, run_status: status.status, error, report },
        };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  server.registerTool(
    "approve_report",
    {
      title: "Approve and publish a sales report",
      description:
        "Approve a finished sales report (stage awaiting_approval) so it's published (admins only). This is irreversible: call once to get the confirmation form, or a sealed token if the client can't show a form, then only continue after the user explicitly confirms.",
      inputSchema: z.object({
        report_id: reportId,
        confirmationToken: z
          .string()
          .max(2000)
          .optional()
          .describe("Only for clients without elicitation: send back the sealed token from the first call."),
      }),
      outputSchema: z.object({ report_id: z.string(), approved: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, ctx) => {
      const { report_id } = args;
      if (tenant.role !== "admin") {
        return toolError("Forbidden (403): only company admins can approve reports. Your role is member. Ask an admin.");
      }
      const approved = await confirmation.require(
        ctx,
        "approve_report",
        args,
        "PUBLISH",
        `Publish sales report ${report_id}? This cannot be undone.`,
      );
      if (!approved.ok) return approved.result;
      try {
        const row = await findReport(report_id);
        if (!row) return toolError(`No report ${report_id} was found in your company.`);
        if (row.stage !== "awaiting_approval") {
          return toolError(`Report ${report_id} is ${row.stage}, not awaiting approval. Check it with get_report_status.`);
        }
        // Wakes the waiting step.waitForEvent in this company's own run.
        await (await workflow.get(report_id)).sendEvent({ type: APPROVAL_EVENT, payload: { approvedBy: tenant.userId } });
        const text = `Approved report ${report_id}. It will be published in a moment.`;
        return { content: [{ type: "text", text }], structuredContent: { report_id, approved: true } };
      } catch (error) {
        return dbError(error);
      }
    },
  );
}
