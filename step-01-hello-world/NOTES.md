# NOTES.md — Step 01: Hello World

## What I built

A minimal **remote MCP server** named `learn-mcp-step-01` on Cloudflare Workers.

- Transport: Streamable HTTP at `/mcp`
- Handler: Cloudflare's stateless `createMcpHandler` from `agents/mcp/server` (MCP SDK v2)
- **Not** the deprecated `McpAgent` class

### Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `greet` | `name` (required, 1–200 chars) | `Hello, <name>! Welcome to the MCP course server.` |
| `get_time` | `timezone` (optional IANA name) | Current date/time in that zone; recoverable error for bad zones |

## How to run, test and deploy

```bash
cd step-01-hello-world
npm install
npm run dev          # local: http://127.0.0.1:8787/mcp
npm test             # Vitest in the Workers runtime
npm run deploy       # after wrangler login
```

### MCP Inspector (local)

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://127.0.0.1:8787/mcp
```

### Deploy URL

After `wrangler login` and `npm run deploy`:

```
https://learn-mcp-step-01.learn-mcp-step-01.workers.dev/mcp
```

Add that URL as a **custom connector** in claude.ai / Claude Desktop, and in ChatGPT developer mode.

## Design choices (why)

1. **Handler created once at module level, server factory per request.**  
   The factory builds a fresh `McpServer` and registers tools on every request. Nothing about a request is kept in module scope, so concurrent calls cannot leak into each other (covered by the 20-way concurrency test).

2. **Zod schemas as tight input schemas.**  
   `greet.name` is required with length limits; `get_time.timezone` is optional and validated by `Intl` at call time.

3. **Recoverable errors.**  
   Invalid timezone returns `isError: true` with a clear message instead of throwing an opaque failure.

4. **No state in Worker memory.**  
   Step 1 has no cross-request data. Later steps put anything durable in KV/D1/Neon/DO, never in memory.

## Test summary

- `npm test`: 4/4 passed (tools/list, greet, concurrency isolation, get_time ok + bad timezone)
- Local `wrangler dev`: `tools/list`, `greet`, `get_time` verified over HTTP

## How to connect in Claude / ChatGPT

1. Deploy → copy `https://learn-mcp-step-01.<subdomain>.workers.dev/mcp`
2. **claude.ai / Claude Desktop:** Settings → Connectors → Add custom connector → paste URL
3. **ChatGPT:** Settings → Connectors → Create → paste URL (developer mode)
4. Test prompt: *"Use the greet tool to say hello to Bilal"*
