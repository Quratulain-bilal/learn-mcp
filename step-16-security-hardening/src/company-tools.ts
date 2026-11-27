import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ConfirmationGate } from "./confirmation";
import type { SettingsStore } from "./settings";
import type { TenantContext } from "./tenant";
import { READ_ONLY, dbError, toolError } from "./tool-helpers";

/**
 * Company tools: which companies you're in, the company's settings, and (admins only)
 * adding and removing members. Membership lives in D1 (auth data); settings live in the
 * company's own database. Nothing here takes a company id: it's always the token's.
 */

const forbidden = (action: string) =>
  toolError(
    `Forbidden (403): only company admins can ${action}. Your role in this company is member. Ask an admin of your company.`,
  );

const email = z.string().trim().toLowerCase().email().max(254);

const settingsSchema = z.object({
  currency: z.string(),
  fiscal_year_start_month: z.number(),
  sales_threshold: z.number(),
});

export function registerCompanyTools(
  server: McpServer,
  deps: { authDb: D1Database; settings: SettingsStore; tenant: TenantContext; confirmation: ConfirmationGate },
): void {
  const { authDb, settings, tenant, confirmation } = deps;

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "list_my_companies",
    {
      title: "List my companies",
      description:
        "List the companies the signed-in user belongs to, with their role in each, and which one this connection is using. " +
        "A connection always works in ONE company; to work in another, the user disconnects and reconnects the connector and picks that company.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        companies: z.array(z.object({ name: z.string(), role: z.string(), current: z.boolean() })),
      }),
      annotations: READ_ONLY,
    },
    async () => {
      const { results } = await authDb
        .prepare(
          `SELECT o.id AS id, o.name AS name, m.role AS role
           FROM member m JOIN organization o ON o.id = m.organizationId
           WHERE m.userId = ?
           ORDER BY o.name
           LIMIT 100`,
        )
        .bind(tenant.userId)
        .all<{ id: string; name: string; role: string }>();
      const companies = results.map((c) => ({
        name: c.name,
        role: c.role.includes("admin") || c.role.includes("owner") ? "admin" : "member",
        current: c.id === tenant.orgId,
      }));
      const text =
        companies.map((c) => `- ${c.name} (${c.role})${c.current ? " ← this connection" : ""}`).join("\n") +
        "\n\nTo work in a different company, disconnect this connector and connect again, then choose the company. " +
        "No tool can switch the company of an existing connection.";
      return { content: [{ type: "text", text }], structuredContent: { companies } };
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "get_company_settings",
    {
      title: "Get company settings",
      description:
        "Show the company's settings: its currency, the month its fiscal year starts, and the sales threshold used to flag big groups in sales summaries.",
      inputSchema: z.object({}),
      outputSchema: settingsSchema.extend({ source: z.enum(["cache", "database", "defaults"]) }),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const { settings: s, source } = await settings.get(tenant);
        const text =
          `Currency: ${s.currency}. Fiscal year starts in month ${s.fiscal_year_start_month}. ` +
          `Sales threshold: ${s.sales_threshold} ${s.currency}.` +
          (source === "defaults" ? " (These are the defaults; an admin can change them.)" : "");
        return { content: [{ type: "text", text }], structuredContent: { ...s, source } };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "update_company_settings",
    {
      title: "Update company settings",
      description:
        "Change one or more of the company's settings (admins only). Give only the fields to change. " +
        "Confirm the new values with the user first.",
      inputSchema: z.object({
        currency: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{3}$/, "Use a three-letter ISO currency code, e.g. USD, EUR, PKR.")
          .optional()
          .describe("Three-letter ISO currency code, e.g. USD."),
        fiscal_year_start_month: z.number().int().min(1).max(12).optional().describe("1 = January … 12 = December."),
        sales_threshold: z
          .number()
          .min(0)
          .max(1_000_000_000)
          .optional()
          .describe("Revenue at or above which a group is flagged in sales summaries."),
      }),
      outputSchema: settingsSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (patch) => {
      if (tenant.role !== "admin") return forbidden("change company settings");
      if (Object.values(patch).every((v) => v === undefined)) {
        return toolError("Nothing to change: give at least one of currency, fiscal_year_start_month or sales_threshold.");
      }
      try {
        const saved = await settings.update(tenant, patch);
        const text = `Saved. Currency ${saved.currency}, fiscal year starts in month ${saved.fiscal_year_start_month}, sales threshold ${saved.sales_threshold}.`;
        return { content: [{ type: "text", text }], structuredContent: saved };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "invite_member",
    {
      title: "Add a member to the company",
      description:
        "Add a person who already has an account to this company, as a member or an admin (admins only). " +
        "If they have no account yet, they must create one by connecting once; then call this again. " +
        "Confirm the email and role with the user first.",
      inputSchema: z.object({
        email: email.describe("The person's account email."),
        role: z.enum(["member", "admin"]).default("member").describe("Their role in this company. Defaults to member."),
      }),
      outputSchema: z.object({ email: z.string(), role: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ email, role }) => {
      if (tenant.role !== "admin") return forbidden("add members");
      const user = await authDb.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>();
      if (!user) {
        return toolError(
          `There's no account for ${email}. Ask them to create one (by connecting to this server once), then add them again.`,
        );
      }
      const existing = await authDb
        .prepare(`SELECT role FROM member WHERE organizationId = ? AND userId = ?`)
        .bind(tenant.orgId, user.id)
        .first<{ role: string }>();
      if (existing) return toolError(`${email} is already in this company (role: ${existing.role}).`);

      // A direct insert rather than Better Auth's invitation flow: that flow needs the
      // invitee's own browser session and an email sender, which a tool call doesn't have.
      await authDb
        .prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), tenant.orgId, user.id, role, new Date().toISOString())
        .run();
      const text = `Added ${email} to this company as ${role}. They'll see it when they next connect and choose this company.`;
      return { content: [{ type: "text", text }], structuredContent: { email, role } };
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "remove_member",
    {
      title: "Remove a member from the company",
      description:
        "Remove a person from this company (admins only). They lose access on their very next request, even with a token they already have. " +
        "You can't remove yourself or the last admin. This is irreversible: call once to get the confirmation form, or a sealed token if the client can't show a form, then only continue after the user explicitly confirms.",
      inputSchema: z.object({
        email: email.describe("The email of the person to remove."),
        confirmationToken: z
          .string()
          .max(2000)
          .optional()
          .describe("Only for clients without elicitation: send back the sealed token from the first call."),
      }),
      outputSchema: z.object({ email: z.string(), removed: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, ctx) => {
      const { email } = args;
      if (tenant.role !== "admin") return forbidden("remove members");
      const approved = await confirmation.require(
        ctx,
        "remove_member",
        args,
        "REMOVE",
        `Permanently remove ${email} from this company?`,
      );
      if (!approved.ok) return approved.result;
      const target = await authDb
        .prepare(
          `SELECT m.id AS memberId, m.userId AS userId, m.role AS role
           FROM member m JOIN "user" u ON u.id = m.userId
           WHERE m.organizationId = ? AND u.email = ?`,
        )
        .bind(tenant.orgId, email)
        .first<{ memberId: string; userId: string; role: string }>();
      // The same answer whether there's no such account or they're just not in this company.
      if (!target) return toolError(`${email} isn't a member of this company.`);
      if (target.userId === tenant.userId) return toolError("You can't remove yourself. Ask another admin to do it.");

      const isAdmin = /admin|owner/.test(target.role);
      if (isAdmin) {
        const admins = await authDb
          .prepare(`SELECT count(*) AS n FROM member WHERE organizationId = ? AND (role LIKE '%admin%' OR role LIKE '%owner%')`)
          .bind(tenant.orgId)
          .first<{ n: number }>();
        if ((admins?.n ?? 0) <= 1) return toolError("That's the company's last admin. Make someone else an admin first.");
      }
      await authDb.prepare(`DELETE FROM member WHERE id = ?`).bind(target.memberId).run();
      const text = `Removed ${email} from this company. Their next request will be refused.`;
      return { content: [{ type: "text", text }], structuredContent: { email, removed: true } };
    },
  );
}
