import { type Embedder, testEmbedder, workersAiEmbedder } from "../src/embeddings";
import { loadLocalEnv } from "./env";

/**
 * An embedder for scripts on your machine.
 *   --embedder test        the deterministic test embedder (no network)
 *   --embedder workers-ai  bge-m3 on Workers AI (the default)
 *
 * For Workers AI it borrows the AI binding from Wrangler (getPlatformProxy), which uses
 * your `wrangler login`, so you need no API token. It counts against the same free daily
 * Workers AI allowance as the deployed Worker.
 */
export async function scriptEmbedder(): Promise<{ embedder: Embedder; close: () => Promise<void> }> {
  const i = process.argv.indexOf("--embedder");
  const choice = i > 0 ? process.argv[i + 1] : "workers-ai";
  if (choice === "test") return { embedder: testEmbedder(), close: async () => {} };
  if (choice !== "workers-ai") throw new Error(`Unknown --embedder ${choice}; use test or workers-ai.`);

  // getPlatformProxy reads wrangler.jsonc, whose Hyperdrive bindings need local connection
  // strings even though we only use AI here.
  loadLocalEnv();
  for (const binding of ["HYPERDRIVE", "TENANT_DB_ENTERPRISE"]) {
    process.env[`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`] ??=
      "postgresql://replace-me:replace-me@localhost:5432/replace-me";
  }
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy<{ AI: Ai }>();
  return { embedder: workersAiEmbedder(proxy.env.AI), close: () => proxy.dispose() };
}
