import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/core/env";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  __dbConnection?: ReturnType<typeof postgres>;
};

const connection =
  globalForDb.__dbConnection ??
  postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__dbConnection = connection;
}

export const db = drizzle(connection, { schema, casing: "snake_case" });

export type Database = typeof db;
export { schema };
