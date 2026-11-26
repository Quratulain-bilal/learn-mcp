import type { SqlClient } from "./db-client";
import { forTenant } from "./tenant";

export interface CompanySettings {
  currency: string;
  fiscalYearStart: number;
  salesThreshold: string;
  updatedAt: string;
}

export type CompanySettingsInput = Pick<
  CompanySettings,
  "currency" | "fiscalYearStart" | "salesThreshold"
>;

export interface CompanySettingsStore {
  get(orgId: string): Promise<CompanySettings | null>;
  upsert(orgId: string, input: CompanySettingsInput): Promise<CompanySettings>;
}

const GET_SQL = `SELECT currency, fiscal_year_start AS "fiscalYearStart",
  sales_threshold::text AS "salesThreshold", updated_at::text AS "updatedAt"
  FROM public.company_settings WHERE org_id = $1`;

const UPSERT_SQL = `INSERT INTO public.company_settings
  (org_id, currency, fiscal_year_start, sales_threshold, updated_at)
  VALUES ($1, $2, $3, $4::numeric, now())
  ON CONFLICT (org_id) DO UPDATE SET
    currency = excluded.currency,
    fiscal_year_start = excluded.fiscal_year_start,
    sales_threshold = excluded.sales_threshold,
    updated_at = now()
  RETURNING currency, fiscal_year_start AS "fiscalYearStart",
    sales_threshold::text AS "salesThreshold", updated_at::text AS "updatedAt"`;

export function createMemoryCompanySettingsStore(): CompanySettingsStore {
  const values = new Map<string, CompanySettings>();
  return {
    async get(orgId) {
      return values.get(orgId) ?? null;
    },
    async upsert(orgId, input) {
      const saved = {
        ...input,
        updatedAt: new Date().toISOString(),
      };
      values.set(orgId, saved);
      return saved;
    },
  };
}

export function createCompanySettingsStore(sql: SqlClient): CompanySettingsStore {
  return {
    async get(orgId) {
      const results = await forTenant<CompanySettings>(sql, orgId, (txn) => [
        txn.query<CompanySettings>(GET_SQL, [orgId]),
      ]);
      return results[0]?.[0] ?? null;
    },

    async upsert(orgId, input) {
      const results = await forTenant<CompanySettings>(sql, orgId, (txn) => [
        txn.query<CompanySettings>(UPSERT_SQL, [
          orgId,
          input.currency,
          input.fiscalYearStart,
          input.salesThreshold,
        ]),
      ]);
      const row = results[0]?.[0];
      if (!row) throw new Error("Company settings were not saved.");
      return row;
    },
  };
}
