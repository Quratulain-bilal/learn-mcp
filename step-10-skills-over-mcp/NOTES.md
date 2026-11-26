# Step 10 notes: Skills over MCP

## What I built

A **`monthly-sales-review`** skill, served by the server through the Skills over MCP extension (`io.modelcontextprotocol/skills`, SEP-2640):

```
skills/monthly-sales-review/
  SKILL.md                         frontmatter (name, description) + the playbook
  references/widgets.md            which widget answers which question
  references/review-template.md    the shape of the written review, with a good and a bad example
```

The playbook tells the model to:
1. pin down the month and the month before;
2. pull the numbers in a fixed order (`get_sales_summary` by month across both months, then top 5 products, then top 5 customers, then `list_orders` only if needed);
3. show them in the right widgets;
4. write a review under 200 words that leads with the change in revenue, uses the company's currency, and only gives recommendations tied to the numbers shown;
5. check `search_sales_policy` before recommending anything about discounts, returns or credit.

It's read-only: no orders, settings or documents.

## How it's served

- `npm run build:skills` packs every file under `skills/` into `src/skills/generated.ts` (git-ignored), because a Worker has no file system. The `pre*` hooks rebuild it, along with the widgets, before tests, dev and deploy.
- `src/skills/catalog.ts` builds the catalog once with the SDK's `SkillCatalog.load(memorySkillFiles(...))`. The SDK checks each `SKILL.md`, and records every file's size and SHA-256 digest. Settings:
  - `prefix: "learn-mcp"`: URIs are `skill://learn-mcp/monthly-sales-review/...`;
  - `cacheHint`: one hour, public, since skills only change on deploy;
  - `strict: true`: a broken skill fails the tests instead of being served.
- `skills.attach(server)` registers `skills/list`, `skills/get`, the `skill://` resource template and the capability. A client that supports the extension lists the skill (name and description only), and loads `SKILL.md` and its references when a task matches.

The skill is the same for every company and holds no company data. It's the playbook; the numbers still come from the tools, scoped to the caller's company.

## Client support, and the fallback

The [client matrix](https://modelcontextprotocol.io/extensions/client-matrix) shows ChatGPT with **partial** support (importing skills from an MCP server) and Claude not yet listed. So the same playbook is also an **MCP prompt**, `monthly_sales_review` (optional `month`, as `YYYY-MM`). It includes `SKILL.md` (without the frontmatter) and both reference files, and Claude shows it in its prompt menu. When Claude supports the extension, nothing changes on the server.

## Tools vs skill

I reviewed every tool description against the skill:

- **Tool descriptions say what a tool does, and when to pick it over a similar tool.** Examples: "use get_sales_summary for totals instead of paging list_orders"; "call create_order directly if every detail is given".
- **The skill says how to do a job with several tools.** That covers the order of calls, which date ranges, how to compare, what to write, and what not to do.
- No tool description contained a multi-step procedure, so nothing had to move out. The new procedure (the monthly review) went into the skill, not into `get_sales_summary`'s description, which would have cost context on every request.
- One rule stays in a tool on purpose: `search_sales_policy` says "answer only from these passages, cite them, and say so if it abstains". That rule applies to every use of the tool, not just one job.

## Versioning

The skill lives next to the tools it uses, in this step's folder, so it's versioned with them in git and deployed with them. Clients see a change through the digests in `skills/list`. If a tool's inputs change, update the skill in the same commit.

## Tests

`test/skills.test.ts`:
- the capability is declared;
- `skills/list` shows the skill with all three files and their digests;
- `skills/get` and `resources/read` work;
- an unknown skill gives `-32602`;
- the prompt fallback contains the playbook and references, without the frontmatter.

## Databases

As in step 9: no migrations, so step 10 shares step 8's databases and Hyperdrive configs. It has its own KV namespace.

## Prompts to try

- In a client that supports skills: "Do our monthly sales review for November 2025." To confirm the skill was used, the client shows it as loaded (ChatGPT lists imported skills). The answer follows the template: a revenue line with the change, "What drove it", "Recommendations".
- In Claude: pick the **Monthly sales review** prompt (the "+" / slash menu on the connector), and enter `2025-11`.
- "How did we do in October?" should trigger the skill by its description, in clients that load skills.
