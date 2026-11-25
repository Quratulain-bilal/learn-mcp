# NOTES.md — Step 02: Designing Good Tools

## What I built

Refactored the Step 1 server into a **notes toolset** on Cloudflare Workers, stored in **Workers KV** (binding `NOTES`). Worker name: `learn-mcp-step-02`.

### Tools

| Tool | What it does | Annotation |
| --- | --- | --- |
| `list_notes` | Lists saved note ids, titles and times | `readOnlyHint` |
| `get_note` | Reads one note by exact id | `readOnlyHint` |
| `create_note` | Creates a note with title and body | — |
| `delete_note` | Deletes a note by exact id | `destructiveHint` |

## Key design choices

1. **Names + descriptions are prompts.** Each tool has a clear verb-noun name and a description that says *when* to use it, so the model picks the right tool.
2. **Tight Zod schemas.** Required fields, min/max lengths, exact-id inputs. Invalid calls fail early with a clear message.
3. **Structured content + short text.** Every tool returns both `content` (human text) and `structuredContent` (machine-readable data).
4. **Annotations.** Reads are marked `readOnlyHint`, delete is marked `destructiveHint`, so hosts can make safe permission/confirmation choices.
5. **Recoverable errors.** Unknown note id returns `isError: true` with "Call list_notes to see valid ids" instead of throwing.
6. **Stateless.** Notes live in Workers KV, never in Worker memory. A fresh handler + server is built per request, so concurrent calls cannot contaminate each other.
7. **Bad vs good comparison** in `DESIGN-COMPARISON.md` and `src/bad-tool-example.ts`.

## How to run, test and deploy

```bash
cd step-02-tool-design
npm install
npm run dev          # local
npm test             # 4 tests: tool list, CRUD, errors, concurrency
npm run deploy
```

**KV namespace already created:** `b566b493947b4c719365168956c349cc`

## Live URL

```
https://learn-mcp-step-02.learn-mcp-step-01.workers.dev/mcp
```

Test prompts for Claude / ChatGPT:
- "List my notes" → `list_notes`
- "Save a note titled Shopping with milk and bread" → `create_note`
- "Read the note I just saved" → `get_note`
- "Delete that note" → `delete_note` (confirmation expected from destructive hint)
