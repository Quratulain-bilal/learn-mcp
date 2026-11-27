import { testEmbedder, toPgVector } from "../src/embeddings";
import { passageText, splitDocument } from "../src/passages";
import { asOwner } from "./helpers";

/**
 * The policy files, bundled into the tests by Vite (the Workers runtime can't read files).
 * Keys look like "../policies/harbor/discounts.md".
 */
const files = import.meta.glob("../policies/*/*.md", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

/** company set -> document id -> text, for the eval and for planting. */
export const POLICY_SETS: Record<string, Record<string, string>> = {};
for (const [path, text] of Object.entries(files)) {
  const [, set, file] = path.match(/policies\/([^/]+)\/([^/]+)\.md$/)!;
  (POLICY_SETS[set!] ??= {})[file!] = text;
}

/** Loads one policy set into a company, embedded with the TEST embedder, as the owner. */
export async function plantPolicies(orgId: string, set: string, binding = "HYPERDRIVE"): Promise<void> {
  const embedder = testEmbedder();
  for (const [documentId, text] of Object.entries(POLICY_SETS[set]!)) {
    const { title, passages } = splitDocument(text);
    const vectors = await embedder.embed(passages.map((p) => passageText(title!, p.content)));
    await asOwner(
      `INSERT INTO policy_documents (org_id, document_id, title, updated_by) VALUES ($1, $2, $3, 'test')`,
      [orgId, documentId, title],
      binding,
    );
    await asOwner(
      `INSERT INTO policy_passages (org_id, document_id, line, content, embedding, embedder)
       SELECT $1, $2, x.line, x.content, x.embedding::vector, $6
       FROM unnest($3::int[], $4::text[], $5::text[]) AS x(line, content, embedding)`,
      [orgId, documentId, passages.map((p) => p.line), passages.map((p) => p.content), vectors.map(toPgVector), embedder.name],
      binding,
    );
  }
}

/** Gives a planted company's product a description embedded with the test embedder. */
export async function describeProduct(orgId: string, description: string, binding = "HYPERDRIVE"): Promise<void> {
  const [vector] = await testEmbedder().embed([description]);
  await asOwner(
    `UPDATE products SET description = $2, description_embedding = $3::vector, description_embedder = $4 WHERE org_id = $1`,
    [orgId, description, toPgVector(vector!), testEmbedder().name],
    binding,
  );
}
