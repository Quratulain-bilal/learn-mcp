import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { TenantContext } from "./tenant";

/**
 * An ADMIN-ONLY tool, to show a role check at work. The role comes from the member
 * table, looked up fresh on this request (see index.ts), never from tool input.
 */
export function registerMemberTools(server: McpServer, db: D1Database, tenant: TenantContext): void {
  server.registerTool(
    "list_company_members",
    {
      title: "List company members",
      description:
        "List the people in the signed-in user's company, with their name, email and role (admin or member). " +
        "Only company admins may use this; for members it returns a permission error.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        members: z.array(z.object({ name: z.string(), email: z.string(), role: z.string(), joinedAt: z.string() })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      if (tenant.role !== "admin") {
        // A "403-style" error: clear, and the model can explain it rather than retry.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Forbidden (403): only company admins can list company members. Your role is member. Ask an admin of your company if you need this.",
            },
          ],
        };
      }

      // Scoped to the company from the verified token. LIMIT keeps the reply small.
      const { results } = await db
        .prepare(
          `SELECT u.name AS name, u.email AS email, m.role AS role, m.createdAt AS joinedAt
           FROM member m JOIN "user" u ON u.id = m.userId
           WHERE m.organizationId = ?
           ORDER BY m.createdAt
           LIMIT 200`,
        )
        .bind(tenant.orgId)
        .all<{ name: string; email: string; role: string; joinedAt: string | number }>();

      const members = results.map((m) => ({ ...m, joinedAt: new Date(m.joinedAt).toISOString() }));
      const text =
        `Your company has ${members.length} member(s):\n` +
        members.map((m) => `- ${m.name} <${m.email}>: ${m.role}`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { members } };
    },
  );
}
