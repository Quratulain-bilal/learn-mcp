CREATE SCHEMA IF NOT EXISTS staging;

CREATE TABLE IF NOT EXISTS staging.flat_sales (
  org_id text NOT NULL,
  order_id text NOT NULL,
  order_line integer NOT NULL,
  order_date date NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_city text NOT NULL,
  product_names text NOT NULL,
  category text NOT NULL,
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (org_id, order_id, order_line)
);

INSERT INTO staging.flat_sales (
  org_id, order_id, order_line, order_date, customer_name, customer_email,
  customer_city, product_names, category, unit_price, quantity
) VALUES
  ('demo-company', 'ORD-1001', 1, '2026-01-05', 'Ayesha Khan', 'ayesha@example.com', 'Karachi', 'Laptop', 'Computers', 1200.00, 1),
  ('demo-company', 'ORD-1001', 2, '2026-01-05', 'Ayesha Khan', 'ayesha@example.com', 'Karachi', 'Mouse', 'Accessories', 25.00, 2),
  ('demo-company', 'ORD-1002', 1, '2026-01-18', 'Bilal Ahmed', 'bilal@example.com', 'Lahore', 'Laptop, Mouse', 'Computers', 1200.00, 1),
  ('demo-company', 'ORD-1003', 1, '2026-02-03', 'Ayesha Khan', 'ayesha@example.com', 'Lahore', 'Monitor', 'Computers', 300.00, 2),
  ('demo-company', 'ORD-1004', 1, '2026-02-14', 'Sara Ali', 'sara@example.com', 'Islamabad', 'Desk', 'Furniture', 180.00, 1),
  ('demo-company', 'ORD-1005', 1, '2026-03-08', 'Bilal Ahmed', 'bilal@example.com', 'Lahore', 'Keyboard', 'Accessories', 45.00, 3),
  ('demo-company', 'ORD-1006', 1, '2026-03-22', 'Sara Ali', 'sara@example.com', 'Islamabad', 'Chair', 'Furniture', 220.00, 2),
  ('demo-company', 'ORD-1007', 1, '2026-04-11', 'Ayesha Khan', 'ayesha@example.com', 'Karachi', 'Laptop', 'Computers', 1250.00, 1),
  ('demo-company', 'ORD-1008', 1, '2026-04-29', 'Usman Raza', 'usman@example.com', 'Faisalabad', 'Mouse', 'Accessories', 30.00, 4),
  ('demo-company', 'ORD-1009', 1, '2026-05-06', 'Sara Ali', 'sara@example.com', 'Islamabad', 'Monitor', 'Computers', 310.00, 1),
  ('demo-company', 'ORD-1010', 1, '2026-05-19', 'Bilal Ahmed', 'bilal@example.com', 'Lahore', 'Desk', 'Furniture', 200.00, 1),
  ('demo-company', 'ORD-1011', 1, '2026-06-02', 'Usman Raza', 'usman@example.com', 'Faisalabad', 'Keyboard, Mouse', 'Accessories', 45.00, 2)
ON CONFLICT DO NOTHING;
