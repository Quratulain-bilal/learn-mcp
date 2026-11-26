import { readFile } from "node:fs/promises";
import path from "node:path";
import { deterministicEmbedding, vectorLiteral } from "../src/embeddings";
import { createPgClient } from "../src/db-client";
import { forTenant } from "../src/tenant";
import { replacePolicyDocument, splitPolicyDocument } from "../src/retrieval";

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

async function embedTexts(texts: readonly string[], mode: string): Promise<number[][]> {
  if (mode === "test") return texts.map(deterministicEmbedding);
  const base = process.env.EMBED_URL ?? (await localVar("EMBED_URL"));
  const token = process.env.MIGRATION_TOKEN ?? (await localVar("MIGRATION_TOKEN"));
  if (!base || !token) throw new Error("Set EMBED_URL and MIGRATION_TOKEN, or use EMBEDDING_MODE=test.");
  const response = await fetch(`${base.replace(/\/$/, "")}/api/embed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ texts, mode }),
  });
  if (!response.ok) throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as { vectors?: number[][] };
  if (!data.vectors || data.vectors.length !== texts.length) {
    throw new Error(`Expected ${texts.length} vector(s) from the embedding endpoint.`);
  }
  return data.vectors;
}

interface PolicyGroup {
  org: string;
  documents: { documentId: string; title: string; content: string }[];
}

const groups = JSON.parse(await readFile(path.join(process.cwd(), "data", "policies.json"), "utf8")) as PolicyGroup[];
const mode = process.env.EMBEDDING_MODE ?? (await localVar("EMBEDDING_MODE")) ?? "ai";

for (const group of groups) {
  const orgId =
    group.org === "enterprise"
      ? process.env.ENTERPRISE_ORG_ID ?? (await localVar("ENTERPRISE_ORG_ID"))
      : process.env.SHARED_ORG_ID ?? (await localVar("SHARED_ORG_ID"));
  const url =
    group.org === "enterprise"
      ? process.env.ENTERPRISE_NEON_DATABASE_URL ?? (await localVar("ENTERPRISE_NEON_DATABASE_URL"))
      : process.env.NEON_DATABASE_URL ?? (await localVar("NEON_DATABASE_URL"));
  if (!orgId || !url) {
    console.log(`skip ${group.org}: no org id or database URL`);
    continue;
  }

  const client = createPgClient(url);
  try {
    for (const document of group.documents) {
      const rules = splitPolicyDocument(document.content);
      if (rules.length === 0 || rules.length > 50) {
        throw new Error(`${document.documentId} must split into 1 to 50 rules.`);
      }
      const vectors = await embedTexts(rules.map((rule) => rule.content), mode);
      await replacePolicyDocument(client, orgId, document.documentId, document.title, rules, vectors);
      console.log(`${group.org}: embedded ${document.documentId} (${rules.length} passage(s)) using ${mode}`);
    }

    const products = await client.query<{
      product_id: string;
      name: string;
      description: string | null;
      category_name: string;
    }>(
      `SELECT p.product_id, p.name, p.description, c.name AS category_name
       FROM public.products p
       JOIN public.categories c ON c.org_id = p.org_id AND c.category_id = p.category_id
       WHERE p.org_id = $1`,
      [orgId],
    );
    if (products.length > 0) {
      const texts = products.map(
        (product) => product.description ?? `${product.name} in the ${product.category_name} category`,
      );
      const vectors = await embedTexts(texts, mode);
      await forTenant(client, orgId, (txn) =>
        products.map((product, index) =>
          txn.query(
            `UPDATE public.products
             SET description = COALESCE(description, $4), description_embedding = $3::vector
             WHERE org_id = $1 AND product_id = $2`,
            [orgId, product.product_id, vectorLiteral(vectors[index]!), texts[index]!],
          ),
        ),
      );
      console.log(`${group.org}: embedded ${products.length} product description(s) using ${mode}`);
    }
  } finally {
    await client.end();
  }
}
