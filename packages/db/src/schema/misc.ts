import {
  BROADCAST_STATUSES,
  MESSAGE_DIRECTIONS,
  OUTBOX_STATUSES,
  SUPPORT_THREAD_STATUSES,
} from "@quickdrop/shared";
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idPk, money, tenantId, timestamptz, updatedAt } from "./_common.js";
import { staff } from "./staff.js";
import { users } from "./users.js";

// §3 v1.1 — support_threads: خيط دعم لكل مستخدم؛ الإسناد لموظف support.
export const supportThreads = pgTable(
  "support_threads",
  {
    id: idPk(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    status: text("status", { enum: SUPPORT_THREAD_STATUSES }).notNull().default("open"),
    assignedStaffId: uuid("assigned_staff_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("support_threads_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "support_threads_user_fk" }),
    foreignKey({ columns: [t.tenantId, t.assignedStaffId], foreignColumns: [staff.tenantId, staff.id], name: "support_threads_staff_fk" }),
  ],
);

// §3 v1.1 — support_messages: رسائل الخيط (تيليغرام in/out)؛ append-only عملياً — لا updated_at.
export const supportMessages = pgTable(
  "support_messages",
  {
    id: idPk(),
    tenantId: tenantId(),
    threadId: uuid("thread_id").notNull(),
    direction: text("direction", { enum: MESSAGE_DIRECTIONS }).notNull(),
    text: text("text").notNull(),
    tgMessageId: bigint("tg_message_id", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("support_messages_tenant_thread_idx").on(t.tenantId, t.threadId), // §2.3
    foreignKey({ columns: [t.tenantId, t.threadId], foreignColumns: [supportThreads.tenantId, supportThreads.id], name: "support_messages_thread_fk" }),
  ],
);

// §3 v1.1 — broadcasts: بث جماهيري بمعدل مضبوط (§4.3)؛ العدّادات تتحدث أثناء الإرسال.
export const broadcasts = pgTable("broadcasts", {
  id: idPk(),
  tenantId: tenantId(),
  title: text("title"),
  body: text("body").notNull(),
  audienceFilter: jsonb("audience_filter"),
  status: text("status", { enum: BROADCAST_STATUSES }).notNull().default("draft"),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  scheduledAt: timestamptz("scheduled_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// D9/§12 — outbox: يُكتب بنفس ترانزاكشن الحدث؛ الالتقاط بـ FOR UPDATE SKIP LOCKED.
export const outbox = pgTable(
  "outbox",
  {
    id: idPk(),
    tenantId: tenantId(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: OUTBOX_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("outbox_tenant_status_next_attempt_idx").on(t.tenantId, t.status, t.nextAttemptAt), // §2.3
    // الاستثناء الوحيد المسموح لفهرس لا يبدأ بالمستأجر: مسح عامل الـ outbox عابر للمستأجرين
    // (worker منصة يلتقط pending عبر الجميع) — موثّق هنا قصداً.
    index("outbox_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
  ],
);

// §14 — tenant_payments: سجل التحصيل اليدوي من المستأجرين؛ يُدار من كونسول المشرف
// (استثناء RLS مسمّى — سياسات platform_admin). append-only عملياً — لا updated_at.
export const tenantPayments = pgTable("tenant_payments", {
  id: idPk(),
  tenantId: tenantId(),
  amount: money("amount").notNull(), // D5: مال BIGINT بأصغر وحدة
  currency: text("currency").notNull().default("SYP"),
  periodNote: text("period_note"),
  receivedBy: text("received_by"),
  createdAt: createdAt(),
});

export type SupportThread = typeof supportThreads.$inferSelect;
export type SupportMessage = typeof supportMessages.$inferSelect;
export type NewSupportMessage = typeof supportMessages.$inferInsert;
export type Broadcast = typeof broadcasts.$inferSelect;
export type OutboxMessage = typeof outbox.$inferSelect;
export type NewOutboxMessage = typeof outbox.$inferInsert;
export type TenantPayment = typeof tenantPayments.$inferSelect;
