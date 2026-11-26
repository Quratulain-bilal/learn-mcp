-- 0008: SEARCH BY MEANING with pgvector, inside the same database and the same rules.
--
-- An embeddings model turns text into a list of 1,024 numbers (a vector) so that texts
-- with similar meaning get similar numbers. pgvector stores those vectors in a column and
-- finds the nearest ones by cosine distance (<=>). We embed with bge-m3 on Workers AI,
-- which makes 1,024-number vectors, so every vector column is vector(1024).
--
-- Passages and embeddings are business data like any other: org_id in every key, forced
-- row-level security, and they live in the company's own database (shared or dedicated).

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per document a company has (discounts, returns, credit terms, ...).
CREATE TABLE policy_documents (
  org_id      text        NOT NULL,
  document_id text        NOT NULL CHECK (document_id ~ '^[a-z0-9][a-z0-9-]{0,59}$'),  -- e.g. "discounts"
  title       text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  version     integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text        NOT NULL,
  PRIMARY KEY (org_id, document_id)
);

-- One row per PASSAGE: one rule of one document, with the line it's on, so every answer
-- can cite exactly where it came from.
CREATE TABLE policy_passages (
  org_id      text         NOT NULL,
  document_id text         NOT NULL,
  line        integer      NOT NULL CHECK (line > 0),
  content     text         NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  embedding   vector(1024) NOT NULL,
  -- Which model made the vector. A search only compares vectors from the SAME model:
  -- numbers from two different models mean nothing to each other.
  embedder    text         NOT NULL,
  PRIMARY KEY (org_id, document_id, line),
  FOREIGN KEY (org_id, document_id) REFERENCES policy_documents (org_id, document_id) ON DELETE CASCADE
);

-- Products can be found by what they're FOR, not just their name.
ALTER TABLE products
  ADD COLUMN description           text CHECK (length(description) <= 1000),
  ADD COLUMN description_embedding vector(1024),
  ADD COLUMN description_embedder  text;

-- An HNSW index for nearest-neighbour search by cosine distance. At a few dozen passages
-- Postgres ignores it and reads the whole (tiny) table, which is faster; it starts to pay
-- off at tens of thousands of rows. See NOTES.md for EXPLAIN.
CREATE INDEX policy_passages_embedding_idx ON policy_passages USING hnsw (embedding vector_cosine_ops);

ALTER TABLE policy_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_documents FORCE  ROW LEVEL SECURITY;
ALTER TABLE policy_passages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_passages  FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON policy_documents TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON policy_passages TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

-- Reading for search; replacing a document's passages for add_policy_document.
GRANT SELECT, INSERT, UPDATE ON policy_documents TO mcp_connector;
GRANT SELECT, INSERT, DELETE ON policy_passages TO mcp_connector;

-- Sample product descriptions for the demo company, plus one product the office catalog
-- didn't have, to show finding by meaning ("something to keep medicine cold").
INSERT INTO categories (org_id, name)
SELECT 'demo', 'Appliances'
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE org_id = 'demo' AND name = 'Appliances');

INSERT INTO products (org_id, category_id, name, list_price)
SELECT 'demo', category_id, 'Compact Desk Fridge', 149.00
FROM categories WHERE org_id = 'demo' AND name = 'Appliances'
  AND NOT EXISTS (SELECT 1 FROM products WHERE org_id = 'demo' AND name = 'Compact Desk Fridge');

UPDATE products p SET description = d.description
FROM (VALUES
  ('Ergo Chair',          'Adjustable office chair with lumbar support for long hours of sitting.'),
  ('Standing Desk',       'Electric height-adjustable desk so you can work sitting or standing.'),
  ('Bookshelf',           'Five-shelf wooden bookcase for books, binders and files.'),
  ('Desk Lamp',           'LED desk lamp with adjustable arm and brightness for reading and paperwork.'),
  ('LED Bulb Pack',       'Pack of four energy-saving warm white light bulbs.'),
  ('Wireless Mouse',      'Cordless mouse with a USB receiver and long battery life.'),
  ('Mechanical Keyboard', 'Durable keyboard with tactile keys for fast, comfortable typing.'),
  ('USB-C Hub',           'Adapter that adds HDMI, USB and card reader ports to a laptop.'),
  ('Laptop Stand',        'Aluminium stand that raises a laptop screen to eye level.'),
  ('Noise-Cancelling Headphones', 'Over-ear headphones that block background noise for calls and focus.'),
  ('Desk Speaker',        'Compact speaker for music and video calls at your desk.'),
  ('Cable Organizer Kit', 'Clips, sleeves and ties to keep cables tidy under and behind the desk.'),
  ('Monitor Arm',         'Clamp-on arm that holds a monitor at any height and angle.'),
  ('Compact Desk Fridge', 'Small refrigerator that keeps drinks, food or medicine cold, quiet enough for an office.')
) AS d(name, description)
WHERE p.org_id = 'demo' AND p.name = d.name;
