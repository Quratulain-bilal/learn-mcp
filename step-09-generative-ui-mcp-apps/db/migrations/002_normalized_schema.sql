CREATE TABLE IF NOT EXISTS customers (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  city text NOT NULL,
  PRIMARY KEY (org_id, customer_id),
  UNIQUE (org_id, email),
  CHECK (length(name) > 0),
  CHECK (length(city) > 0)
);

CREATE TABLE IF NOT EXISTS categories (
  org_id text NOT NULL,
  category_id text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (org_id, category_id),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS products (
  org_id text NOT NULL,
  product_id text NOT NULL,
  name text NOT NULL,
  category_id text NOT NULL,
  catalog_price numeric(12,2) NOT NULL CHECK (catalog_price >= 0),
  PRIMARY KEY (org_id, product_id),
  UNIQUE (org_id, name),
  FOREIGN KEY (org_id, category_id) REFERENCES categories (org_id, category_id)
);

CREATE TABLE IF NOT EXISTS orders (
  org_id text NOT NULL,
  order_id text NOT NULL,
  customer_id text NOT NULL,
  order_date date NOT NULL,
  PRIMARY KEY (org_id, order_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, customer_id)
);

CREATE TABLE IF NOT EXISTS order_items (
  org_id text NOT NULL,
  order_id text NOT NULL,
  line_no integer NOT NULL,
  product_id text NOT NULL,
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (org_id, order_id, line_no),
  FOREIGN KEY (org_id, order_id) REFERENCES orders (org_id, order_id),
  FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, product_id)
);

CREATE INDEX IF NOT EXISTS orders_org_date_idx ON orders (org_id, order_date);
CREATE INDEX IF NOT EXISTS order_items_org_product_idx ON order_items (org_id, product_id);
