import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  migrations: {
    schema: "drizzle",
    table: "__drizzle_migrations",
  },
  dbCredentials: {
    // الترحيلات تعمل بدور migrator حصراً (§2.3) — ليس app_user
    url: process.env["DATABASE_URL_MIGRATOR"] ?? "",
  },
});
