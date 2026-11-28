# Step 18 notes: production deploy, staging, CI/CD and testing

Built on **step 17**; the observability spans, eval set and free eval shape test were carried forward, then the deploy/test layer was added on top.

## Environments

| | dev | staging | production |
| --- | --- | --- | --- |
| How | `npm run dev`, `npm test` (local) | `npm run deploy:staging` | `npm run deploy:production` |
| Worker | local | `learn-mcp-step-18-staging` | `learn-mcp-step-18` |
| URL | localhost | https://learn-mcp-step-18-staging.learn-mcp-step-01.workers.dev/mcp | https://learn-mcp-step-18.learn-mcp-step-01.workers.dev/mcp |
| Sign-in (D1) | local | `learn-mcp-step-12-auth` | `learn-mcp-step-13-auth` |
| Neon | `.env` (`step18_dev`) | isolated `step18_staging` data is created and tested, but the live Worker still reads the shared step 13 database through Hyperdrive | isolated `step18_production` data is created and tested, but the live Worker still reads the shared step 13 database through Hyperdrive |
| Hyperdrive | local strings | same config as production | `4f5bd0da7ddb4449bbec9a122c994cdf` for both bindings |
| Queues | local | `order-imports-step-18-staging`, `sales-events-step-18-staging` | `order-imports-step-18`, `sales-events-step-18` |
| Workflow | local | `learn-mcp-step-18-staging-sales-report` | `learn-mcp-step-18-sales-report` |
| KV | local | `8690e3bfbdd646c4a285554dbdc79447` | `5006c033fb2b4ba5ac2ee1d45766645e` |
| `BETTER_AUTH_SECRET` | `.dev.vars` | uploaded from the step 12 value via `wrangler versions secret put`; never printed | uploaded from the step 16 value; never printed |

All in `wrangler.jsonc`: the top level is production (and dev), and `env.staging` repeats **every** binding because bindings aren't inherited. KV, queues, Workflow and D1 auth are separate per environment: staging uses `learn-mcp-step-12-auth`, production uses `learn-mcp-step-13-auth`. Each has its own `BETTER_AUTH_SECRET`, sessions and signing keys; sessions and tokens were cleared when staging moved. The table shows the resources the deployed Workers use; the free-plan quota still blocks new Hyperdrive configs, so staging and production reuse one Hyperdrive config. Isolated Neon databases are created, migrated and available for tests, but need new Hyperdrive configs before they can be bound. `ENVIRONMENT` is a var per environment.

- **Scripts** accept `ENV_FILE` (for example `npm run db:migrate:staging` sets `ENV_FILE=.env.staging`), so migrations, seeding, embedding and `tenant:dedicate` work per environment. Added `db:migrate:production`, `db:seed:staging`, `db:seed:production` and `test:staging`. `npm run auth:migrate:staging` applies the D1 auth schema to staging.
- **No custom domain:** it needs a domain you pay for. The commented `routes` entry in `wrangler.jsonc` shows where one goes. `preview_urls` is off, so untested versions don't get public URLs.
- **`GET /version`** returns `{ name, release, environment }`. `RELEASE` lives in `src/version.ts`.

## CI/CD

`.github/workflows/step-18-ci.yml` (repo root, where GitHub looks):

1. Every push or PR touching the step runs `npm ci`, `typecheck`, `npm test` and the free retrieval eval. With the `STAGING_DOTENV` secret, the database tests, **including the cross-tenant suite**, run against the configured staging bindings. Without it, they're skipped.
2. A push to `main` deploys **staging** and smoke-checks `/version` and the 401 on `/mcp`. Set a `WORKER_BASE_URL` variable in the GitHub `staging` environment (the Worker origin, without `/mcp`) before the smoke check.
3. The 30-prompt step 17 tool-choice eval is carried forward in `EVALS.md` and `evals/tool-choice.json`. It is **opt-in** because it spends Anthropic API credits: run the workflow manually with `run_paid_eval` ticked after setting `ANTHROPIC_API_KEY`, `EVAL_STAFF_TOKEN` and `EVAL_MANAGER_TOKEN` secrets. The script fails the job if any prompt fails.
4. The **production** job also needs a manual workflow dispatch with `deploy_production` ticked, uses the GitHub `production` environment with required reviewers, and smoke-checks `/version` and the 401 on `/mcp`. Set `WORKER_BASE_URL` in that environment too. If you tick `run_paid_eval` at the same time, production waits for it. No Anthropic key was supplied in this fork session, so the paid eval remains configured but unrun.

