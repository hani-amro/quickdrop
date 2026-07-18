import {
  CONVERSATION_STATUSES,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
} from "@quickdrop/shared";
import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, idPk, tenantId, timestamptz, updatedAt } from "./_common.js";
import { users } from "./users.js";
import { staff } from "./staff.js";

// دمج WaFlow (MERGE_PLAN §4.4، قرار المالك 2026-07-19) — المخزن الموحّد للمحادثات:
// **خيط واحد لكل زبون مهما تعدّدت القنوات** (لا facade على مخزنين). QD support_threads/
// support_messages تندمج هنا (channel='telegram') بـP2.4c. القناة سمة الرسالة.

export const conversations = pgTable(
  "conversations",
  {
    id: idPk(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(), // الزبون (comp-FK) — خيط واحد لكل زبون
    status: text("status", { enum: CONVERSATION_STATUSES }).notNull().default("open"),
    assignedStaffId: uuid("assigned_staff_id"), // موظف مُسنَد (comp-FK) — اختياري
    lastMessageAt: timestamptz("last_message_at"),
    lastMessagePreview: text("last_message_preview"),
    lastInboundAt: timestamptz("last_inbound_at"), // لحساب SLA/at-risk
    unreadCount: integer("unread_count").notNull().default(0),
    aiEnabled: boolean("ai_enabled").notNull().default(true), // تشغيل الـ autopilot لهذه المحادثة
    snoozedUntil: timestamptz("snoozed_until"),
    resolvedAt: timestamptz("resolved_at"),
    csatSentAt: timestamptz("csat_sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversations_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    uniqueIndex("conversations_tenant_user_uq").on(t.tenantId, t.userId), // خيط واحد لكل زبون
    index("conversations_tenant_status_last_idx").on(t.tenantId, t.status, t.lastMessageAt),
    foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id], name: "conversations_user_fk" }),
    foreignKey({ columns: [t.tenantId, t.assignedStaffId], foreignColumns: [staff.tenantId, staff.id], name: "conversations_staff_fk" }),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: idPk(),
    tenantId: tenantId(), // مُنَزَّل (WaFlow Message بلا org — نملؤه هنا للـ RLS المباشر)
    conversationId: uuid("conversation_id").notNull(),
    channel: text("channel", { enum: MESSAGE_CHANNELS }).notNull(),
    direction: text("direction", { enum: MESSAGE_DIRECTIONS }).notNull(), // in/out
    type: text("type", { enum: MESSAGE_TYPES }).notNull().default("text"),
    content: text("content"),
    mediaUrl: text("media_url"), // مؤشّر (waid:<id> للوارد، رابط للصادر)
    mediaMime: text("media_mime"),
    /** معرّف القناة الخارجي (wa_message_id أو tg_message_id) — dedup إعادة إرسال Meta/تيليغرام. */
    externalId: text("external_id"),
    sentByStaffId: uuid("sent_by_staff_id"), // للصادر من موظف (comp-FK)
    status: text("status", { enum: MESSAGE_STATUSES }).notNull().default("sent"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("messages_tenant_id_id_uq").on(t.tenantId, t.id),
    // dedup إعادة الإرسال: نفس القناة + المعرّف الخارجي مرة واحدة لكل مستأجر
    uniqueIndex("messages_tenant_channel_external_uq")
      .on(t.tenantId, t.channel, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    index("messages_conversation_created_idx").on(t.tenantId, t.conversationId, t.createdAt),
    foreignKey({ columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id], name: "messages_conversation_fk" }),
    foreignKey({ columns: [t.tenantId, t.sentByStaffId], foreignColumns: [staff.tenantId, staff.id], name: "messages_staff_fk" }),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
