# Step 08 tenant isolation

## Model

- Tenant comes from the verified Better Auth session only. Tools never accept `orgId`, `userId` or `companyId`.
- Shared-tier company uses `HYPERDRIVE`; enterprise company uses `ENTERPRISE_HYPERDRIVE`.
- Business tables, policy documents, policy passages and product embeddings carry `org_id` and are protected by forced RLS with `current_setting('app.tenant_id', true)`.
- Every query sets the tenant with `set_config` inside a transaction via `forTenant()`.

## Live evidence

- Shared org `org-1a92c8ad-ae66-41fe-969a-2276ed45b7a5`: tier `shared`, binding `HYPERDRIVE`, threshold `1000.00`.
- Enterprise org `org-2a528914-b602-40fb-a940-471962dcdb4d`: tier `enterprise`, binding `ENTERPRISE_HYPERDRIVE`, threshold `5000.00`.
- Both tenants cite `discount-policy:3` for the discount question, but with different tenant-specific content, proving the databases are separate.
- Off-topic questions abstain. Product search returns only the signed-in tenant's product ids.
- Passing `{ orgId: "org-other" }` to `get_company_settings` is refused: `Unrecognized key: "orgId"`.
- Retrieval eval: 10/10 top-three answers and 2/2 abstentions across both tenants with `bge-m3` embeddings.
