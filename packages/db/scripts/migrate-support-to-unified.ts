import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, migrateAllSupport, tenants } from "../src/index.js";

// P2.4c step 2 — سكربت هجرة الدعم القديم إلى المخزن الموحّد (لمرة واحدة، idempotent).
// التشغيل: DATABASE_URL=... tsx scripts/migrate-support-to-unified.ts

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envFile = join(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required (app_user)");
  const handle = createDb(url);
  try {
    // tenants استثناء RLS مسمّى — يُقرأ بلا سياق
    const tenantRows = await handle.db.select({ id: tenants.id }).from(tenants);
    const result = await migrateAllSupport(handle.db, tenantRows.map((t) => t.id));
    console.log(JSON.stringify({ action: "migrate_support_to_unified", ...result }));
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
