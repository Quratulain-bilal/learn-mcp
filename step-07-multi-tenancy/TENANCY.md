# Tenancy decision record

## Question

One MCP Worker serves many companies. We need to decide how company data is isolated, where the company comes from, and how every later feature carries it.

## Isolation models

| Model | Isolation | Cost | Migrations | Noisy neighbours | Backups and compliance | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Shared schema with row-level security | Strong when `app.tenant_id` is set per transaction and RLS is forced | Lowest; one pool and one schema | One migration set | Shared compute and connections | One backup contains every company, filtered by policy | Default for shared-tier companies |
| Schema per company | Strong; separate schema names | Medium; many schemas in one database | Run each migration across every schema | Partial; still one database | Easier logical separation, still one physical backup | Not chosen; more machinery without a dedicated tier |
| Database or Neon project per company | Strongest; separate database and connection | Highest | Run each migration across every database | Best; isolated compute and connections | Separate backup and region per company | Enterprise tier only |

## Decision

This step uses shared tables with forced row-level security for ordinary companies, and a dedicated Neon database behind a second Hyperdrive binding for the enterprise tier. Tools call one data layer and never choose a database. `resolveTenant` reads the company, user, role, tier and database binding once from the verified token and membership row. `TenantRouter` turns the tier into the right SQL client. Every business query goes through `forTenant`, which sets `app.tenant_id` for one transaction only.

## Every place that carries the company

- Sales tools: company comes from `claims.org_id`, never from tool arguments. All tool input schemas are strict and reject `orgId` and `userId`.
- Business data: every row has `org_id`; RLS is enabled and forced on all sales tables, the tenant registry and company settings.
- Tenant context: `{ orgId, userId, role, tier, databaseBinding, requestId }` is resolved on every request, so removal or demotion takes effect on the next call.
- Company tools: `list_my_companies`, `get_company_settings`, `update_company_settings`, `invite_member` and `remove_member` use the caller's own company.
- KV: settings are cached under `org:<orgId>:settings` through `tenantKey()`, with a private entry per company.
- Later features: `tenantObjectName()` names Durable Objects and `tenantEnvelope()` supplies the `{ orgId, userId, requestId }` envelope for queues, Workflows, tasks and events.

## Test results

`npm test` runs 21 tests across `test/server.spec.ts` and `tests/tenancy/tenancy.spec.ts`.

The suite covers strict tool schemas, two companies on shared and enterprise tiers, membership removal, demotion of an admin, a forged company in a token, private KV settings, forced RLS policies on the new tables, and a planted query outside `forTenant`. Every cross-company attempt fails or returns only the caller's rows.

Both tiers are deployed and live-checked. Shared data stays in `HYPERDRIVE`; enterprise data stays in `ENTERPRISE_HYPERDRIVE`. Two-company client checks in Claude and ChatGPT are recorded in `NOTES.md` when complete.
