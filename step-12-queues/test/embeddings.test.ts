import { describe, expect, it } from "vitest";
import { DIMENSIONS, checkVectors, cosineSimilarity, testEmbedder } from "../src/embeddings";
import { splitDocument } from "../src/passages";
import { POLICY_THRESHOLD } from "../src/retrieval-config";
import baseline from "../evals/baseline.json";
import questions from "../evals/retrieval.json";
import { type EvalQuestion, runEval } from "../evals/run-eval";
import { POLICY_SETS } from "./policies";

// No database and no network: the test embedder is deterministic.

describe("embeddings", () => {
  it("the test embedder gives the same 1,024 numbers every time", async () => {
    const [a, b] = await testEmbedder().embed(["Opened items may be returned", "Opened items may be returned"]);
    expect(a).toHaveLength(DIMENSIONS);
    expect(a).toEqual(b);
    expect(cosineSimilarity(a!, b!)).toBeCloseTo(1, 6);
  });

  it("fails loudly on vectors of the wrong size", () => {
    expect(() => checkVectors([[1, 2, 3]], 1)).toThrow(/expected 1024/);
    expect(() => checkVectors([], 1)).toThrow(/Expected 1 embeddings/);
  });
});

describe("splitting documents into passages", () => {
  it("makes one passage per numbered rule, with its line number", () => {
    const { title, passages } = splitDocument("# Returns\n\n1. First rule.\n2) Second rule.\nNot a rule.\n\n3. Third.");
    expect(title).toBe("Returns");
    expect(passages).toEqual([
      { line: 3, content: "First rule." },
      { line: 4, content: "Second rule." },
      { line: 7, content: "Third." },
    ]);
  });
});

describe("retrieval question set (CI, test embedder)", () => {
  it("does at least as well as the recorded baseline", async () => {
    const report = await runEval(
      POLICY_SETS,
      questions.questions as EvalQuestion[],
      testEmbedder(),
      POLICY_THRESHOLD["test-hash-v1"]!,
    );
    const floor = baseline["test-hash-v1"];
    expect(report.foundInTop3).toBeGreaterThanOrEqual(floor.foundInTop3);
    expect(report.correctAbstentions).toBeGreaterThanOrEqual(floor.correctAbstentions);
  });
});
