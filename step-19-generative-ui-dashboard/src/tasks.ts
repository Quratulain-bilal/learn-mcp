import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ForTenant } from "./db";
import { type ReportParams, type ReportSummary, startReport } from "./sales-report";
import type { TenantContext } from "./tenant";
import { markdownTable } from "./tool-helpers";

/**
 * MCP TASKS (extension io.modelcontextprotocol/tasks, SEP-2663) on top of the step 13
 * Workflow. A task is a durable handle the client can follow:
 *
 *   tools/call generate_sales_report  -> CreateTaskResult { resultType: "task", taskId, status: "working", ... }
 *   tasks/get    { taskId }           -> the task: working (with a status message) / completed (with the
 *                                        tool result: the report) / failed (with an error) / cancelled
 *   tasks/cancel { taskId }           -> terminates the Workflow run
 *   tasks/update { taskId, ... }      -> refused: this task never asks for input
 *
 * taskId = report_id = the Workflow instance id. EVERY task method first finds the
 * report in THIS company's reports rows (row-level security), so a task id from another
 * company is "not found", exactly like an id that doesn't exist.
 *
 * Clients that don't declare the extension get a normal tool result instead, and
 * start_sales_report / get_report_status stay as the fallback (with the TaskStatus widget).
 */

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
/** How long a finished task's result is kept for tasks/get: the report row stays, so 7 days is a promise we keep. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 3000;

type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

interface ReportRow {
  stage: string;
  year: number;
  summary: ReportSummary | null;
  created_at: string;
  updated_at: string;
}

/**
 * Did the client opt in to Tasks for this request? Per-request client capabilities live in
 * the reserved `io.modelcontextprotocol/clientCapabilities` key of the request's _meta.
 * The SDK lifts reserved keys out of `_meta` into `ctx.mcpReq.envelope`, so look there
 * (and in `_meta`, for requests where the key wasn't lifted).
 */
export function clientWantsTasks(ctx: ServerContext | undefined): boolean {
  const req = ctx?.mcpReq as { envelope?: Record<string, unknown>; _meta?: Record<string, unknown> } | undefined;
  const caps = (req?.envelope?.[CLIENT_CAPABILITIES] ?? req?._meta?.[CLIENT_CAPABILITIES]) as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return Boolean(caps?.extensions?.[TASKS_EXTENSION]);
}

/** Workflow run + our stage -> a task status and a human message. */
function toTask(taskId: string, row: ReportRow, run: InstanceStatus) {
  const base = {
    taskId,
    createdAt: new Date(row.created_at).toISOString(),
    lastUpdatedAt: new Date(row.updated_at).toISOString(),
    ttlMs: TTL_MS,
    pollIntervalMs: POLL_MS,
  };
  if (row.stage === "cancelled" || run.status === "terminated") {
    return { ...base, status: "cancelled" as TaskStatus, statusMessage: "The report run was cancelled." };
  }
  if (row.stage === "failed" || run.status === "errored") {
    return {
      ...base,
      status: "failed" as TaskStatus,
      statusMessage: run.error?.message ?? "The report run failed.",
      error: { code: -32603, message: run.error?.message ?? "The report run failed." },
    };
  }
  if (row.summary) {
    // The task's job is the report: once it's computed and saved, the task is done. Publishing it
    // (approve_report) is a separate decision for an admin.
    const r = row.summary;
    const text =
      `${r.year} sales report: ${r.orders} orders, revenue ${r.revenue}. Stage: ${row.stage}.\n\n` +
      `Top products:\n${markdownTable(r.topProducts)}`;
    return {
      ...base,
      status: "completed" as TaskStatus,
      statusMessage: row.stage === "awaiting_approval" ? "Report ready; waiting for an admin to approve it." : `Report ${row.stage}.`,
      result: { content: [{ type: "text", text }], structuredContent: { report_id: taskId, stage: row.stage, report: r } },
    };
  }
  const messages: Record<string, string> = {
    queued: "Queued: the report will start in a moment.",
    reading: "Reading the year's orders, page by page.",
    computing: "Computing totals.",
  };
  return { ...base, status: "working" as TaskStatus, statusMessage: messages[row.stage] ?? `Stage: ${row.stage}.` };
}

