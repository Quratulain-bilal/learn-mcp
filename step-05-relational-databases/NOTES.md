# Step 05 notes

I built on the Step 04 server and replaced the KV notes tools with a sales-data server backed by Neon Postgres. D1 still stores Better Auth data only. The Worker serves the same protected `/mcp` endpoint: a signed-in user's token supplies `sub` and `org_id`, the server rechecks the company membership in D1 on every request, and every sales query is parameterized with that `org_id`.

The flat data lives in `staging.flat_sales`, with repeated customer and product details and a few cells that contain two product names. That reproduces update, insert and delete anomalies. The normalized tables are `customers`, `categories`, `products`, `orders` and `order_items`. Each table carries `org_id`; primary and foreign keys include `org_id`, so a row cannot point at another company's row.

## Normalization walkthrough

- **1NF:** `product_names` in the staging table may contain `Laptop, Mouse` in one cell. The normalized `order_items` table gives each product its own row.
- **2NF:** In an order line, the product name, category and customer city do not depend on the whole `(order_id, line_no)` key. They move to `products`, `categories` and `customers`.
- **3NF:** A category name no longer depends on a product name; `products.category_id` points to `categories`. `unit_price` is deliberately copied onto `order_items` because the sale price at the time of the order must not change when the catalog price changes.

## ER diagram

```mermaid
erDiagram
  CUSTOMERS ||--o{ ORDERS : places
  CATEGORIES ||--o{ PRODUCTS : contains
  PRODUCTS ||--o{ ORDER_ITEMS : appears_in
  ORDERS ||--o{ ORDER_ITEMS : has

  CUSTOMERS {
    text org_id PK
    text customer_id PK
    text name
    text email
    text city
  }
  CATEGORIES {
    text org_id PK
    text category_id PK
    text name
  }
  PRODUCTS {
    text org_id PK
    text product_id PK
    text category_id FK
    numeric catalog_price
  }
  ORDERS {
    text org_id PK
    text order_id PK
    text customer_id FK
    date order_date
  }
  ORDER_ITEMS {
    text org_id PK
    text order_id PK
    integer line_no PK
    text product_id FK
    numeric unit_price
    integer quantity
  }
```

## Tools

- `describe_schema`: reads table, column and key metadata for the five normalized tables and the staging table.
- `answer_business_question`: accepts one of ten named questions and runs a fixed, reviewed, parameterized SQL query. It never accepts SQL from the model.
- `compare_designs`: runs the named question against both the flat and normalized designs and reports the anomalies.
- `explain_sales_schema`: a prompt that asks the model to explain keys, normal forms and the deliberate price copy.

## How to run

```powershell
cd step-05-relational-databases
npm install
npm test
npm run typecheck
npm run dev
```

For live Neon setup, create a Neon branch named `step-05`, copy `.dev.vars.example` to `.dev.vars`, and put the connection string on the `NEON_DATABASE_URL` line. The scripts read `.dev.vars` when the environment variable is not set:

```powershell
npm run migrate
```

Find your signed-in account's organization id from the Step 05 auth D1 database, then copy the demo sales rows into your company:

```powershell
npm run seed -- <your-org-id>
```

Store the same connection string as a Worker secret and deploy:

```powershell
npx wrangler secret put NEON_DATABASE_URL
npm run deploy
```

The live Neon connection string is intentionally not committed. The automated tests use a deterministic in-memory sales store, so they check authentication, tenant scoping, tool registration and fixed SQL use without requiring live credentials.

## Live verification

- Migration applied all three SQL files to the `step-05` Neon branch: 12 staging rows, 4 customers, 3 categories, 6 products, 11 orders and 14 order items.
- The remote auth D1 database was migrated with the protected `/__migrate` endpoint. The demo sales rows were seeded into `org-5bc01fd0-e02f-4abe-a97c-f973822ad1bc`.
- The Worker is deployed at `https://learn-mcp-step-05.learn-mcp-step-01.workers.dev`, and the protected MCP endpoint is `https://learn-mcp-step-05.learn-mcp-step-01.workers.dev/mcp`.
- A full live OAuth flow with dynamic client registration, PKCE, consent and token exchange returned 200. MCP `initialize`, `tools/list`, `describe_schema`, `answer_business_question` and `compare_designs` all returned 200 with seeded tenant data.
- The demo sign-in email for this live check is `learner-step05@example.com`; the password was shared separately and is intentionally not stored in this file.

Two Cloudflare CLI details mattered in this fork: `wrangler secret put --env-file .dev.vars` uploaded empty values, so secrets were set by piping the values from `.dev.vars` instead. When `BETTER_AUTH_SECRET` changed after JWKS rows had already been created, the token endpoint returned 500 until the `jwks` table was cleared and Better Auth generated fresh keys.
