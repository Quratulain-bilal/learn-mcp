import { describe, expect, it } from "vitest";
import type { SqlClient } from "../src/db-client";
import { deterministicEmbedding, EMBEDDING_DIMENSIONS, vectorLiteral } from "../src/embeddings";
import {
  cosineSimilarity,
  policySearchResult,
  searchPolicies,
  splitPolicyDocument,
} from "../src/retrieval";

function fakeSql(
  calls: Array<{ text: string; params?: unknown[] }>,
  rows: Record<string, unknown>[] = [],
): SqlClient {
  const query = async <T>(text: string, params?: unknown[]) => {
    calls.push({ text, params });
    return rows as T[];
  };
  return {
    query,
    transaction: async (build) => {
      const pending = build(fakeSql(calls, rows));
      const results: unknown[][] = [];
      for (const promise of pending) results.push(await promise);
      return results;
    },
    end: async () => undefined,
  };
}

describe("retrieval primitives", () => {
  it("creates deterministic 1024-dimension embeddings", () => {
    const embedding = deterministicEmbedding("Repeat customers receive a discount");
    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vectorLiteral(embedding).startsWith("[")).toBe(true);
    expect(cosineSimilarity(embedding, deterministicEmbedding("Repeat customers receive a discount"))).toBeCloseTo(1);
    expect(cosineSimilarity(embedding, deterministicEmbedding("bicycle repair"))).toBeLessThan(0.5);
  });

  it("splits one numbered rule into one passage", () => {
    expect(
      splitPolicyDocument("1. First rule.\n2. Second rule.\nNot a rule."),
    ).toEqual([
      { line: 1, content: "First rule." },
      { line: 2, content: "Second rule." },
    ]);
  });

  it("abstains below the threshold and cites above it", () => {
    const passage = {
      documentId: "discount-policy",
      title: "Discount policy",
      line: 3,
      content: "The maximum approved discount is 10 percent.",
      similarity: 0.8,
    };
    expect(policySearchResult([passage], 0.35).abstained).toBe(false);
    expect(policySearchResult([{ ...passage, similarity: 0.2 }], 0.35).abstained).toBe(true);
    expect(policySearchResult([], 0.35).abstained).toBe(true);
  });

  it("sets the tenant before policy search and filters by org id", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client = fakeSql(calls, [
      {
        document_id: "discount-policy",
        title: "Discount policy",
        line: 3,
        content: "The maximum approved discount is 10 percent.",
        similarity: 0.81,
      },
    ]);
    const passages = await searchPolicies(client, "org-a", deterministicEmbedding("maximum discount"));
    expect(calls[0].text).toBe("SELECT set_config('app.tenant_id', $1, true)");
    expect(calls[0].params).toEqual(["org-a"]);
    expect(calls[1].text).toContain("pp.org_id = $1");
    expect(calls[1].params?.[0]).toBe("org-a");
    expect(passages[0]?.documentId).toBe("discount-policy");
    expect(passages[0]?.line).toBe(3);
  });
});
