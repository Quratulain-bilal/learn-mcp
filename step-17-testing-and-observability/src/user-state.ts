import { DurableObject } from "cloudflare:workers";
import { type TenantContext, tenantObjectName } from "./tenant";

/**
 * USER STATE: one Durable Object per signed-in user IN ONE COMPANY, named
 * "org:<orgId>:user:<userId>". Every request for that name reaches the same object, and
 * the object handles them one at a time, so its reads and writes are strongly consistent:
 * no two tool calls can both see "19 calls this minute" and both get through.
 *
 * It holds small state that must be exact right now and doesn't belong in Neon:
 *   - a DRAFT ORDER the user builds over several tool calls;
 *   - a RATE LIMIT: the times of recent write-tool calls.
 *
 * It is NOT a business database: a submitted order goes to Neon, and the draft is cleared.
 *
 * Storage is the object's own SQLite database (the free plan's kind of Durable Object),
 * used here through its simple key-value API. Between requests the object may be evicted
 * from memory; its storage stays, and the next request (or its alarm) wakes it up.
 *
 * How this differs from the old McpAgent pattern: McpAgent made ONE Durable Object per
 * MCP SESSION and ran the whole MCP server inside it. Here /mcp stays a stateless
 * createMcpHandler, and only the state that needs it lives in a Durable Object, keyed by
 * the USER (in a company), so it survives reconnects and is shared by all of the user's
 * sessions in Claude and ChatGPT.
 */

export interface DraftLine {
  product: string;
  quantity: number;
}
export interface Draft {
  customerEmail: string | null;
  lines: DraftLine[];
  /** Goes up on every change, so submit only clears the draft it actually saved. */
  version: number;
  updatedAt: number;
}

export const MAX_DRAFT_LINES = 20;
/** Write-tool calls allowed per user per minute. */
export const RATE_LIMIT = 20;
/** Calls per user per minute to tools that run Workers AI (each costs from the daily allowance). */
export const AI_RATE_LIMIT = 30;
const WINDOW_MS = 60_000;
/** A draft nobody has touched for this long is deleted by the alarm. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export type RateLimitResult = { allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number };

export class UserState extends DurableObject<Env> {
  // ---- draft order --------------------------------------------------------------

  async getDraft(): Promise<Draft | null> {
    return (await this.ctx.storage.get<Draft>("draft")) ?? null;
  }

  /** Adds a product (or more of one already in the draft), and optionally sets the customer. */
  async addToDraft(line: DraftLine, customerEmail?: string): Promise<{ draft: Draft } | { error: string }> {
    const draft = (await this.getDraft()) ?? { customerEmail: null, lines: [], version: 0, updatedAt: 0 };
    const existing = draft.lines.find((l) => l.product.toLowerCase() === line.product.toLowerCase());
    if (existing) {
      existing.quantity = Math.min(1000, existing.quantity + line.quantity);
    } else {
      if (draft.lines.length >= MAX_DRAFT_LINES) {
        return { error: `A draft can have at most ${MAX_DRAFT_LINES} products. Submit or clear it first.` };
      }
      draft.lines.push(line);
    }
    if (customerEmail) draft.customerEmail = customerEmail;
    return { draft: await this.#save(draft) };
  }

  /** Sets the draft's customer without adding a product. */
  async setDraftCustomer(customerEmail: string): Promise<Draft> {
    const draft = (await this.getDraft()) ?? { customerEmail: null, lines: [], version: 0, updatedAt: 0 };
    draft.customerEmail = customerEmail;
    return this.#save(draft);
  }

  /**
   * Clears the draft. With `onlyVersion`, clears it only if it's still that version, so a
   * product added while an order was being saved isn't thrown away with it.
   */
  async clearDraft(onlyVersion?: number): Promise<boolean> {
    const draft = await this.getDraft();
    if (!draft) return false;
    if (onlyVersion !== undefined && draft.version !== onlyVersion) return false;
    await this.ctx.storage.delete("draft");
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  async #save(draft: Draft): Promise<Draft> {
    const saved = { ...draft, version: draft.version + 1, updatedAt: Date.now() };
    await this.ctx.storage.put("draft", saved);
    // Every change pushes the clean-up alarm back to 24 hours from now.
    await this.ctx.storage.setAlarm(saved.updatedAt + DRAFT_TTL_MS);
    return saved;
  }

  /** Runs when the alarm fires, even if no request has arrived for a day. */
  override async alarm(): Promise<void> {
    const draft = await this.getDraft();
    if (draft && Date.now() - draft.updatedAt >= DRAFT_TTL_MS) {
      await this.ctx.storage.delete("draft");
    } else if (draft) {
      // Touched since the alarm was set: check again 24 hours after the last change.
      await this.ctx.storage.setAlarm(draft.updatedAt + DRAFT_TTL_MS);
    }
  }

  // ---- rate limit ----------------------------------------------------------------

  /**
   * Counts one call in a bucket ("writes": write tools; "ai": tools that call Workers AI),
   * if the user is under that bucket's limit. A sliding window: the times of the calls in
   * the last minute. Because the object handles one request at a time, two calls can't
   * both take the last slot.
   */
  async takeSlot(bucket: "writes" | "ai", limit: number): Promise<RateLimitResult> {
    const now = Date.now();
    const recent = ((await this.ctx.storage.get<number[]>(bucket)) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - now) / 1000));
      await this.ctx.storage.put(bucket, recent);
      return { allowed: false, retryAfterSeconds };
    }
    recent.push(now);
    await this.ctx.storage.put(bucket, recent);
    return { allowed: true, remaining: limit - recent.length };
  }

  /** Counts one write-tool call (step 11's name for the "writes" bucket). */
  async takeWriteSlot(limit = RATE_LIMIT): Promise<RateLimitResult> {
    return this.takeSlot("writes", limit);
  }
}

/**
 * The signed-in user's object. The name comes ONLY from the verified tenant context
 * (company from the token, user from the token), never from tool input, so a tool can't
 * be talked into opening someone else's object. The company is part of the name, so the
 * same user id in two companies gets two separate objects.
 */
export function userStateFor(ns: DurableObjectNamespace<UserState>, ctx: Pick<TenantContext, "orgId" | "userId">) {
  return ns.get(ns.idFromName(tenantObjectName(ctx)));
}
