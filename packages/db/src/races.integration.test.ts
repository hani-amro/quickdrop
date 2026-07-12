import { OFFER_TTL_MS, makePoint, newId } from "@quickdrop/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CouponExhaustedError } from "./coupons.js";
import { acceptOffer, assignManually, handleOfferTimeout, startRound, type AcceptResult } from "./dispatch.js";
import { InsufficientBalanceError, redeemLoyaltyWallet } from "./loyalty-redeem.js";
import { couponRedemptions, offers } from "./schema/index.js";
import { InvalidTransitionError } from "./state-machine.js";
import {
  DEFAULT_PICKUP,
  closeHarness,
  connectHarness,
  countOrdersForCustomer,
  doTransition,
  fetchOffer,
  fetchOrder,
  fetchWallet,
  fulfilledOf,
  grantWallet,
  hasDb,
  makeOrder,
  pgError,
  rejectedOf,
  resetDb,
  seedCoupon,
  seedCustomer,
  seedDriver,
  seedWorld,
  type TestHarness,
} from "./test-helpers.js";
import { withTenant } from "./with-tenant.js";

// §15 حرفياً — سيناريوهات السباق (أولوية الوثيقة القصوى): كل اختبار يطلق العمليتين
// معاً بـ Promise.all/allSettled على قاعدة حقيقية (أقفال صفوف + RLS)، ثم يؤكد أن
// الحالة النهائية بالقاعدة متسقة مهما كان ترتيب فوز الأقفال — لا نثبّت الفائز، نثبّت
// اللاتناقض. env-gated بنمط isolation.test.ts: بلا قاعدة تُتخطى وتعمل بالـ CI.

// startRound يرشّح الأقرب (§6.1) — نميّز النتيجة الناجحة عن exhausted بحارس نوع.
function offerOf(
  round: Awaited<ReturnType<typeof startRound>>,
): { offerId: string; driverId: string; expiresAt: Date } {
  if (!("offerId" in round)) {
    throw new Error("expected startRound to create an offer, got exhausted"); // §16.12
  }
  return round;
}

