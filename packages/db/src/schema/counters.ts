import { bigint, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

// §3 — public_code: عدّاد لكل مستأجر مُثبَّت بالقاعدة (لا Redis — Redis بيضيع).
// الاستخدام: INSERT .. ON CONFLICT DO UPDATE SET value = counters.value + 1 RETURNING value
export const counters = pgTable(
  "counters",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    key: text("key").notNull(), // 'order_public_code'
    value: bigint("value", { mode: "bigint" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);
