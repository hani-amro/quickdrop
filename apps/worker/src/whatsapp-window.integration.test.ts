import {
  createDb,
  createOrder,
  getOrCreateConversation,
  outbox,
  pricingRules,
  recordInboundMessage,
  tenants,
  transition,
  users,
  waAccounts,
  waDeliveries,
  whatsappTemplates,
  withTenant,
  type DbHandle,
} from "@quickdrop/db";
import { encryptSecret, makePoint, newId, type DispatchJob, type NotificationJob, type WaTemplateKey } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNotificationsProcessor, type NotificationsConsumerDeps } from "./notifications-consumer.js";

// Task A (D1) — نافذة واتساب 24 ساعة + قوالب HSM عبر معالج الإشعارات الحقيقي (fetch محقون):
// (3) داخل النافذة → نص حرّ؛ خارجها + قالب معتمد → sendTemplate.
// (2) exactly-once: قالب مرتين → مكالمة Meta واحدة.
// (4) خارجها بلا قالب → degraded + حدث spine (لا إرسال).
// (6) عدم تطابق variable_map → خطأ صريح.

const APP_URL = process.env["DATABASE_URL"];
const WORKER_URL = process.env["DATABASE_URL_WORKER"];
const hasDb = Boolean(APP_URL && WORKER_URL);

const PICK = makePoint(3.139, 101.6869);
const DROP = makePoint(3.145, 101.71);

