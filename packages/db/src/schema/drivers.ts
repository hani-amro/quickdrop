import { DRIVER_STATUSES, VEHICLES } from "@quickdrop/shared";
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
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
  timestamptz,
  updatedAt,
} from "./_common.js";
import { users } from "./users.js";

// §3 v1.1 — drivers. "وردية مفتوحة" = status='online' (بزر ابدأ/أنهِ وردية ببوت السائق).
export const drivers = pgTable(
  "drivers",
  {
    id: idPk(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    vehicle: text("vehicle", { enum: VEHICLES }).notNull(),
    // D14: لا حالة busy — الانشغال يُشتق من عدد الطلبات النشطة (assigned..arrived) مقابل max_concurrent_orders
    status: text("status", { enum: DRIVER_STATUSES }).notNull().default("offline"),
    maxConcurrentOrders: integer("max_concurrent_orders").notNull().default(2), // سقف التكديس، قابل للتعديل لكل سائق
    lastPoint: geographyPoint("last_point"), // لا تُحدَّث من نقطة مشبوهة (§3)
    lastPointAt: timestamptz("last_point_at"),
    shiftStartedAt: timestamptz("shift_started_at"),
    ratingAvg: doublePrecision("rating_avg"),
    docs: jsonb("docs"),
    cashLimit: money("cash_limit"), // سقف الكاش قبل إلزام التسوية
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("drivers_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    index("drivers_tenant_status_idx").on(t.tenantId, t.status), // ترشيح الإسناد (§6.1)
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "drivers_user_fk" }),
  ],
);

// جدول ساخن: partition شهري أو تنظيف بعد 90 يوم — append-only، لا updated_at.
export const driverLocations = pgTable(
  "driver_locations",
  {
    id: idPk(),
    tenantId: tenantId(),
    driverId: uuid("driver_id").notNull(),
    point: geographyPoint("point").notNull(),
    recordedAt: timestamptz("recorded_at").notNull(),
    speedKmh: doublePrecision("speed_kmh"),
    // §3: النقاط المشبوهة (سرعة > 150 كم/س أو قفزة > 2كم بأقل من 10 ثوان) لا تُغذّي
    // الـ geofence ولا drivers.last_point — تُخزَّن وتُنبِّه فقط.
    isSuspect: boolean("is_suspect").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("driver_locations_tenant_driver_recorded_idx").on(t.tenantId, t.driverId, t.recordedAt),
    foreignKey({ columns: [t.tenantId, t.driverId], foreignColumns: [drivers.tenantId, drivers.id], name: "driver_locations_driver_fk" }),
  ],
);

export type Driver = typeof drivers.$inferSelect;
export type NewDriver = typeof drivers.$inferInsert;
export type DriverLocation = typeof driverLocations.$inferSelect;
export type NewDriverLocation = typeof driverLocations.$inferInsert;
