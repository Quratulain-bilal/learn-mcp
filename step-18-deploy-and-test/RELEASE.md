# Release checklist

Every change reaches production the same way: **tests → staging → manual approval → production → watch**. Rolling back takes one command.

## 1. Before the release

- [ ] **Version:** bump `RELEASE` in `src/version.ts` (semver: `1.0.1` fix, `1.1.0` new tool, `2.0.0` breaking change such as a renamed tool or a changed input).
- [ ] **Changelog:** add an entry to `CHANGELOG.md` (what changed, for whom, any migration).
- [ ] **Database migrations** (if any): new files in `db/migrations/` must only **add** things (tables, columns, wider checks) so the old release still works during the switch. Apply to staging first: `npm run db:migrate:staging` (every staging tenant database), and later `npm run db:migrate` for production.
- [ ] **Widgets changed?** Bump `VERSION` in `src/widgets/resources.ts` so hosts fetch the new widget.
- [ ] `npm run typecheck` and `npm test` pass locally.

## 2. Staging

- [ ] Merge to `main`: CI runs the tests (against the staging databases when `STAGING_DOTENV` is set, **including the cross-tenant suite**) and deploys staging. Or by hand: `npm run deploy:staging`.
- [ ] `curl https://learn-mcp-step-18-staging.awaismudasir10.workers.dev/version` shows the new release.
- [ ] Run **TEST-PLAN.md** on staging (at least sections 2, 3, 4 and 6 in claude.ai).

## 3. Production

- [ ] Start the **Step 18 CI/CD** workflow with `deploy_production` ticked (and `run_paid_eval` ticked if you want the paid eval gate), approve the `production` environment, or deploy by hand: `npm run deploy:production`.
- [ ] Gradual rollout, for risky changes: instead of a full deploy, upload a version and send it part of the traffic first:
  ```bash
  npx wrangler versions upload                       # new version, 0% traffic
  npx wrangler versions deploy <new>@10% <old>@90%   # 10% of requests
  # watch the logs for 15-30 minutes, then
  npx wrangler versions deploy <new>@100%
  ```
  Note: Durable Objects and queue consumers run the version that is fully deployed, so keep migrations additive.
- [ ] `/version` on production shows the new release; run TEST-PLAN section 7.

## 4. Watch (first hour)

In the Cloudflare dashboard, **Workers & Pages → learn-mcp-step-18 → Observability / Logs**:

- `type = audit`: tool calls keep flowing; watch for a spike in `outcome = "exception"` or `"tool_error"` for one tool.
- `"database error"` lines (the Postgres error code, never data) and `"tenant lookup failed"` (503s).
- `"events not recorded"`, `"import batch failed"`: queue retries. Check the dead-letter queues `order-imports-dlq` and `sales-events-dlq` stay empty.
- Workflows tab: report runs completing, none stuck in `errored`.
- Metrics: error rate and CPU time per request against the previous day.

## 5. Rollback

If anything looks wrong, roll back first and investigate after:

```bash
npm run rollback:production -- -m "why"     # production -> previous version
npm run rollback:staging -- -m "why"        # staging
npx wrangler deployments list               # what was deployed when
npx wrangler rollback <version-id> -m "why" # to a specific version
```

A rollback changes **code only**. Database migrations stay, which is why they must be additive. Secrets and bindings stay. After rolling back, check `/version` and run TEST-PLAN section 7.

## Practice rollback (done for step 18)

On staging:
1. Changed `RELEASE` to `1.0.1` and deployed (`npm run deploy:staging`). `/version` showed `{"release":"1.0.1","environment":"staging"}`.
2. Ran `npx wrangler rollback --env staging -y -m "practice rollback: 1.0.1 -> 1.0.0"`. Wrangler found the latest stable version and moved 100% of traffic to it.
3. Within seconds `/version` showed `{"release":"1.0.0","environment":"staging"}`.
4. Set `RELEASE` back to `1.0.0` in the code, so the code matches what is running.
