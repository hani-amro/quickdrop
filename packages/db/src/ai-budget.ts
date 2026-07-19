import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { aiBudgets } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// دمج WaFlow (§3.2 / R-18) — الإنفاق الذرّي لميزانية الوكيل: UPDATE شرطي **واحد**
// (يقتل سباق check-then-act الذي جعل سقف WaFlow قابلاً للتجاوز بالتوازي). period
// 'YYYY-MM' يتصفّر ذرّياً بنفس الجملة عند أول إنفاق بشهر جديد. كل المبالغ bigint سنتات (D5).

export type SpendOutcome = "spent" | "exhausted" | "no_budget";

/** 'YYYY-MM' بتوقيت UTC — تقريب شهري يكفي لسقف إنفاق. */
export function budgetPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * خصم costSen من ميزانية شهر period — ذرّياً وبشرط السقف:
 * صف الشهر الحالي: spent+cost ≤ budget؛ شهر جديد: cost ≤ budget مع تصفير spent.
 * 0 صف مُحدَّث: صف موجود → exhausted؛ لا صف أصلاً → no_budget (الوكيل معطّل).
 */
export async function spendAiBudget(db: Db, tenantId: string, costSen: bigint, now = new Date()): Promise<SpendOutcome> {
  if (costSen < 0n) throw new RangeError("spendAiBudget: costSen must be non-negative");
  const period = budgetPeriod(now);
  return withTenant(db, tenantId, async (tx) => {
    const updated = await tx
      .update(aiBudgets)
      .set({
        spentSen: sql`CASE WHEN ${aiBudgets.period} = ${period} THEN ${aiBudgets.spentSen} + ${costSen} ELSE ${costSen} END`,
        period,
        updatedAt: now,
      })
      .where(
        and(
          eq(aiBudgets.tenantId, tenantId),
          sql`(CASE WHEN ${aiBudgets.period} = ${period} THEN ${aiBudgets.spentSen} + ${costSen} ELSE ${costSen} END) <= ${aiBudgets.monthlyBudgetSen}`,
        ),
      )
      .returning({ id: aiBudgets.id });
    if (updated.length === 1) return "spent";
    const exists = await tx.select({ id: aiBudgets.id }).from(aiBudgets).where(eq(aiBudgets.tenantId, tenantId)).limit(1);
    return exists[0] ? "exhausted" : "no_budget";
  });
}

/** إعداد/تحديث ميزانية مستأجر (إدارة) — upsert على الفريد (tenant). */
export async function setAiBudget(db: Db, tenantId: string, monthlyBudgetSen: bigint, now = new Date()): Promise<void> {
  if (monthlyBudgetSen < 0n) throw new RangeError("setAiBudget: monthlyBudgetSen must be non-negative");
  await withTenant(db, tenantId, (tx) =>
    tx
      .insert(aiBudgets)
      .values({ tenantId, monthlyBudgetSen, spentSen: 0n, period: budgetPeriod(now) })
      .onConflictDoUpdate({ target: [aiBudgets.tenantId], set: { monthlyBudgetSen, updatedAt: now } }),
  );
}
