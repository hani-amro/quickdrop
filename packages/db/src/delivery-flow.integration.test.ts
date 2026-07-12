import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignManually } from "./dispatch.js";
import { closeDriverSettlement, getSettlementBoard, SettlementDayClosedError } from "./settlement.js";
import {
  closeHarness,
  connectHarness,
  doTransition,
  fetchLedgerForDriver,
  fetchLedgerForOrder,
  fetchOrder,
  fetchOrderEvents,
  fetchRedemptionsForCoupon,
  fetchTrackingToken,
  fetchWallet,
  hasDb,
  makeOrder,
  resetDb,
  seedCoupon,
  seedCustomer,
  seedDriver,
  seedPricingRule,
  seedStaff,
  seedTenant,
  type TestHarness,
} from "./test-helpers.js";

// §15 — التدفق الكامل create→confirm→assign→picked_up→in_transit→arrived→delivered
// على قاعدة حقيقية: order_events بالتسلسل الصحيح (§5)، قيود الدفتر الثلاثة بنموذج D13
// بالمبالغ الصحيحة (§8.1) مع cod_received أقل من cod_amount (الفخ 18)، منح الولاء (§9)،
// ثم إغلاق تسوية اليوم والتحقق من الفرق (§8.2). تقليص tracking_tokens.expires_at بعد
// التسليم مسؤولية worker خارج packages/db — يُتحقق من الإصدار الابتدائي (72 ساعة §7) فقط.

