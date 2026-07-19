import { sql } from "drizzle-orm";
import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, idPk, money, tenantId, updatedAt } from "./_common.js";

// دمج WaFlow (§3.2 / R-18) — ميزانية وكيل الـ AI: إنفاق ذرّي بأعداد صحيحة (سنتات، D5).
// صف واحد لكل مستأجر؛ period 'YYYY-MM' يتصفّر ذرّياً بأول إنفاق بشهر جديد.
// لا صف = الوكيل معطّل (لا افتراضي مفتوح).
export const aiBudgets = pgTable(
  "ai_budgets",
  {
    id: idPk(),
    tenantId: tenantId(),
    monthlyBudgetSen: money("monthly_budget_sen").notNull().default(sql`0`),
    spentSen: money("spent_sen").notNull().default(sql`0`),
    period: text("period").notNull(), // 'YYYY-MM' بمنطقة UTC (تقريب شهري يكفي للسقف)
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ai_budgets_tenant_uq").on(t.tenantId),
    uniqueIndex("ai_budgets_tenant_id_id_uq").on(t.tenantId, t.id),
  ],
);

export type AiBudget = typeof aiBudgets.$inferSelect;
