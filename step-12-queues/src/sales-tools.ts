import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CHECKS, CHECK_NAMES } from "./compare";
import { SALES_TABLES, type ForTenant } from "./db";
import type { TenantContext } from "./tenant";
import { QUESTIONS, QUESTION_NAMES, runQuestion } from "./questions";
import { READ_ONLY, dbError, markdownTable, rowSchema, toolError } from "./tool-helpers";

/**
 * Three READ-ONLY tools over the sales database. None of them accepts SQL: the model
 * chooses from fixed, reviewed queries, and the company always comes from the verified
 * token (tenant.orgId), never from tool input. Every query runs inside forTenant(), so
 * row-level security filters it too; the explicit `org_id = $1` filters stay as a first guard.
 */

/** What each table is for, written for the model. */
const TABLE_NOTES: Record<(typeof SALES_TABLES)[number], string> = {
  customers: "One row per customer: name, email (unique per company) and the city they live in now.",
  categories: "One row per product category, spelled once.",
  products: "One row per product in the catalog, with its category and today's list price.",
  orders: "One row per order: which customer and when. Line details are in order_items.",
  order_items:
    "One row per order line: product, quantity and unit_price, the price actually paid at the time (kept on purpose, even if the catalog price changes later).",
};

export function registerSalesTools(server: McpServer, forTenant: ForTenant, tenant: TenantContext): void {
  const orgId = tenant.orgId;

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "describe_schema",
    {
      title: "Describe the sales database",
      description:
        "Describe the normalized sales database: its tables, columns, primary keys, foreign keys and constraints, " +
        "plus how many rows the signed-in user's company has in each table. " +
        "Use it when the user asks how the data is organized, what a table holds, or how tables relate, " +
        "or before explaining an answer from answer_business_question. Pass `table` to describe just one table.",
      inputSchema: z.object({
        table: z.enum(SALES_TABLES).optional().describe("Describe only this table. Omit it to describe all five."),
      }),
      outputSchema: z.object({
        tables: z.array(
          z.object({
            name: z.string(),
            purpose: z.string(),
            rowsInYourCompany: z.number(),
            columns: z.array(z.object({ name: z.string(), type: z.string(), nullable: z.boolean() })),
            constraints: z.array(z.object({ kind: z.string(), definition: z.string() })),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ table }) => {
      const names = table ? [table] : [...SALES_TABLES];
      try {
        const { columns, constraints, counts } = await forTenant(tenant, async (db) => {
          // The catalog describes the schema; it holds no company data.
          const columns = await db.query<{ table: string; name: string; type: string; nullable: boolean }>(
            `SELECT table_name AS table, column_name AS name, data_type AS type, is_nullable = 'YES' AS nullable
             FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = ANY($1::text[])
             ORDER BY table_name, ordinal_position`,
            [names],
          );
          const constraints = await db.query<{ table: string; kind: string; definition: string }>(
            `SELECT rel.relname AS table,
                    CASE con.contype WHEN 'p' THEN 'primary key' WHEN 'f' THEN 'foreign key'
                                     WHEN 'u' THEN 'unique' ELSE 'check' END AS kind,
                    pg_get_constraintdef(con.oid) AS definition
             FROM pg_constraint con
             JOIN pg_class rel     ON rel.oid = con.conrelid
             JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
             WHERE nsp.nspname = 'public' AND rel.relname = ANY($1::text[]) AND con.contype IN ('p', 'f', 'u', 'c')
             ORDER BY rel.relname, con.contype DESC, con.conname`,
            [names],
          );
          // Row counts for THIS company only. The table names are written here, not taken from input.
          const [counts] = await db.query<Record<string, number>>(
            `SELECT (SELECT count(*) FROM customers   WHERE org_id = $1)::int AS customers,
                    (SELECT count(*) FROM categories  WHERE org_id = $1)::int AS categories,
                    (SELECT count(*) FROM products    WHERE org_id = $1)::int AS products,
                    (SELECT count(*) FROM orders      WHERE org_id = $1)::int AS orders,
                    (SELECT count(*) FROM order_items WHERE org_id = $1)::int AS order_items`,
            [orgId],
          );
          return { columns, constraints, counts: counts ?? {} };
        });

        const tables = names.map((name) => ({
          name,
          purpose: TABLE_NOTES[name],
          rowsInYourCompany: counts[name] ?? 0,
          columns: columns.filter((c) => c.table === name).map(({ name, type, nullable }) => ({ name, type, nullable })),
          constraints: constraints.filter((c) => c.table === name).map(({ kind, definition }) => ({ kind, definition })),
        }));
        if (tables.every((t) => t.columns.length === 0)) {
          return toolError("The sales tables don't exist yet. The server's owner needs to run the migrations (npm run db:migrate).");
        }

        const empty = tables.every((t) => t.rowsInYourCompany === 0);
        const text =
          tables
            .map(
              (t) =>
                `## ${t.name} (${t.rowsInYourCompany} rows in your company)\n${t.purpose}\n` +
                `Columns: ${t.columns.map((c) => `${c.name} ${c.type}${c.nullable ? "" : " not null"}`).join(", ")}\n` +
                t.constraints.map((c) => `- ${c.kind}: ${c.definition}`).join("\n"),
            )
            .join("\n\n") +
          (empty
            ? `\n\nYour company has no sales data yet. The server's owner can load the sample data into it with \`npm run db:seed -- --org ${orgId}\`.`
            : "");
        return { content: [{ type: "text", text }], structuredContent: { tables } };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "answer_business_question",
    {
      title: "Answer a business question",
      description:
        "Answer one of ten fixed business questions from the signed-in user's company sales data. " +
        "Pick the question that best matches what the user asked:\n" +
        QUESTION_NAMES.map((name) => `- ${name}: ${QUESTIONS[name].description}`).join("\n") +
        "\nOptionally filter to one calendar year (e.g. 2025) and limit how many rows come back. " +
        "If the user asks something none of these answer, say so instead of guessing.",
      inputSchema: z.object({
        question: z.enum(QUESTION_NAMES).describe("Which question to answer."),
        year: z
          .number()
          .int()
          .min(2000)
          .max(2100)
          .optional()
          .describe("Only include orders from this calendar year. Omit for all years."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("For ranked lists (top products, best customers, …): how many rows to return. Defaults to 10."),
      }),
      outputSchema: z.object({
        question: z.string(),
        title: z.string(),
        year: z.number().nullable(),
        rows: z.array(rowSchema),
      }),
      annotations: READ_ONLY,
    },
    async ({ question, year, limit }) => {
      const q = QUESTIONS[question];
      try {
        const rows = await forTenant(tenant, (db) => runQuestion(db, question, { orgId, year: year ?? null, limit }));
        const scope = year ? ` in ${year}` : "";
        const text =
          `${q.title}${scope} (${rows.length} rows):\n\n${markdownTable(rows)}` +
          (rows.length === 0 ? "\n\nNo matching sales data in your company." : "");
        return {
          content: [{ type: "text", text }],
          structuredContent: { question, title: q.title, year: year ?? null, rows: rows.map((r) => ({ ...r })) },
        };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "compare_designs",
    {
      title: "Compare the flat sheet with the normalized design",
      description:
        "Run the same check against the original flat sales spreadsheet (staging.flat_sales) and the normalized tables, " +
        "and explain the anomaly the flat design causes. Use it when the user asks why the database is designed this way, " +
        "why the old spreadsheet gave odd answers (e.g. a customer with two cities), or what normalization fixes. Checks:\n" +
        CHECK_NAMES.map((name) => `- ${name}: ${CHECKS[name].description}`).join("\n"),
      inputSchema: z.object({
        check: z.enum(CHECK_NAMES).describe("Which comparison to run."),
      }),
      outputSchema: z.object({
        check: z.string(),
        rule: z.string(),
        flat: z.array(rowSchema),
        normalized: z.array(rowSchema),
        explanation: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ check }) => {
      const c = CHECKS[check];
      try {
        const [flat, normalized] = await forTenant(tenant, async (db) => [
          await db.query(c.flat, [orgId]),
          await db.query(c.normalized, [orgId]),
        ]);
        const explanation = c.explain(flat, normalized);
        const text =
          `${c.title} (${c.rule})\n\n**Flat spreadsheet:**\n${markdownTable(flat)}\n\n` +
          `**Normalized tables:**\n${markdownTable(normalized)}\n\n${explanation}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            check,
            rule: c.rule,
            flat: flat.map((r) => ({ ...r })),
            normalized: normalized.map((r) => ({ ...r })),
            explanation,
          },
        };
      } catch (error) {
        return dbError(error);
      }
    },
  );
}
