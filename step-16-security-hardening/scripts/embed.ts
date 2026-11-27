/**
 * Splits the policy documents into passages, embeds them, and loads them for a company.
 * Also embeds product descriptions that don't have a vector from this model yet.
 *
 *   npm run embed                                    # the two sample companies (bge-m3)
 *   npm run embed -- --org <your id> --set harbor    # load the Harbor policies into YOUR company
 *   npm run embed -- --database TENANT_DB_ENTERPRISE --org <id> --set summit   # a dedicated company
 *   npm run embed -- --embedder test                 # test embedder (no network)
 *
 * Runs as the OWNER role (which bypasses row-level security), so it names the company
 * explicitly on every row. Re-running replaces each document's passages.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { toPgVector } from "../src/embeddings";
import { passageText, splitDocument } from "../src/passages";
import { scriptEmbedder } from "./embedder";
import { ownerUrlFor } from "./env";

/** The sample companies and the policy set each one gets. */
const SAMPLES: Record<string, string> = { demo: "harbor", "summit-demo": "summit" };

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const org = arg("org");
  const set = arg("set");
  if ((org && !set) || (!org && set)) throw new Error("Give both --org and --set, or neither (to load the samples).");
  if (org && !/^[A-Za-z0-9_-]{1,64}$/.test(org)) throw new Error("Invalid --org.");
  const targets: Record<string, string> = org && set ? { [org]: set } : SAMPLES;
  const binding = arg("database") ?? "HYPERDRIVE";

  const { embedder, close } = await scriptEmbedder();
  const client = new pg.Client({ connectionString: ownerUrlFor(binding) });
  await client.connect();
  try {
    for (const [orgId, policySet] of Object.entries(targets)) {
      const dir = join(import.meta.dirname, "..", "policies", policySet);
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        const documentId = file.replace(/\.md$/, "");
        const { title, passages } = splitDocument(readFileSync(join(dir, file), "utf8"));
        if (!title || passages.length === 0) throw new Error(`${policySet}/${file} needs a '# title' and numbered rules.`);
        const vectors = await embedder.embed(passages.map((p) => passageText(title, p.content)));

        await client.query("BEGIN");
        try {
          await client.query(
            `INSERT INTO policy_documents (org_id, document_id, title, updated_by) VALUES ($1, $2, $3, 'npm run embed')
             ON CONFLICT (org_id, document_id)
             DO UPDATE SET title = $3, version = policy_documents.version + 1, updated_at = now(), updated_by = 'npm run embed'`,
            [orgId, documentId, title],
          );
          await client.query(`DELETE FROM policy_passages WHERE org_id = $1 AND document_id = $2`, [orgId, documentId]);
          for (const [n, p] of passages.entries()) {
            await client.query(
              `INSERT INTO policy_passages (org_id, document_id, line, content, embedding, embedder)
               VALUES ($1, $2, $3, $4, $5::vector, $6)`,
              [orgId, documentId, p.line, p.content, toPgVector(vectors[n]!), embedder.name],
            );
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        console.log(`  ${orgId}: ${documentId} (${passages.length} passages)`);
      }
    }

    // Product descriptions that have no vector from THIS model yet.
    const { rows } = await client.query<{ org_id: string; product_id: string; description: string }>(
      `SELECT org_id, product_id::text, description FROM products
       WHERE description IS NOT NULL AND description_embedder IS DISTINCT FROM $1`,
      [embedder.name],
    );
    if (rows.length) {
      const vectors = await embedder.embed(rows.map((r) => r.description));
      for (const [n, r] of rows.entries()) {
        await client.query(
          `UPDATE products SET description_embedding = $3::vector, description_embedder = $4 WHERE org_id = $1 AND product_id = $2`,
          [r.org_id, r.product_id, toPgVector(vectors[n]!), embedder.name],
        );
      }
    }
    console.log(`  products: ${rows.length} description(s) embedded with ${embedder.name}`);
  } finally {
    await client.end();
    await close();
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
