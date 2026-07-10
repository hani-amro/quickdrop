import { sql } from "drizzle-orm";
import { SERVICES } from "@quickdrop/shared";
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
  geographyPolygon,
  idPk,
  money,
  tenantId,
  timestamptz,
  updatedAt,
} from "./_common.js";

// §3 v1.1 — zones.
export const zones = pgTable(
  "zones",
  {
    id: idPk(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    polygon: geographyPolygon("polygon").notNull(), // D7: الإدخال WKT بترتيب lng lat
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("zones_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
  ],
);

// المطابقة بمنطقة نقطة التسليم (dropoff) حصراً؛ zone_id NULL = قاعدة عامة (priority يحسم).
export const pricingRules = pgTable(
  "pricing_rules",
  {
    id: idPk(),
    tenantId: tenantId(),
    zoneId: uuid("zone_id"), // NULL = قاعدة عامة
    service: text("service", { enum: SERVICES }).notNull(),
    base: money("base").notNull().default(sql`0`), // D5: NOT NULL DEFAULT 0 — CHECK مع NULL يمرّ بصمت
    perKm: money("per_km").notNull().default(sql`0`),
    perKg: money("per_kg").notNull().default(sql`0`),
    minTotal: money("min_total").notNull().default(sql`0`),
    surgeMultiplierBp: integer("surge_multiplier_bp").notNull().default(10000), // 10000 bp = ×1.0
    activeFrom: timestamptz("active_from"),
    activeTo: timestamptz("active_to"),
    priority: integer("priority").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("pricing_rules_tenant_service_idx").on(t.tenantId, t.service), // §2.3
    foreignKey({ columns: [t.tenantId, t.zoneId], foreignColumns: [zones.tenantId, zones.id], name: "pricing_rules_zone_fk" }),
  ],
);

export type Zone = typeof zones.$inferSelect;
export type NewZone = typeof zones.$inferInsert;
export type PricingRule = typeof pricingRules.$inferSelect;
export type NewPricingRule = typeof pricingRules.$inferInsert;
