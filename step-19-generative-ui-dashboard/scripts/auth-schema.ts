/**
 * Used ONLY by `npm run auth:schema` to generate the D1 schema SQL from our real Better
 * Auth config. It swaps D1 for an in-memory SQLite database (same SQL dialect).
 * Never deployed.
 */
import { DatabaseSync } from "node:sqlite";
import { createAuth } from "../src/auth";

const env = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a DatabaseSync stands in for D1 here
  AUTH_DB: new DatabaseSync(":memory:") as any,
  BETTER_AUTH_SECRET: "schema-generation-only-not-a-real-secret",
} as Env;

export const auth = createAuth(env, "http://localhost:8787");
