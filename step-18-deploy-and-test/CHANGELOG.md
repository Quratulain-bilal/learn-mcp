# Changelog

## 1.0.0 (step 18)

First release with a staging Worker, CI gates and a cross-client release checklist.

- Same tools as step 17 (sales, orders, policies, company admin, drafts, imports, reports, tasks, events), with step 16 security hardening and step 17 structured logs, spans, 30-prompt eval set and retrieval guard.
- New: `GET /version` returns `{ name, release, environment }`.
- Configured as `learn-mcp-step-18` (production) and `learn-mcp-step-18-staging` (staging); staging is deployed. KV namespaces, queues and Workflow names are separate, but both environments reuse the step 13 D1 auth database and the same Hyperdrive config for Neon, so auth and business data are shared between them.
