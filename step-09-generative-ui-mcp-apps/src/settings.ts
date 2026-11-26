import type { ForTenant } from "./db";
import { type TenantContext, tenantKey } from "./tenant";

/**
 * Each company's own settings (book lesson 19.11): one set of code, different rules per
 * company. Stored in the company's own database (company_settings, under row-level
 * security), cached in Workers KV under org:<orgId>:settings.
 *
 * KV is eventually consistent: after an update, other Cloudflare locations may serve the
 * old value for up to about a minute. That's fine for display settings; never cache
 * anything there that must be exact (permissions, balances).
 */

export interface CompanySettings {
  currency: string;
  fiscal_year_start_month: number;
  sales_threshold: number;
}

export const DEFAULT_SETTINGS: CompanySettings = { currency: "USD", fiscal_year_start_month: 1, sales_threshold: 1000 };

const CACHE_TTL_SECONDS = 300;

export type SettingsSource = "cache" | "database" | "defaults";

export interface SettingsStore {
  get(ctx: TenantContext): Promise<{ settings: CompanySettings; source: SettingsSource }>;
  update(ctx: TenantContext, patch: Partial<CompanySettings>): Promise<CompanySettings>;
}

export function createSettingsStore(kv: KVNamespace, forTenant: ForTenant): SettingsStore {
  return {
    async get(ctx) {
      const key = tenantKey(ctx, "settings");
      const cached = await kv.get<CompanySettings>(key, "json");
      if (cached) return { settings: cached, source: "cache" };

      const [row] = await forTenant(ctx, (db) =>
        db.query<CompanySettings>(
          `SELECT currency, fiscal_year_start_month::int AS fiscal_year_start_month, sales_threshold::float8 AS sales_threshold
           FROM company_settings WHERE org_id = $1`,
          [ctx.orgId],
        ),
      );
      const settings = row ?? DEFAULT_SETTINGS;
      await kv.put(key, JSON.stringify(settings), { expirationTtl: CACHE_TTL_SECONDS });
      return { settings, source: row ? "database" : "defaults" };
    },

    async update(ctx, patch) {
      // Insert the company's row on first save; afterwards change only the fields given.
      const [saved] = await forTenant(ctx, (db) =>
        db.query<CompanySettings>(
          `INSERT INTO company_settings (org_id, currency, fiscal_year_start_month, sales_threshold, updated_by)
           VALUES ($1, coalesce($2, $5), coalesce($3::smallint, $6::smallint), coalesce($4::numeric, $7::numeric), $8)
           ON CONFLICT (org_id) DO UPDATE SET
             currency                = coalesce($2, company_settings.currency),
             fiscal_year_start_month = coalesce($3::smallint, company_settings.fiscal_year_start_month),
             sales_threshold         = coalesce($4::numeric, company_settings.sales_threshold),
             updated_at              = now(),
             updated_by              = $8
           RETURNING currency, fiscal_year_start_month::int AS fiscal_year_start_month, sales_threshold::float8 AS sales_threshold`,
          [
            ctx.orgId,
            patch.currency ?? null,
            patch.fiscal_year_start_month ?? null,
            patch.sales_threshold ?? null,
            DEFAULT_SETTINGS.currency,
            DEFAULT_SETTINGS.fiscal_year_start_month,
            DEFAULT_SETTINGS.sales_threshold,
            ctx.userId,
          ],
        ),
      );
      // Clear the cache so the next read comes from the database.
      await kv.delete(tenantKey(ctx, "settings"));
      return saved!;
    },
  };
}
