# Step 07 notes

## Local setup

- Worker: `learn-mcp-step-07`.
- Auth D1 database: `learn-mcp-step-07-auth`, id `cea63cb4-dca4-4844-8bcf-4ea3ae2f8714`.
- Settings KV namespace: `LEARN_MCP_STEP_07_SETTINGS`, id `d8a57e5fabd4442e964a2026af4dfe0d`, bound as `SETTINGS_KV`.
- Shared and enterprise Hyperdrive IDs in `wrangler.jsonc` are placeholders until the two Step 07 Neon databases are created.
- `.dev.vars` is local-only and ignored. Never commit connection strings, tokens or generated secrets.

## Code

- `src/tenant.ts` resolves one tenant context per request and provides `tenantKey()`, `tenantObjectName()`, `tenantEnvelope()`, `resolveTenant()` and `forTenant()`.
- `src/tenant-router.ts` returns a SQL client for the shared or enterprise tier.
- `src/company-settings.ts` stores settings in Neon under RLS and provides a memory store for local tests.
- `src/index.ts` adds `list_my_companies`, `get_company_settings`, `update_company_settings`, `invite_member` and `remove_member`. Every tool input schema is strict, so a model cannot smuggle in a company or user id.
- `db/migrations/005_tenant_registry.sql` and `006_company_settings.sql` add forced RLS to the tenant registry and company settings.

## Verification

- `npm run typecheck` passes.
- `npm test` passes 21 tests in two files.
- `TENANCY.md` records the isolation decision and the test results.

## Shared-tier live setup

- Created the `step7` Neon branch from `step6` with data included. The owner URL was supplied locally and is never recorded here.
- The inherited `learn_mcp_connector` role was reset to a generated password, and the connector URL was written only to `.dev.vars`.
- `npm run migrate` applied `005_tenant_registry.sql` and `006_company_settings.sql`; `npm run grant-connector` succeeded.
- Shared Hyperdrive config: `learn-mcp-step-07-shared`, id `8c281ce071954d0e83b5b67da320d076`, bound as `HYPERDRIVE`, caching disabled.
- Worker: `https://learn-mcp-step-07.learn-mcp-step-01.workers.dev`. Version ID `1494e4c6-797f-49e2-9c79-355006ec4186`.
- `/healthz` reports `database: shared` and `dedicated: not configured`. `/__migrate` created all Better Auth tables.
- Demo user: `learner-step07@example.com` / `LearnMcpStep07!`, org `org-702354f8-b9dd-4550-b88a-842b16eca5dd`, role admin.
- Seeded the shared org with `npm run seed -- <shared-org-id>` and inserted its `public.tenants` and `public.company_settings` rows.
- RLS verified: all eight business tables have `relrowsecurity = true` and `relforcerowsecurity = true`. The connector returns no rows without a tenant and `[12, 4, 3, 6, 11, 14, 1, 1]` with the shared org, in transaction.
- Live MCP check passed: 11 tools listed; `list_orders`, `get_company_settings` and `list_my_companies` returned only the signed-in company's data; `get_company_settings({ userId: "user-other" })` was refused by strict input validation.

## Enterprise-tier live setup

- Created a second Neon branch from `step6` for the dedicated tier. The owner URL was supplied locally and is never recorded here.
- The enterprise connector role was created with a generated password and least-privilege flags; its URL is only in ignored `.dev.vars`.
- `npm run migrate` applied `005_tenant_registry.sql` and `006_company_settings.sql` to the enterprise database; `npm run grant-connector` granted privileges on both databases.
- Enterprise Hyperdrive config: `learn-mcp-step-07-enterprise`, id `da28fda154f34cc59cf0d6cbd5108865`, bound as `ENTERPRISE_HYPERDRIVE`, caching disabled.
- Demo enterprise user: `enterprise-step07@example.com` / `EnterpriseStep07!`, org `org-94b0467a-93fc-4e76-8488-2e5bffdeafd1`, role admin.
- D1 organization metadata was set with `json_object('tier','enterprise','databaseBinding','ENTERPRISE_HYPERDRIVE')`; plain quoted JSON was mangled by the shell, so `json_object` is the reliable form here.
- Seeded enterprise sales data with `npx tsx scripts/seed.ts --enterprise <enterprise-org-id>` and inserted its `public.tenants` and `public.company_settings` rows.
- A first seed attempt used the wrong argument and wrote rows for a bad org id; those rows were deleted before re-seeding.
- Final deploy Version ID: `45337bcb-ff8b-4c84-931b-bbb9ec5d6d95`. `/healthz` now reports `database: shared` and `dedicated: configured`.
- `npm run typecheck` and `npm test` pass with 21 tests after the enterprise binding was added.

## Cross-tenant live proof

- Shared user: `list_orders`, `get_company_settings` and `list_my_companies` report org `org-702354f8-b9dd-4550-b88a-842b16eca5dd`, tier `shared`, binding `HYPERDRIVE`.
- Enterprise user: the same tools report org `org-94b0467a-93fc-4e76-8488-2e5bffdeafd1`, tier `enterprise`, binding `ENTERPRISE_HYPERDRIVE`.
- Neither response contained the other company's id or data. Strict tool input schemas refuse `orgId`, `userId` and `companyId` arguments.

## Switching users in one browser

- Claude reused the shared Better Auth cookie for both connectors because both use the same Worker URL. The connector name does not choose the account; the signed-in cookie does.
- Added `/sign-out` and a **Sign in as a different user** link on `/sign-in`. The endpoint clears Better Auth session cookies and returns to the OAuth sign-in page.
- Use `https://learn-mcp-step-07.learn-mcp-step-01.workers.dev/sign-out` in the browser that Claude opens for OAuth, then reconnect the connector and sign in with the other user.
- Final deploy Version ID after this helper: `61983d27-a9ce-409b-bfb2-41ae4d5c23a3`.

## Claude Desktop manual pass

- Shared connector passed: 11 tools listed; settings `USD`, threshold `1000.00`, tier `shared`, binding `HYPERDRIVE`; `list_orders` limit 3 returned `ORD-1011`, `ORD-1010`, `ORD-1009` with next cursor `3`; `list_my_companies` showed one admin membership; `userId` was refused by input validation.
- Enterprise connector passed: settings `USD`, threshold `5000.00`, tier `enterprise`, binding `ENTERPRISE_HYPERDRIVE`; `list_orders` limit 2 returned `ORD-1011`, `ORD-1010` with next cursor `2`; `list_my_companies` showed one admin membership for the enterprise org.

## Pending live work

- Test both connector users in ChatGPT developer mode with the prompts from the step README.
