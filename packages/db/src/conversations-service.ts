import type { MessageChannel, MessageStatus, MessageType } from "@quickdrop/shared";
import { and, eq, sql } from "drizzle-orm";
import { conversations, messages } from "./schema/conversations.js";
import type { Tx } from "./with-tenant.js";

// دمج WaFlow (MERGE_PLAN §4.4) — منطق المخزن الموحّد داخل ترانزاكشن مستأجر قائمة.
// خيط واحد لكل زبون (get-or-create ذرّي)، والرسائل idempotent بمفتاح (tenant, channel,
// external_id) — إعادة إرسال Meta/تيليغرام لا تُضاعف.

/** خيط الزبون — ينشئه إن غاب (سباق رسالتين متزامنتين يحسمه الفريد على (tenant, user)). */
export async function getOrCreateConversation(tx: Tx, tenantId: string, userId: string): Promise<string> {
  const existing = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const inserted = await tx
    .insert(conversations)
    .values({ tenantId, userId })
    .onConflictDoNothing({ target: [conversations.tenantId, conversations.userId] })
    .returning({ id: conversations.id });
  if (inserted[0]) return inserted[0].id;

  // خسرنا السباق — الصف موجود الآن حتماً
  const winner = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)))
    .limit(1);
  if (!winner[0]) throw new Error(`getOrCreateConversation: lost race but no row (tenant ${tenantId})`); // §16.12
  return winner[0].id;
}

export interface RecordInboundInput {
  tenantId: string;
  conversationId: string;
  channel: MessageChannel;
  externalId: string; // wa_message_id / tg_message_id — مفتاح إزالة التكرار
  type: MessageType;
  content?: string;
  mediaUrl?: string;
  mediaMime?: string;
  metadata?: Record<string, unknown>;
  at?: Date;
}

export type RecordInboundOutcome = "inserted" | "duplicate";

/**
 * رسالة واردة: إدراج idempotent (dedup على external_id) + تحديث ملخّص المحادثة
 * (last_message_at/preview/unread++) **فقط عند الإدراج الجديد** (لا تضخيم unread بالإعادة).
 */
export async function recordInboundMessage(tx: Tx, input: RecordInboundInput): Promise<RecordInboundOutcome> {
  const at = input.at ?? new Date();
  const inserted = await tx
    .insert(messages)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      channel: input.channel,
      direction: "in",
      type: input.type,
      externalId: input.externalId,
      status: "delivered",
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.mediaUrl !== undefined ? { mediaUrl: input.mediaUrl } : {}),
      ...(input.mediaMime !== undefined ? { mediaMime: input.mediaMime } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      createdAt: at,
    })
    // الفهرس جزئي (WHERE external_id IS NOT NULL) — لازم targetWhere كي يستدلّ Postgres عليه
    .onConflictDoNothing({
      target: [messages.tenantId, messages.channel, messages.externalId],
      where: sql`external_id IS NOT NULL`,
    })
    .returning({ id: messages.id });

  if (inserted.length === 0) return "duplicate"; // إعادة إرسال — لا تحديث للملخّص

  const preview = (input.content ?? `[${input.type}]`).slice(0, 200);
  await tx
    .update(conversations)
    .set({
      lastMessageAt: at,
      lastInboundAt: at,
      lastMessagePreview: preview,
      unreadCount: sql`${conversations.unreadCount} + 1`,
      // رسالة جديدة تُعيد فتح خيطاً مُغلقاً (resolved/snoozed → open)
      status: sql`CASE WHEN ${conversations.status} IN ('resolved','snoozed') THEN 'open' ELSE ${conversations.status} END`,
      updatedAt: at,
    })
    .where(and(eq(conversations.tenantId, input.tenantId), eq(conversations.id, input.conversationId)));
  return "inserted";
}

/** رسالة صادرة (من موظف/بوت/AI): إدراج + تحديث last_message_at بلا مسّ unread. */
export async function recordOutboundMessage(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    channel: MessageChannel;
    type: MessageType;
    content?: string;
    externalId?: string;
    sentByStaffId?: string;
    status?: MessageStatus;
    metadata?: Record<string, unknown>;
    at?: Date;
  },
): Promise<string> {
  const at = input.at ?? new Date();
  const inserted = await tx
    .insert(messages)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      channel: input.channel,
      direction: "out",
      type: input.type,
      status: input.status ?? "sent",
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(input.sentByStaffId !== undefined ? { sentByStaffId: input.sentByStaffId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      createdAt: at,
    })
    .returning({ id: messages.id });
  const row = inserted[0];
  if (!row) throw new Error("recordOutboundMessage: INSERT returned no row"); // §16.12

  const preview = (input.content ?? `[${input.type}]`).slice(0, 200);
  await tx
    .update(conversations)
    .set({ lastMessageAt: at, lastMessagePreview: preview, updatedAt: at })
    .where(and(eq(conversations.tenantId, input.tenantId), eq(conversations.id, input.conversationId)));
  return row.id;
}
