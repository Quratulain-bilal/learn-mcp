import type { McpServer } from "@modelcontextprotocol/server";
import { SkillCatalog, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";
import type { ForTenant } from "../db";
import type { TenantContext } from "../tenant";
import { companyPlaybookSkillFiles, readCompanyPlaybook } from "../company-playbook";
import { SKILL_FILES } from "./generated";

export async function registerSkills(server: McpServer, forTenant: ForTenant, tenant: TenantContext): Promise<void> {
  const playbook = await readCompanyPlaybook(forTenant, tenant.orgId);
  const catalog = await SkillCatalog.load(
    memorySkillFiles({ ...SKILL_FILES, ...companyPlaybookSkillFiles(playbook) }),
    {
      prefix: "learn-mcp",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
      strict: true,
    },
  );
  catalog.attach(server);

  server.registerPrompt(
    "monthly_sales_review",
    {
      title: "Monthly sales review",
      description:
        "Prepare a review of one month's sales: numbers, charts, comparison with the month before and recommendations. " +
        "(The same playbook as the monthly-sales-review skill, for apps that don't load skills from servers yet.)",
      argsSchema: z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/, "Use YYYY-MM, e.g. 2025-11.")
          .optional()
          .describe("The month to review, as YYYY-MM. Leave empty for last month."),
      }),
    },
    async ({ month }) => {
      const references = Object.entries(SKILL_FILES)
        .filter(([path]) => path.startsWith("monthly-sales-review/references/"))
        .map(([path, text]) => `\n\n---\n(${path.replace("monthly-sales-review/", "")})\n\n${text.trim()}`)
        .join("");
      return {
        description: "Monthly sales review",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Prepare the monthly sales review for ${month ?? "last month"}. Follow this playbook exactly:\n\n` +
                body(SKILL_FILES["monthly-sales-review/SKILL.md"]!) +
                references,
            },
          },
        ],
      };
    },
  );
}

/** Removes the frontmatter block, leaving the instructions. */
const body = (markdown: string) => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
