import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMerchant, upsertCatalogItem } from "./merchants-service.js";
import { merchantAcceptOrder, merchantMarkReady } from "./merchant-bot.js";
import { acceptOffer, assignManually, startRound } from "./dispatch.js";
import { createOrder } from "./orders-service.js";
import { drivers, merchantOperators, offers, orders, outbox } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import {
  closeHarness,
  connectHarness,
  DEFAULT_DROPOFF,
  DEFAULT_PICKUP,
  doTransition,
  fulfilledOf,
  makeOrder,
  seedCustomer,
  seedDriver,
  seedPricingRule,
  seedTenant,
  type TestHarness,
} from "./test-helpers.js";

// المرحلة 3 — **قائمة §4.2 الحاجبة (قرار المالك)**: اختبارات المفصل. لكل موقع من الستة:
// (أ) طلب طعام مدفوع/مؤكّد → order.ready_for_dispatch يصدر **مرة واحدة** → الإسناد يبدأ
//     على **نفس صف الطلب**؛ (ب) طلب pickup لا يُرسَل له سائق فيزيائي أبداً.
// + chaos: 5 محاولات متزامنة ⇒ ختم واحد وحدث واحد (R-15)؛ تسليم مزدوج ⇒ جولة واحدة.

const hasDb = Boolean(process.env["DATABASE_URL"] && process.env["DATABASE_URL_MIGRATOR"]);

const OPERATOR_TG = 990_001;

