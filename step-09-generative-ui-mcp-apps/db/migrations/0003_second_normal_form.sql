-- 0003: SECOND NORMAL FORM (2NF).
--
-- Rule: in a table with a composite key, every other column depends on the WHOLE key.
-- Broken by: staging.sales_1nf, whose key is (org_id, order_ref, line_no). The columns
-- order_date, customer_name, customer_email and customer_city depend only on order_ref
-- (part of the key), so they are repeated on every line of the same order.
-- Fix: move the order-level facts into their own table, keyed by the order alone.
-- The line-level facts (product, category, price, quantity) stay with the line.

CREATE TABLE staging.orders_2nf (
  org_id         text NOT NULL,
  order_ref      text NOT NULL,
  order_date     date NOT NULL,
  customer_name  text NOT NULL,
  customer_email text NOT NULL,
  customer_city  text NOT NULL,
  PRIMARY KEY (org_id, order_ref)
);

CREATE TABLE staging.order_lines_2nf (
  org_id       text          NOT NULL,
  order_ref    text          NOT NULL,
  line_no      integer       NOT NULL CHECK (line_no > 0),
  product_name text          NOT NULL,
  category     text          NOT NULL,
  unit_price   numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  quantity     integer       NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (org_id, order_ref, line_no),
  FOREIGN KEY (org_id, order_ref) REFERENCES staging.orders_2nf (org_id, order_ref)
);

-- One row per order. DISTINCT works because every line of an order carries the same
-- order-level values (that repetition is exactly what 2NF removes).
INSERT INTO staging.orders_2nf
SELECT DISTINCT org_id, order_ref, order_date, customer_name, customer_email, customer_city
FROM staging.sales_1nf;

INSERT INTO staging.order_lines_2nf
SELECT org_id, order_ref, line_no, product_name, category, unit_price, quantity
FROM staging.sales_1nf;
