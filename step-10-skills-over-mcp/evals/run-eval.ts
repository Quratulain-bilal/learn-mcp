import { type Embedder, cosineSimilarity } from "../src/embeddings";
import { passageText, splitDocument } from "../src/passages";
import { TOP_K } from "../src/retrieval-config";

/**
 * The retrieval eval, shared by `npm run eval:retrieval` (Node, real model or test
 * embedder) and tests/retrieval.test.ts (Workers runtime, test embedder, in CI).
 *
 * It does what search_sales_policy does (top 3 by cosine similarity, drop anything below
 * the threshold), but in memory over the policy files, so it needs no database and
 * measures only the retrieval choices: one passage per rule, the model, the threshold.
 */

export type Expect = { document: string; line: number } | "abstain";
export interface EvalQuestion {
  company: string;
  question: string;
  expect: Expect;
}
/** company -> document id -> Markdown text */
export type PolicySets = Record<string, Record<string, string>>;

export interface QuestionResult {
  company: string;
  question: string;
  expect: Expect;
  returned: { document: string; line: number; similarity: number }[];
  topSimilarity: number;
  pass: boolean;
}

export interface EvalReport {
  embedder: string;
  threshold: number;
  /** Share of answerable questions whose expected passage is in the top 3 (and not abstained). */
  foundInTop3: number;
  /** Share of unanswerable questions where the search abstained. */
  correctAbstentions: number;
  results: QuestionResult[];
}

export async function runEval(
  sets: PolicySets,
  questions: EvalQuestion[],
  embedder: Embedder,
  threshold: number,
): Promise<EvalReport> {
  // Embed every passage of every company, the same way npm run embed stores them.
  const index: Record<string, { document: string; line: number; vector: number[] }[]> = {};
  for (const [company, documents] of Object.entries(sets)) {
    const items: { document: string; line: number; text: string }[] = [];
    for (const [document, text] of Object.entries(documents)) {
      const { title, passages } = splitDocument(text);
      for (const p of passages) items.push({ document, line: p.line, text: passageText(title ?? document, p.content) });
    }
    const vectors = await embedder.embed(items.map((i) => i.text));
    index[company] = items.map((i, n) => ({ document: i.document, line: i.line, vector: vectors[n]! }));
  }

  const questionVectors = await embedder.embed(questions.map((q) => q.question));
  const results = questions.map((q, n): QuestionResult => {
    const ranked = (index[q.company] ?? [])
      .map((p) => ({ document: p.document, line: p.line, similarity: cosineSimilarity(questionVectors[n]!, p.vector) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, TOP_K);
    const returned = ranked.filter((r) => r.similarity >= threshold);
    const pass =
      q.expect === "abstain"
        ? returned.length === 0
        : returned.some((r) => r.document === (q.expect as { document: string }).document && r.line === (q.expect as { line: number }).line);
    return { ...q, returned, topSimilarity: ranked[0]?.similarity ?? 0, pass };
  });

  const answerable = results.filter((r) => r.expect !== "abstain");
  const unanswerable = results.filter((r) => r.expect === "abstain");
  const share = (rs: QuestionResult[]) => (rs.length ? rs.filter((r) => r.pass).length / rs.length : 1);
  return {
    embedder: embedder.name,
    threshold,
    foundInTop3: share(answerable),
    correctAbstentions: share(unanswerable),
    results,
  };
}
