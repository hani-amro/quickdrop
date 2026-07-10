import { newId } from "@quickdrop/shared";
import { bigint, customType, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

// اصطلاحات المخطط — كل جدول أعمال جديد يستخدم هذه الأدوات حصراً:
//   id: idPk() · tenant_id: tenantId() · مال: money() · وقت: timestamptz()
//   جغرافيا: geographyPoint()/geographyPolygon() (D7: الإدخال WKT بترتيب lng lat)

export const idPk = () => uuid("id").primaryKey().$defaultFn(newId); // D11

export const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id);

/** D5: المال BIGINT بأصغر وحدة — ممنوع float/NUMERIC للمبالغ. */
export const money = (name: string) => bigint(name, { mode: "bigint" });

/** D6: كل الأعمدة TIMESTAMPTZ بتوقيت UTC. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const createdAt = () => timestamptz("created_at").notNull().defaultNow();
export const updatedAt = () => timestamptz("updated_at").notNull().defaultNow();

export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// الإدخال WKT نصي ('POINT(lng lat)') عبر toPostgisWkt من @quickdrop/shared؛
// القراءة الهندسية بـ SQL صريح (ST_AsText/ST_DWithin) — لا قراءة WKB خام عبر الـ ORM.
export const geographyPoint = customType<{ data: string }>({
  dataType() {
    return "geography(Point,4326)";
  },
});

export const geographyPolygon = customType<{ data: string }>({
  dataType() {
    return "geography(Polygon,4326)";
  },
});
