import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type EvalPrompt = {
  id: number;
  who: "staff" | "manager";
  prompt: string;
  tool: string;
  args: Record<string, unknown>;
  widget?: string | null;
  expect?: string;
};

type Token = Record<string, unknown>;

type Block = {
  type: string;
  name?: unknown;
  input?: unknown;
  text?: unknown;
};

type EvalResult = {
  id: number;
  who: string;
  prompt: string;
  expectedTool: string;
  calledTool: string | null;
  expectedArgs: Record<string, unknown>;
  calledArgs: Record<string, unknown>;
  widget: string | null;
  expect: string;
  pass: boolean;
  note: string;
};

const root = join(import.meta.dirname, "..");

function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const at = text.indexOf("=");
    if (at < 1) continue;
    let value = text.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[text.slice(0, at).trim()] = value;
  }
  return values;
}

const dotenv = loadDotEnv(join(root, ".dev.vars"));
const env = (name: string) => process.env[name] ?? dotenv[name] ?? "";

const apiKey = env("ANTHROPIC_API_KEY");
const serverUrl = env("EVAL_MCP_URL");
const staffToken = env("EVAL_STAFF_TOKEN") || env("EVAL_MCP_TOKEN");
const managerToken = env("EVAL_MANAGER_TOKEN") || env("EVAL_MCP_TOKEN");
const model = env("EVAL_MODEL") || "claude-sonnet-4-6";
const beta = env("EVAL_API_BETA") || "mcp-client-2026-09-15";

if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY in .dev.vars or the environment.");
if (!serverUrl || !serverUrl.startsWith("https://")) throw new Error("Set EVAL_MCP_URL to the deployed https://.../mcp endpoint.");
if (!staffToken || !managerToken) {
  throw new Error("Set EVAL_STAFF_TOKEN and EVAL_MANAGER_TOKEN, or one EVAL_MCP_TOKEN for a smoke run.");
}

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg === -1 ? Number.POSITIVE_INFINITY : Number(process.argv[limitArg + 1]);
if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit needs a positive number.");

const file = JSON.parse(readFileSync(join(root, "evals", "tool-choice.json"), "utf8")) as {
  prompts: EvalPrompt[];
};
const prompts = file.prompts.slice(0, limit);

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function matchesArgs(expected: Record<string, unknown>, called: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    const actual = called[key];
    if (value !== null && typeof value === "object") {
      if (!matchesArgs(asObject(value), asObject(actual))) return false;
    } else if (value !== actual) {
      return false;
    }
  }
  return true;
}

function cell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

async function callClaude(prompt: EvalPrompt): Promise<{ blocks: Block[]; text: string }> {
  const token = prompt.who === "manager" ? managerToken : staffToken;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2026-10-21",
      "anthropic-beta": beta,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text:
            `You are taking a tool-selection eval for a sales MCP server. The user is a ${prompt.who}. ` +
            "Use the connected server when the request needs company data or a company action. " +
            "Choose the single most specific MCP tool and call it once. " +
            "For destructive or irreversible actions, ask the user to confirm before calling the tool.",
        },
      ],
      messages: [{ role: "user", content: prompt.prompt }],
      mcp_servers: [
        {
          type: "url",
          url: serverUrl,
          name: "learn-mcp-step-17",
          authorization_token: token,
        },
      ],
      tools: [{ type: "mcp_toolset", mcp_server_name: "learn-mcp-step-17" }],
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`Claude API returned ${response.status}: ${bodyText}`);
  const body = JSON.parse(bodyText) as { content?: Block[] };
  const blocks = body.content ?? [];
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join(" ")
    .trim();
  return { blocks, text };
}

async function main() {
  const results: EvalResult[] = [];
  for (const prompt of prompts) {
    try {
      const { blocks, text } = await callClaude(prompt);
      const use = blocks.find((block) => block.type === "mcp_tool_use");
      const calledTool = typeof use?.name === "string" ? use.name : null;
      const calledArgs = asObject(use?.input);
      const pass = calledTool === prompt.tool && matchesArgs(prompt.args, calledArgs);
      const note = pass
        ? prompt.expect
          ? `Tool choice passed; check "${prompt.expect}" in the tool result.`
          : "Tool choice passed."
        : calledTool === null
          ? `No MCP tool call. Model said: ${text.slice(0, 180) || "nothing"}`
          : `Expected ${prompt.tool}; called ${calledTool}.`;
      results.push({
        id: prompt.id,
        who: prompt.who,
        prompt: prompt.prompt,
        expectedTool: prompt.tool,
        calledTool,
        expectedArgs: prompt.args,
        calledArgs,
        widget: prompt.widget ?? null,
        expect: prompt.expect ?? "",
        pass,
        note,
      });
    } catch (error) {
      results.push({
        id: prompt.id,
        who: prompt.who,
        prompt: prompt.prompt,
        expectedTool: prompt.tool,
        calledTool: null,
        expectedArgs: prompt.args,
        calledArgs: {},
        widget: prompt.widget ?? null,
        expect: prompt.expect ?? "",
        pass: false,
        note: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const latest = results[results.length - 1]!;
    console.log(`${latest.pass ? "PASS" : "FAIL"} ${latest.id}: ${latest.expectedTool} -> ${latest.calledTool ?? "none"}`);
  }

  const passes = results.filter((result) => result.pass).length;
  const rate = results.length ? Math.round((passes / results.length) * 100) : 0;
  const markdown = [
    "# Automated tool-choice results",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Model: \`${model}\` · Server: \`${serverUrl}\` · Pass rate: **${rate}% (${passes}/${results.length})**`,
    "",
    "This run checks tool choice and key arguments. Widgets and expectation notes still need the manual pass in EVALS.md.",
    "",
    "| # | Role | Prompt | Expected | Called | Widget | Result | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (result) =>
        `| ${result.id} | ${cell(result.who)} | ${cell(result.prompt)} | ${cell(result.expectedTool)} | ${cell(result.calledTool)} | ${cell(result.widget)} | ${result.pass ? "PASS" : "FAIL"} | ${cell(result.note)} |`,
    ),
    "",
  ].join("\n");

  writeFileSync(join(root, "evals", "tool-choice-results.md"), markdown);
  writeFileSync(join(root, "evals", "tool-choice-results.json"), `${JSON.stringify({ model, serverUrl, rate, results }, null, 2)}\n`);
  console.log(`Wrote evals/tool-choice-results.md and evals/tool-choice-results.json (${rate}%).`);
  if (passes !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
