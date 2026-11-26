import { createPgClient, type SqlClient } from "./db-client";
import { connectionString, type DatabaseEnv, type TenantTier } from "./tenant";

export class TenantRouter {
  private readonly clients: SqlClient[] = [];

  constructor(private readonly env: DatabaseEnv) {}

  clientFor(tier: TenantTier): SqlClient {
    const client = createPgClient(connectionString(this.env, tier));
    this.clients.push(client);
    return client;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      await client.end();
    }
    this.clients.length = 0;
  }
}
