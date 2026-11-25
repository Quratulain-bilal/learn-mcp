# Good vs bad tool design — Step 02

## Deliberately bad version (`src/bad-tool-example.ts`)

```
doThing({ text: "whatever" })
```

- Vague name: `doThing` says nothing about what it does or when to call it.
- No description: the model has no signal for tool selection.
- Loose schema: `text` is any string, no limits, no required fields.
- Single ambiguous tool for create/read/delete: the model must guess the intent.
- Plain text output only: no structured data for a host or UI to use.
- No annotations: the host cannot tell that a delete is destructive.

## Good version (`create_note` in `src/index.ts`)

```
create_note({ title: "Short title", body: "Full note text" })
```

- Clear verb + noun name: `create_note` is unambiguous.
- Description says **when** to use it ("asks to save, remember or add a note").
- Tight schema: required `title` and `body`, with length limits.
- Focused granularity: one tool per intent (`list_notes`, `get_note`, `create_note`, `delete_note`).
- Structured content plus a short human summary.
- Annotations: `delete_note` is `destructiveHint`, reads are `readOnlyHint`.

## Why the good version gets called correctly more often

The model sees only names, descriptions, schemas and annotations — never the implementation. Precise language and tight schemas remove ambiguity, so the right tool is chosen on the first call, invalid calls fail early, and the host knows when to ask for confirmation before a destructive action.
