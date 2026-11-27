import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { QUESTION_NAMES } from "./questions";

/**
 * A RESOURCE the user can attach (the ER diagram of the sales design), and a PROMPT they
 * can pick to start a guided tour of it. Neither touches company data: the diagram is
 * the same for every company.
 */

export const ER_DIAGRAM = `erDiagram
  categories ||--o{ products : "groups"
  customers  ||--o{ orders : "places"
  orders     ||--|{ order_items : "has lines"
  products   ||--o{ order_items : "sold as"

  categories {
    text org_id PK
    bigint category_id PK
    text name "unique per company"
  }
  products {
    text org_id PK
    bigint product_id PK
    bigint category_id FK
    text name "unique per company"
    numeric list_price "today's price"
  }
  customers {
    text org_id PK
    bigint customer_id PK
    text name
    text email "unique per company"
    text city
  }
  orders {
    text org_id PK
    bigint order_id PK
    text order_ref "unique per company"
    bigint customer_id FK
    date order_date
  }
  order_items {
    text org_id PK
    bigint order_id PK
    int line_no PK
    bigint product_id FK
    int quantity
    numeric unit_price "price paid, a copy on purpose"
  }`;

export function registerSchemaDocs(server: McpServer): void {
  server.registerResource(
    "sales-er-diagram",
    "sales://schema/er-diagram",
    {
      title: "Sales database ER diagram",
      description: "A Mermaid entity-relationship diagram of the normalized (3NF) sales tables and their keys.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text:
            "# Sales database (third normal form)\n\n" +
            "Every primary key starts with `org_id` (the company), and every foreign key includes it, " +
            "so no row can point at another company's row.\n\n```mermaid\n" +
            ER_DIAGRAM +
            "\n```\n",
        },
      ],
    }),
  );

  server.registerPrompt(
    "tour_sales_database",
    {
      title: "Tour the sales database",
      description: "Explain how the sales data is designed, why, and answer a first business question.",
      argsSchema: z.object({
        question: z
          .enum(QUESTION_NAMES)
          .optional()
          .describe("A business question to answer at the end, e.g. top_products. Leave empty for monthly_revenue."),
      }),
    },
    async ({ question }) => ({
      description: "A guided tour of the sales database",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Give me a short tour of my company's sales database.\n" +
              "1. Call describe_schema and explain each table and how the tables link, in plain language.\n" +
              "2. Call compare_designs with check customer_city and explain what went wrong in the old spreadsheet and how the new design prevents it.\n" +
              `3. Call answer_business_question with question ${question ?? "monthly_revenue"} and summarize the answer in two or three sentences.\n` +
              "Keep it brief and use the real numbers from the tools.",
          },
        },
      ],
    }),
  );
}
