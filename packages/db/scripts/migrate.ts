import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// الترحيلات تعمل بدور migrator حصراً (§2.3) — app_user لا يملك DDL.
async function main(): Promise<void> {
  const url = process.env["DATABASE_URL_MIGRATOR"];
  if (!url) throw new Error("DATABASE_URL_MIGRATOR is required");
  const pool = new pg.Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"),
      migrationsSchema: "drizzle",
      migrationsTable: "__drizzle_migrations",
    });
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
