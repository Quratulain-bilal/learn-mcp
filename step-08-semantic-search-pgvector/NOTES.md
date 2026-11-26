# Step 08 notes (local)

## Shared-tier setup

- Scaffolded from step 07; Worker `learn-mcp-step-08`, D1 `learn-mcp-step-08-auth` (`3a709107-3bd2-4f64-a1ea-dcb9a617be72`), KV `LEARN_MCP_STEP_08_SETTINGS` (`c6fc6dae50e542bf87abad4a5210efa8`), AI binding added.
- Neon branch `step-08` (parent `step-07`): owner URL kept only in ignored `.dev.vars`.
- Least-privilege connector role `learn_mcp_connector` created; shared Hyperdrive `learn-mcp-step-08-shared` (`9c26ec5254ff4704abf1eced81b58353`), caching disabled, bound as `HYPERDRIVE`.
- Migrations: `007_pgvector.sql` (extension, `policy_documents`, `policy_passages vector(1024)`, product embedding column, HNSW indexes, forced RLS) and `008_product_descriptions.sql` (`products.description`).
- Secrets uploaded with the pipe method: `BETTER_AUTH_SECRET`, `MIGRATION_TOKEN`, `RETRIEVAL_THRESHOLD=0.60`.
- Deployed: `https://learn-mcp-step-08.learn-mcp-step-01.workers.dev`, version `6b2062a2-daa0-47bd-a8c7-9a5380cc2d5e`.
- `/healthz`: `database shared`, `dedicated not configured` (enterprise binding intentionally removed until the step-08 enterprise branch exists).
- Demo user `learner-step08@example.com` / `LearnMcpStep08!`, org `org-1a92c8ad-ae66-41fe-969a-2276ed45b7a5`, seeded; tenant registry + company settings rows inserted.
- `npm run embed` stored 3 policy documents (9 passages) and 6 product descriptions with real `@cf/baai/bge-m3` through the Worker's `AI` binding (`/api/embed`, token-protected).

## Retrieval eval (real model)

- `npm run eval:retrieval` with `EMBEDDING_MODE=ai`: **found-in-top-three 5/5, correct abstentions 1/1** for the shared company (enterprise questions skipped until its branch exists).
- Threshold chosen: **0.60**. Measured top similarities: relevant questions 0.66–0.87; off-topic "cold storage rental" 0.49. 0.35 let the off-topic question through, so the Worker secret was updated.
- Deterministic test embedder (`EMBEDDING_MODE=test`) used by unit tests and CI; no network in tests.

## Live MCP check (shared)

- 14 tools listed (11 from step 07 + `search_sales_policy`, `find_products`, `add_policy_document`).
- `search_sales_policy` "How long can a customer return an opened item?" → cited `returns-policy:1`, similarity 0.770.
- Off-topic question → `abstained: true` with the abstain message.
- `find_products` "something portable for typing" → 3 products (0.594 / 0.538 / 0.522).

## Pending

- Enterprise branch `step-08-enterprise` (parent `step7-enterprise`, include data, auto-delete Never): owner URL needed, then connector role, migration 007/008, Hyperdrive `ENTERPRISE_HYPERDRIVE`, enterprise user + seed + embed, full 12-question eval, two-tenant client tests.
- Claude/ChatGPT manual prompts, screenshots, commit/push/tag.
