import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

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
