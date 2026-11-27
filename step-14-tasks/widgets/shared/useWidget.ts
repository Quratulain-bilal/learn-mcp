import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useState } from "react";

/**
 * Every widget starts the same way:
 *   1. connect to the chat host with the STANDARD MCP Apps API (no Claude- or
 *      ChatGPT-specific calls, so the same widget works in both),
 *   2. take the host's theme and CSS variables, so it looks native in light and dark,
 *   3. receive the tool's result (structuredContent) whenever the model calls the tool.
 *
 * The widget only ever shows what the tool returned, and every tool it calls back goes
 * through the same authenticated MCP connection, so the server re-checks the company on
 * each call. The widget never sees a token or a company id.
 */
export function useWidget<T>(name: string): {
  app: App | null;
  /** The arguments the model called the tool with (e.g. the filters), for follow-up calls. */
  input: Record<string, unknown>;
  data: T | null;
  setData: (data: T) => void;
  error: string | null;
} {
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { app, error: connectError } = useApp({
    appInfo: { name, version: "1.0.0" },
    capabilities: {},
    autoResize: true, // the iframe grows and shrinks with the content
    onAppCreated: (created) => {
      // Handlers go on BEFORE the connection handshake, so the first result isn't missed.
      created.ontoolinput = (params) => setInput(params.arguments ?? {});
      created.ontoolresult = (result) => {
        if (result.isError) {
          setError(textOf(result.content) || "The tool returned an error.");
          return;
        }
        setError(null);
        setData((result.structuredContent ?? null) as T | null);
      };
    },
  });
  useHostStyles(app, app?.getHostContext());

  // Follow the host's light or dark theme, now and when it changes.
  useEffect(() => {
    if (!app) return;
    const apply = () => {
      const theme = app.getHostContext()?.theme;
      document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
    };
    apply();
    const previous = app.onhostcontextchanged;
    app.onhostcontextchanged = (params) => {
      previous?.(params);
      apply();
    };
  }, [app]);

  return { app, input, data, setData, error: error ?? connectError?.message ?? null };
}

/** The text of a tool result's content blocks, for errors. */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Calls one of OUR server's tools from inside the widget, through the host. Returns the
 * structuredContent, or throws with the tool's own error text (e.g. a 403 for a member).
 */
export async function callTool<T>(app: App, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(textOf(result.content) || `${name} failed.`);
  return result.structuredContent as T;
}

export const formatMoney = (value: number, currency?: string) =>
  currency
    ? new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value)
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
