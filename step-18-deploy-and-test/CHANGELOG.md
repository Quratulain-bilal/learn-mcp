# Changelog

## 1.0.0 (step 18)

First release with staging and production Workers, CI gates and a cross-client release checklist.

- Same tools as step 17 (sales, orders, policies, company admin, drafts, imports, reports, tasks, events), with step 16 security hardening and step 17 structured logs, spans, 30-prompt eval set and retrieval guard.
- New: `GET /version` returns `{ name, release, environment }`.
- Deployed as `learn-mcp-step-18` (production) and `learn-mcp-step-18-staging` (staging). KV namespaces, queues and Workflow names are separate.
- Isolated Neon databases were created and migrated for dev, staging and production, each with a dedicated-tenant database. The cross-tenant suite passes 144/144 against the staging database configuration.
- D1 auth is separate: staging uses `learn-mcp-step-12-auth` with its own secret and signing key; production keeps `learn-mcp-step-13-auth`. The staging test users and company were copied so the manual plan still works, but sessions and tokens were cleared during the move.
- Cloudflare's free-plan quota blocks new Hyperdrive configs, so both live Workers still share one Hyperdrive config. Binding the isolated Neon databases requires a paid plan or deleting older resources.
