import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.js";
import { getOrCreateConversation, recordInboundMessage } from "./conversations-service.js";
import { appendInboundMessage, getSupportThread, listSupportThreads, staffReplyToThread } from "./support.js";
import { conversations, messages, outbox, tenants, users } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import { APP_URL, hasDb } from "./test-helpers.js";

// P2.4c (قرار المالك 2026-07-19) — المخزن الموحّد يخدم قناتي تيليغرام وواتساب لنفس
// الزبون بخيط **واحد**. اختبار أولاً (test-first): يقود إعادة كتابة support.ts.

describe.skipIf(!hasDb)("دمج الدعم بالمخزن الموحّد (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    app = createDb(APP_URL!);
    const t = await app.db.insert(tenants).values({ slug: `sup-${Date.now().toString(36)}`, name: "Support QA", nameAr: "دعم" }).returning({ id: tenants.id });
    tenantId = t[0]!.id;
    userId = await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "customer", telegramUserId: 55501, phoneE164: "+60155501", firstName: "Omar", waId: "60155501" }).returning({ id: users.id });
      return u[0]!.id;
    });
  });

  afterAll(async () => {
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.execute(sql`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`);
      await tx.execute(sql`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`);
      await tx.delete(outbox).where(eq(outbox.tenantId, tenantId));
      await tx.delete(users).where(eq(users.tenantId, tenantId));
    });
    await app.db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
  });

  it("رسالة دعم تيليغرام + رسالة واتساب لنفس الزبون → خيط واحد بكلتا القناتين", async () => {
    // (1) دعم تيليغرام عبر appendInboundMessage (المسار المُعاد كتابته)
    const tg = await appendInboundMessage(app.db, tenantId, userId, "مشكلة بالطلب", 9001);
    expect(tg.isNewThread).toBe(true);

    // (2) رسالة واتساب لنفس الزبون عبر المخزن الموحّد
    await withTenant(app.db, tenantId, async (tx) => {
      const convId = (await getOrCreateConversation(tx, tenantId, userId)).id;
      await recordInboundMessage(tx, { tenantId, conversationId: convId, channel: "whatsapp", externalId: "wamid.sup1", type: "text", content: "استفسار واتساب" });
    });

    // خيط واحد فقط لهذا الزبون، وبه الرسالتان بقناتيهما
    const convRows = await withTenant(app.db, tenantId, async (tx) => {
      const c = await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.userId, userId)));
      const m = c[0] ? await tx.select({ channel: messages.channel, content: messages.content }).from(messages).where(eq(messages.conversationId, c[0].id)).orderBy(messages.createdAt) : [];
      return { count: c.length, threadId: tg.threadId, unifiedId: c[0]?.id, msgs: m };
    });
    expect(convRows.count).toBe(1); // خيط واحد رغم قناتين
    expect(convRows.threadId).toBe(convRows.unifiedId); // appendInboundMessage يعيد معرّف المحادثة الموحّدة
    expect(convRows.msgs).toEqual([
      { channel: "telegram", content: "مشكلة بالطلب" },
      { channel: "whatsapp", content: "استفسار واتساب" },
    ]);
  });

  it("listSupportThreads/getSupportThread يخدمان الخيط الموحّد (شكل الدعم محفوظ)", async () => {
    const list = await listSupportThreads(app.db, tenantId);
    expect(list).toHaveLength(1);
    expect(list[0]!.userName).toBe("Omar");
    expect(list[0]!.messageCount).toBe(2);

    const detail = await getSupportThread(app.db, tenantId, list[0]!.id);
    expect(detail).not.toBeNull();
    expect(detail!.messages.map((m) => m.direction)).toEqual(["in", "in"]);
  });

  it("staffReplyToThread: يكتب رسالة صادرة + outbox 'support.reply' بنفس المعرّف الموحّد", async () => {
    const list = await listSupportThreads(app.db, tenantId);
    const convId = list[0]!.id;
    const result = await staffReplyToThread(app.db, tenantId, convId, null, "نعتذر، جارٍ الحل");
    expect(result).toEqual({ outcome: "sent", threadId: convId });

    const check = await withTenant(app.db, tenantId, async (tx) => {
      const outMsg = await tx.select({ dir: messages.direction, content: messages.content }).from(messages).where(and(eq(messages.tenantId, tenantId), eq(messages.direction, "out")));
      const ob = await tx.select({ topic: outbox.topic, payload: outbox.payload }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "support.reply")));
      return { outMsg, ob };
    });
    expect(check.outMsg).toHaveLength(1);
    expect(check.outMsg[0]!.content).toBe("نعتذر، جارٍ الحل");
    expect(check.ob).toHaveLength(1);
    expect((check.ob[0]!.payload as { threadId: string }).threadId).toBe(convId);
  });
});
