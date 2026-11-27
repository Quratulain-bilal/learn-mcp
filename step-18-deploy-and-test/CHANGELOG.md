# Changelog

## 1.0.0 (step 18)

First release with separate **staging** and **production** environments.

- Same tools as step 17 (sales, orders, policies, company admin, drafts, imports, reports, tasks, events), with step 16 security hardening and step 17 structured logs, spans, 30-prompt eval set and retrieval guard.
- New: `GET /version` returns `{ name, release, environment }`.
- Staging has its own sign-in database (D1 `learn-mcp-auth-staging`), Neon databases (`step18_staging`, `step18_staging_enterprise`), Hyperdrive configs, KV, queues, Workflow and Durable Objects. Production uses the step 8 databases and the shared sign-in database.
