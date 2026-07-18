import { BROADCAST_STATUSES, OUTBOX_STATUSES } from "@quickdrop/shared";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk, money, tenantId, timestamptz, updatedAt } from "./_common.js";

// P2.4c step 3 — support_threads/support_messages أُسقِطا (ترحيل 0018) بعد اندماج الدعم
// في المخزن الموحّد conversations/messages (خيط واحد لكل زبون عبر كل القنوات).

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

// §14 — tenant_payments: سجل التحصيل اليدوي من المستأجرين؛ يُدار من كونسول المشرف.
// تحت FORCE RLS منذ ترحيل 0012 (MERGE_PLAN R-02 — الاستثناء القديم كان ثغرة، وتعليقه
// أحال على سياسة platform_admin لم توجد قط). الكتابة عبر withTenant(tenantId) حصراً.
// append-only عملياً — لا updated_at.
export const tenantPayments = pgTable("tenant_payments", {
  id: idPk(),
  tenantId: tenantId(),
  amount: money("amount").notNull(), // D5: مال BIGINT بأصغر وحدة
  currency: text("currency").notNull().default("SYP"),
  periodNote: text("period_note"),
  receivedBy: text("received_by"),
  createdAt: createdAt(),
});

export type Broadcast = typeof broadcasts.$inferSelect;
export type OutboxMessage = typeof outbox.$inferSelect;
export type NewOutboxMessage = typeof outbox.$inferInsert;
export type TenantPayment = typeof tenantPayments.$inferSelect;
