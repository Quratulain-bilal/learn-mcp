import type { McpServer } from "@modelcontextprotocol/server";
import type { RateLimitResult } from "./user-state";

/**
 * A PER-USER RATE LIMIT on every tool that writes: at most 20 calls a minute per user in
 * a company, counted in the user's UserState Durable Object (strongly consistent, so the
 * count is exact even across many simultaneous requests).
 *
 * Applied in ONE place: before any tool is registered, registerTool is wrapped so every
 * tool NOT marked readOnlyHint: true gets the check first. A new write tool added in a
 * later step is limited automatically; nobody has to remember to add the check.
 */
/** Read-only tools that still cost something per call (an embedding on Workers AI). */
export const AI_TOOLS = new Set(["search_sales_policy", "find_products"]);

export function rateLimitWriteTools(
  server: McpServer,
  takeSlot: () => Promise<RateLimitResult>,
  /** Step 16: a separate, looser limit for AI-backed read tools. */
  takeAiSlot?: () => Promise<RateLimitResult>,
): void {
  // registerTool is heavily overloaded; the wrapper only passes the arguments through,
  // so it's typed loosely here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register = server.registerTool.bind(server) as (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, config: any, handler: (...args: any[]) => unknown) => {
    const writes = config?.annotations?.readOnlyHint !== true; // unmarked tools count as writes: fail safe
    const ai = AI_TOOLS.has(name) && takeAiSlot !== undefined;
    if (!writes && !ai) return register(name, config, handler);
    const take = writes ? takeSlot : takeAiSlot!;
    const what = writes ? "changes" : "searches";
    const limit = writes ? 20 : 30;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return register(name, config, async (...args: any[]) => {
      const slot = await take();
      if (!slot.allowed) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Rate limit reached: at most ${limit} ${what} per minute per user. Nothing was done. ` +
                `Try this again in ${slot.retryAfterSeconds} second(s), and tell the user why there's a short wait.`,
            },
          ],
        };
      }
      return handler(...args);
    });
  };
}
