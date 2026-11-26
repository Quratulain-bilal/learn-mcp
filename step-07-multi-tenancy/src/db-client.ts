import { Client } from "pg";

export type SqlRows<T> = readonly T[];
export type SqlQuery<T> = Promise<SqlRows<T>>;

export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): SqlQuery<T>;
  transaction<T>(build: (txn: SqlClient) => readonly SqlQuery<T>[]): Promise<SqlRows<T>[]>;
  end(): Promise<void>;
}

export function createPgClient(connectionString: string): SqlClient {
  const client = new Client({ connectionString });
  let connected = false;

  const ensureConnected = async () => {
    if (!connected) {
      await client.connect();
      connected = true;
    }
  };

  const query = async <T>(text: string, params?: readonly unknown[]): Promise<SqlRows<T>> => {
    await ensureConnected();
    const result = await client.query(text, params as unknown[]);
    return result.rows as SqlRows<T>;
  };

  const txn: SqlClient = {
    query,
    transaction: () => {
      throw new Error("Nested transactions are not supported.");
    },
    end: async () => undefined,
  };

  return {
    query,
    async transaction(build) {
      await ensureConnected();
      await client.query("BEGIN");
      try {
        const pending = build(txn);
        const results: SqlRows<never>[] = [];
        for (const promise of pending) {
          results.push((await promise) as SqlRows<never>);
        }
        await client.query("COMMIT");
        return results as SqlRows<never>[];
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
    async end() {
      if (!connected) return;
      await client.end();
      connected = false;
    },
  };
}