const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!hasDb)("§15 — تدفق التوصيل الكامل (تكامل)", () => {
  let h: TestHarness;
  let tenantId: string;
  let customerId: string;
  let staffId: string;

  beforeAll(async () => {
    h = connectHarness();
    await resetDb(h);
    // 8000bp: حصة سائق مميّزة عن 100% كي تختبر القسمة بالـ basis points فعلاً (§8.1)
    tenantId = await seedTenant(h.app.db, { driverFeeShareBp: 8_000, loyaltyPointsPerOrder: 10 });
    await seedPricingRule(h.app.db, tenantId); // base 5000 + 1000/كم — مسافة العالم الافتراضي ≈ 7كم
    customerId = await seedCustomer(h.app.db, tenantId);
    staffId = await seedStaff(h.app.db, tenantId);
  });

  afterAll(async () => {
    await closeHarness(h);
  });

  it("التدفق السعيد: أحداث مرتبة، قيود D13 الثلاثة، ولاء ممنوح، وتسوية بفرق ظاهر", async () => {
    const driverId = await seedDriver(h.app.db, tenantId);
    const goodsAmount = 12_000n;
    const beforeCreate = Date.now();
    const { order: created, trackingToken } = await makeOrder(h.app.db, tenantId, {
      customerId,
      goodsAmount,
      confirm: false,
    });

    // §3: cod_amount = بضاعة + توصيل (D13)، والمعادلة §8.3-1 محفوظة بالأعمدة المسمّاة
    expect(created.status).toBe("pending");
    expect(created.codAmount).toBe(goodsAmount + created.priceTotal);
    expect(created.priceTotal).toBeGreaterThan(0n);

    // §7: رابط تتبع وُلد بنفس ترانزاكشن الإنشاء بعمر ابتدائي 72 ساعة
    const token = await fetchTrackingToken(h.app.db, tenantId, trackingToken);
    expect(token.orderId).toBe(created.id);
    expect(token.expiresAt.getTime()).toBeGreaterThan(beforeCreate + 71 * HOUR_MS);
    expect(token.expiresAt.getTime()).toBeLessThan(Date.now() + 73 * HOUR_MS);

    // confirm → assign (يدوي §10.1) → مسار السائق حتى التسليم — كله عبر transition (D8)
    await doTransition(h.app.db, tenantId, {
      orderId: created.id,
      to: "confirmed",
      actor: { type: "staff", id: staffId },
    });
    const assigned = await assignManually(h.app.db, tenantId, created.id, driverId, staffId);
    expect(assigned).toEqual({ outcome: "accepted", orderId: created.id });

    for (const to of ["picked_up", "in_transit", "arrived"] as const) {
      await doTransition(h.app.db, tenantId, { orderId: created.id, to, actor: { type: "driver", id: driverId } });
    }

    // الفخ 18: الزبون ما معه فراطة — المُحصَّل أقل من cod_amount بـ 500
    const codReceived = created.codAmount - 500n;
    const delivered = await doTransition(h.app.db, tenantId, {
      orderId: created.id,
      to: "delivered",
      actor: { type: "driver", id: driverId },
      codReceived,
    });
    expect(delivered.status).toBe("delivered");
    expect(delivered.codReceived).toBe(codReceived);
    expect(delivered.deliveredAt).not.toBeNull();

    // §5/§3: order_events سجل append-only بالتسلسل الحرفي وفاعليه الصحيحين
    const events = await fetchOrderEvents(h.app.db, tenantId, created.id);
    expect(events.map((e) => e.toStatus)).toEqual([
      "pending",
      "confirmed",
      "assigned",
      "picked_up",
      "in_transit",
      "arrived",
      "delivered",
    ]);
    expect(events.map((e) => e.fromStatus)).toEqual([
      "draft",
      "pending",
      "confirmed",
      "assigned",
      "picked_up",
      "in_transit",
      "arrived",
    ]);
    expect(events.map((e) => e.actorType)).toEqual([
      "staff",
      "staff",
      "staff",
      "driver",
      "driver",
      "driver",
      "driver",
    ]);
    expect(events[2]!.meta).toEqual({ manual: true }); // §10.1: الإسناد اليدوي مميَّز بالسجل

    // §8.1 حرفياً (D13): ثلاثة قيود بنفس ترانزاكشن delivered، بإشاراتها ومبالغها
    const entries = await fetchLedgerForOrder(h.app.db, tenantId, created.id);
    expect(entries).toHaveLength(3);
    const byType = new Map(entries.map((e) => [e.entryType, e]));
    expect(byType.get("cod_collected")?.amount).toBe(codReceived); // بالمُحصَّل الفعلي لا المتوقع (§8.4)
    expect(byType.get("goods_paid_by_driver")?.amount).toBe(-goodsAmount);
    const driverFee = (delivered.priceTotal * 8_000n) / 10_000n;
    expect(byType.get("delivery_fee_earned")?.amount).toBe(-driverFee);
    for (const entry of entries) {
      expect(entry.driverId).toBe(driverId);
      expect(entry.settlementId).toBeNull(); // لم تُسوَّ بعد
    }

    // §9: منح الولاء عند delivered فقط وبنفس الترانزاكشن
    const balance = await fetchWallet(h.app.db, tenantId, customerId);
    expect(balance.points).toBe(10);

    // §8.2: صافي ذمة السائق = SUM القيود؛ لوحة التسوية تعرضه قبل الإغلاق
    const expected = codReceived - goodsAmount - driverFee;
    const board = await getSettlementBoard(h.app.db, tenantId);
    const boardRow = board.find((r) => r.driverId === driverId);
    expect(boardRow?.expected).toBe(expected);
    expect(boardRow?.entryCount).toBe(3);

    // إغلاق اليوم: المستلَم أقل بـ 300 — الفرق يظهر حسابياً ولا يُخفى (§8.2)
    expect(expected).toBeGreaterThan(300n); // حارس هندسة النقاط الافتراضية — لا تسوية بمبلغ سالب هنا
    const received = expected - 300n;
    const settlement = await closeDriverSettlement(h.app.db, tenantId, {
      driverId,
      periodDate: "2026-07-12", // المستدعي الحقيقي يحسبها بـ tenantDay (§16.8)
      received,
      staffId,
    });
    expect(settlement.expected).toBe(expected);
    expect(settlement.received).toBe(received);
    expect(settlement.diff).toBe(300n);
    expect(settlement.status).toBe("closed");

    // القيود الثلاثة ارتبطت بالتسوية + قيد remitted سالب بالمستلَم الفعلي
    const allEntries = await fetchLedgerForDriver(h.app.db, tenantId, driverId);
    expect(allEntries).toHaveLength(4);
    const remitted = allEntries.find((e) => e.entryType === "remitted");
    expect(remitted?.amount).toBe(-received);
    for (const entry of allEntries) {
      expect(entry.settlementId).toBe(settlement.id);
    }
    // بعد الإغلاق لا قيود غير مسوّاة لهذا السائق — اللوحة فارغة منه
    const boardAfter = await getSettlementBoard(h.app.db, tenantId);
    expect(boardAfter.find((r) => r.driverId === driverId)).toBeUndefined();

    // §16.7: إغلاق ثانٍ لنفس اليوم = خطأ عمل واضح (unique tenant/driver/period)
    await expect(
      closeDriverSettlement(h.app.db, tenantId, { driverId, periodDate: "2026-07-12", received: 0n, staffId }),
    ).rejects.toThrow(SettlementDayClosedError);
  });

  it("إلغاء بعد حجز الكوبون يحرّر الحجز ويعيد الاستخدام للمخزون (§8.3-4)", async () => {
    const couponId = await seedCoupon(h.app.db, tenantId, {
      code: "FLOW1",
      kind: "fixed",
      value: 500n,
      maxUses: 1, // مخزون واحد — التحرير هو ما يسمح بالحجز الثاني أدناه فعلاً
    });

    const first = await makeOrder(h.app.db, tenantId, { customerId, couponCode: "FLOW1", confirm: false });
    expect(first.order.priceDiscount).toBe(500n);
    let redemptions = await fetchRedemptionsForCoupon(h.app.db, tenantId, couponId);
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]!.status).toBe("reserved");
    expect(redemptions[0]!.orderId).toBe(first.order.id);

    // الإلغاء قبل أي إسناد — transition يحرّر الحجز بنفس الترانزاكشن (§8.3-4)
    const cancelled = await doTransition(h.app.db, tenantId, {
      orderId: first.order.id,
      to: "cancelled_by_customer",
      actor: { type: "customer", id: customerId },
    });
    expect(cancelled.status).toBe("cancelled_by_customer");
    redemptions = await fetchRedemptionsForCoupon(h.app.db, tenantId, couponId);
    expect(redemptions[0]!.status).toBe("released");

    // المخزون عاد: طلب جديد بنفس الكوبون (max_uses=1) يحجز من جديد بلا CouponExhausted
    const second = await makeOrder(h.app.db, tenantId, { customerId, couponCode: "FLOW1", confirm: false });
    expect(second.order.priceDiscount).toBe(500n);
    redemptions = await fetchRedemptionsForCoupon(h.app.db, tenantId, couponId);
    expect(redemptions).toHaveLength(2);
    expect(redemptions.map((r) => r.status).sort()).toEqual(["released", "reserved"]);
    expect(redemptions.find((r) => r.status === "reserved")?.orderId).toBe(second.order.id);
  });
});