I can't run the workflow from here (it needs your GitHub repo, secrets and environment variables). Its setup is at the top of `.github/workflows/step-18-ci.yml`.

## Release checklist and rollback

**RELEASE.md**: versioning, changelog, additive migrations, staging first, gradual rollout with `wrangler versions deploy new@10% old@90%`, what to watch in the logs after a release, and rollback commands.

**Practice rollback:** done on staging: deployed `1.0.1`, confirmed `/version`, rolled back to `1.0.0`, confirmed `/version`, and restored `RELEASE` in code.

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

- Staging deployed as `learn-mcp-step-18-staging`; `/version` reports `{"name":"learn-mcp-step-18","release":"1.0.0","environment":"staging"}`, `/mcp` returns 401 without a token, and `/sign-in` returns 200.
- Staging KV namespace and four step 18 queues were created. D1 auth is now separate: staging uses `learn-mcp-step-12-auth`, production uses `learn-mcp-step-13-auth`, with different secrets and signing keys. Hyperdrive is still reused from step 13.
- Claude.ai staging: admin prompts 1–10 pass (10/10), including the Ayesha Khan orders retry; member role/company-switch and member write-denial prompts pass (2/2).
- ChatGPT staging (developer mode): admin flow passed — role `Admin`, currency restored to `EUR` with threshold `1,000`, 27 tools listed, schema/questions/widgets/events passed, report approved and `published` / `complete` verified. Member flow passed (3/3): role `member`, write denied, settings still `EUR` / `1,000`.
- Admin and member sessions/refresh tokens were revoked during troubleshooting; both connectors were reconnected and the final checks above were made after that.
- Production deployed as-is (no new Neon database or D1) at `https://learn-mcp-step-18.learn-mcp-step-01.workers.dev`; `/version` reports `{"name":"learn-mcp-step-18","release":"1.0.0","environment":"production"}`, `/mcp` returns 401 without a token, and `/sign-in` returns 200.
- After carrying step 17 forward: `npm run typecheck`, `npm test -- --maxWorkers=1 --silent` (49 passed, 95 skipped) and `npm run eval:retrieval -- --embedder test` (100%) pass locally. Staging and production were deployed after these checks.
- Isolated Neon databases `step18_dev`, `step18_staging`, `step18_production` and their `_enterprise` counterparts were created and migrated (12 migrations each). `npm run test:staging -- --maxWorkers=1 --silent` runs the full suite, including the cross-tenant suite: 144/144 passed. A local run against `step18_dev` had one transient Neon timeout; the staging-config run is the release gate.
- Practice rollback on staging passed: `1.0.1` deployed, `/version` confirmed, rollback restored `1.0.0`, `/version` confirmed, source restored to `1.0.0`.
- Cloudflare free-plan limits block the final Hyperdrive isolation: Hyperdrive is capped at 10 configs. Four new configs (production shared/dedicated and staging shared/dedicated) need a paid plan or deleting older step resources. D1 auth is separate and the isolated Neon databases exist and are tested; both live Workers still use the step 13 Hyperdrive config.

## Types

With an `env` block, `wrangler types` drops the typed Durable Object and exports import, so `worker-configuration.d.ts` is the step 16 file plus `ENVIRONMENT`. To regenerate, remove the `env` block temporarily, run `npm run cf-typegen`, put the block back and re-add `ENVIRONMENT`.
