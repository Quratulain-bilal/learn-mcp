import { BGE_M3, TEST_EMBEDDER } from "./embeddings";

/**
 * The THRESHOLD: the lowest similarity a passage may have and still be returned. Below
 * it the search ABSTAINS: it says nothing is close enough, instead of handing the model
 * the closest wrong rule to answer from.
 *
 * Each model spreads its similarities differently, so each has its own threshold, chosen
 * with the retrieval question set (npm run eval:retrieval). See NOTES.md for the numbers.
 */
export const POLICY_THRESHOLD: Record<string, number> = {
  [BGE_M3]: 0.52,
  [TEST_EMBEDDER]: 0.2,
};

/** Product searches: tuned on real needs (0.62-0.75) vs things the catalog lacks (0.45-0.57). See NOTES.md. */
export const PRODUCT_THRESHOLD: Record<string, number> = {
  [BGE_M3]: 0.6,
  [TEST_EMBEDDER]: 0.2,
};

/** How many passages a search returns at most. */
export const TOP_K = 3;

export function thresholdFor(table: Record<string, number>, embedder: string): number {
  const t = table[embedder];
  if (t === undefined) throw new Error(`No threshold set for embedder ${embedder}.`);
  return t;
}
