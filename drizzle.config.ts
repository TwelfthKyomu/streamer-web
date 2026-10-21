import { defineConfig } from "drizzle-kit";

// Миграции идут в обход пулера: PgBouncer в transaction mode не держит
// сессионное состояние, а DDL на него полагается. Для локального Postgres
// переменной просто нет, и берётся обычный DATABASE_URL.
const databaseUrl =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL не задан. Скопируй .env.example в .env и заполни его.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/core/db/schema/index.ts",
  out: "./src/core/db/migrations",
  dbCredentials: { url: databaseUrl },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
