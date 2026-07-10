import { STAFF_ROLES } from "@quickdrop/shared";
import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idPk, tenantId, updatedAt } from "./_common.js";
import { users } from "./users.js";

// §3 v1.1 — staff: موظفو المكتب (داشبورد)؛ الدخول email+password+TOTP (§10.2).
export const staff = pgTable(
  "staff",
  {
    id: idPk(),
    tenantId: tenantId(),
    userId: uuid("user_id"), // ربط اختياري بحساب تيليغرام (users)
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: STAFF_ROLES }).notNull(),
    totpSecret: text("totp_secret"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("staff_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    uniqueIndex("staff_tenant_email_uq").on(t.tenantId, t.email),
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "staff_user_fk" }),
  ],
);

// §3 v1.1 — admin_users: مشرفو المنصة — جدول على مستوى المنصة بلا tenant_id
// (استثناء RLS مسمّى §2.3)؛ يدعم دخول /admin المنفصل (§10.2).
export const adminUsers = pgTable("admin_users", {
  id: idPk(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  totpSecret: text("totp_secret"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
});

// §3 v1.1 — audit_log: append-only بنفس آلية order_events (REVOKE UPDATE/DELETE + trigger
// بالترحيل المخصص — لا updated_at)؛ CHECK أحد الفاعلين إلزامي بالترحيل المخصص.
export const auditLog = pgTable(
  "audit_log",
  {
    id: idPk(),
    tenantId: tenantId(),
    actorStaffId: uuid("actor_staff_id"),
    actorAdminId: uuid("actor_admin_id").references(() => adminUsers.id), // FK بعمود واحد مسموح: جدول استثناء (منصة)
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt), // §2.3: الفهارس تبدأ بالمستأجر
    foreignKey({ columns: [t.tenantId, t.actorStaffId], foreignColumns: [staff.tenantId, staff.id], name: "audit_log_actor_staff_fk" }),
  ],
);

export type Staff = typeof staff.$inferSelect;
export type NewStaff = typeof staff.$inferInsert;
export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