describe.skipIf(!hasDb)("المفصل §4.2 (تكامل، قاعدة حية)", () => {
  let h: TestHarness;

  beforeAll(() => {
    h = connectHarness();
  });

  afterAll(async () => {
    await closeHarness(h);
  });

  /** صفوف order.ready_for_dispatch بالـ outbox لطلب. */
  async function seamEvents(tenantId: string, orderId: string): Promise<number> {
    return withTenant(h.app.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: outbox.id, payload: outbox.payload })
        .from(outbox)
        .where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "order.ready_for_dispatch")));
      return rows.filter((r) => (r.payload as { orderId?: string }).orderId === orderId).length;
    });
  }

  async function readOrder(tenantId: string, orderId: string) {
    return withTenant(h.app.db, tenantId, async (tx) => {
      const rows = await tx.select().from(orders).where(eq(orders.id, orderId));
      return rows[0]!;
    });
  }

  /** عالم طعام: مستأجر + تسعير + زبون + مطعم بصنف + مشغّل مربوط. */
  async function seedFoodWorld(dispatchTrigger: "ready" | "confirmed" = "ready") {
    const tenantId = await seedTenant(h.app.db, { dispatchTrigger });
    await seedPricingRule(h.app.db, tenantId, { service: "food" });
    await seedPricingRule(h.app.db, tenantId); // p2p للاختبارات المجاورة
    const customerId = await seedCustomer(h.app.db, tenantId);
    const merchant = await createMerchant(h.app.db, tenantId, { name: "مطعم المفصل", point: DEFAULT_PICKUP, category: "restaurant" });
    const item = await upsertCatalogItem(h.app.db, tenantId, { merchantId: merchant.id, nameAr: "شاورما", price: 30_000n });
    await withTenant(h.app.db, tenantId, (tx) =>
      tx.insert(merchantOperators).values({ tenantId, merchantId: merchant.id, telegramUserId: OPERATOR_TG }),
    );
    return { tenantId, customerId, merchantId: merchant.id, itemId: item.id };
  }

  function foodOrderInput(customerId: string, merchantId: string, itemId: string, extra: Record<string, unknown> = {}) {
    return {
      service: "food" as const,
      customerId,
      merchantId,
      items: [{ catalogItemId: itemId, qty: 2 }],
      pickup: DEFAULT_PICKUP,
      dropoff: DEFAULT_DROPOFF,
      createdBy: { type: "staff" as const },
      ...extra,
    };
  }

  it("p2p توصيل: التأكيد يختم dispatch_requested_at ويصدر الحدث مرة واحدة — بنفس الترانزاكشن", async () => {
    const tenantId = await seedTenant(h.app.db);
    await seedPricingRule(h.app.db, tenantId);
    const customerId = await seedCustomer(h.app.db, tenantId);
    const { order } = await makeOrder(h.app.db, tenantId, { customerId }); // confirm=true

    const row = await readOrder(tenantId, order.id);
    expect(row.dispatchRequestedAt).not.toBeNull(); // الختم كُتب
    expect(await seamEvents(tenantId, order.id)).toBe(1); // حدث واحد بالضبط
  });

  it("chaos (R-15): خمس محاولات تأكيد متزامنة ⇒ انتقال واحد وختم واحد وحدث واحد", async () => {
    const tenantId = await seedTenant(h.app.db);
    await seedPricingRule(h.app.db, tenantId);
    const customerId = await seedCustomer(h.app.db, tenantId);
    const { order } = await makeOrder(h.app.db, tenantId, { customerId, confirm: false }); // pending

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => doTransition(h.app.db, tenantId, { orderId: order.id, to: "confirmed", actor: { type: "staff" } })),
    );
    expect(fulfilledOf(attempts)).toHaveLength(1); // قفل الصف + الآلة: واحدة فقط تمر
    expect(await seamEvents(tenantId, order.id)).toBe(1);
    const row = await readOrder(tenantId, order.id);
    expect(row.dispatchRequestedAt).not.toBeNull();
  });

  it("food بالمُطلِق الافتراضي 'ready': لا حدث عند التأكيد ولا القبول — يصدر عند الجهوز فقط (مرة واحدة)", async () => {
    const w = await seedFoodWorld("ready");
    const created = await createOrder(h.app.db, w.tenantId, foodOrderInput(w.customerId, w.merchantId, w.itemId));
    const orderId = created.order.id;

    await doTransition(h.app.db, w.tenantId, { orderId, to: "confirmed", actor: { type: "staff" } });
    expect(await seamEvents(w.tenantId, orderId)).toBe(0); // المطبخ لم يقبل بعد

    const accepted = await merchantAcceptOrder(h.app.db, w.tenantId, OPERATOR_TG, orderId, 30);
    expect(accepted.outcome).toBe("accepted"); // D-M6: transition(confirmed→preparing)
    const afterAccept = await readOrder(w.tenantId, orderId);
    expect(afterAccept.status).toBe("preparing");
    expect(afterAccept.merchantConfirmedAt).not.toBeNull();
    expect(afterAccept.merchantPrepMinutes).toBe(30);
    expect(await seamEvents(w.tenantId, orderId)).toBe(0); // ولا حدث بعد

    const ready = await merchantMarkReady(h.app.db, w.tenantId, OPERATOR_TG, orderId);
    expect(ready.outcome).toBe("ready");
    const afterReady = await readOrder(w.tenantId, orderId);
    expect(afterReady.status).toBe("ready");
    expect(afterReady.readyAt).not.toBeNull(); // write-once
    expect(afterReady.dispatchRequestedAt).not.toBeNull(); // الختم
    // F3 (مراجعة Phase 3): promised_at يُحسب عند ختم المفصل لمسار تأكيد الطعام (لا يمر بـ
    // confirm() الطاقم) — كان يبقى null. الآن مضبوط ومستقبلي (now + eta + هامش).
    expect(afterReady.promisedAt).not.toBeNull();
    expect(afterReady.promisedAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await seamEvents(w.tenantId, orderId)).toBe(1); // الحدث صدر الآن — مرة واحدة
  });

  it("food بمُطلِق 'confirmed': الحدث عند التأكيد؛ القبول والجهوز لا يضاعفانه (write-once)", async () => {
    const w = await seedFoodWorld("confirmed");
    const created = await createOrder(h.app.db, w.tenantId, foodOrderInput(w.customerId, w.merchantId, w.itemId));
    const orderId = created.order.id;

    await doTransition(h.app.db, w.tenantId, { orderId, to: "confirmed", actor: { type: "staff" } });
    expect(await seamEvents(w.tenantId, orderId)).toBe(1); // فوراً — السائق ينطلق مع التحضير

    await merchantAcceptOrder(h.app.db, w.tenantId, OPERATOR_TG, orderId, 15);
    await merchantMarkReady(h.app.db, w.tenantId, OPERATOR_TG, orderId);
    expect(await seamEvents(w.tenantId, orderId)).toBe(1); // الختم يمنع الازدواج
  });

  it("pickup (استلام ذاتي): صفر أحداث، صفر عروض، والإسناد اليدوي يرفض — لا سائق فيزيائي أبداً", async () => {
    const w = await seedFoodWorld("ready");
    await seedDriver(h.app.db, w.tenantId); // سائق متاح — لإثبات أن الرفض حارس لا نقص مرشّحين
    const created = await createOrder(
      h.app.db,
      w.tenantId,
      foodOrderInput(w.customerId, w.merchantId, w.itemId, { fulfillment: "pickup", dropoff: undefined }),
    );
    const orderId = created.order.id;
    expect(created.order.fulfillment).toBe("pickup");
    expect(created.order.priceTotal).toBe(0n); // لا سعر توصيل لطلب استلام ذاتي
    expect(created.order.codAmount).toBe(60_000n); // البضاعة فقط (شاورما ×2)

    // المسار الكامل: تأكيد → قبول → جاهز — ولا حدث مفصل واحد
    await doTransition(h.app.db, w.tenantId, { orderId, to: "confirmed", actor: { type: "staff" } });
    await merchantAcceptOrder(h.app.db, w.tenantId, OPERATOR_TG, orderId, 15);
    await merchantMarkReady(h.app.db, w.tenantId, OPERATOR_TG, orderId);
    expect(await seamEvents(w.tenantId, orderId)).toBe(0); // ⛔ المفصل لا يُختم لـ pickup
    const row = await readOrder(w.tenantId, orderId);
    expect(row.dispatchRequestedAt).toBeNull();

    // حتى لو وصلت مهمة إسناد غريبة (باغ منتج قديم): startRound يخرج بلا عروض
    const round = await startRound(h.app.db, w.tenantId, orderId, 1);
    expect(round).toEqual({ exhausted: true });
    const offerRows = await withTenant(h.app.db, w.tenantId, (tx) =>
      tx.select({ id: offers.id }).from(offers).where(eq(offers.orderId, orderId)),
    );
    expect(offerRows).toHaveLength(0); // صفر عروض = صفر سائقين أُزعجوا

    // والإسناد اليدوي من الداشبورد يرفض أيضاً
    const driverRows = await withTenant(h.app.db, w.tenantId, (tx) =>
      tx.select({ id: drivers.id }).from(drivers).where(eq(drivers.tenantId, w.tenantId)),
    );
    const manual = await assignManually(h.app.db, w.tenantId, orderId, driverRows[0]!.id);
    expect(manual.outcome).toBe("expired");
  });

  it("الإسناد من ready (المواقع الأربعة): جولة تنطلق من ready، القبول يُسند نفس صف الطلب، والتسليم المزدوج لا يضاعف", async () => {
    const w = await seedFoodWorld("ready");
    await seedDriver(h.app.db, w.tenantId); // فوق نقطة الاستلام — مرشّح جولة 1
    const created = await createOrder(h.app.db, w.tenantId, foodOrderInput(w.customerId, w.merchantId, w.itemId));
    const orderId = created.order.id;
    await doTransition(h.app.db, w.tenantId, { orderId, to: "confirmed", actor: { type: "staff" } });
    await merchantAcceptOrder(h.app.db, w.tenantId, OPERATOR_TG, orderId, 15);
    await merchantMarkReady(h.app.db, w.tenantId, OPERATOR_TG, orderId);
    expect(await seamEvents(w.tenantId, orderId)).toBe(1);

    // الحدث وصل مرتين (at-least-once): جولتان متتاليتان — الثانية تعيد العرض القائم، لا عرض ثانٍ
    const round1 = await startRound(h.app.db, w.tenantId, orderId, 1);
    expect(round1).not.toEqual({ exhausted: true });
    const round1Again = await startRound(h.app.db, w.tenantId, orderId, 1);
    expect(round1Again).toEqual(round1); // idempotent — نفس العرض المعلّق
    const offerRows = await withTenant(h.app.db, w.tenantId, (tx) =>
      tx.select({ id: offers.id, driverId: offers.driverId }).from(offers).where(eq(offers.orderId, orderId)),
    );
    expect(offerRows).toHaveLength(1); // عرض واحد رغم تسليمين

    // القبول: **نفس صف الطلب** ready→assigned (المدخل من DISPATCHABLE لا confirmed حصراً)
    const offerId = (round1 as { offerId: string }).offerId;
    const driverId = offerRows[0]!.driverId;
    const acceptResult = await acceptOffer(h.app.db, w.tenantId, offerId, driverId);
    expect(acceptResult.outcome).toBe("accepted");
    const finalRow = await readOrder(w.tenantId, orderId);
    expect(finalRow.id).toBe(orderId); // نفس الصف حرفياً
    expect(finalRow.status).toBe("assigned");
    expect(finalRow.driverId).toBe(driverId);
  });

  it("حارس food: p2p لا يدخل المطبخ (preparing/ready مرفوضتان لغير الطعام)", async () => {
    const tenantId = await seedTenant(h.app.db);
    await seedPricingRule(h.app.db, tenantId);
    const customerId = await seedCustomer(h.app.db, tenantId);
    const { order } = await makeOrder(h.app.db, tenantId, { customerId }); // p2p confirmed
    await expect(
      doTransition(h.app.db, tenantId, { orderId: order.id, to: "preparing", actor: { type: "staff" } }),
    ).rejects.toThrow(/invalid order transition/);
  });
});
