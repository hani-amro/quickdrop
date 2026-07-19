import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachPaymentRef, markOrderPaidByRef } from "./payments.js";
import { orders, outbox } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";
import {
  closeHarness,
  connectHarness,
  doTransition,
  makeOrder,
  seedCustomer,
  seedDriver,
  seedPricingRule,
  seedTenant,
  type TestHarness,
} from "./test-helpers.js";

// خطوة 20 (قرار المالك 2026-07-18) — طبقة الدفع: الدفع الإلكتروني يصفّر cod_amount
// **بنفس الترانزاكشن** ويكتب payment.paid بها؛ إعادات Billplz رتيبة idempotent؛
// المرجع write-once؛ ولا مساس بآلة الحالة (payment_status عمود لا حالة §4.1).

const hasDb = Boolean(process.env["DATABASE_URL"] && process.env["DATABASE_URL_MIGRATOR"]);

describe.skipIf(!hasDb)("payments (تكامل، قاعدة حية)", () => {
  let h: TestHarness;
  let tenantId: string;
  let customerId: string;

  beforeAll(async () => {
    h = connectHarness();
    tenantId = await seedTenant(h.app.db);
    await seedPricingRule(h.app.db, tenantId);
    customerId = await seedCustomer(h.app.db, tenantId);
  });

  afterAll(async () => {
    await closeHarness(h);
  });

  async function paidEvents(orderId: string): Promise<number> {
    return withTenant(h.app.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "payment.paid")));
      return rows.filter((r) => (r.payload as { orderId?: string }).orderId === orderId).length;
    });
  }

  it("markOrderPaidByRef: paid + paid_at + **cod_amount=0** + صف payment.paid — والحالة لا تُمسّ", async () => {
    const { order } = await makeOrder(h.app.db, tenantId, { customerId, goodsAmount: 40_000n, confirm: false });
    expect(order.codAmount > 0n).toBe(true);
    await attachPaymentRef(h.app.db, tenantId, { orderId: order.id, paymentRef: "bill_A" });

    const r = await markOrderPaidByRef(h.app.db, tenantId, { paymentRef: "bill_A" });
    expect(r).toEqual({ outcome: "paid", orderId: order.id });

    const row = await withTenant(h.app.db, tenantId, async (tx) => (await tx.select().from(orders).where(eq(orders.id, order.id)))[0]!);
    expect(row.paymentStatus).toBe("paid");
    expect(row.paymentPaidAt).not.toBeNull();
    expect(row.codAmount).toBe(0n); // قرار المالك: التصفير بنفس الترانزاكشن
    expect(row.status).toBe("pending"); // الدفع لا يغيّر الحالة — التأكيد قرار مستهلك الحدث
    expect(await paidEvents(order.id)).toBe(1);
  });

  it("إعادة النداء (Billplz retry): already_paid — لا حدث ثانٍ ولا لمس للأعمدة", async () => {
    const r = await markOrderPaidByRef(h.app.db, tenantId, { paymentRef: "bill_A" });
    expect(r.outcome).toBe("already_paid");
    const row = await withTenant(h.app.db, tenantId, async (tx) =>
      (await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.paymentRef, "bill_A"))))[0]!,
    );
    expect(await paidEvents(row.id)).toBe(1); // ما زال واحداً
  });

  it("مرجع مجهول → not_found (المستدعي يرد 200 هادئة)", async () => {
    expect(await markOrderPaidByRef(h.app.db, tenantId, { paymentRef: "bill_unknown" })).toEqual({ outcome: "not_found" });
  });

  it("attachPaymentRef: write-once — الثاني يعيد المرجع القائم، والمدفوع يرفض", async () => {
    const { order } = await makeOrder(h.app.db, tenantId, { customerId, confirm: false });
    expect(await attachPaymentRef(h.app.db, tenantId, { orderId: order.id, paymentRef: "bill_B1" })).toEqual({ outcome: "attached" });
    expect(await attachPaymentRef(h.app.db, tenantId, { orderId: order.id, paymentRef: "bill_B2" })).toEqual({ outcome: "ref_exists", paymentRef: "bill_B1" });

    await markOrderPaidByRef(h.app.db, tenantId, { paymentRef: "bill_B1" });
    expect(await attachPaymentRef(h.app.db, tenantId, { orderId: order.id, paymentRef: "bill_B3" })).toEqual({ outcome: "already_paid" });
  });

  it("عزل: مستأجر آخر لا يرى المرجع (not_found) ولا يعلّم طلب غيره مدفوعاً", async () => {
    const other = await seedTenant(h.app.db);
    expect(await markOrderPaidByRef(h.app.db, other, { paymentRef: "bill_A" })).toEqual({ outcome: "not_found" });
  });

  // ═══ مراجعة Phase 3 (money-F1/idem-F2، HIGH) — حارس الحالة النهائية ═══
  it("دفع رابط قديم بعد التسليم: paid_after_terminal — لا تصفير cod، لا payment.paid، صف anomaly", async () => {
    // طلب يُسلَّم نقداً ثم يُدفع رابطه القديم متأخراً (شحن مزدوج لولا الحارس)
    const driverId = await seedDriver(h.app.db, tenantId);
    const { order } = await makeOrder(h.app.db, tenantId, { customerId, goodsAmount: 30_000n }); // confirmed
    await attachPaymentRef(h.app.db, tenantId, { orderId: order.id, paymentRef: "bill_term" });
    await doTransition(h.app.db, tenantId, { orderId: order.id, to: "assigned", actor: { type: "staff" }, driverId });
    await doTransition(h.app.db, tenantId, { orderId: order.id, to: "picked_up", actor: { type: "driver", id: driverId } });
    await doTransition(h.app.db, tenantId, { orderId: order.id, to: "in_transit", actor: { type: "driver", id: driverId } });
    await doTransition(h.app.db, tenantId, { orderId: order.id, to: "arrived", actor: { type: "driver", id: driverId } });
    await doTransition(h.app.db, tenantId, { orderId: order.id, to: "delivered", actor: { type: "driver", id: driverId } });
    const codBefore = await withTenant(h.app.db, tenantId, async (tx) => (await tx.select({ c: orders.codAmount, r: orders.codReceived }).from(orders).where(eq(orders.id, order.id)))[0]!);
    expect(codBefore.c > 0n).toBe(true); // لم يُصفَّر (تُحصّل نقداً)
    expect(codBefore.r).toBe(codBefore.c); // حُصّل كامل المبلغ نقداً

    const r = await markOrderPaidByRef(h.app.db, tenantId, { paymentRef: "bill_term" });
    expect(r).toEqual({ outcome: "paid_after_terminal", orderId: order.id });

    const after = await withTenant(h.app.db, tenantId, async (tx) => (await tx.select().from(orders).where(eq(orders.id, order.id)))[0]!);
    expect(after.codAmount).toBe(codBefore.c); // ⛔ لم يُصفَّر (لا فساد لطلب مُسلَّم)
    expect(after.paymentStatus).toBe("paid"); // سُجّل الدفع (لا يتكرر النداء)
    const anomalies = await withTenant(h.app.db, tenantId, (tx) => tx.select({ payload: outbox.payload }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "payment.anomaly"))));
    expect(anomalies.some((a) => (a.payload as { orderId?: string }).orderId === order.id)).toBe(true);
    // ولا صف payment.paid لهذا الطلب (لا "شكراً"/تأكيد)
    const paid = await withTenant(h.app.db, tenantId, (tx) => tx.select({ payload: outbox.payload }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "payment.paid"))));
    expect(paid.some((p) => (p.payload as { orderId?: string }).orderId === order.id)).toBe(false);
  });

  it("attachPaymentRef يرفض طلباً نهائياً (لا رابط دفع لطلب مُلغى)", async () => {
    const { order } = await makeOrder(h.app.db, tenantId, { customerId, confirm: false });
    await doTransition(h.app.db, tenantId, { orderId: order.id, to: "cancelled_by_office", actor: { type: "staff" } });
    expect(await attachPaymentRef(h.app.db, tenantId, { orderId: order.id, paymentRef: "bill_cxl" })).toEqual({ outcome: "terminal" });
  });

  it("idem-F3: attachPaymentRef مع linkMessage يكتب صف payment.link بنفس الترانزاكشن", async () => {
    const { order } = await makeOrder(h.app.db, tenantId, { customerId, confirm: false });
    const r = await attachPaymentRef(h.app.db, tenantId, { orderId: order.id, paymentRef: "bill_link", linkMessage: { userId: customerId, url: "https://bp.test/bills/bill_link" } });
    expect(r).toEqual({ outcome: "attached" });
    const links = await withTenant(h.app.db, tenantId, (tx) => tx.select({ payload: outbox.payload }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "payment.link"))));
    expect(links.some((l) => (l.payload as { orderId?: string }).orderId === order.id)).toBe(true);
  });
});
