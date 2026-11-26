import type { SalesStore } from "./sales";

export function createMemorySalesStore(): SalesStore {
  return {
    async describeSchema() {
      return {
        tables: [
          {
            schema: "public",
            name: "customers",
            columns: [{ name: "org_id", type: "text", nullable: false }],
            keys: [{ type: "PRIMARY KEY", columns: ["org_id", "customer_id"] }],
          },
          {
            schema: "staging",
            name: "flat_sales",
            columns: [{ name: "org_id", type: "text", nullable: false }],
            keys: [],
          },
        ],
      };
    },

    async answer(orgId, question) {
      return {
        question,
        rows: [{ org_id: orgId, question, total: "100.00" }],
      };
    },

    async compare(orgId, question) {
      return {
        question,
        flat: [{ org_id: orgId, source: "flat" }],
        normalized: [{ org_id: orgId, source: "normalized" }],
        anomalies: ["The flat design repeats customer and product facts."],
      };
    },
  };
}
