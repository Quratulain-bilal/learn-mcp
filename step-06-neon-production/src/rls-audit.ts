import { TENANT_TABLES } from "./tenant";

export interface RlsFinding {
  table: string;
  issue: string;
}

const TENANT_EXPRESSION = "org_id = current_setting('app.tenant_id', true)";

export function auditRlsMigration(sql: string): RlsFinding[] {
  const findings: RlsFinding[] = [];
  for (const table of TENANT_TABLES) {
    const marker = `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`;
    const start = sql.indexOf(marker);
    if (start < 0) {
      findings.push({ table, issue: "Row-level security is not enabled." });
      continue;
    }
    const nextEnable = sql.indexOf("ENABLE ROW LEVEL SECURITY", start + marker.length);
    const nextBlock = nextEnable < 0 ? -1 : sql.indexOf("\n", nextEnable);
    const section = nextBlock < 0 ? sql.slice(start) : sql.slice(start, nextBlock);
    if (!section.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`)) {
      findings.push({ table, issue: "Row-level security is not forced." });
    }
    if (!section.includes("CREATE POLICY tenant_isolation")) {
      findings.push({ table, issue: "The tenant policy is missing." });
    }
    if (!section.includes(`USING (${TENANT_EXPRESSION})`)) {
      findings.push({ table, issue: "The policy has no tenant USING clause." });
    }
    if (!section.includes(`WITH CHECK (${TENANT_EXPRESSION})`)) {
      findings.push({ table, issue: "The policy has no tenant WITH CHECK clause." });
    }
  }
  return findings;
}

export function auditTenantTransaction(calls: readonly { text: string }[]): string[] {
  if (calls.length === 0) return ["No transaction was opened."];
  if (calls[0]?.text !== "SELECT set_config('app.tenant_id', $1, true)") {
    return ["The query ran outside forTenant; app.tenant_id was not set first."];
  }
  return [];
}
