import type { Db, Row } from "./db";

/**
 * The ten business questions the server can answer. Each one is FIXED SQL that we wrote
 * and reviewed. The model picks a question by name and may pass a year and a limit; it
 * never writes SQL.
 *
 * Every query takes the same three parameters, always in this order:
 *   $1 = the company (org_id), from the verified token
 *   $2 = the year to filter on, or NULL for all years
 *   $3 = the row limit for ranked lists
 *
 * Money is summed as numeric (exact) and only cast to float8 at the end, rounded to
 * cents, so the JSON reply has plain numbers. Counts are cast to int for the same reason.
 */

export type { Row };

export interface QuestionParams {
  orgId: string;
  /** Only count orders from this calendar year; null means all years. */
  year: number | null;
  limit: number;
}

interface Question {
  title: string;
  /** Shown to the model in the tool description. */
  description: string;
  sql: string;
}

// Orders from the chosen year ($2), or all orders when $2 is NULL.
const IN_YEAR = `($2::int IS NULL OR extract(year FROM o.order_date) = $2::int)`;

export const QUESTIONS = {
  monthly_revenue: {
    title: "Monthly revenue",
    description: "revenue and number of orders per month",
    sql: `
      SELECT to_char(date_trunc('month', o.order_date), 'YYYY-MM') AS month,
             count(DISTINCT o.order_id)::int                       AS orders,
             round(sum(i.quantity * i.unit_price), 2)::float8      AS revenue
      FROM orders o
      JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
      WHERE o.org_id = $1 AND ${IN_YEAR}
      GROUP BY 1
      ORDER BY 1
      LIMIT greatest($3::int, 120)`, // months aren't a ranking: always return them all
  },
  top_products: {
    title: "Top products",
    description: "best-selling products by revenue, with units sold",
    sql: `
      SELECT p.name                                           AS product,
             c.name                                           AS category,
             sum(i.quantity)::int                             AS units,
             round(sum(i.quantity * i.unit_price), 2)::float8 AS revenue
      FROM order_items i
      JOIN orders o     ON o.org_id = i.org_id AND o.order_id = i.order_id
      JOIN products p   ON p.org_id = i.org_id AND p.product_id = i.product_id
      JOIN categories c ON c.org_id = p.org_id AND c.category_id = p.category_id
      WHERE i.org_id = $1 AND ${IN_YEAR}
      GROUP BY p.name, c.name
      ORDER BY revenue DESC, product
      LIMIT $3`,
  },
  best_customers: {
    title: "Best customers",
    description: "customers who spent the most, with their city and number of orders",
    sql: `
      SELECT cu.name                                          AS customer,
             cu.city                                          AS city,
             count(DISTINCT o.order_id)::int                  AS orders,
             round(sum(i.quantity * i.unit_price), 2)::float8 AS revenue
      FROM customers cu
      JOIN orders o      ON o.org_id = cu.org_id AND o.customer_id = cu.customer_id
      JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
      WHERE cu.org_id = $1 AND ${IN_YEAR}
      GROUP BY cu.customer_id, cu.name, cu.city
      ORDER BY revenue DESC, customer
      LIMIT $3`,
  },
  revenue_by_category: {
    title: "Revenue by category",
    description: "revenue and units per product category",
    sql: `
      SELECT c.name                                           AS category,
             sum(i.quantity)::int                             AS units,
             round(sum(i.quantity * i.unit_price), 2)::float8 AS revenue
      FROM order_items i
      JOIN orders o     ON o.org_id = i.org_id AND o.order_id = i.order_id
      JOIN products p   ON p.org_id = i.org_id AND p.product_id = i.product_id
      JOIN categories c ON c.org_id = p.org_id AND c.category_id = p.category_id
      WHERE i.org_id = $1 AND ${IN_YEAR}
      GROUP BY c.name
      ORDER BY revenue DESC
      LIMIT $3`,
  },
  revenue_by_city: {
    title: "Revenue by city",
    description: "revenue and customers per customer city",
    sql: `
      SELECT cu.city                                          AS city,
             count(DISTINCT cu.customer_id)::int              AS customers,
             round(sum(i.quantity * i.unit_price), 2)::float8 AS revenue
      FROM customers cu
      JOIN orders o      ON o.org_id = cu.org_id AND o.customer_id = cu.customer_id
      JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
      WHERE cu.org_id = $1 AND ${IN_YEAR}
      GROUP BY cu.city
      ORDER BY revenue DESC, city
      LIMIT $3`,
  },
  average_order_value: {
    title: "Average order value",
    description: "number of orders, total revenue and the average order value",
    sql: `
      WITH totals AS (
        SELECT o.order_id, sum(i.quantity * i.unit_price) AS total
        FROM orders o
        JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
        WHERE o.org_id = $1 AND ${IN_YEAR}
        GROUP BY o.order_id
      )
      SELECT count(*)::int                             AS orders,
             coalesce(round(sum(total), 2), 0)::float8 AS revenue,
             coalesce(round(avg(total), 2), 0)::float8 AS average_order_value
      FROM totals
      LIMIT $3`,
  },
  repeat_customers: {
    title: "Repeat customers",
    description: "customers with two or more orders, with their first and last order dates",
    sql: `
      SELECT cu.name                                  AS customer,
             count(*)::int                            AS orders,
             to_char(min(o.order_date), 'YYYY-MM-DD') AS first_order,
             to_char(max(o.order_date), 'YYYY-MM-DD') AS last_order
      FROM customers cu
      JOIN orders o ON o.org_id = cu.org_id AND o.customer_id = cu.customer_id
      WHERE cu.org_id = $1 AND ${IN_YEAR}
      GROUP BY cu.customer_id, cu.name
      HAVING count(*) >= 2
      ORDER BY orders DESC, customer
      LIMIT $3`,
  },
  products_never_sold: {
    title: "Products never sold",
    description: "catalog products with no sales (in the chosen year, if one is given)",
    sql: `
      SELECT p.name AS product, c.name AS category, p.list_price::float8 AS list_price
      FROM products p
      JOIN categories c ON c.org_id = p.org_id AND c.category_id = p.category_id
      WHERE p.org_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM order_items i
          JOIN orders o ON o.org_id = i.org_id AND o.order_id = i.order_id
          WHERE i.org_id = p.org_id AND i.product_id = p.product_id AND ${IN_YEAR}
        )
      ORDER BY p.name
      LIMIT $3`,
  },
  largest_orders: {
    title: "Largest orders",
    description: "the biggest orders by value, with customer, date and number of lines",
    sql: `
      SELECT o.order_ref                                      AS order_ref,
             to_char(o.order_date, 'YYYY-MM-DD')              AS order_date,
             cu.name                                          AS customer,
             count(*)::int                                    AS lines,
             round(sum(i.quantity * i.unit_price), 2)::float8 AS total
      FROM orders o
      JOIN customers cu  ON cu.org_id = o.org_id AND cu.customer_id = o.customer_id
      JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
      WHERE o.org_id = $1 AND ${IN_YEAR}
      GROUP BY o.order_id, o.order_ref, o.order_date, cu.name
      ORDER BY total DESC, order_ref
      LIMIT $3`,
  },
  price_changes: {
    title: "Price changes",
    description:
      "products whose price at the time of sale differs from today's catalog price " +
      "(shows why each order line keeps its own unit_price)",
    sql: `
      SELECT p.name                    AS product,
             p.list_price::float8      AS list_price_today,
             min(i.unit_price)::float8 AS lowest_price_paid,
             max(i.unit_price)::float8 AS highest_price_paid,
             (count(*) FILTER (WHERE i.unit_price <> p.list_price))::int AS lines_at_old_price
      FROM products p
      JOIN order_items i ON i.org_id = p.org_id AND i.product_id = p.product_id
      JOIN orders o      ON o.org_id = i.org_id AND o.order_id = i.order_id
      WHERE p.org_id = $1 AND ${IN_YEAR}
      GROUP BY p.product_id, p.name, p.list_price
      HAVING min(i.unit_price) <> max(i.unit_price) OR min(i.unit_price) <> p.list_price
      ORDER BY p.name
      LIMIT $3`,
  },
} satisfies Record<string, Question>;

export type QuestionName = keyof typeof QUESTIONS;
export const QUESTION_NAMES = Object.keys(QUESTIONS) as [QuestionName, ...QuestionName[]];

/** Runs one question for one company. */
export function runQuestion(db: Db, name: QuestionName, p: QuestionParams): Promise<Row[]> {
  return db.query(QUESTIONS[name].sql, [p.orgId, p.year, p.limit]);
}
