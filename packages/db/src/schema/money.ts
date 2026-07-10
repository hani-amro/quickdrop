import { sql } from "drizzle-orm";
import { LEDGER_ENTRY_TYPES, SETTLEMENT_STATUSES } from "@quickdrop/shared";
import {
  date,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idPk, money, tenantId, timestamptz, updatedAt } from "./_common.js";
import { drivers } from "./drivers.js";
import { orders } from "./orders.js";

// §8.2 v1.1 — settlements: تسوية يومية لكل سائق (اليوم يُقفل بقيد remitted بالدفتر).
// diff لا يُمحى — قيد adjustment مبرَّر عند الاختلاف (§8.2).
export const settlements = pgTable(
  "settlements",
  {
    id: idPk(),
    tenantId: tenantId(),
    driverId: uuid("driver_id").notNull(),
    periodDate: date("period_date", { mode: "string" }).notNull(),
    expected: money("expected").notNull().default(sql`0`), // D5: مال BIGINT بأصغر وحدة
    received: money("received").notNull().default(sql`0`),
    diff: money("diff").notNull().default(sql`0`),
    status: text("status", { enum: SETTLEMENT_STATUSES }).notNull().default("open"),
    closedBy: uuid("closed_by"),
    closedAt: timestamptz("closed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("settlements_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    uniqueIndex("settlements_tenant_driver_period_uq").on(t.tenantId, t.driverId, t.periodDate), // تسوية واحدة لكل سائق/يوم
    foreignKey({ columns: [t.tenantId, t.driverId], foreignColumns: [drivers.tenantId, drivers.id], name: "settlements_driver_fk" }),
  ],
);

// §8.1 v1.1 — ledger_entries: دفتر الكاش، مصدر الحقيقة الوحيد لذمة السائق.
// append-only: REVOKE UPDATE/DELETE + trigger يرمي استثناء (بالترحيل المخصص)؛
// التصحيح = قيد عكسي جديد، ممنوع UPDATE — لذلك لا updated_at هنا.
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: idPk(),
    tenantId: tenantId(),
    driverId: uuid("driver_id").notNull(),
    orderId: uuid("order_id"),
    settlementId: uuid("settlement_id"),
    entryType: text("entry_type", { enum: LEDGER_ENTRY_TYPES }).notNull(),
    // المنظور المُلزم: موجب = بذمة السائق للمكتب؛ CHECK الإشارة لكل نوع بالترحيل المخصص (§8.1)
    amount: money("amount").notNull(),
    memo: text("memo"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_entries_tenant_driver_created_idx").on(t.tenantId, t.driverId, t.createdAt), // §2.3: الفهارس تبدأ بالمستأجر
    index("ledger_entries_tenant_settlement_idx").on(t.tenantId, t.settlementId),
    foreignKey({ columns: [t.tenantId, t.driverId], foreignColumns: [drivers.tenantId, drivers.id], name: "ledger_entries_driver_fk" }),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id], name: "ledger_entries_order_fk" }),
    foreignKey({ columns: [t.tenantId, t.settlementId], foreignColumns: [settlements.tenantId, settlements.id], name: "ledger_entries_settlement_fk" }),
  ],
);

export type Settlement = typeof settlements.$inferSelect;
export type NewSettlement = typeof settlements.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
