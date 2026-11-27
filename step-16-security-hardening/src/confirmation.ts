import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { TenantContext } from "./tenant";

export interface ConfirmationState {
  tool: string;
  argsDigest: string;
  phrase: string;
}

const confirmationSchema = z.object({
  confirmation: z.string().min(1).max(80),
});

type Result = { ok: true } | { ok: false; result: ReturnType<typeof inputRequired>; token: string };

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "confirmationToken")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`);
  return `{${entries.join(",")}}`;
}

async function digest(args: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(stable(args));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createConfirmationGate(secret: string, tenant: TenantContext, ttlSeconds = 120) {
  const codec = createRequestStateCodec<ConfirmationState>({
    key: secret,
    ttlSeconds,
    bind: () => `${tenant.orgId}\u0000${tenant.userId}`,
  });

  return {
    codec,
    async require(
      ctx: ServerContext,
      tool: string,
      args: Record<string, unknown>,
      phrase: string,
      summary: string,
    ): Promise<Result> {
      const argsDigest = await digest(args);
      const fallback = typeof args.confirmationToken === "string" ? args.confirmationToken : undefined;
      let state = ctx.mcpReq.requestState<ConfirmationState>();
      if (!state && fallback) {
        try {
          state = await codec.verify(fallback, ctx);
        } catch {
          state = undefined;
        }
      }
      const accepted = acceptedContent(ctx.mcpReq.inputResponses, "confirm", confirmationSchema);
      const hasFormResponse = Object.hasOwn(ctx.mcpReq.inputResponses ?? {}, "confirm");
      if (
        state &&
        state.tool === tool &&
        state.argsDigest === argsDigest &&
        state.phrase === phrase &&
        (!hasFormResponse || accepted?.confirmation === phrase)
      ) {
        return { ok: true };
      }

      const token = await codec.mint({ tool, argsDigest, phrase }, ctx);
      return {
        ok: false,
        token,
        result: inputRequired({
          requestState: token,
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `${summary}\n\nType ${phrase} to confirm.`,
              requestedSchema: confirmationSchema,
            }),
          },
        }),
      };
    },
  };
}

export type ConfirmationGate = ReturnType<typeof createConfirmationGate>;