const taskIdParams = z.object({ taskId: z.string().max(64) });
/** Same answer for an unknown task and another company's task. */
const notFound = (taskId: string) => Object.assign(new Error(`Task not found: ${taskId}`), { code: -32602 });

export function registerTasks(
  server: McpServer,
  deps: { forTenant: ForTenant; tenant: TenantContext; workflow: Workflow<ReportParams> },
): void {
  const { forTenant, tenant, workflow } = deps;

  const findRow = async (taskId: string): Promise<ReportRow | null> => {
    if (!/^[a-z0-9-]{8,64}$/.test(taskId)) return null;
    const rows = await forTenant(tenant, (db) =>
      db.query<ReportRow>(
        `SELECT stage, year, summary, created_at::text AS created_at, updated_at::text AS updated_at
         FROM reports WHERE org_id = $1 AND report_id = $2`,
        [tenant.orgId, taskId],
      ),
    );
    return rows[0] ?? null;
  };

  // Tell clients this server can run tool calls as tasks.
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });

  // ---- tools/call that creates a task ------------------------------------------------
  server.registerTool(
    "generate_sales_report",
    {
      title: "Generate a yearly sales report (task)",
      description:
        "Build the company's sales report for one calendar year. In apps that support MCP Tasks it runs as a task the app follows " +
        "until the report is ready; elsewhere it starts the run and returns a report_id to check with get_report_status.",
      inputSchema: z.object({ year: z.number().int().min(2000).max(2100).describe("The calendar year, e.g. 2025.") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ year }, ctx) => {
      const started = await startReport(forTenant, tenant, workflow, year);
      if ("error" in started) return started.error;
      if (clientWantsTasks(ctx)) {
        const now = new Date().toISOString();
        // A CreateTaskResult instead of a normal tool result. The run (and its row) exist
        // already, so the handle is durable before we answer.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool results as CallToolResult
        return {
          resultType: "task",
          taskId: started.reportId,
          status: "working",
          statusMessage: "Queued: the report will start in a moment.",
          createdAt: now,
          lastUpdatedAt: now,
          ttlMs: TTL_MS,
          pollIntervalMs: POLL_MS,
        } as any;
      }
      const text = `Started the ${year} sales report (report_id ${started.reportId}). Check it with get_report_status.`;
      return { content: [{ type: "text", text }], structuredContent: { report_id: started.reportId, year } };
    },
  );

  // ---- tasks/get ---------------------------------------------------------------------
  server.server.setRequestHandler("tasks/get", { params: taskIdParams }, async ({ taskId }) => {
    const row = await findRow(taskId);
    if (!row) throw notFound(taskId);
    const run = await (await workflow.get(taskId)).status();
    return toTask(taskId, row, run);
  });

  // ---- tasks/cancel ------------------------------------------------------------------
  server.server.setRequestHandler("tasks/cancel", { params: taskIdParams }, async ({ taskId }) => {
    const row = await findRow(taskId);
    if (!row) throw notFound(taskId);
    // Cooperative and idempotent: a finished or already-cancelled task is left as it is.
    if (["queued", "reading", "computing", "awaiting_approval"].includes(row.stage)) {
      const instance = await workflow.get(taskId);
      const run = await instance.status();
      if (!["complete", "errored", "terminated"].includes(run.status)) await instance.terminate();
      await forTenant(tenant, (db) =>
        db.query(`UPDATE reports SET stage = 'cancelled', updated_at = now() WHERE org_id = $1 AND report_id = $2`, [
          tenant.orgId,
          taskId,
        ]),
      );
    }
    return {};
  });

  // ---- tasks/update ------------------------------------------------------------------
  server.server.setRequestHandler(
    "tasks/update",
    // inputResponses isn't required here: the SDK lifts that reserved name out of params
    // (it belongs to multi-round requests), and this task never asks for input anyway.
    { params: taskIdParams.extend({ inputResponses: z.record(z.string(), z.unknown()).optional() }) },
    async ({ taskId }) => {
      const row = await findRow(taskId);
      if (!row) throw notFound(taskId);
      throw Object.assign(new Error("This task never asks for input; there is nothing to update."), { code: -32602 });
    },
  );
}
