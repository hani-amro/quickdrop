import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoyaltyTier } from "@quickdrop/shared";
import { and, eq, sql } from "drizzle-orm";
import { createDb, loyaltyAccounts, tenants, withTenant } from "../src/index.js";

// §9 v1.1 — إعادة حساب مستوى الولاء (tier) بـ cron ليلي — لا لحظياً (الهبوط وسط
// الشهر تجربة سيئة). لكل مستأجر ولكل حساب ولاء: عدد الطلبات delivered آخر 90 يوماً
// يحدّد المستوى + tier_calculated_at. المستأجرون يُقرَأون بلا سياق (tenants استثناء
// RLS مسمّى §2.4)، وكل حساب عبر withTenant بدور app_user (DATABASE_URL §2.2).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// DX: حمّل .env من جذر الريبو إن وُجد — env الشِل لها الأسبقية (سلوك Node نفسه).
const envFile = join(repoRoot, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// §9 — عتبات المستوى (v1، قابلة للتحويل لأعمدة لكل مستأجر لاحقاً مثل باقي معدلات
// الولاء §9): برونزي < 10 طلباً، فضّي 10–29، ذهبي ≥ 30 (خلال آخر 90 يوماً).
const SILVER_THRESHOLD = 10;
const GOLD_THRESHOLD = 30;

function tierFor(deliveredCount: number): LoyaltyTier {
  if (deliveredCount >= GOLD_THRESHOLD) return "gold";
  if (deliveredCount >= SILVER_THRESHOLD) return "silver";
  return "bronze";
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required (app_user)");

  const handle = createDb(url);
  let tenantsProcessed = 0;
  let accountsUpdated = 0;
  try {
    // tenants استثناء RLS مسمّى — يُقرأ بلا سياق (§2.4).
    const tenantRows = await handle.db.select({ id: tenants.id, slug: tenants.slug }).from(tenants);

    for (const tenant of tenantRows) {
      const now = new Date(); // D6: UTC — لقطة زمن حساب المستوى لهذا المستأجر
      const updated = await withTenant(handle.db, tenant.id, async (tx) => {
        // §16.10: عدّ الطلبات المُسلَّمة آخر 90 يوماً لكل حساب بـ subquery مرتبط واحد
        // (لا N+1)؛ الحساب عبر customer_id = loyalty_accounts.user_id.
        const deliveredCountExpr = sql<number>`(
          SELECT count(*) FROM orders o
           WHERE o.tenant_id = ${loyaltyAccounts.tenantId}
             AND o.customer_id = ${loyaltyAccounts.userId}
             AND o.status = 'delivered'
             AND o.delivered_at >= now() - interval '90 days'
        )`.mapWith(Number);

        const accounts = await tx
          .select({
            id: loyaltyAccounts.id,
            tier: loyaltyAccounts.tier,
            deliveredCount: deliveredCountExpr,
          })
          .from(loyaltyAccounts)
          .where(eq(loyaltyAccounts.tenantId, tenant.id));

        let changed = 0;
        for (const account of accounts) {
          const nextTier = tierFor(account.deliveredCount);
          // نكتب tier_calculated_at دائماً (سجل تشغيل المهمة)، وننبّه لتغيّر المستوى.
          await tx
            .update(loyaltyAccounts)
            .set({ tier: nextTier, tierCalculatedAt: now, updatedAt: now })
            .where(and(eq(loyaltyAccounts.tenantId, tenant.id), eq(loyaltyAccounts.id, account.id)));
          if (nextTier !== account.tier) changed += 1;
        }
        return { total: accounts.length, changed };
      });

      tenantsProcessed += 1;
      accountsUpdated += updated.total;
      // §13: لوغ منظّم بلا PII — أعداد فقط
      console.log(
        JSON.stringify({
          action: "recalc_tiers",
          tenant: tenant.slug,
          accounts: updated.total,
          tier_changed: updated.changed,
        }),
      );
    }
  } finally {
    await handle.close();
  }

  console.log(
    JSON.stringify({ action: "recalc_tiers_done", tenants: tenantsProcessed, accounts: accountsUpdated }),
  );
}

main().catch((error: unknown) => {
  // §16.12: لا ابتلاع — فشل المهمة يخرج بكود غير صفري كي يلتقطه المجدول
  console.error(error);
  process.exitCode = 1;
});
