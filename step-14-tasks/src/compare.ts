import type { Row } from "./db";

/**
 * Checks for compare_designs: the same question asked of the flat spreadsheet
 * (staging.flat_sales) and of the normalized tables. Each check shows one anomaly the
 * flat design causes and how 3NF removes it. All fixed SQL; $1 is always the company.
 */

interface Check {
  title: string;
  description: string;
  /** Which normal-form rule the flat design breaks here. */
  rule: string;
  /** SQL against staging.flat_sales. */
  flat: string;
  /** The same question against the normalized tables. */
  normalized: string;
  /** Explains the difference, given both results. */
  explain: (flat: Row[], normalized: Row[]) => string;
}

export const CHECKS = {
  customer_city: {
    title: "Where does each customer live?",
    description: "customers whose city disagrees between rows (an update anomaly)",
    rule: "3NF: the city depends on the customer, not on the order line",
    flat: `
      SELECT customer_email AS customer,
             string_agg(DISTINCT customer_city, ', ' ORDER BY customer_city) AS cities,
             count(DISTINCT customer_city)::int AS city_count
      FROM staging.flat_sales
      WHERE org_id = $1
      GROUP BY customer_email
      HAVING count(DISTINCT customer_city) > 1
      ORDER BY customer_email`,
    normalized: `
      SELECT email AS customer, city AS cities, 1 AS city_count
      FROM customers
      WHERE org_id = $1
        AND email IN (
          SELECT customer_email FROM staging.flat_sales
          WHERE org_id = $1
          GROUP BY customer_email HAVING count(DISTINCT customer_city) > 1)
      ORDER BY email`,
    explain: (flat) =>
      flat.length === 0
        ? "No customer has conflicting cities in the flat sheet for this company."
        : `In the flat sheet, ${flat.length} customer(s) have more than one city, because the city is typed again on every order line and one row was updated but not the others (an update anomaly). ` +
          "In the normalized design the city is stored once, in customers, so it can't disagree with itself.",
  },
  category_names: {
    title: "Which categories exist?",
    description: "the same category spelled different ways",
    rule: "3NF: the category depends on the product, so it belongs in its own table",
    flat: `
      SELECT '"' || category || '"' AS category, count(*)::int AS rows
      FROM staging.flat_sales
      WHERE org_id = $1
      GROUP BY category
      ORDER BY category`,
    normalized: `
      SELECT c.name AS category, count(p.product_id)::int AS products
      FROM categories c
      LEFT JOIN products p ON p.org_id = c.org_id AND p.category_id = c.category_id
      WHERE c.org_id = $1
      GROUP BY c.name
      ORDER BY c.name`,
    explain: (flat, normalized) =>
      `The flat sheet has ${flat.length} different category values (including lists like "Lighting; Lighting" and spellings like "accessories "), ` +
      `while the normalized design has ${normalized.length} categories, each typed exactly once and linked by key.`,
  },
  revenue_by_category: {
    title: "Revenue by category",
    description: "totals that break when a cell holds several values",
    rule: "1NF: one value per cell",
    flat: `
      -- Only rows with ONE product can be summed; list cells like "24.00; 7.00" can't.
      SELECT category,
             round(sum(unit_price::numeric * quantity::int), 2)::float8 AS revenue,
             (SELECT count(*)::int FROM staging.flat_sales
               WHERE org_id = $1 AND products LIKE '%;%') AS rows_skipped
      FROM staging.flat_sales
      WHERE org_id = $1 AND products NOT LIKE '%;%'
      GROUP BY category
      ORDER BY revenue DESC`,
    normalized: `
      SELECT c.name AS category,
             round(sum(i.quantity * i.unit_price), 2)::float8 AS revenue,
             0 AS rows_skipped
      FROM order_items i
      JOIN products p   ON p.org_id = i.org_id AND p.product_id = i.product_id
      JOIN categories c ON c.org_id = p.org_id AND c.category_id = p.category_id
      WHERE i.org_id = $1
      GROUP BY c.name
      ORDER BY revenue DESC`,
    explain: (flat, normalized) => {
      const skipped = Number(flat[0]?.rows_skipped ?? 0);
      return (
        `On the flat sheet, ${skipped} row(s) hold several products in one cell, so SUM() can't read their prices and they are left out, ` +
        `and a misspelled category becomes its own group (${flat.length} groups versus ${normalized.length}). ` +
        "The normalized totals include every line and every category exactly once."
      );
    },
  },
  product_catalog: {
    title: "Which products do we sell?",
    description: "products the flat sheet can't record or would forget (insert and delete anomalies)",
    rule: "3NF: product facts belong in a products table, not on order lines",
    flat: `
      SELECT trim(x.product) AS product, count(*)::int AS order_lines
      FROM staging.flat_sales f
      CROSS JOIN LATERAL unnest(string_to_array(f.products, ';')) AS x(product)
      WHERE f.org_id = $1
      GROUP BY trim(x.product)
      ORDER BY order_lines, product`,
    normalized: `
      SELECT p.name AS product, count(i.line_no)::int AS order_lines
      FROM products p
      LEFT JOIN order_items i ON i.org_id = p.org_id AND i.product_id = p.product_id
      WHERE p.org_id = $1
      GROUP BY p.name
      ORDER BY order_lines, product`,
    explain: (flat, normalized) => {
      const flatNames = new Set(flat.map((r) => String(r.product)));
      const onlyNormalized = normalized.filter((r) => !flatNames.has(String(r.product))).map((r) => r.product);
      const soldOnce = flat.filter((r) => r.order_lines === 1).map((r) => r.product);
      return (
        `The flat sheet only knows products that appear on an order line, so it lists ${flat.length} products. ` +
        (onlyNormalized.length
          ? `The products table also has ${onlyNormalized.join(", ")}, which nobody has bought yet: the flat sheet can't record it without inventing an order (an insert anomaly). `
          : "") +
        (soldOnce.length
          ? `${soldOnce.join(", ")} appear on a single line, so deleting that one order would erase the product, its category and its price from the sheet (a delete anomaly).`
          : "")
      );
    },
  },
} satisfies Record<string, Check>;

export type CheckName = keyof typeof CHECKS;
export const CHECK_NAMES = Object.keys(CHECKS) as [CheckName, ...CheckName[]];
