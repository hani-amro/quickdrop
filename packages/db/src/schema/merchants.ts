import { MERCHANT_CATEGORIES } from "@quickdrop/shared";
import {
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
// تبليغ التاجر بـ v1: الموزّع يتصل هاتفياً + زر "المطعم أكّد" بالداشبورد (إجراء موثّق)؛
// بوت التاجر (قبول/رفض/مدة تحضير + قلب is_available) = مرحلة لاحقة معلنة.
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

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
export type CatalogItem = typeof catalogItems.$inferSelect;
export type NewCatalogItem = typeof catalogItems.$inferInsert;
