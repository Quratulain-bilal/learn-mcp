import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASKS_EXTENSION } from "../src/tasks";
import { asOwner, clientAs, hasDatabase, tenantCtx } from "./helpers";

async function makeMember(orgId: string, userId: string) {
  const now = new Date().toISOString();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(
      `INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)`,
    ).bind(userId, userId, `${userId}@example.com`, now, now),
    env.AUTH_DB.prepare(`INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`).bind(orgId, orgId, orgId, now),
    env.AUTH_DB.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'admin', ?)`).bind(
      crypto.randomUUID(),
      orgId,
      userId,
      now,
    ),
  ]);
}

const optIn = { "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION]: {} } } };

const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean, seconds = 90): Promise<T> => {
  for (let i = 0; i < seconds; i++) {
    const v = await read();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out");
};

describe("Tasks extension wiring (no database needed)", () => {
  it("declares io.modelcontextprotocol/tasks in the server's capabilities", async () => {
    const init = await clientAs(tenantCtx({ orgId: "demo" })).rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(init.result.capabilities.extensions).toHaveProperty([TASKS_EXTENSION]);
  });
});

describe.skipIf(!hasDatabase)("sales report as an MCP task (needs Neon)", () => {
  const userId = `tasker-${crypto.randomUUID().slice(0, 6)}`;
  const client = clientAs(tenantCtx({ orgId: "demo", userId }));
  const started: string[] = [];
  beforeAll(() => makeMember("demo", userId));
  afterAll(async () => {
    if (started.length) await asOwner(`DELETE FROM reports WHERE report_id = ANY($1)`, [started]);
  });

  it("a client that opts in gets a task handle; tasks/get follows it to the finished report", { timeout: 180_000 }, async () => {
    const call = await client.rpc("tools/call", { name: "generate_sales_report", arguments: { year: 2025 }, _meta: optIn });
    const handle = call.result;
    expect(handle.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(handle.status).toBe("working");
    expect(handle.pollIntervalMs).toBeGreaterThan(0);
    started.push(handle.taskId);

    const done = await until(
      () => client.rpc("tasks/get", { taskId: handle.taskId }),
      (r) => r.result?.status === "completed",
      150,
    );
    expect(done.result.result.structuredContent.report.orders).toBe(145);
    expect(done.result.statusMessage).toContain("waiting for an admin");
  });

  it("a client without Tasks gets a normal result with a report_id", async () => {
    const result = await client.callTool("generate_sales_report", { year: 2024 });
    expect(result.structuredContent.report_id).toMatch(/^[0-9a-f-]{36}$/);
    started.push(result.structuredContent.report_id);
  });

  it("refuses a task id from another company, exactly like an unknown one", async () => {
    const call = await client.rpc("tools/call", { name: "generate_sales_report", arguments: { year: 2023 }, _meta: optIn });
    started.push(call.result.taskId);
    const nosy = clientAs(tenantCtx({ orgId: "someone-else", userId }));
    for (const method of ["tasks/get", "tasks/cancel"]) {
      const theirs = await nosy.rpc(method, { taskId: call.result.taskId });
      const unknown = await nosy.rpc(method, { taskId: "00000000-0000-0000-0000-000000000000" });
      expect(theirs.error?.code, method).toBe(-32602);
      expect(theirs.error.message.replace(call.result.taskId, "<id>")).toBe(
        unknown.error.message.replace("00000000-0000-0000-0000-000000000000", "<id>"),
      );
    }
    // Still running for its owner.
    expect((await client.rpc("tasks/get", { taskId: call.result.taskId })).result.status).not.toBe("cancelled");
  });

  it("tasks/cancel terminates the Workflow run", { timeout: 60_000 }, async () => {
    const call = await client.rpc("tools/call", { name: "generate_sales_report", arguments: { year: 2022 }, _meta: optIn });
    const taskId = call.result.taskId;
    started.push(taskId);
    const cancelled = await client.rpc("tasks/cancel", { taskId });
    expect(cancelled.error).toBeUndefined();
    const task = await client.rpc("tasks/get", { taskId });
    expect(task.result.status).toBe("cancelled");
    const run = await (await env.SALES_REPORT.get(taskId)).status();
    expect(run.status).toBe("terminated");
    // Cancelling again is harmless.
    expect((await client.rpc("tasks/cancel", { taskId })).error).toBeUndefined();
  });

  it("tasks/update is refused: this task never asks for input", async () => {
    const id = started[0]!;
    const update = await client.rpc("tasks/update", { taskId: id, inputResponses: {} });
    expect(update.error?.message).toContain("never asks for input");
  });
});
