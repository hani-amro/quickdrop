import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.js";
import { migrateSupportToUnified } from "./support-migrate.js";
import { conversations, messages, supportMessages, supportThreads, tenants, users } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import { APP_URL, hasDb } from "./test-helpers.js";

// P2.4c step 2 — التحقق من هجرة الدعم القديم: بذر support_threads/support_messages ثم
// migrateSupportToUnified ثم فحص التكافؤ (عدد الرسائل + المحتوى + الاتجاه) وidempotency.

describe.skipIf(!hasDb)("migrateSupportToUnified (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    app = createDb(APP_URL!);
    const t = await app.db.insert(tenants).values({ slug: `supmig-${Date.now().toString(36)}`, name: "SupMig QA", nameAr: "هجرة" }).returning({ id: tenants.id });
    tenantId = t[0]!.id;
    await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "customer", telegramUserId: 77701, firstName: "Nour" }).returning({ id: users.id });
      userId = u[0]!.id;
      // خيطان قديمان لنفس الزبون (مفتوح + مغلق) — يجب أن ينطويا في محادثة موحّدة واحدة
      const closed = await tx.insert(supportThreads).values({ tenantId, userId, status: "closed" }).returning({ id: supportThreads.id });
      const open = await tx.insert(supportThreads).values({ tenantId, userId, status: "open" }).returning({ id: supportThreads.id });
      await tx.insert(supportMessages).values([
        { tenantId, threadId: closed[0]!.id, direction: "in", text: "قديم 1", tgMessageId: 1, createdAt: new Date(Date.now() - 40_000) },
        { tenantId, threadId: closed[0]!.id, direction: "out", text: "رد قديم", createdAt: new Date(Date.now() - 30_000) },
        { tenantId, threadId: open[0]!.id, direction: "in", text: "جديد", tgMessageId: 2, createdAt: new Date(Date.now() - 10_000) },
      ]);
    });
  });

  afterAll(async () => {
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.execute(sql`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`);
      await tx.execute(sql`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`);
      await tx.execute(sql`DELETE FROM support_messages WHERE tenant_id = ${tenantId}::uuid`);
      await tx.execute(sql`DELETE FROM support_threads WHERE tenant_id = ${tenantId}::uuid`);
      await tx.delete(users).where(eq(users.tenantId, tenantId));
    });
    await app.db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
  });

  it("يهاجر كل الرسائل إلى محادثة موحّدة واحدة بتكافؤ المحتوى والاتجاه والترتيب", async () => {
    const result = await migrateSupportToUnified(app.db, tenantId);
    expect(result.threads).toBe(2);
    expect(result.messagesMigrated).toBe(3);
    expect(result.conversationsTouched).toBe(1); // خيطان → محادثة واحدة

    const unified = await withTenant(app.db, tenantId, async (tx) => {
      const c = await tx.select().from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)));
      const m = await tx
        .select({ direction: messages.direction, content: messages.content, channel: messages.channel })
        .from(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, c[0]!.id)))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      return { conv: c[0]!, msgs: m };
    });
    expect(unified.conv.status).toBe("open"); // زبون له خيط مفتوح → open
    expect(unified.conv.lastMessagePreview).toBe("جديد"); // آخر رسالة زمنياً
    expect(unified.msgs).toEqual([
      { direction: "in", content: "قديم 1", channel: "telegram" },
      { direction: "out", content: "رد قديم", channel: "telegram" },
      { direction: "in", content: "جديد", channel: "telegram" },
    ]);
  });

  it("idempotent: إعادة التشغيل لا تضاعف الرسائل", async () => {
    const rerun = await migrateSupportToUnified(app.db, tenantId);
    expect(rerun.messagesMigrated).toBe(0); // كلها مهاجَرة سلفاً (metadata.migrated_from)

    const count = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ n: sql<number>`count(*)::int` }).from(messages).where(eq(messages.tenantId, tenantId));
      return rows[0]!.n;
    });
    expect(count).toBe(3); // لا تكرار
  });
});
