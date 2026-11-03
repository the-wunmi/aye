/**
 * Database connection. One pool per process; pass `Db` explicitly (no global singleton) so
 * tests and workers control lifecycle.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export function connect(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, { max: opts.max ?? 10, prepare: true, onnotice: () => {} });
  const db = drizzle(client, { schema, casing: "snake_case" });
  return { db, close: () => client.end({ timeout: 5 }) };
}

export type Db = ReturnType<typeof connect>["db"];
