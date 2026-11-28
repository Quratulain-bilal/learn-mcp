import type { McpServer } from "@modelcontextprotocol/server";
import { SkillCatalog, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";
import { SKILL_FILES } from "./generated";

/**
 * SKILLS OVER MCP (extension io.modelcontextprotocol/skills): the server ships know-how
 * with its tools. A skill is a folder with a SKILL.md (frontmatter: name, description)
 * and optional reference files. Clients that support the extension discover skills with
 * skills/list, fetch one with skills/get, and read its files as skill:// resources,
 * loading the full text only when a task needs it (progressive disclosure).
 *
 * The SDK builds the catalog from the files (checking each SKILL.md and recording every
 * file's size and SHA-256 digest) and wires the methods onto a server with attach().
 *
 * The catalog is the same for every company and holds no company data: it's the
 * playbook, and the data still comes from the tools, scoped to the caller's company. It's
 * built once per isolate from files in the bundle, like the widget HTML: static content,
 * not request state.
 */
export const skills = await SkillCatalog.load(memorySkillFiles(SKILL_FILES), {
  // skill://learn-mcp/<skill>/SKILL.md
  prefix: "learn-mcp",
  // Skills only change when we deploy, so clients may cache them for an hour.
  cacheHint: { ttlMs: 60 * 60 * 1000, cacheScope: "public" },
  // A broken SKILL.md fails the build/tests instead of being served half-right.
  strict: true,
});

/** Removes the frontmatter block, leaving the instructions. */
const body = (markdown: string) => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();

/**
 * Serves the skills on this server, plus a FALLBACK for clients that don't support the
 * Skills extension yet (Claude, at the time of writing): the same playbook as an MCP
 * prompt the user can pick, with the reference files included.
 */
export function registerSkills(server: McpServer): void {
  skills.attach(server);

  server.registerPrompt(
    "monthly_sales_review",
    {
      title: "Monthly sales review",
      description:
        "Prepare a sales review: numbers, a show_dashboard widget, comparison with the previous equal-length period and " +
        "recommendations. Use for a month, quarter, year or 'how are we doing'. " +
        "(The same playbook as the monthly-sales-review skill, for apps that don't load skills from servers yet.)",
      argsSchema: z.object({
        month: z
          .string()
          .regex(/^\d{4}(-\d{2})?$/, "Use YYYY or YYYY-MM, e.g. 2026 or 2025-11.")
          .optional()
          .describe("The month (YYYY-MM) or year (YYYY) to review. Leave empty for last month."),
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
                `Prepare the sales review for ${month ?? "last month"}. Follow this playbook exactly:\n\n` +
                body(SKILL_FILES["monthly-sales-review/SKILL.md"]!) +
                references,
            },
          },
        ],
      };
    },
  );
}
