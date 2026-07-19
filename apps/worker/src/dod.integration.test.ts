import {
  acceptOffer,
  attachPaymentRef,
  createDb,
  createDriver,
  createMerchant,
  drivers,
  ledgerEntries,
  loyaltyEvents,
  markOrderPaidByRef,
  merchantAcceptOrder,
  merchantMarkReady,
  merchantOperators,
  orders,
  outbox,
  pricingRules,
  setAiBudget,
  startRound,
  tenants,
  trackingTokens,
  transition,
  upsertCatalogItem,
  waAccounts,
  waWebhookUpdates,
  withTenant,
  type DbHandle,
} from "@quickdrop/db";
import { runAgent, type LlmClient, type LlmCompleteArgs, type LlmResponse } from "@quickdrop/ai";
import { encryptSecret, makePoint, newId, toPostgisWkt, type DispatchJob, type NotificationJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrainProcessor } from "./brain-consumer.js";
import { dispatchOrderJobId } from "./dispatch-worker.js";
import { createNotificationsProcessor, type NotificationsConsumerDeps } from "./notifications-consumer.js";
import { processWaUpdate, type AgentTrigger } from "./wa-update-processor.js";

// ═══════════ Tier-1 (تعريف الإنجاز — CLAUDE.md/قائمة المالك البند 4) ═══════════
// مستأجر واحد، فرع واحد، على الكود المدموج، من طرف لطرف:
// زبون يطلب على واتساب (وكيل AI بنموذج مبرمَج) ← يدفع (test عبر طبقة Billplz) ←
// order.ready_for_dispatch (مرة واحدة بالضبط) ← الإسناد يعيّن سائقاً على **نفس صف
// الطلب** ← تتبع حي ← إثبات تسليم ← الزبون محفوظ بدماغ الزبون المشترك.
// ولا نداء مباشر واحد بين الدماغين — الرحلة كلها أحداث (يفرضها حارس check-brain-seam).

const APP_URL = process.env["DATABASE_URL"];
const WORKER_URL = process.env["DATABASE_URL_WORKER"];
const hasDb = Boolean(APP_URL && WORKER_URL);

const MERCHANT_POINT = makePoint(33.5138, 36.2765);
const CUSTOMER_LOC = { lat: 33.5588, lng: 36.2765 };
const WA_CUSTOMER = "60123334444";
const OPERATOR_TG = 880_001;
const MASTER_KEY = Buffer.alloc(32, 9);

function scriptedLlm(responses: LlmResponse[]): LlmClient & { calls: LlmCompleteArgs[] } {
  const calls: LlmCompleteArgs[] = [];
  let i = 0;
  return {
    calls,
    complete(args) {
      calls.push(args);
      const res = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return Promise.resolve(res);
    },
  };
}
const USAGE = { inputTokens: 500, outputTokens: 100 };

