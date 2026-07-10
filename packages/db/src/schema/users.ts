import { USER_ROLES } from "@quickdrop/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  geographyPoint,
  idPk,
  tenantId,
  timestamptz,
  updatedAt,
} from "./_common.js";

// §3 v1.1 — users. هوية موحّدة للزبون/السائق/الموظف داخل المستأجر.
export const users = pgTable(
  "users",
  {
    id: idPk(),
    tenantId: tenantId(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }), // NULL = زبون تلفون بلا تيليغرام (D15)
    role: text("role", { enum: USER_ROLES }).notNull(),
    phoneE164: text("phone_e164"),
    firstName: text("first_name"),
    locale: text("locale").notNull().default("ar"),
    blockedAt: timestamptz("blocked_at"), // 403 من تيليغرام: أوقف إشعاراته، لا تعيد المحاولة (§4.3)
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    // فريد جزئي: يسمح بعدة زبائن تلفون (telegram_user_id IS NULL) لنفس المستأجر
    uniqueIndex("users_tenant_tg_uq")
      .on(t.tenantId, t.telegramUserId)
      .where(sql`telegram_user_id IS NOT NULL`),
    index("users_tenant_phone_idx").on(t.tenantId, t.phoneE164), // البحث الأساسي لشاشة الطلب اليدوي
  ],
);

export const addresses = pgTable(
  "addresses",
  {
    id: idPk(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    label: text("label"),
    point: geographyPoint("point").notNull(),
    detailsText: text("details_text"),
    floor: text("floor"),
    hasElevator: boolean("has_elevator"),
    phoneOverride: text("phone_override"),
    deletedAt: timestamptz("deleted_at"), // D10: soft delete
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("addresses_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    index("addresses_tenant_user_idx").on(t.tenantId, t.userId), // §2.3: الفهارس تبدأ بالمستأجر
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "addresses_user_fk" }),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
