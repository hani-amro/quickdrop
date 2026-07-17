import { MERCHANT_CATEGORIES } from "@quickdrop/shared";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  geographyPoint,
  idPk,
  money,
  tenantId,
  updatedAt,
} from "./_common.js";

// §3 v1.1 — merchants.
// تبليغ التاجر: الموزّع يتصل هاتفياً + زر "المطعم أكّد" بالداشبورد (v1)، **وبوت التاجر
// مبنيّ** (قبول/رفض/مدة تحضير + قلب is_available عبر /menu) — merchant-bot.ts + merchant-flow.ts.
export const merchants = pgTable(
  "merchants",
  {
    id: idPk(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    point: geographyPoint("point").notNull(),
    phone: text("phone"),
    commissionBp: integer("commission_bp"), // basis points؛ مؤجل رسمياً (D13): لا يستهلكه أي كود بـ v1
    category: text("category", { enum: MERCHANT_CATEGORIES }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    prepMinutesDefault: integer("prep_minutes_default"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("merchants_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
  ],
);

export const catalogItems = pgTable(
  "catalog_items",
  {
    id: idPk(),
    tenantId: tenantId(),
    merchantId: uuid("merchant_id").notNull(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en"),
    price: money("price").notNull(), // D5: أصغر وحدة؛ الطلب يأخذ لقطة unit_price_snapshot — لا FK حي للسعر
    photoKey: text("photo_key"),
    isAvailable: boolean("is_available").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("catalog_items_tenant_merchant_idx").on(t.tenantId, t.merchantId), // §2.3
    foreignKey({ columns: [t.tenantId, t.merchantId], foreignColumns: [merchants.tenantId, merchants.id], name: "catalog_items_merchant_fk" }),
  ],
);

// §3 (مرحلة بوت التاجر) — ربط حساب تيليغرام بمطعم: مشغّل واحد يخدم مطعماً واحداً
// (فريد على tenant+telegram_user_id)، والمطعم قد يملك عدة مشغّلين (عدة أرقام موظفين).
// يُملأ بتدفق ربط: الداشبورد يولّد كوداً قصير العمر (Redis)، المشغّل يرسله للبوت فيُقيَّد.
export const merchantOperators = pgTable(
  "merchant_operators",
  {
    id: idPk(),
    tenantId: tenantId(),
    merchantId: uuid("merchant_id").notNull(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // مشغّل (حساب تيليغرام) واحد ⇒ مطعم واحد ضمن المستأجر — إعادة الربط تستبدل الصف
    uniqueIndex("merchant_operators_tenant_tg_uq").on(t.tenantId, t.telegramUserId),
    index("merchant_operators_tenant_merchant_idx").on(t.tenantId, t.merchantId), // §2.3
    foreignKey({ columns: [t.tenantId, t.merchantId], foreignColumns: [merchants.tenantId, merchants.id], name: "merchant_operators_merchant_fk" }),
  ],
);

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
export type CatalogItem = typeof catalogItems.$inferSelect;
export type NewCatalogItem = typeof catalogItems.$inferInsert;
export type MerchantOperator = typeof merchantOperators.$inferSelect;
