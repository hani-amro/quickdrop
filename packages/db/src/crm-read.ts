import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { ConversationStatus } from "@quickdrop/shared";
import { conversations, messages } from "./schema/conversations.js";
import { customerFacts, customerProfiles } from "./schema/crm.js";
import { orders } from "./schema/orders.js";
import { users } from "./schema/users.js";
import type { Db } from "./client.js";
import { withTenant } from "./with-tenant.js";

// دمج WaFlow (MERGE_PLAN §3.6/P2 step 10) — قراءات CRM للداشبورد: قوائم/تفاصيل بلا N+1
// (join واحد)، ترقيم بالخادم (keyset)، كلها داخل withTenant (RLS §2.3).

export interface ConversationListItem {
  id: string;
  userId: string;
  userName: string | null;
  userPhone: string | null;
  status: ConversationStatus;
  assignedStaffId: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
  aiEnabled: boolean;
}

/** قائمة المحادثات لمستأجر — join واحد مع users، أحدث نشاطاً أولاً، ترقيم keyset.
 *  keyset مركّب (last_message_at, id) DESC: بلا كاسر التعادل على المعرّف، محادثات
 *  بنفس last_message_at عند حدّ الصفحة قد تُتخطّى. المؤشّر التالي = (before, beforeId)
 *  من آخر عنصر. beforeId بلا before يُتجاهل (يلزمان معاً). */
export async function listConversations(
  db: Db,
  tenantId: string,
  opts: { status?: ConversationStatus; before?: Date; beforeId?: string; limit?: number } = {},
): Promise<ConversationListItem[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  return withTenant(db, tenantId, (tx) => {
    const filters = [eq(conversations.tenantId, tenantId)];
    if (opts.status) filters.push(eq(conversations.status, opts.status));
    if (opts.before) {
      filters.push(
        opts.beforeId
          ? sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${opts.before.toISOString()}, ${opts.beforeId})`
          : lt(conversations.lastMessageAt, opts.before),
      );
    }
    return tx
      .select({
        id: conversations.id,
        userId: conversations.userId,
        userName: users.firstName,
        userPhone: users.phoneE164,
        status: conversations.status,
        assignedStaffId: conversations.assignedStaffId,
        lastMessagePreview: conversations.lastMessagePreview,
        lastMessageAt: conversations.lastMessageAt,
        unreadCount: conversations.unreadCount,
        aiEnabled: conversations.aiEnabled,
      })
      .from(conversations)
      .innerJoin(users, and(eq(users.tenantId, conversations.tenantId), eq(users.id, conversations.userId)))
      .where(and(...filters))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(limit);
  });
}

export interface ConversationDetail {
  conversation: ConversationListItem;
  messages: {
    id: string;
    channel: string;
    direction: string;
    type: string;
    content: string | null;
    mediaUrl: string | null;
    status: string;
    createdAt: Date;
  }[];
}

/** تفاصيل محادثة + آخر رسائلها (ترتيب زمني)، ويصفّر unread (تمت المشاهدة). */
export async function getConversation(
  db: Db,
  tenantId: string,
  conversationId: string,
  opts: { messageLimit?: number } = {},
): Promise<ConversationDetail | null> {
  const limit = Math.min(opts.messageLimit ?? 50, 200);
  return withTenant(db, tenantId, async (tx) => {
    const convRows = await tx
      .select({
        id: conversations.id,
        userId: conversations.userId,
        userName: users.firstName,
        userPhone: users.phoneE164,
        status: conversations.status,
        assignedStaffId: conversations.assignedStaffId,
        lastMessagePreview: conversations.lastMessagePreview,
        lastMessageAt: conversations.lastMessageAt,
        unreadCount: conversations.unreadCount,
        aiEnabled: conversations.aiEnabled,
      })
      .from(conversations)
      .innerJoin(users, and(eq(users.tenantId, conversations.tenantId), eq(users.id, conversations.userId)))
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
      .limit(1);
    const conversation = convRows[0];
    if (!conversation) return null;

    const msgs = await tx
      .select({
        id: messages.id,
        channel: messages.channel,
        direction: messages.direction,
        type: messages.type,
        content: messages.content,
        mediaUrl: messages.mediaUrl,
        status: messages.status,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)))
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    // تصفير unread عند الفتح (تمت المشاهدة) — إن كان > 0
    if (conversation.unreadCount > 0) {
      await tx
        .update(conversations)
        .set({ unreadCount: 0, updatedAt: new Date() })
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
      conversation.unreadCount = 0;
    }
    return { conversation, messages: msgs.reverse() }; // تصاعدي للعرض
  });
}

export interface Customer360 {
  userId: string;
  name: string | null;
  phone: string | null;
  waId: string | null;
  lifecycleStage: string | null;
  rfmScore: number | null;
  orderCount: number | null;
  totalSpent: string | null; // bigint → نص (لا float على المال — D5)
  favoriteItems: unknown;
  recentOrders: { id: string; publicCode: string; status: string; goodsAmount: string; deliveredAt: Date | null }[];
  facts: { key: string; value: string; source: string; confidence: number }[];
}

/** بطاقة الزبون 360: الهوية + ملف الدماغ + آخر الطلبات + حقائق الـ AI — استعلامات محدودة. */
export async function getCustomer360(db: Db, tenantId: string, userId: string): Promise<Customer360 | null> {
  return withTenant(db, tenantId, async (tx) => {
    const uRows = await tx
      .select({ name: users.firstName, phone: users.phoneE164, waId: users.waId })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .limit(1);
    const u = uRows[0];
    if (!u) return null;

    const pRows = await tx
      .select({
        lifecycleStage: customerProfiles.lifecycleStage,
        rfmScore: customerProfiles.rfmScore,
        orderCount: customerProfiles.orderCount,
        totalSpent: sql<string>`${customerProfiles.totalSpent}::text`,
        favoriteItems: customerProfiles.favoriteItems,
      })
      .from(customerProfiles)
      .where(and(eq(customerProfiles.tenantId, tenantId), eq(customerProfiles.userId, userId)))
      .limit(1);
    const p = pRows[0];

    const recentOrders = await tx
      .select({
        id: orders.id,
        publicCode: orders.publicCode,
        status: orders.status,
        goodsAmount: sql<string>`${orders.goodsAmount}::text`,
        deliveredAt: orders.deliveredAt,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, userId)))
      .orderBy(desc(orders.createdAt))
      .limit(10);

    const facts = await tx
      .select({ key: customerFacts.key, value: customerFacts.value, source: customerFacts.source, confidence: customerFacts.confidence })
      .from(customerFacts)
      .where(and(eq(customerFacts.tenantId, tenantId), eq(customerFacts.userId, userId)))
      .limit(50);

    return {
      userId,
      name: u.name,
      phone: u.phone,
      waId: u.waId,
      lifecycleStage: p?.lifecycleStage ?? null,
      rfmScore: p?.rfmScore ?? null,
      orderCount: p?.orderCount ?? null,
      totalSpent: p?.totalSpent ?? null,
      favoriteItems: p?.favoriteItems ?? null,
      recentOrders,
      facts,
    };
  });
}
