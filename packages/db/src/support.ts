import type { MessageDirection, SupportThreadStatus } from "@quickdrop/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { getOrCreateConversation, recordInboundMessage, recordOutboundMessage } from "./conversations-service.js";
import { writeOutbox } from "./outbox.js";
import { conversations, messages, users } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §9 (خيوط الدعم) — مراسلة زبون↔مكتب. P2.4c (قرار المالك 2026-07-19): **المخزن الموحّد**
// conversations/messages هو مصدر الحقيقة (خيط واحد لكل زبون مهما تعدّدت القنوات؛ support_
// threads/support_messages تُهجَر وتُسقَط لاحقاً). هذه الدوال تحفظ توقيعاتها وأشكال
// استجابتها كي لا تتغيّر مستدعياتها (بوت تيليغرام + SupportService + المستهلك).
// تعيين الحالة: الدعم open/closed ↔ الموحّد open/resolved.

// دعم تيليغرام قناته 'telegram' — الرسائل الواردة/الصادرة عبره تحمل هذه القناة.
const SUPPORT_CHANNEL = "telegram" as const;

/** تعيين حالة المحادثة الموحّدة → حالة الدعم (open/closed) للحفاظ على واجهة الدعم. */
function toSupportStatus(convStatus: string): SupportThreadStatus {
  return convStatus === "resolved" ? "closed" : "open";
}

export interface SupportThreadListItem {
  id: string;
  userId: string;
  userName: string | null;
  userPhone: string | null;
  status: SupportThreadStatus;
  assignedStaffId: string | null;
  lastMessageText: string | null;
  lastMessageAt: Date | null;
  messageCount: number;
  createdAt: Date;
}

export interface SupportThreadDetail {
  thread: {
    id: string;
    userId: string;
    userName: string | null;
    userPhone: string | null;
    status: SupportThreadStatus;
    assignedStaffId: string | null;
    createdAt: Date;
  };
  messages: { id: string; direction: MessageDirection; text: string; createdAt: Date }[];
}

export type StaffReplyOutcome =
  | { outcome: "sent"; threadId: string }
  | { outcome: "not_found" }; // محادثة غير موجودة لهذا المستأجر (الخيوط الموحّدة لا تُغلق أمام الرد)

export type CloseThreadOutcome = { outcome: "closed" } | { outcome: "not_found" };

/**
 * §9 — رسالة واردة من الزبون (عبر بوت تيليغرام): خيط الزبون الموحّد (get-or-create) ثم
 * رسالة واردة channel='telegram'. يعيد {threadId=conversationId, isNewThread}.
 * idempotent ضد إعادة تسليم التحديث بمفتاح (tenant, telegram, tg_message_id).
 */
export async function appendInboundMessage(
  db: Db,
  tenantId: string,
  userId: string,
  text: string,
  tgMessageId?: number,
): Promise<{ threadId: string; isNewThread: boolean }> {
  return withTenant(db, tenantId, async (tx) => {
    const { id: conversationId, created } = await getOrCreateConversation(tx, tenantId, userId);
    await recordInboundMessage(tx, {
      tenantId,
      conversationId,
      channel: SUPPORT_CHANNEL,
      type: "text",
      content: text,
      ...(tgMessageId !== undefined ? { externalId: String(tgMessageId) } : {}),
    });
    return { threadId: conversationId, isNewThread: created };
  });
}

