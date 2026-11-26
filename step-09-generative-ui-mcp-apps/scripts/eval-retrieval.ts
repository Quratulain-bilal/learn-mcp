/**
 * Measures retrieval with the fixed question set in evals/retrieval.json.
 *
 *   npm run eval:retrieval                          # bge-m3 on Workers AI (the real model)
 *   npm run eval:retrieval -- --embedder test       # the test embedder (what CI runs)
 *   npm run eval:retrieval -- --sweep               # try thresholds from 0.20 to 0.70
 *   npm run eval:retrieval -- --update-baseline     # record today's numbers as the floor
 *
 * Exits with an error if found-in-top-3 or correct abstentions drop below the baseline in
 * evals/baseline.json, so a change that makes retrieval worse fails the build.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POLICY_THRESHOLD, thresholdFor } from "../src/retrieval-config";
import { type EvalQuestion, type PolicySets, runEval } from "../evals/run-eval";
import { scriptEmbedder } from "./embedder";

const root = join(import.meta.dirname, "..");
const pct = (x: number) => `${Math.round(x * 100)}%`;

function loadPolicySets(): PolicySets {
  const sets: PolicySets = {};
  for (const company of readdirSync(join(root, "policies"))) {
    sets[company] = {};
    for (const file of readdirSync(join(root, "policies", company)).filter((f) => f.endsWith(".md"))) {
      sets[company]![file.replace(/\.md$/, "")] = readFileSync(join(root, "policies", company, file), "utf8");
    }
  }
  return sets;
}

async function main() {
  const { questions } = JSON.parse(readFileSync(join(root, "evals", "retrieval.json"), "utf8")) as {
    questions: EvalQuestion[];
  };
  const baselinePath = join(root, "evals", "baseline.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<
    string,
    { threshold: number; foundInTop3: number; correctAbstentions: number }
  >;
  const sets = loadPolicySets();
  const { embedder, close } = await scriptEmbedder();
  try {
    if (process.argv.includes("--sweep")) {
      console.log(`Threshold sweep for ${embedder.name}:`);
      for (let t = 0.2; t <= 0.701; t += 0.05) {
        const r = await runEval(sets, questions, embedder, t);
        console.log(`  ${t.toFixed(2)}  found in top 3: ${pct(r.foundInTop3).padStart(4)}  correct abstentions: ${pct(r.correctAbstentions)}`);
      }
      return;
    }

    const threshold = thresholdFor(POLICY_THRESHOLD, embedder.name);
    const report = await runEval(sets, questions, embedder, threshold);
    for (const r of report.results) {
      const want = r.expect === "abstain" ? "abstain" : `${r.expect.document}:${r.expect.line}`;
      const got = r.returned.length ? r.returned.map((p) => `${p.document}:${p.line} (${p.similarity.toFixed(3)})`).join(", ") : `abstained (top ${r.topSimilarity.toFixed(3)})`;
      console.log(`${r.pass ? "PASS" : "FAIL"}  [${r.company}] ${r.question}\n      want ${want}; got ${got}`);
    }
    console.log(
      `\n${embedder.name}, threshold ${threshold}: found in top 3 ${pct(report.foundInTop3)}, correct abstentions ${pct(report.correctAbstentions)}`,
    );

    if (process.argv.includes("--update-baseline")) {
      baseline[embedder.name] = {
        threshold,
        foundInTop3: report.foundInTop3,
        correctAbstentions: report.correctAbstentions,
      };
      writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      console.log("Baseline updated.");
      return;
    }
    const floor = baseline[embedder.name];
    if (!floor) throw new Error(`No baseline for ${embedder.name}. Run with --update-baseline once.`);
    if (report.foundInTop3 < floor.foundInTop3 || report.correctAbstentions < floor.correctAbstentions) {
      console.error(
        `Retrieval got WORSE than the baseline (found in top 3 ${pct(floor.foundInTop3)}, correct abstentions ${pct(floor.correctAbstentions)}).`,
      );
      process.exitCode = 1;
    } else {
      console.log("At or above the baseline.");
    }
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
