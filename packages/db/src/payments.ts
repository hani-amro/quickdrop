import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { writeOutbox } from "./outbox.js";
import { orders } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// دمج WaFlow (MERGE_PLAN §7 خطوة 20، قرار المالك 2026-07-18) — طبقة الدفع على القاعدة.
// payment_status **عمود عادي لا حالة** (§4.1): لا يمسّ آلة D8. الحارس رتيب — إعادات
// Billplz (at-least-once) لا تُرجِع مدفوعاً وتُعالَج كنجاح idempotent. الدفع الإلكتروني
// يصفّر cod_amount **بنفس الترانزاكشن** ويكتب صف payment.paid بها (outbox ترانزاكشني D6).

export type MarkPaidOutcome =
  | { outcome: "paid"; orderId: string }
  | { outcome: "already_paid"; orderId: string } // إعادة نداء — idempotent، لا آثار جديدة
  | { outcome: "not_found" }; // مرجع مجهول (فاتورة قديمة/مستأجر آخر) — المستدعي يقرر (200 هادئة)

/**
 * تعليم الطلب مدفوعاً بمرجع البوابة (billplz bill id): قفل الصف ← حارس رتيب
 * (payment_status <> 'paid') ← paid + paid_at + **cod_amount=0** ← صف payment.paid —
 * كله ترانزاكشن واحدة. الانتقالات الحالة (تأكيد pickup…) مسؤولية مستهلك الحدث، ليست هنا.
 */
export async function markOrderPaidByRef(
  db: Db,
  tenantId: string,
  args: { paymentRef: string; paidAt?: Date },
): Promise<MarkPaidOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: orders.id, paymentStatus: orders.paymentStatus })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.paymentRef, args.paymentRef), isNull(orders.deletedAt)))
      .limit(1)
      .for("update");
    const order = rows[0];
    if (!order) return { outcome: "not_found" as const };
    if (order.paymentStatus === "paid") return { outcome: "already_paid" as const, orderId: order.id };

    const now = new Date(); // D6: UTC
    await tx
      .update(orders)
      .set({
        paymentStatus: "paid",
        paymentPaidAt: args.paidAt ?? now,
        codAmount: 0n, // قرار المالك: الدفع الإلكتروني يصفّر التحصيل بنفس الترانزاكشن
        updatedAt: now,
      })
      .where(and(eq(orders.id, order.id), eq(orders.paymentStatus, "unpaid"))); // الحارس الرتيب

    await writeOutbox(tx, tenantId, "payment.paid", { orderId: order.id, paymentRef: args.paymentRef });
    return { outcome: "paid" as const, orderId: order.id };
  });
}

export type AttachPaymentRefOutcome =
  | { outcome: "attached" }
  | { outcome: "ref_exists"; paymentRef: string } // رابط دفع سبق إرساله — أعد نفس الفاتورة
  | { outcome: "already_paid" }
  | { outcome: "not_found" };

/**
 * ربط مرجع فاتورة بالطلب (send-payment-link): مرة واحدة (payment_ref IS NULL) —
 * إعادة الطلب تعيد المرجع القائم بدل فاتورة ثانية (فاتورتان = دفعتان محتملتان).
 */
export async function attachPaymentRef(
  db: Db,
  tenantId: string,
  args: { orderId: string; paymentRef: string },
): Promise<AttachPaymentRefOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: orders.id, paymentStatus: orders.paymentStatus, paymentRef: orders.paymentRef })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, args.orderId), isNull(orders.deletedAt)))
      .limit(1)
      .for("update");
    const order = rows[0];
    if (!order) return { outcome: "not_found" as const };
    if (order.paymentStatus === "paid") return { outcome: "already_paid" as const };
    if (order.paymentRef !== null) return { outcome: "ref_exists" as const, paymentRef: order.paymentRef };

    await tx
      .update(orders)
      .set({ paymentRef: args.paymentRef, updatedAt: new Date() })
      .where(and(eq(orders.id, order.id), isNull(orders.paymentRef)));
    return { outcome: "attached" as const };
  });
}