/** §9 — قائمة خيوط الدعم (اختيارياً بحالة) من المخزن الموحّد. آخر رسالة/عدّادها بلا N+1. */
export async function listSupportThreads(
  db: Db,
  tenantId: string,
  status?: SupportThreadStatus,
): Promise<SupportThreadListItem[]> {
  return withTenant(db, tenantId, async (tx) => {
    const conditions = [eq(conversations.tenantId, tenantId)];
    // تعيين الحالة: closed → resolved حصراً؛ open → أي حالة غير resolved
    if (status === "closed") conditions.push(eq(conversations.status, "resolved"));
    else if (status === "open") conditions.push(ne(conversations.status, "resolved"));

    const rows = await tx
      .select({
        id: conversations.id,
        userId: conversations.userId,
        userName: users.firstName,
        userPhone: users.phoneE164,
        status: conversations.status,
        assignedStaffId: conversations.assignedStaffId,
        createdAt: conversations.createdAt,
        lastMessageText: conversations.lastMessagePreview,
        lastMessageAt: conversations.lastMessageAt,
        messageCount: sql<number>`(SELECT count(*)::int FROM messages m WHERE m.tenant_id = ${conversations.tenantId} AND m.conversation_id = ${conversations.id})`,
      })
      .from(conversations)
      .innerJoin(users, and(eq(users.tenantId, conversations.tenantId), eq(users.id, conversations.userId)))
      .where(and(...conditions))
      .orderBy(sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) DESC`);

    return rows.map((r) => ({ ...r, status: toSupportStatus(r.status) }));
  });
}

/** §9 — خيط واحد بترويسته وكل رسائله (تصاعدياً) — null إن لم يوجد لهذا المستأجر. */
export async function getSupportThread(
  db: Db,
  tenantId: string,
  threadId: string,
): Promise<SupportThreadDetail | null> {
  return withTenant(db, tenantId, async (tx) => {
    const threadRows = await tx
      .select({
        id: conversations.id,
        userId: conversations.userId,
        userName: users.firstName,
        userPhone: users.phoneE164,
        status: conversations.status,
        assignedStaffId: conversations.assignedStaffId,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .innerJoin(users, and(eq(users.tenantId, conversations.tenantId), eq(users.id, conversations.userId)))
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, threadId)))
      .limit(1);
    const t = threadRows[0];
    if (!t) return null;

    const msgs = await tx
      .select({ id: messages.id, direction: messages.direction, text: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, threadId)))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    return {
      thread: { ...t, status: toSupportStatus(t.status) },
      messages: msgs.map((m) => ({ id: m.id, direction: m.direction, text: m.text ?? "", createdAt: m.createdAt })),
    };
  });
}

/**
 * §9 — رد الموظف: يقفل صف المحادثة FOR UPDATE؛ غير موجودة → not_found. يُدرِج رسالة
 * صادرة channel='telegram'، يُسند المحادثة للموظف إن كانت بلا مُسنَد ويعيد فتحها إن كانت
 * resolved، ويكتب outbox 'support.reply' {threadId=convId} بنفس الترانزاكشن (D9).
 */
export async function staffReplyToThread(
  db: Db,
  tenantId: string,
  threadId: string,
  staffId: string | null,
  text: string,
): Promise<StaffReplyOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: conversations.id, status: conversations.status, assignedStaffId: conversations.assignedStaffId })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, threadId)))
      .for("update");
    const conv = rows[0];
    if (!conv) return { outcome: "not_found" as const };

    await recordOutboundMessage(tx, {
      tenantId,
      conversationId: threadId,
      channel: SUPPORT_CHANNEL,
      type: "text",
      content: text,
      ...(staffId !== null ? { sentByStaffId: staffId } : {}),
    });

    // إسناد للموظف إن بلا مُسنَد + إعادة فتح إن كانت resolved (الخيط الموحّد يستمر)
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (conv.assignedStaffId === null && staffId !== null) patch["assignedStaffId"] = staffId;
    if (conv.status === "resolved") patch["status"] = "open";
    await tx.update(conversations).set(patch).where(eq(conversations.id, threadId));

    await writeOutbox(tx, tenantId, "support.reply", { threadId, text });
    return { outcome: "sent" as const, threadId };
  });
}

/** §9 — إغلاق خيط: status='resolved' وإسناده للموظف إن بلا مُسنَد. غير موجود → not_found. */
export async function closeSupportThread(
  db: Db,
  tenantId: string,
  threadId: string,
  staffId: string | null,
): Promise<CloseThreadOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: conversations.id, assignedStaffId: conversations.assignedStaffId })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, threadId)))
      .for("update");
    const conv = rows[0];
    if (!conv) return { outcome: "not_found" as const };

    await tx
      .update(conversations)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
        ...(conv.assignedStaffId === null && staffId !== null ? { assignedStaffId: staffId } : {}),
      })
      .where(eq(conversations.id, threadId));

    return { outcome: "closed" as const };
  });
}
