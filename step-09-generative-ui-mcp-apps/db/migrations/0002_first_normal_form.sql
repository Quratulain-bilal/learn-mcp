-- 0002: FIRST NORMAL FORM (1NF).
--
-- Rule: every cell holds ONE value, and there are no repeating groups.
-- Broken by: staging.flat_sales.products, category, unit_price and quantity, which
-- sometimes hold a list ("Desk Lamp; LED Bulb Pack").
-- Fix: split each list into its own row, one product per row, and give each row a
-- line number inside its order. Prices and quantities become real numbers.
--
-- Key of the new table: (org_id, order_ref, line_no).

CREATE TABLE staging.sales_1nf (
  org_id         text          NOT NULL,
  order_ref      text          NOT NULL,
  line_no        integer       NOT NULL CHECK (line_no > 0),
  order_date     date          NOT NULL,
  customer_name  text          NOT NULL,
  customer_email text          NOT NULL,
  customer_city  text          NOT NULL,
  product_name   text          NOT NULL,
  category       text          NOT NULL,
  unit_price     numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  quantity       integer       NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (org_id, order_ref, line_no)
);

-- unnest() over the four lists, side by side, turns "A; B" into two rows.
-- WITH ORDINALITY keeps the original order, so line numbers are stable.
INSERT INTO staging.sales_1nf
SELECT f.org_id,
       f.order_ref,
       row_number() OVER (PARTITION BY f.org_id, f.order_ref ORDER BY f.line_id, x.pos)::integer,
       f.order_date,
       f.customer_name,
       f.customer_email,
       f.customer_city,
       trim(x.product),
       trim(x.category),
       trim(x.price)::numeric(10,2),
       trim(x.qty)::integer
FROM staging.flat_sales f
CROSS JOIN LATERAL unnest(
  string_to_array(f.products, ';'),
  string_to_array(f.category, ';'),
  string_to_array(f.unit_price, ';'),
  string_to_array(f.quantity, ';')
) WITH ORDINALITY AS x(product, category, price, qty, pos);
