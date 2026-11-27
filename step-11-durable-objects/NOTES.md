# Step 11 notes: per-user state with Durable Objects

## What I built

A **`UserState`** Durable Object (`src/user-state.ts`), one per signed-in user **in one company**, named `org:<orgId>:user:<userId>` with the step 7 `tenantObjectName()` helper. It holds:

- **a draft order** (customer email, up to 20 products, a version number, last change time). The new tools:
  - `add_to_draft`: adding the same product again adds to its quantity;
  - `view_draft`;
  - `clear_draft`;
  - `submit_draft`: checks the draft, saves it to Neon with the same `insertOrder` logic as `create_order`, and only then clears it, and only the version it saved. If saving fails, the draft is kept so it can be fixed.
- **a rate limit**: the times of the user's write-tool calls in the last minute (a sliding window), at most **20**.
- **an alarm** that deletes a draft untouched for **24 hours**. Every change pushes the alarm back. If the draft was touched after the alarm was set, the alarm re-arms instead of deleting.

## Durable Objects in plain words

- **Naming:** `idFromName("org:acme:user:ali")` always gives the same object, anywhere in the world. One name is one object.
- **Storage:** each object has its own small SQLite database. I use its key-value API (`storage.get/put/delete`). The free plan supports only SQLite-backed objects, hence `new_sqlite_classes` in the wrangler migration.
- **Consistency:** an object handles its requests one at a time, so read-then-write is safe. Two simultaneous calls can't both see "19 calls this minute" and both get through. KV (up to a minute stale) couldn't promise that.
- **Alarms:** `storage.setAlarm(time)` wakes the object at that time, even if no request arrives. Between requests an idle object is evicted from memory; its storage stays, and the next request or the alarm brings it back.

## Why the name comes only from the token

The object name is built from the **verified** company (the token's `org_id`) and user (the token's `sub`), never from tool input. So no prompt can make a tool open someone else's object. The company is part of the name, so the same user id in two companies gets two separate objects: tested by adding to a draft as `same-user` in one company and seeing an empty draft as `same-user` in another.

## The rate limit, applied once

`src/rate-limit.ts` wraps `server.registerTool` before any tool is registered. Every tool **not** marked `readOnlyHint: true` first takes a slot from the user's `UserState`. Unmarked tools count as writes, so the default is the safe one. Today that covers `create_order`, `add_to_draft`, `clear_draft`, `submit_draft`, `update_company_settings`, `invite_member`, `remove_member` and `add_policy_document`, and any write tool added later is covered automatically.

Over the limit, the tool returns a recoverable error: "Rate limit reached… Nothing was done. Try this again in N second(s)…". Read-only tools aren't limited, and other users aren't affected (tested).

## Not the McpAgent pattern

`McpAgent` ran one Durable Object per MCP **session** and put the whole server in it. Here `/mcp` stays a stateless `createMcpHandler`, and only the state that needs strong consistency lives in a Durable Object, keyed by **user in a company**. It survives reconnects and is shared by all of the user's sessions in Claude and ChatGPT.

## Tests

`test/user-state.test.ts`:
- separate objects per company;
- quantities add up, and a draft is capped at 20 products;
- the 21st write call in a minute is refused with a retry time, while reads and other users still work;
- the alarm keeps a fresh draft and deletes a day-old one (`runInDurableObject`);
- `submit_draft` saves to Neon and then clears the draft;
- a failed submit keeps the draft;
- submitting with no customer asks for one.

## Databases

No migrations: step 11 shares step 8's databases and Hyperdrive configs. It has its own KV namespace. Durable Objects are on the free plan (SQLite-backed).

## Try it in Claude and ChatGPT

1. "Start an order for laura.schmidt@example.com: two Desk Lamps." Then "Add an Ergo Chair." Then "What's in my draft?" Then "Submit it."
2. Ask it to clear the draft 21 times in a row (or have it add products quickly): the 21st change is refused with a wait time.
3. Dashboard: **Workers & Pages → learn-mcp-step-11 → Durable Objects → UserState** lists the objects and their storage use.
