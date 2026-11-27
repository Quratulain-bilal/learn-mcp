import { z } from "zod";
import { type Row, safeDbErrorForLog } from "./db";

/** Shared pieces for the sales and order tools. */

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const rowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export function toolError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** A database failure, explained so the model can tell the user what to do. */
export function dbError(error: unknown) {
  // Only the error code and constraint name: Postgres details can quote row values.
  console.error("database error", safeDbErrorForLog(error));
  return toolError(
    "The sales database couldn't be reached or returned an error, so no data was read. " +
      "This is a server problem, not a problem with your request: try again in a minute, and if it keeps happening, tell the server's owner.",
  );
}

/** Renders rows as a small Markdown table for the text part of a reply. */
export function markdownTable(rows: Row[], max = 25): string {
  if (rows.length === 0) return "(no rows)";
  const columns = Object.keys(rows[0]!);
  const lines = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`];
  for (const row of rows.slice(0, max)) lines.push(`| ${columns.map((c) => String(row[c] ?? "")).join(" | ")} |`);
  if (rows.length > max) lines.push(`… and ${rows.length - max} more rows (see structured content).`);
  return lines.join("\n");
}
