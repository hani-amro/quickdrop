import { newId, TENANT_PLANS, TENANT_STATUSES } from "@quickdrop/shared";
import { sql } from "drizzle-orm";
import {
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// §2.4 — جدول المستأجرين. استثناء RLS مسمّى: بوابة الـ webhook تبحث بالـ slug قبل معرفة المستأجر.
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull(),
  logoUrl: text("logo_url"),
  brandColor: text("brand_color"),
  timezone: text("timezone").notNull().default("Asia/Damascus"),
  defaultLocale: text("default_locale").notNull().default("ar"),
  currency: text("currency").notNull().default("SYP"),
  plan: text("plan", { enum: TENANT_PLANS }).notNull().default("starter"),
  status: text("status", { enum: TENANT_STATUSES }).notNull().default("trial"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true, mode: "date" }),
  suspendedReason: text("suspended_reason"),
  etaCorrectionBp: integer("eta_correction_bp").notNull().default(12000),
  // §8.1 v1.1: حصة السائق من أجرة التوصيل بالـ basis points — 10000 = كامل الأجرة للسائق
  // (المكتب يربح من عمولة/اشتراك لاحقاً)؛ كل معدلات المال أعمدة لكل مستأجر لا ثوابت (§9)
  driverFeeShareBp: integer("driver_fee_share_bp").notNull().default(10000),
  botTokenEncrypted: bytea("bot_token_encrypted"),
  botUsername: text("bot_username"),
  botWebhookSecret: text("bot_webhook_secret"),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  limits: jsonb("limits").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
