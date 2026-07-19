import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.js";
import { getConversation, getCustomer360, listConversations } from "./crm-read.js";
import { getOrCreateConversation, recordInboundMessage, recordOutboundMessage } from "./conversations-service.js";
import { conversations, customerProfiles, messages, tenants, users } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import { APP_URL, hasDb } from "./test-helpers.js";

describe.skipIf(!hasDb)("crm-read (تكامل، قاعدة حية)", () => {
  let app: DbHandle;
  let tenantId: string;
  let userId: string;
  let convId: string;

  beforeAll(async () => {
    app = createDb(APP_URL!);
    const t = await app.db.insert(tenants).values({ slug: `crm-${Date.now().toString(36)}`, name: "CRM QA", nameAr: "سي آر إم" }).returning({ id: tenants.id });
    tenantId = t[0]!.id;
    await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "customer", phoneE164: "+60133334444", firstName: "Layla", waId: "60133334444" }).returning({ id: users.id });
      userId = u[0]!.id;
      await tx.insert(customerProfiles).values({ tenantId, userId, lifecycleStage: "loyal", rfmScore: 90, orderCount: 6, totalSpent: 144_000n });
      convId = (await getOrCreateConversation(tx, tenantId, userId)).id;
      await recordInboundMessage(tx, { tenantId, conversationId: convId, channel: "whatsapp", externalId: "in1", type: "text", content: "مرحبا" });
      await recordInboundMessage(tx, { tenantId, conversationId: convId, channel: "whatsapp", externalId: "in2", type: "text", content: "طلب" });
      await recordOutboundMessage(tx, { tenantId, conversationId: convId, channel: "whatsapp", type: "text", content: "أهلاً" });
    });
  });

  afterAll(async () => {
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.execute(sql`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`);
      await tx.execute(sql`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`);
      await tx.delete(customerProfiles).where(eq(customerProfiles.tenantId, tenantId));
      await tx.delete(users).where(eq(users.tenantId, tenantId));
    });
    await app.db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
  });

  it("listConversations: يعيد الخيط مع اسم الزبون وunread (رسالتان واردتان)", async () => {
    const list = await listConversations(app.db, tenantId);
    expect(list).toHaveLength(1);
    expect(list[0]!.userName).toBe("Layla");
    expect(list[0]!.unreadCount).toBe(2); // رسالتان واردتان (الصادرة لا تزيد unread)
    expect(list[0]!.lastMessagePreview).toBe("أهلاً"); // آخر رسالة (صادرة)
  });

  it("getConversation: يعيد الرسائل تصاعدياً ويصفّر unread عند الفتح", async () => {
    const detail = await getConversation(app.db, tenantId, convId);
    expect(detail).not.toBeNull();
    expect(detail!.messages.map((m) => m.content)).toEqual(["مرحبا", "طلب", "أهلاً"]);
    expect(detail!.messages[0]!.direction).toBe("in");
    expect(detail!.messages[2]!.direction).toBe("out");
    expect(detail!.conversation.unreadCount).toBe(0); // صُفّر عند المشاهدة

    // تأكيد التصفير محفوظ بالقاعدة
    const persisted = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ n: conversations.unreadCount }).from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, convId)));
      return rows[0]!.n;
    });
    expect(persisted).toBe(0);
  });

  it("getCustomer360: الهوية + ملف الدماغ (totalSpent نص لا float)", async () => {
    const c = await getCustomer360(app.db, tenantId, userId);
    expect(c).not.toBeNull();
    expect(c!.name).toBe("Layla");
    expect(c!.waId).toBe("60133334444");
    expect(c!.lifecycleStage).toBe("loyal");
    expect(c!.rfmScore).toBe(90);
    expect(c!.totalSpent).toBe("144000"); // نص (D5 — لا float)
    expect(c!.orderCount).toBe(6);
  });

  it("getConversation لمعرّف غير موجود → null", async () => {
    expect(await getConversation(app.db, tenantId, "00000000-0000-4000-8000-000000000099")).toBeNull();
  });

  it("keyset مركّب: محادثات بنفس last_message_at تُرقَّم كلها بلا تخطٍّ (كاسر تعادل المعرّف)", async () => {
    // 5 محادثات بنفس اللحظة تماماً (تعادل عند حدود الصفحة) — أحدث من محادثة Layla
    const TIE = new Date("2030-01-01T00:00:00.000Z");
    const tieIds: string[] = [];
    await withTenant(app.db, tenantId, async (tx) => {
      for (let i = 0; i < 5; i += 1) {
        const u = await tx.insert(users).values({ tenantId, role: "customer", firstName: `tie${i}`, phoneE164: `+601400000${i}0` }).returning({ id: users.id });
        const c = await getOrCreateConversation(tx, tenantId, u[0]!.id);
        tieIds.push(c.id);
      }
      // اضبط نفس last_message_at للخمسة (لتعادل مضمون عند الترقيم)
      await tx.execute(sql`UPDATE conversations SET last_message_at = ${TIE.toISOString()} WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${sql`ARRAY[${sql.join(tieIds.map((id) => sql`${id}::uuid`), sql`, `)}]`})`);
    });

    // رقّم كامل القائمة بصفحات من 2 عبر المؤشّر المركّب، واجمع المعرّفات
    const seen: string[] = [];
    let before: Date | undefined;
    let beforeId: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await listConversations(app.db, tenantId, {
        limit: 2,
        ...(before ? { before } : {}),
        ...(beforeId ? { beforeId } : {}),
      });
      if (page.length === 0) break;
      for (const item of page) seen.push(item.id);
      const last = page[page.length - 1]!;
      before = last.lastMessageAt ?? undefined;
      beforeId = last.id;
      if (page.length < 2) break;
    }

    // لا تكرار، وكل الخمسة المتعادلة حاضرة + محادثة Layla (6 إجمالاً)
    expect(new Set(seen).size).toBe(seen.length); // بلا ازدواج
    for (const id of tieIds) expect(seen).toContain(id); // ولا واحدة مُتخطّاة
    expect(seen).toContain(convId);
    expect(seen.length).toBe(6);
  });
});