describe.skipIf(!hasDb)("Task A — نافذة واتساب/قوالب/degraded/exactly-once", () => {
  let app: DbHandle;
  let scan: DbHandle;
  let tenantId: string;
  const waSends: { type: string; body: string }[] = [];
  const MASTER_KEY = Buffer.alloc(32, 7);
  let waFail = false; // محاكاة فشل شبكي غامض (fetch يرمي، لا ردّ من Meta) — لاختبارات Fix A

  const waFetch = ((url: string, init: RequestInit) => {
    if (waFail) return Promise.reject(new Error("ECONNREFUSED (simulated network failure)"));
    const body = String(init.body);
    let type = "?";
    try { type = (JSON.parse(body) as { type?: string }).type ?? "?"; } catch { /* keep ? */ }
    waSends.push({ type, body });
    return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 }));
  }) as unknown as typeof fetch;

  const fakeDispatchQueue = { add: () => Promise.resolve({}) } as unknown as Queue<DispatchJob>;
  const fakeRt = { publish: () => Promise.resolve(1) };
  const fakeConvRedis = { get: () => Promise.resolve(null), set: () => Promise.resolve("OK"), del: () => Promise.resolve(1) };

  function deps(): NotificationsConsumerDeps {
    return { appDb: app.db, scanDb: scan.db, redis: fakeConvRedis as never, masterKey: MASTER_KEY, dispatchQueue: fakeDispatchQueue, rtRedis: fakeRt as never, waFetch };
  }

  beforeAll(async () => {
    app = createDb(APP_URL!);
    scan = createDb(WORKER_URL!);
    const t = await app.db.insert(tenants).values({ slug: `waw-${Date.now().toString(36)}`, name: "WA Window", nameAr: "نافذة", plan: "growth", currency: "MYR" }).returning({ id: tenants.id });
    tenantId = t[0]!.id;
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.insert(waAccounts).values({ tenantId, phoneNumberId: `pnid-${Date.now().toString(36)}`, accessTokenEnc: encryptSecret("wa-token", MASTER_KEY) });
      await tx.insert(pricingRules).values({ tenantId, service: "p2p", base: 5_000n, perKm: 1_000n, perKg: 0n, minTotal: 0n, surgeMultiplierBp: 10_000, priority: 0 });
    });
  });

  afterAll(async () => {
    await app.close();
    await scan.close();
  });

  /** زبون WA-only + طلب p2p (توصيل)؛ inWindow=true يبذر رسالة واردة حديثة عبر واتساب. */
  async function seedOrder(inWindow: boolean): Promise<{ orderId: string; customerId: string }> {
    const customerId = await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "customer", waId: `601${Math.floor(Math.random() * 1e9)}`, firstName: "C" }).returning({ id: users.id });
      const id = u[0]!.id;
      if (inWindow) {
        const conv = await getOrCreateConversation(tx, tenantId, id);
        await recordInboundMessage(tx, { tenantId, conversationId: conv.id, channel: "whatsapp", type: "text", content: "hi", externalId: `in-${id}` });
      }
      return id;
    });
    const { order } = await createOrder(app.db, tenantId, { service: "p2p", customerId, pickup: PICK, dropoff: DROP, createdBy: { type: "staff" } });
    return { orderId: order.id, customerId };
  }

  async function seedTemplate(internalKey: WaTemplateKey, variableMap: string[], status: "approved" | "pending" = "approved"): Promise<void> {
    await withTenant(app.db, tenantId, (tx) =>
      tx.insert(whatsappTemplates).values({ tenantId, internalKey, metaTemplateName: `${internalKey}_ms`, language: "ms", status, variableMap }).onConflictDoNothing({ target: [whatsappTemplates.tenantId, whatsappTemplates.internalKey] }),
    );
  }

  async function waDeliveryOf(outboxId: string): Promise<{ mode: string; status: string; metaMessageId: string | null } | null> {
    const rows = await withTenant(app.db, tenantId, (tx) => tx.select({ mode: waDeliveries.mode, status: waDeliveries.status, metaMessageId: waDeliveries.metaMessageId }).from(waDeliveries).where(and(eq(waDeliveries.tenantId, tenantId), eq(waDeliveries.outboxId, outboxId))));
    return rows[0] ?? null;
  }

  async function undeliverableCount(): Promise<number> {
    const rows = await withTenant(app.db, tenantId, (tx) => tx.select({ id: outbox.id }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "notification.undeliverable"))));
    return rows.length;
  }

  it("(3) داخل النافذة → نص حرّ (sendText)", async () => {
    const { orderId } = await seedOrder(true);
    const before = waSends.length;
    await createNotificationsProcessor(deps())({ outboxId: newId(), tenantId, topic: "payment.paid", payload: { orderId, paymentRef: `bill_${newId()}` } });
    expect(waSends.length).toBe(before + 1);
    expect(waSends[waSends.length - 1]!.type).toBe("text");
  });

  it("(3) خارج النافذة + قالب معتمد → sendTemplate (لا نص حرّ)", async () => {
    await seedTemplate("payment_receipt", ["code"]);
    const { orderId } = await seedOrder(false);
    const outboxId = newId();
    const before = waSends.length;
    await createNotificationsProcessor(deps())({ outboxId, tenantId, topic: "payment.paid", payload: { orderId, paymentRef: `bill_${newId()}` } });
    expect(waSends.length).toBe(before + 1);
    expect(waSends[waSends.length - 1]!.type).toBe("template");
    expect(waSends[waSends.length - 1]!.body).toContain("payment_receipt_ms");
    expect(await waDeliveryOf(outboxId)).toMatchObject({ mode: "template", status: "sent", metaMessageId: "wamid.X" });
  });

  it("(2) exactly-once: نفس صفّ الـoutbox مرتين → مكالمة Meta واحدة", async () => {
    await seedTemplate("payment_receipt", ["code"]);
    const { orderId } = await seedOrder(false);
    const outboxId = newId();
    const job: NotificationJob = { outboxId, tenantId, topic: "payment.paid", payload: { orderId, paymentRef: `bill_${newId()}` } };
    const before = waSends.length;
    const process = createNotificationsProcessor(deps());
    await process(job);
    await process(job); // إعادة تسليم at-least-once
    expect(waSends.length).toBe(before + 1); // مكالمة واحدة فقط
    expect(await waDeliveryOf(outboxId)).toMatchObject({ status: "sent" });
  });

  it("(4) خارج النافذة + بلا مفتاح قالب → degraded + حدث spine، لا إرسال", async () => {
    const { orderId, customerId } = await seedOrder(false);
    const outboxId = newId();
    const before = waSends.length;
    const beforeUndeliv = await undeliverableCount();
    // payment.link: internalKey=null → لا مفتاح قالب → خارج النافذة degrade (مرئي)
    await createNotificationsProcessor(deps())({ outboxId, tenantId, topic: "payment.link", payload: { orderId, userId: customerId, url: "https://billplz.test/x" } });
    expect(waSends.length).toBe(before); // لا إرسال
    expect(await waDeliveryOf(outboxId)).toMatchObject({ mode: "degraded", status: "degraded" });
    expect(await undeliverableCount()).toBe(beforeUndeliv + 1); // حدث spine مكتوب
  });

  it("(6) عدم تطابق variable_map (خطأ إعداد دائم) → degraded مرئي، لا عاصفة إعادة ولا إسقاط صامت", async () => {
    await seedTemplate("order_confirmed", ["nonexistent_var"]); // القالب يطلب متغيّراً لا نوفّره
    const { orderId } = await seedOrder(false);
    await withTenant(app.db, tenantId, (tx) => transition(tx, { orderId, to: "confirmed", actor: { type: "staff" } }));
    const outboxId = newId();
    const before = waSends.length;
    const beforeUndeliv = await undeliverableCount();
    // خطأ دائم → degrade (لا رمي = لا retry-until-DLQ)، مرئي عبر spine
    await createNotificationsProcessor(deps())({ outboxId, tenantId, topic: "order.status_changed", payload: { orderId, from: "pending", to: "confirmed" } });
    expect(waSends.length).toBe(before); // لا إرسال
    expect(await waDeliveryOf(outboxId)).toMatchObject({ mode: "degraded", status: "degraded" });
    expect(await undeliverableCount()).toBe(beforeUndeliv + 1); // حدث spine مكتوب
  });

  // ——— Fix A (من المراجعة العدائية): سياسة الفشل الشبكي الغامض تختلف حسب الوضع ———

  it("(A) فشل شبكي على نص حرّ → يُرمى (إعادة محاولة، الادّعاء يُحرَّر) — لا إسقاط صامت للحرّ", async () => {
    const { orderId } = await seedOrder(true); // داخل النافذة → نص حرّ
    const outboxId = newId();
    const before = waSends.length;
    waFail = true;
    try {
      await expect(
        createNotificationsProcessor(deps())({ outboxId, tenantId, topic: "payment.paid", payload: { orderId, paymentRef: `bill_${newId()}` } }),
      ).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      waFail = false;
    }
    expect(waSends.length).toBe(before); // لم يُسجَّل إرسال ناجح
    expect(await waDeliveryOf(outboxId)).toBeNull(); // الادّعاء حُرِّر → الطابور يعيد المحاولة
  });

  it("(A) فشل شبكي على قالب مدفوع → at-most-once (sent بلا wamid، لا رمي) — تفادي الشحن المزدوج", async () => {
    await seedTemplate("payment_receipt", ["code"]);
    const { orderId } = await seedOrder(false); // خارج النافذة → قالب
    const outboxId = newId();
    waFail = true;
    try {
      // لا يرمي (غموض: قد تكون Meta استلمت) — علّم sent كي لا تعيد المحاولة فتشحن مرتين
      await createNotificationsProcessor(deps())({ outboxId, tenantId, topic: "payment.paid", payload: { orderId, paymentRef: `bill_${newId()}` } });
    } finally {
      waFail = false;
    }
    expect(await waDeliveryOf(outboxId)).toMatchObject({ status: "sent", metaMessageId: null });
  });

  // ——— من مراجعة سدّ-الثغرات: ثغرتا إسقاط صامت D7 على مسارات مسّها Task A ———

  it("(gap-1) variable_map مشوّه (شكل خاطئ) → degrade مرئي، لا إرسال مُعلَّم sent بصمت", async () => {
    // إدراج قالب "معتمد" لكن variable_map ليس مصفوفة (خطأ إدراج يدوي: '\"code\"' بدل '[\"code\"]')
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.delete(whatsappTemplates).where(and(eq(whatsappTemplates.tenantId, tenantId), eq(whatsappTemplates.internalKey, "payment_receipt")));
      await tx.execute(
        sql`INSERT INTO whatsapp_templates (id, tenant_id, internal_key, meta_template_name, language, status, variable_map)
            VALUES (gen_random_uuid(), ${tenantId}::uuid, 'payment_receipt', 'pr_bad', 'ms', 'approved', '"code"'::jsonb)`,
      );
    });
    const { orderId } = await seedOrder(false); // خارج النافذة → مسار القالب
    const outboxId = newId();
    const before = waSends.length;
    const beforeUndeliv = await undeliverableCount();
    await createNotificationsProcessor(deps())({ outboxId, tenantId, topic: "payment.paid", payload: { orderId, paymentRef: `bill_${newId()}` } });
    expect(waSends.length).toBe(before); // لا إرسال (لا يُعلَّم sent كاذباً)
    expect(await waDeliveryOf(outboxId)).toMatchObject({ mode: "degraded", status: "degraded" });
    expect(await undeliverableCount()).toBe(beforeUndeliv + 1); // حدث spine مرئي
  });

  it("(gap-2) مسار degrade + ادّعاء 'claimed' عالق → يلوّج wa_delivery_claim_stuck (لا تخطٍّ صامت)", async () => {
    const { orderId, customerId } = await seedOrder(false); // خارج النافذة
    const outboxId = newId();
    // ادّعاء عالق سابق (انهيار بين الادّعاء والإرسال) لنفس صفّ الـoutbox
    await withTenant(app.db, tenantId, (tx) => tx.insert(waDeliveries).values({ tenantId, outboxId, mode: "free_form", status: "claimed", internalKey: null }));
    const beforeUndeliv = await undeliverableCount();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let loggedStuck = false;
    try {
      // payment.link (internalKey=null) → مسار degrade؛ claimWaDelivery(degraded) يخسر (won=false, existing='claimed')
      await createNotificationsProcessor(deps())({ outboxId, tenantId, topic: "payment.link", payload: { orderId, userId: customerId, url: "https://billplz.test/x" } });
      // اقرأ mock.calls قبل mockRestore (mockRestore يمسح السجلّ)
      loggedStuck = warnSpy.mock.calls.some((c) => String(c[0]).includes("wa_delivery_claim_stuck"));
    } finally {
      warnSpy.mockRestore();
    }
    expect(loggedStuck).toBe(true); // مرئي، لا صامت
    expect(await undeliverableCount()).toBe(beforeUndeliv); // won=false → لا حدث مكرّر
  });
});
