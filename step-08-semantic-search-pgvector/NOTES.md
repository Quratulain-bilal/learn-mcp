# Step 08 notes (local)

## Shared-tier setup

- Scaffolded from step 07; Worker `learn-mcp-step-08`, D1 `learn-mcp-step-08-auth` (`3a709107-3bd2-4f64-a1ea-dcb9a617be72`), KV `LEARN_MCP_STEP_08_SETTINGS` (`c6fc6dae50e542bf87abad4a5210efa8`), AI binding added.
- Neon branch `step-08` (parent `step-07`): owner URL kept only in ignored `.dev.vars`.
- Least-privilege connector role `learn_mcp_connector` created; shared Hyperdrive `learn-mcp-step-08-shared` (`9c26ec5254ff4704abf1eced81b58353`), caching disabled, bound as `HYPERDRIVE`.
- Migrations: `007_pgvector.sql` (extension, `policy_documents`, `policy_passages vector(1024)`, product embedding column, HNSW indexes, forced RLS) and `008_product_descriptions.sql` (`products.description`).
- Secrets uploaded with the pipe method: `BETTER_AUTH_SECRET`, `MIGRATION_TOKEN`, `RETRIEVAL_THRESHOLD=0.60`.
- Deployed: `https://learn-mcp-step-08.learn-mcp-step-01.workers.dev`, final version `097fa177-fc62-4a5f-b611-e554d32beb0e`.
- `/healthz`: `database shared`, `dedicated configured`.
- Demo user `learner-step08@example.com` / `LearnMcpStep08!`, org `org-1a92c8ad-ae66-41fe-969a-2276ed45b7a5`, seeded; tenant registry + company settings rows inserted.
- `npm run embed` stored 3 policy documents (9 passages) and 6 product descriptions for each tenant with real `@cf/baai/bge-m3` through the Worker's `AI` binding (`/api/embed`, token-protected).

## Retrieval eval (real model)

- `npm run eval:retrieval` with `EMBEDDING_MODE=ai`: **found-in-top-three 10/10, correct abstentions 2/2** across both tenants.
- Threshold chosen: **0.60**. Measured top similarities: relevant questions 0.66–0.87; off-topic "cold storage rental" 0.49. 0.35 let the off-topic question through, so the Worker secret was updated.
- Deterministic test embedder (`EMBEDDING_MODE=test`) used by unit tests and CI; no network in tests.

## Live MCP check (shared)

- 14 tools listed (11 from step 07 + `search_sales_policy`, `find_products`, `add_policy_document`).
- `search_sales_policy` "How long can a customer return an opened item?" → cited `returns-policy:1`, similarity 0.770.
- Off-topic question → `abstained: true` with the abstain message.
- `find_products` "something portable for typing" → 3 products (0.594 / 0.538 / 0.522).

## Enterprise-tier live setup

- Created `step-08-enterprise` from `step-07` with data included; the owner URL was used locally only and is never recorded here.
- Reset the inherited `learn_mcp_connector` password and wrote the connector URL only to ignored `.dev.vars`.
- Migrations `007_pgvector.sql` and `008_product_descriptions.sql` were applied to the enterprise database; connector grants were refreshed.
- Enterprise Hyperdrive config: `learn-mcp-step-08-enterprise`, id `6a50544b0b6041809c4ea665b4df8b88`, bound as `ENTERPRISE_HYPERDRIVE`, caching disabled.
- Demo enterprise user: `enterprise-step08@example.com` / `EnterpriseStep08!`, org `org-2a528914-b602-40fb-a940-471962dcdb4d`, role admin.
- D1 organization metadata was set with `json_object('tier','enterprise','databaseBinding','ENTERPRISE_HYPERDRIVE')`.
- Seeded enterprise sales data with `npx tsx scripts/seed.ts --enterprise <enterprise-org-id>` and inserted its `public.tenants` and `public.company_settings` rows.
- An npm-argument mistake seeded the enterprise org into the shared database twice; all rows for that org were removed from the shared database before re-seeding the enterprise branch correctly.

## Cross-tenant live proof

- Both users list 14 tools; neither response contains the other company's id or data.
- Shared settings: org `org-1a92c8ad-ae66-41fe-969a-2276ed45b7a5`, tier `shared`, binding `HYPERDRIVE`, threshold `1000.00`.
- Enterprise settings: org `org-2a528914-b602-40fb-a940-471962dcdb4d`, tier `enterprise`, binding `ENTERPRISE_HYPERDRIVE`, threshold `5000.00`.
- "Highest discount an admin may approve" cites `discount-policy:3` in both tenants, but with different content: shared says 10 percent, enterprise says 5 percent.
- Off-topic questions abstain in both tenants. `find_products` returns tenant-scoped product ids.
- Strict input validation refuses `orgId`: `Unrecognized key: "orgId"` with `isError: true`.

## Verification

- `npm run typecheck` passes; `npm test` passes 25 tests; `npm run eval:retrieval` passes 12 questions with the real model.
- Commit `a140d2b` and tag `step-08-done` were pushed before the enterprise live setup; the enterprise config changes still need a follow-up commit and tag move.
