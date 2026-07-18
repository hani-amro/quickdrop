import { CUSTOMER_FACT_SOURCES, LIFECYCLE_STAGES } from "@quickdrop/shared";
import { foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, idPk, money, tenantId, timestamptz, updatedAt } from "./_common.js";
import { users } from "./users.js";

// ——— دمج WaFlow (MERGE_PLAN §4.3, D-M2) — دماغ الزبون ———
// لا جدول "contacts" منفصل: الهوية = users (role='customer')، وهذا الجدول ملف CRM
// مشتق 1:1. كل الأعمدة التجميعية **كاش مُعلَن**: مصدر الحقيقة orders، وإعادة الحساب
// عند عامل الدماغ (مستهلك spine + كنس ليلي) — لا كتابة بمسار الطلب الحي.
// D10 (شبكي-جاهز): كل المفاتيح لكل مستأجر؛ لا قيود فريدة عالمية على هوية الزبون.

export const customerProfiles = pgTable(
  "customer_profiles",
  {
    id: idPk(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    lifecycleStage: text("lifecycle_stage", { enum: LIFECYCLE_STAGES }).notNull().default("new"),
    rfmScore: integer("rfm_score").notNull().default(0),
    orderCount: integer("order_count").notNull().default(0), // عدّاد لا مال — الاسم يوضّح (حارس D5 يفرض bigint على total_*)
    totalSpent: money("total_spent").notNull().default(sql`0`), // D5 — كاش bigint
    // "amount" لا "value": الاسم مالي صريح كي يراه حارسا المال (كود+سكيما) — مراجعة Phase 1
    avgOrderAmount: money("avg_order_amount").notNull().default(sql`0`),
    lastOrderAt: timestamptz("last_order_at"),
    favoriteItems: jsonb("favorite_items"), // [{catalogItemId, count}] — بالمعرّف لا بالاسم (§3.3 landing)
    churnRiskAt: timestamptz("churn_risk_at"),
    brainComputedAt: timestamptz("brain_computed_at"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    referralCode: text("referral_code"),
    avatarUrl: text("avatar_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("customer_profiles_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    uniqueIndex("customer_profiles_tenant_user_uq").on(t.tenantId, t.userId), // 1:1 مع الزبون
    uniqueIndex("customer_profiles_tenant_referral_uq")
      .on(t.tenantId, t.referralCode)
      .where(sql`referral_code IS NOT NULL`),
    index("customer_profiles_tenant_lifecycle_idx").on(t.tenantId, t.lifecycleStage),
    index("customer_profiles_tenant_last_order_idx").on(t.tenantId, t.lastOrderAt),
    foreignKey({
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
      name: "customer_profiles_user_fk",
    }),
  ],
);

// ذاكرة الـ AI طويلة الأمد (allergy، usual_order…) — confidence عدد صحيح مئوي
// (كان Float بـ WaFlow — جدول التعارضات #26).
export const customerFacts = pgTable(
  "customer_facts",
  {
    id: idPk(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    source: text("source", { enum: CUSTOMER_FACT_SOURCES }).notNull().default("ai"),
    confidence: integer("confidence").notNull().default(70), // نسبة مئوية 0-100
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("customer_facts_tenant_id_id_uq").on(t.tenantId, t.id),
    uniqueIndex("customer_facts_tenant_user_key_uq").on(t.tenantId, t.userId, t.key),
    foreignKey({
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
      name: "customer_facts_user_fk",
    }),
  ],
);

export type CustomerProfile = typeof customerProfiles.$inferSelect;
export type NewCustomerProfile = typeof customerProfiles.$inferInsert;
export type CustomerFact = typeof customerFacts.$inferSelect;
export type NewCustomerFact = typeof customerFacts.$inferInsert;
