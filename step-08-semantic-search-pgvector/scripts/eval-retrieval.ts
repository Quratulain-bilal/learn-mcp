import { readFile } from "node:fs/promises";
import path from "node:path";

async function localVar(name: string): Promise<string | undefined> {
  try {
    const localVars = await readFile(path.join(process.cwd(), ".dev.vars"), "utf8");
    const line = localVars
      .split(/\r?\n/)
      .find((entry) => entry.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  } catch {
    return undefined;
  }
}

interface EvalQuestion {
  question: string;
  expect: "abstain" | { documentId: string; line: number };
}

interface EvalGroup {
  org: string;
  questions: EvalQuestion[];
}

interface EvalResponse {
  abstained: boolean;
  passages: { documentId: string; line: number; similarity: number }[];
}

const groups = JSON.parse(await readFile(path.join(process.cwd(), "evals", "retrieval.json"), "utf8")) as EvalGroup[];
const base = process.env.EVAL_URL ?? (await localVar("EVAL_URL")) ?? (await localVar("EMBED_URL"));
const token = process.env.MIGRATION_TOKEN ?? (await localVar("MIGRATION_TOKEN"));
const mode = process.env.EMBEDDING_MODE ?? (await localVar("EMBEDDING_MODE")) ?? "test";
if (!base || !token) throw new Error("Set EVAL_URL and MIGRATION_TOKEN.");

let total = 0;
let correct = 0;
let abstentions = 0;
let correctAbstentions = 0;

for (const group of groups) {
  const orgId =
    group.org === "enterprise"
      ? process.env.ENTERPRISE_ORG_ID ?? (await localVar("ENTERPRISE_ORG_ID"))
      : process.env.SHARED_ORG_ID ?? (await localVar("SHARED_ORG_ID"));
  if (!orgId) {
    console.log(`skip ${group.org}: no org id`);
    continue;
  }

  for (const item of group.questions) {
    const response = await fetch(`${base.replace(/\/$/, "")}/api/retrieval-eval`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ orgId, question: item.question, mode }),
    });
    if (!response.ok) throw new Error(`Eval request failed: ${response.status} ${await response.text()}`);
    const result = (await response.json()) as EvalResponse;
    total += 1;

    if (item.expect === "abstain") {
      abstentions += 1;
      if (result.abstained) correctAbstentions += 1;
      console.log(`${group.org} abstain ${result.abstained ? "PASS" : "FAIL"}: ${item.question}`);
      continue;
    }

    const found = result.passages.slice(0, 3).some(
      (passage) =>
        passage.documentId === item.expect.documentId && passage.line === item.expect.line,
    );
    if (found && !result.abstained) correct += 1;
    console.log(
      `${group.org} top3 ${found && !result.abstained ? "PASS" : "FAIL"}: ${item.question} ` +
        `expected ${item.expect.documentId}:${item.expect.line}, got ${result.passages.map((passage) => `${passage.documentId}:${passage.line}`).join(", ") || "abstain"}`,
    );
  }
}

console.log(
  `found-in-top-three ${correct}/${total - abstentions}; correct abstentions ${correctAbstentions}/${abstentions}; mode ${mode}`,
);
if (correct < total - abstentions || correctAbstentions < abstentions) process.exitCode = 1;
