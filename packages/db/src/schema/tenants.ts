import { DISPATCH_TRIGGERS, newId, TENANT_PLANS, TENANT_STATUSES } from "@quickdrop/shared";
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
  // §9 v1.1: معدلات الولاء أعمدة لكل مستأجر لا ثوابت. المنح عند delivered فقط.
  loyaltyPointsPerOrder: integer("loyalty_points_per_order").notNull().default(10),
  // دمج WaFlow (ترحيل 0016، جدول التعارضات #13) — نموذج WaFlow: نقاط لكل وحدة عملة +
  // معدّل استبدال، بأعداد صحيحة basis points (كان Float RM). 0 = معطّل (النموذج الافتراضي
  // يبقى loyaltyPointsPerOrder). التحويل من WaFlow: round(pointsPerRM*10000)،
  // round(redeemRate*10000). المنح الفعلي بهذا النموذج يُوصَل بـPhase 3 (طلبات WA المسعّرة).
  loyaltyPointsPerCurrencyUnitBp: integer("loyalty_points_per_currency_unit_bp").notNull().default(0),
  loyaltyRedeemRateBp: integer("loyalty_redeem_rate_bp").notNull().default(0),
  // دمج WaFlow (§4.2.3) — توقيت seam الطعام لكل مستأجر: 'ready' (افتراضي — عند جهوز
  // المطبخ) أو 'confirmed' (السائق ينطلق مع بدء التحضير). parcel/p2p دوماً عند confirmed.
  dispatchTrigger: text("dispatch_trigger", { enum: DISPATCH_TRIGGERS }).notNull().default("ready"),
  referralBonusPoints: integer("referral_bonus_points").notNull().default(100),
  referralMonthlyCap: integer("referral_monthly_cap").notNull().default(5), // منع مزارع الإحالات
  botTokenEncrypted: bytea("bot_token_encrypted"),
  botUsername: text("bot_username"),
  botWebhookSecret: text("bot_webhook_secret"), // انتقالي — يحل محله المشفّر (ترحيل 0013)
  botWebhookSecretEnc: bytea("bot_webhook_secret_enc"),
  // دمج WaFlow (ترحيل 0014) — مفتاح توجيه webhook واتساب: phone_number_id → مستأجر،
  // على جدول الاستثناء المخصص للتوجيه (نفس سابقة slug). ليس سراً؛ التوكن بـ wa_accounts
  // تحت FORCE RLS. فريد جزئياً عالمياً (R-13 — findFirst الغامض بـ WaFlow كان يوصل
  // رسائل مستأجر لصندوق مستأجر آخر). القيد بالترحيل (drizzle بلا partial-unique هنا).
  waPhoneNumberId: text("wa_phone_number_id"),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  limits: jsonb("limits").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
