# Step 18 notes: production deploy, staging, CI/CD and testing

Built on **step 17**; the observability spans, eval set and free eval shape test were carried forward, then the deploy/test layer was added on top.

## Environments

| | dev | staging | production |
| --- | --- | --- | --- |
| How | `npm run dev`, `npm test` (local) | `npm run deploy:staging` | `npm run deploy:production` |
| Worker | local | `learn-mcp-step-18-staging` | `learn-mcp-step-18` |
| URL | localhost | https://learn-mcp-step-18-staging.awaismudasir10.workers.dev/mcp | https://learn-mcp-step-18.awaismudasir10.workers.dev/mcp |
| Sign-in (D1) | local | `learn-mcp-auth-staging` | `learn-mcp-auth` |
| Neon | `.env` (step 8 databases) | `step18_staging`, `step18_staging_enterprise` (`.env.staging`) | `step08`, `step08_tenant_enterprise` |
| Hyperdrive | local strings | 2 configs of its own | the step 8 configs |
| Queues | local | `order-imports-step-18-staging`, `sales-events-step-18-staging` | `order-imports-step-18`, `sales-events-step-18` |
| Workflow | local | `learn-mcp-step-18-staging-sales-report` | `learn-mcp-step-18-sales-report` |
| KV, Durable Objects | local | its own | its own |
| `BETTER_AUTH_SECRET` | `.dev.vars` | its own (generated, never printed) | the shared one |

All in `wrangler.jsonc`: the top level is production (and dev), and `env.staging` repeats **every** binding, because bindings aren't inherited, so **no users, companies, settings or data are shared** between environments. `ENVIRONMENT` is a var per environment.

- **Scripts** accept `ENV_FILE` (for example `npm run db:migrate:staging` sets `ENV_FILE=.env.staging`), so migrations, seeding, embedding and `tenant:dedicate` work per environment. `npm run auth:migrate:staging` applies the D1 auth schema to staging.
- **No custom domain:** it needs a domain you pay for. The commented `routes` entry in `wrangler.jsonc` shows where one goes. `preview_urls` is off, so untested versions don't get public URLs.
- **`GET /version`** returns `{ name, release, environment }`. `RELEASE` lives in `src/version.ts`.

## CI/CD

`.github/workflows/step-18-ci.yml` (repo root, where GitHub looks):

1. Every push or PR touching the step runs `npm ci`, `typecheck`, `npm test` and the free retrieval eval. With the `STAGING_DOTENV` secret, the database tests, **including the cross-tenant suite**, run against the staging databases. Without it, they're skipped.
2. A push to `main` deploys **staging** and smoke-checks `/version` and the 401 on `/mcp`. Set a `WORKER_BASE_URL` variable in the GitHub `staging` environment (the Worker origin, without `/mcp`) before the smoke check.
3. The 30-prompt step 17 tool-choice eval is carried forward in `EVALS.md` and `evals/tool-choice.json`. It is **opt-in** because it spends Anthropic API credits: run the workflow manually with `run_paid_eval` ticked after setting `ANTHROPIC_API_KEY`, `EVAL_STAFF_TOKEN` and `EVAL_MANAGER_TOKEN` secrets. The script fails the job if any prompt fails.
4. The **production** job also needs a manual workflow dispatch with `deploy_production` ticked, uses the GitHub `production` environment with required reviewers, and smoke-checks `/version` and the 401 on `/mcp`. Set `WORKER_BASE_URL` in that environment too. If you tick `run_paid_eval` at the same time, production waits for it.

I can't run the workflow from here (it needs your GitHub repo, secrets and environment variables). Its setup is at the top of `.github/workflows/step-18-ci.yml`.

## Release checklist and rollback

**RELEASE.md**: versioning, changelog, additive migrations, staging first, gradual rollout with `wrangler versions deploy new@10% old@90%`, what to watch in the logs after a release, and rollback commands.

**Practice rollback, done:** staging was deployed as `1.0.1` (`/version` confirmed it), then `wrangler rollback --env staging` brought back `1.0.0` within seconds (`/version` confirmed it), and the code was set back to `1.0.0`.

## Test plan

**TEST-PLAN.md**: a checklist per client (claude.ai, Claude Desktop, ChatGPT) covering:
- sign-in;
- every reading tool;
- all four widgets, including dark mode and text fallback;
- every write tool;
- search, skills and events;
- security (other company, member vs admin, confirmation, removal, rate limit);
- a production smoke section;
- a table of differences between clients.

## Verified

- Both environments deployed. `/version` reports `staging` / `production`, and `/mcp` returns 401 without a token on both.
- Staging databases created and migrated (12 migrations each), sample policies embedded, and the staging D1 auth schema applied.
- The practice rollback worked as described above.
- After carrying step 17 forward: `npm run typecheck`, `npm test -- --maxWorkers=1 --silent` (49 passed, 95 skipped) and `npm run eval:retrieval -- --embedder test` (100%) pass locally. No new deploy was made in this session.

## Types

With an `env` block, `wrangler types` drops the typed Durable Object and exports import, so `worker-configuration.d.ts` is the step 16 file plus `ENVIRONMENT`. To regenerate, remove the `env` block temporarily, run `npm run cf-typegen`, put the block back and re-add `ENVIRONMENT`.
