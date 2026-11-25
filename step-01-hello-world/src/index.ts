import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

// Factory: a fresh McpServer for every request. Nothing from one request
// may leak into another, so no module-level server or per-request state.
function createServer() {
  const server = new McpServer({
    name: "learn-mcp-step-01",
    version: "0.0.1",
  });

  server.registerTool(
    "greet",
    {
      description: "Return a friendly greeting for a person by name.",
      inputSchema: {
        name: z.string().min(1).max(200).describe("Person to greet"),
      },
    },
    async ({ name }) => ({
      content: [
        { type: "text", text: `Hello, ${name}! Welcome to the MCP course server.` },
      ],
    }),
  );

  server.registerTool(
    "get_time",
    {
      description:
        "Return the current date and time, optionally in a given IANA timezone (for example Asia/Karachi).",
      inputSchema: {
        timezone: z
          .string()
          .max(64)
          .optional()
          .describe("IANA timezone name; defaults to UTC"),
      },
    },
    async ({ timezone }) => {
      const tz = timezone ?? "UTC";
      try {
        const now = new Date();
        const formatted = new Intl.DateTimeFormat("en-GB", {
          dateStyle: "full",
          timeStyle: "long",
          timeZone: tz,
        }).format(now);
        return {
          content: [{ type: "text" as const, text: `${formatted} (${tz})` }],
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid timezone "${tz}". Use an IANA name such as UTC or Asia/Karachi.`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

// Handler once at module level; the factory still builds a new server per request.
const handler = createMcpHandler(createServer, { route: "/mcp" });

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler;
