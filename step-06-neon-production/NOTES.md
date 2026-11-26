# Step 06 notes

This step makes the Step 05 sales server production-ready. Auth stays in D1. Neon remains the business database, but this step adds pooled access through Cloudflare Hyperdrive, paginated reads, a transactional write, and row-level security enforced inside Postgres.

The Worker no longer trusts application filters alone. Every sales query runs through `forTenant`, which opens a transaction, calls `set_config('app.tenant_id', $1, true)` with the company id from the verified token, then runs the reviewed query. The company id is also a bound parameter in every query, and `FORCE ROW LEVEL SECURITY` with matching `USING` and `WITH CHECK` policies makes a missing company fail closed with no rows.

## What changed from Step 05

- A new Neon branch `step-06` was created from the branch available as `production` in this fork, leaving the earlier live branch untouched.
- Hyperdrive sits in front of that branch, with query caching disabled because a cached answer cannot see the per-transaction tenant setting.
- `NEON_DATABASE_URL` is used by the local migration and seed scripts. The deployed Worker reads `HYPERDRIVE.connectionString`.
- The Worker uses `pg` through Hyperdrive. `@neondatabase/serverless` is only used by local scripts, because Cloudflare Hyperdrive does not support Neon's serverless HTTP driver.
- A least-privilege `learn_mcp_connector` role is used by the Worker. It can read and write business rows but cannot change the schema and must not have `BYPASSRLS`.

## Tools

- `list_orders`: filters by date range, customer and product, with opaque offset cursor paging and a default page size of 20.
- `get_sales_summary`: totals grouped by month, product or customer, limited to 20 rows for context budgeting.
- `create_order`: validates strict ids, dates and quantities, then inserts the order and its lines in one transaction. The catalog price is copied into `order_items.unit_price`.
- `describe_schema`, `answer_business_question`, `compare_designs` and the `explain_sales_schema` prompt are kept from Step 05.

## RLS and planted bugs

`004_row_level_security.sql` enables and forces row-level security on `staging.flat_sales`, `customers`, `categories`, `products`, `orders` and `order_items`. Each policy uses `org_id = current_setting('app.tenant_id', true)` for both `USING` and `WITH CHECK`.

The data matrix test acts as two companies against every read tool and checks that no result contains the other company's id. The audit tests plant three bugs before checking that the suite catches them: missing `FORCE ROW LEVEL SECURITY`, missing `WITH CHECK`, and a query that runs outside `forTenant`.

## How to run

```powershell
cd step-06-neon-production
npm install
npm test
npm run typecheck
npm run dev
```

For live setup, create the `step-06` Neon branch from `step-05`, copy `.dev.vars.example` to `.dev.vars`, and set the owner connection string on `NEON_DATABASE_URL`. Apply migrations, then grant privileges to the connector role and seed your signed-in company:

```powershell
npm run migrate
npm run grant-connector
npm run seed -- <your-org-id>
```

Create a Hyperdrive config for the connector connection string with caching disabled, add it to `wrangler.jsonc` as the `HYPERDRIVE` binding, set the Worker secrets, and deploy:

```powershell
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put MIGRATION_TOKEN
npm run deploy
```

## Live verification

The Worker is deployed as `learn-mcp-step-06` with Hyperdrive config `4972edc115d84a89ad427943c0356fed`. `/healthz` reported `database: hyperdrive`, and `/__migrate` created the Better Auth tables in the new `learn-mcp-step-06-auth` D1 database.

All six business tables show `relrowsecurity = true` and `relforcerowsecurity = true`. With the owner connection string the seeded company has 12 flat rows, 4 customers, 3 categories, 6 products, 11 orders and 14 order items. With the connector role and no tenant setting every table returns 0 rows; with `app.tenant_id` set to the company id the same counts return.

The live MCP OAuth flow was completed in the browser-style sign-in and consent pages. All six tools are listed. `list_orders` returned 3 rows on the first page with cursor `3`, `get_sales_summary` returned 6 monthly rows, `answer_business_question` returned 5 product rows, `describe_schema` returned 6 tables with their keys, and `create_order` committed a real order with total `1200.00`. Read tools put their compact JSON in the text content as well as `structuredContent`, because some chat clients do not surface structured content to the model. The schema key query qualifies `table_name` as `tc.table_name` so the join with `information_schema.key_column_usage` is not ambiguous.

The live connection strings and generated secrets are intentionally not committed. Automated tests use a deterministic in-memory sales store and a fake SQL client, so they check tool behavior, tenant scoping, transaction setup and the RLS audit without live credentials.