describe.skipIf(!hasDb)("═ Tier-1 DoD: واتساب ← دفع ← مفصل ← إسناد ← تسليم ← دماغ ═", () => {
  let app: DbHandle;
  let scan: DbHandle;
  let tenantId: string;
  let merchantId: string;
  let itemId: string;
  let driverId: string;
  let customerId = "";
  let orderId = "";
  const waSends: string[] = [];
  const dispatchAdds: { data: DispatchJob; jobId: string | undefined }[] = [];

  const waFetch = ((_url: string, init: RequestInit) => {
    waSends.push(String(init.body));
    return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: `wamid.out${waSends.length}` }] }), { status: 200 }));
  }) as unknown as typeof fetch;

  const fakeDispatchQueue = {
    add: (_n: string, data: DispatchJob, opts?: { jobId?: string }) => {
      dispatchAdds.push({ data, jobId: opts?.jobId });
      return Promise.resolve({});
    },
  } as unknown as Queue<DispatchJob>;

  function notifDeps(): NotificationsConsumerDeps {
    return {
      appDb: app.db,
      scanDb: scan.db,
      redis: { get: () => Promise.resolve(null), set: () => Promise.resolve("OK"), del: () => Promise.resolve(1) } as never,
      masterKey: MASTER_KEY,
      dispatchQueue: fakeDispatchQueue,
      rtRedis: { publish: () => Promise.resolve(1) } as never,
      waFetch,
    };
  }

  /** صفوف outbox لموضوع لهذا المستأجر (اختياريّاً لطلب محدد). */
  async function outboxRows(topic: string, forOrderId?: string): Promise<Record<string, unknown>[]> {
    return withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, topic)));
      const payloads = rows.map((r) => r.payload as Record<string, unknown>);
      return forOrderId ? payloads.filter((p) => p["orderId"] === forOrderId) : payloads;
    });
  }

  async function orderRow() {
    return withTenant(app.db, tenantId, async (tx) => (await tx.select().from(orders).where(eq(orders.id, orderId)))[0]!);
  }

  /** إدراج صف inbox واتساب (كما تفعل البوابة persist-then-200) ثم معالجته. */
  async function ingestWaMessage(message: Record<string, unknown>, onAgentTrigger?: (t: AgentTrigger) => Promise<void>): Promise<void> {
    const updateId = newId();
    await withTenant(app.db, tenantId, (tx) =>
      tx.insert(waWebhookUpdates).values({
        id: updateId,
        tenantId,
        eventKey: message["id"] as string,
        payload: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "dod-pnid" },
          contacts: [{ wa_id: WA_CUSTOMER, profile: { name: "Zulaikha" } }],
          messages: [message],
        },
      }),
    );
    const outcome = await processWaUpdate(
      { appDb: app.db, ...(onAgentTrigger !== undefined ? { onAgentTrigger } : {}) },
      { tenantId, updateId },
    );
    expect(outcome).toBe("processed");
  }

  beforeAll(async () => {
    app = createDb(APP_URL!);
    scan = createDb(WORKER_URL!);
    // ── العالم: مستأجر (مُطلِق seam افتراضي 'ready') + WA + مطعم + مشغّل + سائق + ميزانية AI ──
    const t = await app.db
      .insert(tenants)
      .values({ slug: `dod-${Date.now().toString(36)}`, name: "DoD Restaurant", nameAr: "مطعم الإنجاز", plan: "growth" })
      .returning({ id: tenants.id });
    tenantId = t[0]!.id;
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.insert(waAccounts).values({ tenantId, phoneNumberId: `dod-pnid-${Date.now().toString(36)}`, accessTokenEnc: encryptSecret("wa-tok", MASTER_KEY) });
      await tx.insert(pricingRules).values({ tenantId, service: "food", base: 5_000n, perKm: 1_000n, perKg: 0n, minTotal: 0n, surgeMultiplierBp: 10_000, priority: 0 });
    });
    const m = await createMerchant(app.db, tenantId, { name: "DoD Kitchen", point: MERCHANT_POINT, category: "restaurant" });
    merchantId = m.id;
    const item = await upsertCatalogItem(app.db, tenantId, { merchantId, nameAr: "ناسي لمق", price: 35_000n });
    itemId = item.id;
    await withTenant(app.db, tenantId, (tx) => tx.insert(merchantOperators).values({ tenantId, merchantId, telegramUserId: OPERATOR_TG }));
    const created = await createDriver(app.db, tenantId, { vehicle: "motorbike", phone: "+60177778888", name: "Rider DoD" });
    if (created.outcome !== "created") throw new Error("driver seed failed");
    driverId = created.driver.id;
    await withTenant(app.db, tenantId, (tx) =>
      tx
        .update(drivers)
        .set({ status: "online", lastPoint: toPostgisWkt(MERCHANT_POINT), lastPointAt: new Date(), shiftStartedAt: new Date() })
        .where(eq(drivers.id, driverId)),
    );
    await setAiBudget(app.db, tenantId, 100_000n);
  });

  afterAll(async () => {
    await app.close();
    await scan.close();
  });

  it("1) الزبون يطلب على واتساب: موقع ← نص ← الوكيل ينشئ طلب توصيل مسعّراً من الخادم ويرد", async () => {
    // رسالة الموقع (مشبك ← موقع) → حقيقة last_location
    await ingestWaMessage({ id: "wamid.loc1", from: WA_CUSTOMER, type: "location", location: { latitude: CUSTOMER_LOC.lat, longitude: CUSTOMER_LOC.lng } });

    // الوكيل مفعّل على الخيط (المكتب فعّله) — نقرأ خيط الزبون ونفعّل ai_enabled
    await withTenant(app.db, tenantId, async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`UPDATE conversations SET ai_enabled = true WHERE tenant_id = ${tenantId}::uuid`,
      );
    });

    // رسالة الطلب النصية → مُطلِق الوكيل (نموذج مبرمَج: menu ← create_order ← رد)
    const llm = scriptedLlm([
      { content: [{ type: "tool_use", id: "t1", name: "get_menu", input: {} }], stopReason: "tool_use", usage: USAGE },
      {
        content: [{ type: "tool_use", id: "t2", name: "create_order", input: { merchant_id: merchantId, items: [{ catalog_item_id: itemId, qty: 2 }] } }],
        stopReason: "tool_use",
        usage: USAGE,
      },
      { content: [{ type: "text", text: "تم! ناسي لمق ×2 بالطريق إليك بعد التأكيد 🛵" }], stopReason: "end_turn", usage: USAGE },
    ]);
    let triggered = false;
    await ingestWaMessage({ id: "wamid.txt1", from: WA_CUSTOMER, type: "text", text: { body: "بدي ٢ ناسي لمق توصيل" } }, async (trigger) => {
      triggered = true;
      customerId = trigger.userId;
      const result = await runAgent({ db: app.db, llm }, { ...trigger, inboundText: trigger.text, systemPrompt: "أنت وكيل مطعم الإنجاز." });
      expect(result.outcome).toBe("replied");
    });
    expect(triggered).toBe(true);

    // الطلب: مسعّر من الخادم (35000×2 + توصيل من محرك التسعير) بنطاق زبون المحادثة
    const rows = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, customerId))),
    );
    expect(rows).toHaveLength(1);
    const o = rows[0]!;
    orderId = o.id;
    expect(o.source).toBe("ai");
    expect(o.fulfillment).toBe("delivery");
    expect(o.goodsAmount).toBe(70_000n); // من الكتالوج حصراً — النموذج ما مرّر سعراً (D11)
    expect(o.priceTotal > 0n).toBe(true); // توصيل من محرك التسعير
    expect(o.codAmount).toBe(o.goodsAmount + o.priceTotal);
    expect(o.status).toBe("pending");
    expect((await outboxRows("agent.reply")).length).toBeGreaterThanOrEqual(1); // رد الوكيل
  });

  it("2) يدفع (test): تصفير COD بنفس الترانزاكشن + payment.paid؛ التوصيل يبقى للبشر", async () => {
    await attachPaymentRef(app.db, tenantId, { orderId, paymentRef: "bill_dod" });
    const paid = await markOrderPaidByRef(app.db, tenantId, { paymentRef: "bill_dod" });
    expect(paid.outcome).toBe("paid");
    let o = await orderRow();
    expect(o.paymentStatus).toBe("paid");
    expect(o.codAmount).toBe(0n); // قرار المالك — بنفس ترانزاكشن الدفع
    expect((await outboxRows("payment.paid", orderId)).length).toBe(1);

    // مستهلك payment.paid: طلب **توصيل** → يبقى pending (بوابة البشر) + إشعار WA للزبون
    const process = createNotificationsProcessor(notifDeps());
    await process({ outboxId: "dod-pp", tenantId, topic: "payment.paid", payload: { orderId, paymentRef: "bill_dod" } });
    o = await orderRow();
    expect(o.status).toBe("pending");
    expect(waSends.some((b) => b.includes(WA_CUSTOMER))).toBe(true);
  });

  it("3) المطعم يقبل ويجهّز: المفصل يصدر مرة واحدة بالضبط ولا يزدوج", async () => {
    const accepted = await merchantAcceptOrder(app.db, tenantId, OPERATOR_TG, orderId, 20);
    expect(accepted.outcome).toBe("accepted"); // بوابة البشر: pending→confirmed→preparing
    expect((await outboxRows("order.ready_for_dispatch", orderId)).length).toBe(0); // ليس بعد

    const ready = await merchantMarkReady(app.db, tenantId, OPERATOR_TG, orderId);
    expect(ready.outcome).toBe("ready");
    const o = await orderRow();
    expect(o.status).toBe("ready");
    expect(o.readyAt).not.toBeNull();
    expect(o.dispatchRequestedAt).not.toBeNull(); // الختم write-once
    expect((await outboxRows("order.ready_for_dispatch", orderId)).length).toBe(1); // ⚡ الحدث — مرة واحدة
  });

  it("4) المفصل ← الإسناد: الحدث (حتى مكرَّراً) → جولة واحدة، والسائق يُعيَّن على نفس صف الطلب", async () => {
    const process = createNotificationsProcessor(notifDeps());
    const seamJob: NotificationJob = { outboxId: "dod-rfd", tenantId, topic: "order.ready_for_dispatch", payload: { orderId } };
    await process(seamJob);
    await process(seamJob); // تسليم مزدوج at-least-once
    expect(dispatchAdds).toHaveLength(2);
    expect(dispatchAdds[0]!.jobId).toBe(dispatchOrderJobId(orderId, 1));
    expect(dispatchAdds[1]!.jobId).toBe(dispatchAdds[0]!.jobId); // نفس المعرّف — BullMQ يُسقط الثاني

    // منفّذ مهمة الإسناد: جولة 1 → عرض للسائق؛ إعادة الجولة تعيد نفس العرض (idempotent)
    const round = await startRound(app.db, tenantId, orderId, 1);
    expect(round).not.toEqual({ exhausted: true });
    expect(await startRound(app.db, tenantId, orderId, 1)).toEqual(round);
    const offerId = (round as { offerId: string }).offerId;

    const accept = await acceptOffer(app.db, tenantId, offerId, driverId);
    expect(accept.outcome).toBe("accepted");
    const o = await orderRow();
    expect(o.id).toBe(orderId); // **نفس صف الطلب** — لا نسخ ولا جدول ثانٍ
    expect(o.status).toBe("assigned");
    expect(o.driverId).toBe(driverId);
  });

  it("5) تتبع حي ← إثبات تسليم: الرحلة الكاملة على الآلة، توكن التتبع حي، الدفتر والولاء", async () => {
    const token = await withTenant(app.db, tenantId, (tx) =>
      tx.select({ token: trackingTokens.token, expiresAt: trackingTokens.expiresAt }).from(trackingTokens).where(and(eq(trackingTokens.tenantId, tenantId), eq(trackingTokens.orderId, orderId))),
    );
    expect(token).toHaveLength(1); // §7 — رابط التتبع الحي وُلد مع الطلب
    expect(token[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const driverActor = { type: "driver" as const, id: driverId };
    await withTenant(app.db, tenantId, (tx) => transition(tx, { orderId, to: "picked_up", actor: driverActor }));
    await withTenant(app.db, tenantId, (tx) => transition(tx, { orderId, to: "in_transit", actor: driverActor }));
    await withTenant(app.db, tenantId, (tx) => transition(tx, { orderId, to: "arrived", actor: driverActor }));
    await withTenant(app.db, tenantId, (tx) => transition(tx, { orderId, to: "delivered", actor: driverActor })); // POD

    const o = await orderRow();
    expect(o.status).toBe("delivered");
    expect(o.deliveredAt).not.toBeNull();
    expect(o.codReceived).toBe(0n); // مدفوع إلكترونياً — لا تحصيل نقدي (الفخ 18)

    // §8.1 — الدفتر بنفس ترانزاكشن التسليم + الولاء
    const ledger = await withTenant(app.db, tenantId, (tx) =>
      tx.select({ entryType: ledgerEntries.entryType, amount: ledgerEntries.amount }).from(ledgerEntries).where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.orderId, orderId))),
    );
    expect(ledger.length).toBeGreaterThanOrEqual(1);
    const loyalty = await withTenant(app.db, tenantId, (tx) =>
      tx.select({ id: loyaltyEvents.id }).from(loyaltyEvents).where(and(eq(loyaltyEvents.tenantId, tenantId), eq(loyaltyEvents.userId, customerId))),
    );
    expect(loyalty.length).toBeGreaterThanOrEqual(1);
  });

  it("6) الزبون محفوظ بدماغ الزبون المشترك — والمفصل لم يصدر إلا مرة واحدة طوال الرحلة", async () => {
    const processBrain = createBrainProcessor({ appDb: app.db });
    await processBrain({ outboxId: "dod-brain", tenantId, topic: "order.status_changed", payload: { orderId, from: "arrived", to: "delivered" } });

    const profile = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.execute(
        (await import("drizzle-orm")).sql`SELECT order_count, total_spent, lifecycle_stage FROM customer_profiles WHERE tenant_id = ${tenantId}::uuid AND user_id = ${customerId}::uuid`,
      );
      return rows.rows[0] as { order_count: number; total_spent: string; lifecycle_stage: string } | undefined;
    });
    expect(profile).toBeDefined();
    expect(Number(profile!.order_count)).toBe(1);
    expect(BigInt(profile!.total_spent) > 0n).toBe(true); // goods+delivery — دماغ واحد مشترك
    expect(profile!.lifecycle_stage).toBeTruthy();

    // ⚡ الثابت الأهم: حدث المفصل صدر **مرة واحدة بالضبط** عبر الرحلة كلها
    expect((await outboxRows("order.ready_for_dispatch", orderId)).length).toBe(1);
  });
});
