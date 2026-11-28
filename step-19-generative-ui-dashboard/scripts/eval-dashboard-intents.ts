import { readFileSync, writeFileSync } from "node:fs";
import { dashboardIntentErrors, type DashboardIntentSet } from "../evals/dashboard-evals";

const source = new URL("../evals/dashboard-intents.json", import.meta.url);
const target = new URL("../evals/dashboard-runbook.md", import.meta.url);

let data: unknown;
try {
  data = JSON.parse(readFileSync(source, "utf8"));
} catch (error) {
  console.error(`Could not read ${source.pathname}:`, error);
  process.exit(1);
}

const errors = dashboardIntentErrors(data);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const intents = data as DashboardIntentSet;
const screen = (widget: string, blocks: string[]) => {
  if (widget === "none") return "text only";
  return blocks.length > 0 ? `${widget} (${blocks.join(", ")})` : widget;
};
const rows = intents.prompts.map(
  (p) =>
    `| ${p.id} | ${p.prompt.replaceAll("|", "\\|")} | \`${p.tool}\` | \`${screen(p.widget, p.blocks)}\` |  |  |  |`,
);

const markdown = [
  "# Dashboard intent runbook",
  "",
  "Use a fresh conversation in each client for every prompt. Paste the prompt once, record `yes` or `no` for the tool and the screen, and save a screenshot for at least two different intents producing two different widgets in both Claude and ChatGPT.",
  "",
  "The expected screen is the widget URI key from `src/widgets/resources.ts`. `text only` means the tool has no MCP Apps widget and must still return a useful text answer.",
  "",
  "| # | Prompt | Expected tool | Expected screen | claude.ai | Claude Desktop | ChatGPT |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows,
  "",
  "## Notes",
  "",
  "- Tool choice: did the client call the expected tool without being told its name?",
  "- Screen choice: for `show_dashboard`, did it choose blocks that answer the question?",
  "- Tenant scope: did every number come from the connected company only?",
  "- Fallback: in a client without MCP Apps, did the tool return readable text?",
  "",
].join("\n");

writeFileSync(target, markdown);
console.log(`Wrote ${target.pathname} with ${intents.prompts.length} prompts.`);
