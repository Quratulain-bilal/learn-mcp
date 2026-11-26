import type { SqlClient, SqlQuery } from "./db-client";
import { forTenant } from "./tenant";
import { vectorLiteral } from "./embeddings";

export interface PolicyPassage {
  documentId: string;
  title: string;
  line: number;
  content: string;
  similarity: number;
}

export interface ProductHit {
  productId: string;
  name: string;
  description: string;
  similarity: number;
}

interface PassageRow {
  document_id: string;
  title: string;
  line: number | string;
  content: string;
  similarity: number | string;
}

interface ProductRow {
  product_id: string;
  name: string;
  description: string;
  similarity: number | string;
}

export interface SplitRule {
  line: number;
  content: string;
}

export function splitPolicyDocument(document: string): SplitRule[] {
  const lines = document.split(/\r?\n/);
  const numbered = lines
    .map((raw, index) => {
      const trimmed = raw.trim();
      const match = trimmed.match(/^(?:\d+[.)]|[-*])\s+(.+)$/);
      if (!match) return null;
      return { line: index + 1, content: match[1]!.trim() };
    })
    .filter((rule): rule is SplitRule => rule !== null);
  if (numbered.length > 0) return numbered;
  return lines
    .map((raw, index) => ({ line: index + 1, content: raw.trim() }))
    .filter((rule) => rule.content.length > 0);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! * left[index]!;
    rightMagnitude += right[index]! * right[index]!;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function policySearchResult(passages: readonly PolicyPassage[], threshold: number) {
  if (passages.length === 0 || passages[0]!.similarity < threshold) {
    return {
      abstained: true,
      message:
        "The sales policies do not cover this question. Say the policies do not cover it and ask a manager.",
      threshold,
      passages: [],
    };
  }
  return {
    abstained: false,
    message: `Found ${passages.length} cited passage(s).`,
    threshold,
    passages,
  };
}

export async function searchPolicies(
  sql: SqlClient,
  orgId: string,
  embedding: readonly number[],
  limit = 3,
): Promise<PolicyPassage[]> {
  const [rows] = await forTenant(sql, orgId, (txn) => [
    txn.query<PassageRow>(
      `SELECT pp.document_id, pd.title, pp.line, pp.content,
              1 - (pp.embedding <=> $2::vector) AS similarity
       FROM public.policy_passages pp
       JOIN public.policy_documents pd
         ON pd.org_id = pp.org_id AND pd.document_id = pp.document_id
       WHERE pp.org_id = $1
       ORDER BY pp.embedding <=> $2::vector
       LIMIT $3`,
      [orgId, vectorLiteral(embedding), limit],
    ) as SqlQuery<PassageRow>,
  ]);
  return rows.map((row) => ({
    documentId: row.document_id,
    title: row.title,
    line: Number(row.line),
    content: row.content,
    similarity: Number(row.similarity),
  }));
}

export async function searchProducts(
  sql: SqlClient,
  orgId: string,
  embedding: readonly number[],
  limit = 3,
): Promise<ProductHit[]> {
  const [rows] = await forTenant(sql, orgId, (txn) => [
    txn.query<ProductRow>(
      `SELECT product_id, name, description,
              1 - (description_embedding <=> $2::vector) AS similarity
       FROM public.products
       WHERE org_id = $1 AND description_embedding IS NOT NULL
       ORDER BY description_embedding <=> $2::vector
       LIMIT $3`,
      [orgId, vectorLiteral(embedding), limit],
    ) as SqlQuery<ProductRow>,
  ]);
  return rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
    description: row.description,
    similarity: Number(row.similarity),
  }));
}

export async function replacePolicyDocument(
  sql: SqlClient,
  orgId: string,
  documentId: string,
  title: string,
  rules: readonly SplitRule[],
  embeddings: readonly number[][],
): Promise<number> {
  await forTenant(sql, orgId, (txn) => {
    const queries: SqlQuery<Record<string, unknown>>[] = [
      txn.query("DELETE FROM public.policy_passages WHERE org_id = $1 AND document_id = $2", [
        orgId,
        documentId,
      ]) as SqlQuery<Record<string, unknown>>,
      txn.query(
        `INSERT INTO public.policy_documents (org_id, document_id, title, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (org_id, document_id) DO UPDATE SET title = excluded.title, updated_at = now()`,
        [orgId, documentId, title],
      ) as SqlQuery<Record<string, unknown>>,
    ];
    for (let index = 0; index < rules.length; index += 1) {
      queries.push(
        txn.query(
          `INSERT INTO public.policy_passages (org_id, document_id, line, content, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [
            orgId,
            documentId,
            rules[index]!.line,
            rules[index]!.content,
            vectorLiteral(embeddings[index]!),
          ],
        ) as SqlQuery<Record<string, unknown>>,
      );
    }
    return queries;
  });
  return rules.length;
}
