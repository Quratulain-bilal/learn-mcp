# Step 04 notes

## What is implemented

- Remote MCP server `learn-mcp-step-04` using the stateless Cloudflare MCP handler.
- Better Auth with email/password, JWT, organization and MCP OAuth provider plugins.
- Cloudflare D1 database `learn-mcp-step-04-auth` for auth data.
- Better Auth schema is created with `getMigrations()` from a protected worker endpoint.
- OAuth metadata, sign-in page, consent page and bearer-token verification on `/mcp`.
- Dynamic client registration is enabled because Claude custom connectors need it. CIMD is not used in this step.
- Every user gets a personal company with the `admin` role on first sign-up.
- The active organization is stored in the session and placed in the access token as `org_id`.
- Membership and role are re-read from D1 on every MCP request.
- Notes use the key pattern `org:<orgId>:user:<userId>:note:<noteId>`.
- Admin-only tool `list_company_members` demonstrates role checks.

## Local verification

- `npx tsc --noEmit` passes.
- `npm test -- --run` passes 5 integration tests, including no-token rejection, tenant-scoped notes and member/admin checks.

## Deployment notes

- Set `BETTER_AUTH_SECRET` and `MIGRATION_TOKEN` with `wrangler secret put` before deploying.
- After deploy, call `POST /__migrate?token=<MIGRATION_TOKEN>` once to create the Better Auth tables.
- The migration endpoint returns 404 without the token; remove or keep it protected.
- Manual OAuth checks in claude.ai, Claude Desktop and ChatGPT are still required.
- No SSO provider is configured; the course marks this as optional for this step.
