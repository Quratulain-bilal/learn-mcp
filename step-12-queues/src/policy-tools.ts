import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Db, ForTenant } from "./db";
import { type Embedder, toPgVector } from "./embeddings";
import { MAX_DOCUMENT_CHARS, MAX_PASSAGES, passageText, splitDocument } from "./passages";
import { POLICY_THRESHOLD, PRODUCT_THRESHOLD, TOP_K, thresholdFor } from "./retrieval-config";
import type { TenantContext } from "./tenant";
import { READ_ONLY, dbError, toolError } from "./tool-helpers";

/**
 * SEARCH BY MEANING over the company's own documents and products. Every search:
 *   1. embeds the question with the same model as the stored vectors,
 *   2. runs inside forTenant(), so row-level security limits it to this company,
 *      in this company's own database (shared or dedicated),
 *   3. returns passages WITH their document and line, so the answer can be checked,
 *   4. ABSTAINS when nothing reaches the threshold, rather than returning the closest
 *      wrong rule.
 */

const passageSchema = z.object({
  document: z.string(),
  title: z.string(),
  line: z.number(),
  text: z.string(),
  similarity: z.number(),
  citation: z.string().describe('Cite it like this, e.g. "discounts, line 3".'),
});

/** Turns on pgvector's iterative index scans for this transaction, so a filtered HNSW search still finds enough rows. */
async function preferExactFilteredScan(db: Db): Promise<void> {
  await db.query("SELECT set_config('hnsw.iterative_scan', 'strict_order', true)");
}

