import type { McpServer } from "@modelcontextprotocol/server";
import type { TenantContext } from "./tenant";

/**
 * AN AUDIT LOG of every tool call: who (company, user, client), which tool, when, the
 * outcome and how long it took. One JSON line per call in Workers Logs, searchable by
 * request id, company or tool.
 *
 * Never the ARGUMENTS or the RESULT: they can hold personal data (emails, names) and,
 * in principle, secrets pasted by a user. The audit says what happened, not what was said.
 *
 * Applied like the rate limit: registerTool is wrapped before any tool is registered,
 * so no tool can be left out.
 */
export function auditToolCalls(server: McpServer, tenant: TenantContext): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- passes registerTool's overloads through
  const register = server.registerTool.bind(server) as (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, config: any, handler: (...args: any[]) => unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register(name, config, async (...args: any[]) => {
      const started = Date.now();
      let outcome: "ok" | "tool_error" | "exception" = "ok";
      try {
        const result = (await handler(...args)) as { isError?: boolean } | undefined;
        if (result?.isError) outcome = "tool_error";
        return result;
      } catch (error) {
        outcome = "exception";
        throw error;
      } finally {
        console.log(
          JSON.stringify({
            type: "audit",
            at: new Date(started).toISOString(),
            requestId: tenant.requestId,
            org: tenant.orgId,
            user: tenant.userId,
            role: tenant.role,
            client: tenant.clientId,
            tool: name,
            writes: config?.annotations?.readOnlyHint !== true,
            outcome,
            ms: Date.now() - started,
          }),
        );
      }
    });
}
