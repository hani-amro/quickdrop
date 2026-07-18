import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { getOrCreateConversation } from "./conversations-service.js";
import { conversations, messages, supportMessages, supportThreads } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// P2.4c step 2 (expand/contract) — هجرة بيانات الدعم القديمة (support_threads/
// support_messages) إلى المخزن الموحّد قبل إسقاط الجداول القديمة. **idempotent**:
// كل رسالة مهاجَرة تحمل metadata.migrated_from = معرّف support_message الأصلي؛ إعادة
// التشغيل تتخطّى المهاجَر سلفاً. عدة خيوط لزبون واحد تنطوي في محادثته الموحّدة الوحيدة.

export interface SupportMigrationResult {
  threads: number;
  messagesMigrated: number;
  conversationsTouched: number;
}

/** يهاجر دعم مستأجر واحد إلى المخزن الموحّد (داخل withTenant). idempotent. */
export async function migrateSupportToUnified(db: Db, tenantId: string): Promise<SupportMigrationResult> {
  return withTenant(db, tenantId, async (tx) => {
    // (1) رسائل الدعم مع صاحب خيطها، ترتيباً زمنياً (لثبات آخر رسالة/الملخّص)
    const rows = await tx
      .select({
        smId: supportMessages.id,
        userId: supportThreads.userId,
        direction: supportMessages.direction,
        text: supportMessages.text,
        tgMessageId: supportMessages.tgMessageId,
        createdAt: supportMessages.createdAt,
      })
      .from(supportMessages)
      .innerJoin(supportThreads, and(eq(supportThreads.tenantId, supportMessages.tenantId), eq(supportThreads.id, supportMessages.threadId)))
      .where(eq(supportMessages.tenantId, tenantId))
      .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id));
    if (rows.length === 0) return { threads: 0, messagesMigrated: 0, conversationsTouched: 0 };

    // (2) ما هوجِر سلفاً (idempotency): metadata.migrated_from
    const migratedRows = await tx
      .select({ from: sql<string>`metadata->>'migrated_from'` })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), sql`metadata ? 'migrated_from'`));
    const alreadyMigrated = new Set(migratedRows.map((r) => r.from));

    const convByUser = new Map<string, string>();
    const touched = new Set<string>();
    let migrated = 0;

    for (const r of rows) {
      if (alreadyMigrated.has(r.smId)) continue;
      let conversationId = convByUser.get(r.userId);
      if (!conversationId) {
        conversationId = (await getOrCreateConversation(tx, tenantId, r.userId)).id;
        convByUser.set(r.userId, conversationId);
      }
      await tx.insert(messages).values({
        tenantId,
        conversationId,
        channel: "telegram",
        direction: r.direction,
        type: "text",
        content: r.text,
        status: r.direction === "in" ? "delivered" : "sent",
        ...(r.tgMessageId !== null ? { externalId: String(r.tgMessageId) } : {}),
        metadata: { migrated_from: r.smId },
        createdAt: r.createdAt,
      });
      touched.add(conversationId);
      migrated += 1;
    }

    // (3) لكل محادثة مُتأثّرة: أعِد ضبط last_message_at/preview من آخر رسالة، والحالة من
    // خيوط الزبون (أي خيط غير مغلق → open، وإلا resolved). unread يبقى (تاريخي = مُشاهَد).
    for (const conversationId of touched) {
      const last = await tx
        .select({ at: messages.createdAt, content: messages.content })
        .from(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)))
        .orderBy(sql`${messages.createdAt} DESC`)
        .limit(1);
      const userRow = await tx
        .select({ userId: conversations.userId })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
        .limit(1);
      const openThreads = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(supportThreads)
        .where(and(eq(supportThreads.tenantId, tenantId), eq(supportThreads.userId, userRow[0]!.userId), eq(supportThreads.status, "open")));
      const hasOpen = (openThreads[0]?.n ?? 0) > 0;
      await tx
        .update(conversations)
        .set({
          lastMessageAt: last[0]?.at ?? null,
          lastMessagePreview: last[0]?.content ? last[0].content.slice(0, 200) : null,
          status: hasOpen ? "open" : "resolved",
          updatedAt: new Date(),
        })
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
    }

    const threadCount = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(supportThreads)
      .where(eq(supportThreads.tenantId, tenantId));

    return { threads: threadCount[0]?.n ?? 0, messagesMigrated: migrated, conversationsTouched: touched.size };
  });
}

/** يهاجر كل المستأجرين (السكربت). tenants استثناء RLS — يُقرأ بلا سياق. */
export async function migrateAllSupport(db: Db, tenantIds: string[]): Promise<SupportMigrationResult> {
  const total: SupportMigrationResult = { threads: 0, messagesMigrated: 0, conversationsTouched: 0 };
  for (const tenantId of tenantIds) {
    const r = await migrateSupportToUnified(db, tenantId);
    total.threads += r.threads;
    total.messagesMigrated += r.messagesMigrated;
    total.conversationsTouched += r.conversationsTouched;
  }
  return total;
}