describe.skipIf(!hasDb)("§15 — سباقات الإسناد والمال (تكامل)", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = connectHarness();
    await resetDb(h);
  });

  afterAll(async () => {
    await closeHarness(h);
  });

  it("قبولان متزامنان: عرضان لسائقين على نفس الطلب → سائق واحد فقط يفوز والعروض تُحسم", async () => {
    const { tenantId, customerId } = await seedWorld(h.app.db);
    // A فوق نقطة الاستلام تماماً (الأقرب — يختاره startRound §6.1)، B على بعد ~200م
    const driverA = await seedDriver(h.app.db, tenantId, { point: DEFAULT_PICKUP });
    const driverB = await seedDriver(h.app.db, tenantId, {
      point: makePoint(DEFAULT_PICKUP.lat + 0.0018, DEFAULT_PICKUP.lng),
    });
    const { order } = await makeOrder(h.app.db, tenantId, { customerId });

    // العرض الأول عبر مسار الإنتاج (startRound يختار A الأقرب)؛ الثاني يُدرَج مباشرة:
    // v1 أحادي العرض بالجولة، والعقد المُختبَر هنا هو عقد §6.2 نفسه للبث المستقبلي
    // ("أول من يقبل يكسب قفل الطلب") — لا مسار إنتاج يخلق عرضين متوازيين بعد.
    const offerA = offerOf(await startRound(h.app.db, tenantId, order.id, 1));
    expect(offerA.driverId).toBe(driverA);
    const offerBId = await withTenant(h.app.db, tenantId, async (tx) => {
      const inserted = await tx
        .insert(offers)
        .values({
          tenantId,
          orderId: order.id,
          driverId: driverB,
          status: "pending",
          expiresAt: new Date(Date.now() + OFFER_TTL_MS), // D6: UTC
          round: 1,
        })
        .returning({ id: offers.id });
      return inserted[0]!.id;
    });

    const results = await Promise.allSettled([
      acceptOffer(h.app.db, tenantId, offerA.offerId, driverA),
      acceptOffer(h.app.db, tenantId, offerBId, driverB),
    ]);

    // بالضبط قبول واحد نجح — قبولان = كارثة الإسناد المزدوج
    const outcomes = fulfilledOf(results);
    const acceptedResults = outcomes.filter((o) => o.outcome === "accepted");
    expect(acceptedResults).toHaveLength(1);
    expect(acceptedResults[0]!).toEqual({ outcome: "accepted", orderId: order.id });

    // الخاسر إن اكتمل: taken/expired حصراً (§6.2 — الرسالة من صفوف القاعدة).
    // ملاحظة موثّقة بتعليق acceptOffer نفسه ("ملاحظة بث لاحقة"): مع عروض متوازية قد
    // يتشابك قفل عرض الخاسر مع UPDATE «بقية العروض» عند الفائز → Postgres يفضّ
    // deadlock بإجهاض أحدهما (40P01). المقبول هنا حصراً: إمّا نتيجة نظيفة أو 40P01 —
    // وفي الحالتين نؤكد أدناه أن حالة القاعدة النهائية متسقة تماماً.
    for (const loser of outcomes.filter((o) => o.outcome !== "accepted")) {
      expect(["taken", "expired"]).toContain(loser.outcome);
    }
    for (const reason of rejectedOf(results)) {
      expect(pgError(reason).code).toBe("40P01");
    }

    // الطلب: driver_id واحد لسائق فائز واحد، والحالة assigned (D8 عبر transition)
    const finalOrder = await fetchOrder(h.app.db, tenantId, order.id);
    expect(finalOrder.status).toBe("assigned");
    expect([driverA, driverB]).toContain(finalOrder.driverId);

    // العروض: عرض الفائز accepted وعرض الآخر expired — لا pending عالق ولا قبولان
    const offerARow = await fetchOffer(h.app.db, tenantId, offerA.offerId);
    const offerBRow = await fetchOffer(h.app.db, tenantId, offerBId);
    const winnerOffer = finalOrder.driverId === driverA ? offerARow : offerBRow;
    const loserOffer = finalOrder.driverId === driverA ? offerBRow : offerARow;
    expect(winnerOffer.status).toBe("accepted");
    expect(loserOffer.status).toBe("expired");
  });

  it("إلغاء أثناء قبول: لا حالة نهائية متناقضة — مُلغى بلا سائق أو assigned والإلغاء فشل", async () => {
    const { tenantId, customerId } = await seedWorld(h.app.db);
    const driverId = await seedDriver(h.app.db, tenantId);
    const { order } = await makeOrder(h.app.db, tenantId, { customerId });
    const offer = offerOf(await startRound(h.app.db, tenantId, order.id, 1));
    expect(offer.driverId).toBe(driverId);

    const [acceptRes, cancelRes] = await Promise.allSettled([
      acceptOffer(h.app.db, tenantId, offer.offerId, driverId),
      doTransition(h.app.db, tenantId, {
        orderId: order.id,
        to: "cancelled_by_customer",
        actor: { type: "customer", id: customerId },
      }),
    ]);

    // acceptOffer لا يرمي بهذا السيناريو (يشتق النتيجة من الصفوف §6.2 D16)
    expect(acceptRes.status).toBe("fulfilled");
    const accept = (acceptRes as PromiseFulfilledResult<AcceptResult>).value;

    const finalOrder = await fetchOrder(h.app.db, tenantId, order.id);
    if (finalOrder.status === "assigned") {
      // القبول كسب قفل الطلب أولاً → الإلغاء وجد assigned فرُفض InvalidTransition (§5)
      expect(accept.outcome).toBe("accepted");
      expect(finalOrder.driverId).toBe(driverId);
      expect(cancelRes.status).toBe("rejected");
      expect((cancelRes as PromiseRejectedResult).reason).toBeInstanceOf(InvalidTransitionError);
    } else {
      // الإلغاء كسب أولاً → مُلغى بلا سائق، والقبول رأى الطلب لم يعد confirmed → expired
      expect(finalOrder.status).toBe("cancelled_by_customer");
      expect(finalOrder.driverId).toBeNull();
      expect(cancelRes.status).toBe("fulfilled");
      expect(accept.outcome).toBe("expired");
    }
  });

  it("كوبون max_uses=1 بطلبين متزامنين: واحد يحجز والثاني CouponExhaustedError بلا طلب يتيم", async () => {
    const { tenantId, customerId } = await seedWorld(h.app.db);
    const otherCustomerId = await seedCustomer(h.app.db, tenantId);
    const couponId = await seedCoupon(h.app.db, tenantId, {
      code: "RACE1",
      kind: "fixed",
      value: 1_000n,
      maxUses: 1,
    });

    // الحتمية هنا من مسار الإنتاج نفسه: nextPublicCode يقفل صف عدّاد المستأجر (§3)
    // فيتسلسل الإنشاءان — الثاني يعدّ الحجوزات بعد التزام الأول فيرى المخزون مستنفداً.
    const results = await Promise.allSettled([
      makeOrder(h.app.db, tenantId, { customerId, couponCode: "RACE1", confirm: false }),
      makeOrder(h.app.db, tenantId, { customerId: otherCustomerId, couponCode: "RACE1", confirm: false }),
    ]);

    const winners = fulfilledOf(results);
    const losers = rejectedOf(results);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toBeInstanceOf(CouponExhaustedError);

    // §8.3-4: reserved+consumed ≤ max_uses — حجز واحد بالضبط، للطلب الفائز
    const active = await withTenant(h.app.db, tenantId, (tx) =>
      tx
        .select()
        .from(couponRedemptions)
        .where(
          and(
            eq(couponRedemptions.couponId, couponId),
            inArray(couponRedemptions.status, ["reserved", "consumed"]),
          ),
        ),
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.orderId).toBe(winners[0]!.order.id);
    expect(winners[0]!.order.priceDiscount).toBe(1_000n);

    // ترانزاكشن الخاسر كلها rollback: لا طلب ولا عدّاد محروق على إنشاء فاشل (§10.1)
    const winnerCustomer = winners[0]!.order.customerId;
    const loserCustomer = winnerCustomer === customerId ? otherCustomerId : customerId;
    expect(await countOrdersForCustomer(h.app.db, tenantId, loserCustomer)).toBe(0);
  });

  it("استرداد نقاط متزامن: محفظة 1000 وسحبان 800 معاً → واحد ينجح والرصيد النهائي 200", async () => {
    const { tenantId, customerId } = await seedWorld(h.app.db);
    await grantAndVerifyWallet(h, tenantId, customerId, 1_000n);

    const results = await Promise.allSettled([
      redeemLoyaltyWallet(h.app.db, tenantId, { userId: customerId, orderId: newId(), amount: 800n }),
      redeemLoyaltyWallet(h.app.db, tenantId, { userId: customerId, orderId: newId(), amount: 800n }),
    ]);

    // §9: قفل صف loyalty_accounts يسلسل الطرفين — الثاني يرى الرصيد المنقوص
    const succeeded = fulfilledOf(results);
    const failed = rejectedOf(results);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.wallet).toBe(200n);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(InsufficientBalanceError);
    const insufficiency = failed[0] as InsufficientBalanceError;
    expect(insufficiency.requested).toBe(800n);
    expect(insufficiency.available).toBe(200n);

    // الرصيد SUM من القيود (§9) — 1000 − 800 = 200، لا قيد سحب ثانٍ تسلل
    const balance = await fetchWallet(h.app.db, tenantId, customerId);
    expect(balance.wallet).toBe(200n);
  });

  it("طلبان يتنافسان على سائق سعته 1: إسناد واحد يمر والثاني يُرفض سعةً (D14)", async () => {
    const { tenantId, customerId } = await seedWorld(h.app.db);
    const driverId = await seedDriver(h.app.db, tenantId, { maxConcurrentOrders: 1 });
    const first = await makeOrder(h.app.db, tenantId, { customerId });
    const second = await makeOrder(h.app.db, tenantId, { customerId });

    // ترتيب الأقفال order→driver بالمسارين وصفّا الطلبين مختلفان — قفل صف السائق
    // (§16.11) هو نقطة التسلسل الوحيدة: لا deadlock، ونتيجة حتمية.
    const [r1, r2] = await Promise.all([
      assignManually(h.app.db, tenantId, first.order.id, driverId),
      assignManually(h.app.db, tenantId, second.order.id, driverId),
    ]);

    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(["accepted", "expired"]); // expired = «غير قابل للإسناد الآن» (سعة D14)

    const o1 = await fetchOrder(h.app.db, tenantId, first.order.id);
    const o2 = await fetchOrder(h.app.db, tenantId, second.order.id);
    const assigned = [o1, o2].filter((o) => o.status === "assigned");
    const stillConfirmed = [o1, o2].filter((o) => o.status === "confirmed");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.driverId).toBe(driverId);
    expect(stillConfirmed).toHaveLength(1);
    expect(stillConfirmed[0]!.driverId).toBeNull(); // الخاسر بقي متاحاً لسائق آخر — لا نصف-إسناد
  });

  it("timeout يستيقظ أثناء قبول جارٍ: العرض النهائي accepted أو expired حصراً — لا expired-بعد-accepted", async () => {
    const { tenantId, customerId } = await seedWorld(h.app.db);
    const driverId = await seedDriver(h.app.db, tenantId);
    const { order } = await makeOrder(h.app.db, tenantId, { customerId });
    const offer = offerOf(await startRound(h.app.db, tenantId, order.id, 1));

    // كلاهما يقفل صف العرض أول عبارة (§6.2) — القفل يسلسلهما والصفوف تحسم، لا الساعة
    const [acceptRes, timeoutRes] = await Promise.allSettled([
      acceptOffer(h.app.db, tenantId, offer.offerId, driverId),
      handleOfferTimeout(h.app.db, tenantId, offer.offerId),
    ]);
    expect(acceptRes.status).toBe("fulfilled");
    expect(timeoutRes.status).toBe("fulfilled");
    const accept = (acceptRes as PromiseFulfilledResult<AcceptResult>).value;
    const timeout = (timeoutRes as PromiseFulfilledResult<Awaited<ReturnType<typeof handleOfferTimeout>>>).value;

    const finalOffer = await fetchOffer(h.app.db, tenantId, offer.offerId);
    const finalOrder = await fetchOrder(h.app.db, tenantId, order.id);

    if (accept.outcome === "accepted") {
      // القبول كسب قفل العرض أولاً → المهلة رأت العرض غير pending فخرجت بلا توسيع (§6.2)
      expect(timeout).toEqual({ done: true });
      expect(finalOffer.status).toBe("accepted"); // لم تُقلَب accepted → expired لاحقاً
      expect(finalOrder.status).toBe("assigned");
      expect(finalOrder.driverId).toBe(driverId);
    } else {
      // المهلة كسبت أولاً → العرض expired والقبول اشتق «انتهى» من الصفوف؛ الجولة تتوسع
      expect(accept.outcome).toBe("expired");
      expect(timeout).toEqual({ nextRound: 2 });
      expect(finalOffer.status).toBe("expired");
      expect(finalOrder.status).toBe("confirmed"); // الطلب سليم بانتظار جولة أوسع
      expect(finalOrder.driverId).toBeNull();
    }
  });
});

// منح رصيد ثم التأكد أنه استقر قبل إطلاق السباق — يعزل فشل البذر عن فشل السباق
async function grantAndVerifyWallet(
  h: TestHarness,
  tenantId: string,
  userId: string,
  amount: bigint,
): Promise<void> {
  await grantWallet(h.app.db, tenantId, userId, amount);
  const balance = await fetchWallet(h.app.db, tenantId, userId);
  expect(balance.wallet).toBe(amount);
}