export function registerPolicyTools(
  server: McpServer,
  deps: { forTenant: ForTenant; embedder: Embedder; tenant: TenantContext },
): void {
  const { forTenant, embedder, tenant } = deps;

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "search_sales_policy",
    {
      title: "Search the sales policies",
      description:
        "Search the company's own sales policies (discounts, returns, credit terms, and any documents an admin added) by MEANING, " +
        "for questions like \"can I give a new customer 15% off?\" or \"what's the rule for opened items?\". " +
        `Returns up to ${TOP_K} passages, each with its document and line. Answer ONLY from these passages and cite each one you use ` +
        '(e.g. "discounts, line 3"). If the result says abstained, tell the user the policies don\'t cover it and suggest asking a manager: ' +
        "do not answer from general knowledge.",
      inputSchema: z.object({
        question: z.string().trim().min(3).max(500).describe("The user's question, in their own words."),
      }),
      outputSchema: z.object({
        abstained: z.boolean(),
        passages: z.array(passageSchema),
        message: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ question }) => {
      try {
        const [vector] = await embedder.embed([question]);
        const threshold = thresholdFor(POLICY_THRESHOLD, embedder.name);
        const rows = await forTenant(tenant, async (db) => {
          await preferExactFilteredScan(db);
          return db.query<{ document: string; title: string; line: number; text: string; similarity: number }>(
            `SELECT p.document_id AS document, d.title, p.line, p.content AS text,
                    round((1 - (p.embedding <=> $2::vector))::numeric, 4)::float8 AS similarity
             FROM policy_passages p
             JOIN policy_documents d ON d.org_id = p.org_id AND d.document_id = p.document_id
             WHERE p.org_id = $1 AND p.embedder = $3
             ORDER BY p.embedding <=> $2::vector
             LIMIT $4`,
            [tenant.orgId, toPgVector(vector!), embedder.name, TOP_K],
          );
        });

        const passages = rows
          .filter((r) => r.similarity >= threshold)
          .map((r) => ({ ...r, citation: `${r.document}, line ${r.line}` }));
        if (passages.length === 0) {
          const message =
            "ABSTAINED: no policy passage is close enough to this question. Tell the user the company's policies don't cover it, " +
            "and suggest they ask their manager. Don't answer from general knowledge.";
          return { content: [{ type: "text", text: message }], structuredContent: { abstained: true, passages: [], message } };
        }
        const message = "Answer only from these passages and cite each one you use.";
        const text =
          passages.map((p) => `[${p.citation}] (similarity ${p.similarity}) ${p.title}: ${p.text}`).join("\n") + `\n\n${message}`;
        return { content: [{ type: "text", text }], structuredContent: { abstained: false, passages, message } };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "find_products",
    {
      title: "Find products by what they're for",
      description:
        "Find the company's products by MEANING, from their descriptions: e.g. \"something to keep medicine cold\" or \"help with neck pain at the desk\". " +
        "Returns up to 5 products with name, price, description and similarity, or abstains if nothing matches well. " +
        "Only suggest products this tool returns.",
      inputSchema: z.object({
        need: z.string().trim().min(3).max(300).describe("What the customer needs, in their own words."),
      }),
      outputSchema: z.object({
        abstained: z.boolean(),
        products: z.array(
          z.object({ name: z.string(), list_price: z.number(), description: z.string(), similarity: z.number() }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ need }) => {
      try {
        const [vector] = await embedder.embed([need]);
        const threshold = thresholdFor(PRODUCT_THRESHOLD, embedder.name);
        const rows = await forTenant(tenant, (db) =>
          db.query<{ name: string; list_price: number; description: string; similarity: number }>(
            `SELECT name, list_price::float8 AS list_price, description,
                    round((1 - (description_embedding <=> $2::vector))::numeric, 4)::float8 AS similarity
             FROM products
             WHERE org_id = $1 AND description_embedder = $3 AND description_embedding IS NOT NULL
             ORDER BY description_embedding <=> $2::vector
             LIMIT 5`,
            [tenant.orgId, toPgVector(vector!), embedder.name],
          ),
        );
        const products = rows.filter((r) => r.similarity >= threshold);
        if (products.length === 0) {
          const text = "No product in the catalog matches this need closely enough. Say so rather than suggesting something unrelated.";
          return { content: [{ type: "text", text }], structuredContent: { abstained: true, products: [] } };
        }
        const text = products
          .map((p) => `- ${p.name} (${p.list_price}): ${p.description} [similarity ${p.similarity}]`)
          .join("\n");
        return { content: [{ type: "text", text }], structuredContent: { abstained: false, products } };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "add_policy_document",
    {
      title: "Add or replace a policy document",
      description:
        "Add a policy document for the company, or replace the existing one with the same id (admins only). " +
        "Write it as a title line starting with '# ' and then numbered rules ('1. ...', '2. ...'): each rule becomes one searchable passage. " +
        "Replacing removes the old version's passages. Confirm the content with the user before calling this.",
      inputSchema: z.object({
        document_id: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9-]{0,59}$/, 'Use a short lowercase id like "discounts" or "shipping-rules".')
          .describe('A short id, e.g. "shipping-rules". Using an existing id replaces that document.'),
        content: z
          .string()
          .min(10)
          .max(MAX_DOCUMENT_CHARS, `Documents are limited to ${MAX_DOCUMENT_CHARS} characters; split it into several documents.`)
          .describe("The document as Markdown: '# Title', then one numbered rule per line."),
      }),
      outputSchema: z.object({ document: z.string(), title: z.string(), version: z.number(), passages: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ document_id, content }) => {
      if (tenant.role !== "admin") {
        return toolError(
          "Forbidden (403): only company admins can add or replace policy documents. Your role is member. Ask an admin of your company.",
        );
      }
      const { title, passages } = splitDocument(content);
      if (!title) return toolError("The document needs a title line starting with '# ', e.g. '# Shipping rules'.");
      if (passages.length === 0) {
        return toolError("No numbered rules found. Write each rule on its own line as '1. ...', '2. ...'.");
      }
      if (passages.length > MAX_PASSAGES) {
        return toolError(`That's ${passages.length} rules; the limit is ${MAX_PASSAGES} per document. Split it into several documents.`);
      }

      try {
        // Embed BEFORE opening the transaction: the model call can take a moment, and a
        // database transaction shouldn't sit open waiting on the network.
        const vectors = await embedder.embed(passages.map((p) => passageText(title, p.content)));
        const version = await forTenant(tenant, async (db) => {
          const [doc] = await db.query<{ version: number }>(
            `INSERT INTO policy_documents (org_id, document_id, title, updated_by) VALUES ($1, $2, $3, $4)
             ON CONFLICT (org_id, document_id)
             DO UPDATE SET title = $3, version = policy_documents.version + 1, updated_at = now(), updated_by = $4
             RETURNING version`,
            [tenant.orgId, document_id, title, tenant.userId],
          );
          // Replace: the old version's passages go, the new ones come in, in ONE transaction.
          await db.query(`DELETE FROM policy_passages WHERE org_id = $1 AND document_id = $2`, [tenant.orgId, document_id]);
          await db.query(
            `INSERT INTO policy_passages (org_id, document_id, line, content, embedding, embedder)
             SELECT $1, $2, x.line, x.content, x.embedding::vector, $6
             FROM unnest($3::int[], $4::text[], $5::text[]) AS x(line, content, embedding)`,
            [
              tenant.orgId,
              document_id,
              passages.map((p) => p.line),
              passages.map((p) => p.content),
              vectors.map(toPgVector),
              embedder.name,
            ],
          );
          return doc!.version;
        });
        const text = `Saved "${title}" as ${document_id} (version ${version}) with ${passages.length} searchable passages.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { document: document_id, title, version, passages: passages.length },
        };
      } catch (error) {
        return dbError(error);
      }
    },
  );
}
