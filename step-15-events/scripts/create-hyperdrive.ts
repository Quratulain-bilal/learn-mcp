/**
 * Creates this step's Hyperdrive config in YOUR Cloudflare account, pointing at Neon as
 * the least-privilege role, with query caching OFF, and writes its id into wrangler.jsonc.
 *
 *   npm run hyperdrive:create                                   # the shared database (HYPERDRIVE)
 *   npm run hyperdrive:create -- --binding TENANT_DB_ENTERPRISE  # a dedicated tenant database
 *
 * It uses the connector connection string for that binding from .env
 * (CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>), so point .env at the
 * databases production should use before running it.
 *
 * Why caching off: Hyperdrive can cache the results of read queries. The cache key is the
 * SQL and its parameters, not our transaction-local app.tenant_id setting, so a cached
 * answer for one company could be served to another (book lesson 19.9).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { loadLocalEnv } from "./env";

const bindingArg = process.argv.indexOf("--binding");
const BINDING = bindingArg > 0 ? (process.argv[bindingArg + 1] ?? "") : "HYPERDRIVE";
if (!/^(HYPERDRIVE|TENANT_DB_[A-Z0-9_]+)$/.test(BINDING)) {
  console.error("--binding must be HYPERDRIVE or TENANT_DB_<NAME>.");
  process.exit(1);
}
const BASE_NAME = "learn-mcp-step-15";
const NAME = BINDING === "HYPERDRIVE" ? BASE_NAME : `${BASE_NAME}-${BINDING.toLowerCase().replace(/_/g, "-")}`;

loadLocalEnv();
const url = process.env[`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${BINDING}`];
if (!url || url.includes("replace-me") || !url.includes("mcp_connector")) {
  console.error("Run npm run db:connector first: .env needs the mcp_connector connection string.");
  process.exit(1);
}

// Run Wrangler directly with Node (no shell), so the connection string's & and ? are
// passed through untouched and never interpreted by a shell.
// (Wrangler's package only exports its library entry, so find bin/ next to it.)
const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler")), "..", "bin", "wrangler.js");
const result = spawnSync(
  process.execPath,
  [wrangler, "hyperdrive", "create", NAME, `--connection-string=${url}`, "--caching-disabled"],
  { encoding: "utf8" },
);
const output = `${result.stdout}\n${result.stderr}`;
const id = output.match(/"id":\s*"([0-9a-f]{32})"/)?.[1] ?? output.match(/\b([0-9a-f]{32})\b/)?.[1];
if (result.status !== 0 || !id) {
  // Wrangler's output never contains the password, so it's safe to show.
  console.error(output);
  console.error("Creating the Hyperdrive config failed (see above).");
  process.exit(1);
}

// Put the id on THIS binding's entry in wrangler.jsonc.
const config = readFileSync("wrangler.jsonc", "utf8");
const entry = new RegExp(`("binding": "${BINDING}", "id": ")[0-9a-f]{32}(")`);
if (entry.test(config)) {
  writeFileSync("wrangler.jsonc", config.replace(entry, `$1${id}$2`));
  console.log(`Created Hyperdrive ${NAME} (${id}) with caching off, and set it on ${BINDING} in wrangler.jsonc.`);
} else {
  console.log(`Created Hyperdrive ${NAME} (${id}) with caching off. Put this id on the ${BINDING} binding in wrangler.jsonc.`);
}
