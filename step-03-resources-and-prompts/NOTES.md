# NOTES.md — Step 03: Resources and Prompts

## What I built

Step 2 ke notes server ko aage badhaya: ab wohi data **tool, resource aur prompt** — teenon tareeqon se available hai. Worker: `learn-mcp-step-03`.

### Tools (Step 2 se)
`list_notes`, `get_note`, `create_note`, `delete_note` — same KV namespace `NOTES`.

### Resources (new)
- **Resource template:** `note://{id}` — har saved note ek resource hai
- `resources/list`: har note ko `note://<id>` ke saath list karta hai
- `resources/read`: note ka title + body return karta hai
- `create_note` / `delete_note` ke baad `notify.resourcesChanged()` call hota hai

### Prompts (new)
- `summarize_notes` — optional `tag` argument; model ko notes tools/resources use karke summary likhne ko kehta hai
- `draft_note_from_meeting` — `meeting_text` lekar clean note draft banata hai

## Tool, resource ya prompt — aur kyun?

| Feature | Primitive | Kyun |
| --- | --- | --- |
| `create_note` / `delete_note` | Tool | Side effects hain; model ko decide karna chahiye |
| `list_notes` / `get_note` | Tool | Model parameters chose karta hai (id, filter) |
| `note://{id}` | Resource | Read-only data hai, host/user attach karta hai |
| `summarize_notes` | Prompt | Baar baar chalne wala user-chosen workflow |
| `draft_note_from_meeting` | Prompt | User raw meeting text dekar template chalta hai |

**Who controls what:** model tools choose karta hai, host/user resources attach karta hai, user prompts pick karta hai.

## Notification note

`notify.resourcesChanged()` usi handler instance ke open `subscriptions/listen` streams tak pahunchta hai. Har request par naya handler banta hai (KV env capture karne ke liye), isliye notification sirf usi request ke listeners ko milega. Clients jo subscribe nahi hain, woh resources list dobara fetch karke update pakad sakte hain — is step ke liye ye theek hai.

## Run / test / deploy

```bash
cd step-03-resources-and-prompts
npm install
npm test
npm run deploy
```

Live URL:
```
https://learn-mcp-step-03.learn-mcp-step-01.workers.dev/mcp
```

## Claude / ChatGPT test

1. Connector URL upar wala set karein
2. Note save karein: `Save a note titled Client meeting`
3. Resource attach karein (client UI me "Attach resource" → note)
4. Prompt run karein: `/summarize_notes` with `tag: client`
5. MCP Inspector se bhi `resources/list`, `resources/read`, `prompts/get` check kiye

## Test status

- `npm test`: 3/3 passed (tools, resources/read, prompts/get)
- Live `resources/list` aur `prompts/list` verified
