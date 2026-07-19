import type { OrderStatus } from "@quickdrop/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { writeOutbox } from "./outbox.js";
import { orders } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// مراجعة Phase 3 (money-F1/idem-F2، HIGH) — الحالات النهائية: طلب سُلّم/أُلغي/فشل/أُرجع
// انتهى مساره. دفع رابط قديم بعد بلوغها لا يجوز أن يصفّر cod_amount (قد يكون حُصّل نقداً)
// ولا يُشعل مسار "شكراً/تأكيد pickup" — يُسجَّل كشذوذ للطاقم بدل إفساد صف مستقر.
const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "delivered",
  "cancelled_by_customer",
  "cancelled_by_office",
  "returned",
  "failed",
]);

// دمج WaFlow (MERGE_PLAN §7 خطوة 20، قرار المالك 2026-07-18) — طبقة الدفع على القاعدة.
// payment_status **عمود عادي لا حالة** (§4.1): لا يمسّ آلة D8. الحارس رتيب — إعادات
// Billplz (at-least-once) لا تُرجِع مدفوعاً وتُعالَج كنجاح idempotent. الدفع الإلكتروني
// يصفّر cod_amount **بنفس الترانزاكشن** ويكتب صف payment.paid بها (outbox ترانزاكشني D6).

export type MarkPaidOutcome =
  | { outcome: "paid"; orderId: string }
  | { outcome: "already_paid"; orderId: string } // إعادة نداء — idempotent، لا آثار جديدة
  | { outcome: "paid_after_terminal"; orderId: string } // دفع متأخر بعد حالة نهائية — شذوذ مالي، للطاقم
  | { outcome: "not_found" }; // مرجع مجهول (فاتورة قديمة/مستأجر آخر) — المستدعي يقرر (200 هادئة)

/**
 * تعليم الطلب مدفوعاً بمرجع البوابة (billplz bill id): قفل الصف ← حارس رتيب
 * (payment_status <> 'paid') ← paid + paid_at + **cod_amount=0** ← صف payment.paid —
 * كله ترانزاكشن واحدة. الانتقالات الحالة (تأكيد pickup…) مسؤولية مستهلك الحدث، ليست هنا.
 *
 * مراجعة Phase 3 (HIGH) — حارس الحالة النهائية: طلب سُلّم/أُلغي (رابط قديم دُفع متأخراً) —
 * **لا نصفّر cod_amount** (قد يكون حُصّل نقداً عند التسليم → شحن مزدوج) و**لا نُشعل
 * payment.paid** (لا "شكراً" ولا تأكيد pickup)؛ نسجّل payment_paid_at وصف payment.anomaly
 * ليعالجه الطاقم (استرداد يدوي)، والصف يبقى متسقاً (cod كما هو).
 */
export async function markOrderPaidByRef(
  db: Db,
  tenantId: string,
  args: { paymentRef: string; paidAt?: Date },
): Promise<MarkPaidOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.paymentRef, args.paymentRef), isNull(orders.deletedAt)))
      .limit(1)
      .for("update");
    const order = rows[0];
    if (!order) return { outcome: "not_found" as const };
    if (order.paymentStatus === "paid") return { outcome: "already_paid" as const, orderId: order.id };

    const now = new Date(); // D6: UTC

    if (TERMINAL_STATUSES.has(order.status)) {
      // شذوذ: دفع رابط بعد حالة نهائية. سجّل الدفعة (paymentStatus=paid كي لا يتكرر النداء)
      // بلا تصفير cod وبلا payment.paid؛ نبّه الطاقم للاسترداد اليدوي (لا قيد دفتر آلي —
      // التصحيح المالي قرار بشري، المال تحرّك خارجياً).
      await tx
        .update(orders)
        .set({ paymentStatus: "paid", paymentPaidAt: args.paidAt ?? now, updatedAt: now })
        .where(and(eq(orders.id, order.id), eq(orders.paymentStatus, "unpaid")));
      await writeOutbox(tx, tenantId, "payment.anomaly", { orderId: order.id, paymentRef: args.paymentRef, reason: "paid_after_terminal", status: order.status });
      return { outcome: "paid_after_terminal" as const, orderId: order.id };
    }

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
  | { outcome: "terminal" } // طلب نهائي (مُسلَّم/مُلغى) — لا رابط دفع له (مراجعة Phase 3)
  | { outcome: "not_found" };

/**
 * ربط مرجع فاتورة بالطلب (send-payment-link): مرة واحدة (payment_ref IS NULL) —
 * إعادة الطلب تعيد المرجع القائم بدل فاتورة ثانية (فاتورتان = دفعتان محتملتان).
 * مراجعة Phase 3 (HIGH): يرفض الطلب النهائي (لا رابط دفع لطلب سُلّم/أُلغي).
 * idem-F3: إن مُرِّر linkMessage تُكتب رسالة الرابط (outbox 'payment.link') **بنفس هذه
 * الترانزاكشن** كي لا تنفصل عن الربط (crash بينهما = رسالة ضائعة).
 */
export async function attachPaymentRef(
  db: Db,
  tenantId: string,
  args: { orderId: string; paymentRef: string; linkMessage?: { userId: string; url: string } },
): Promise<AttachPaymentRefOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus, paymentRef: orders.paymentRef })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, args.orderId), isNull(orders.deletedAt)))
      .limit(1)
      .for("update");
    const order = rows[0];
    if (!order) return { outcome: "not_found" as const };
    if (order.paymentStatus === "paid") return { outcome: "already_paid" as const };
    if (TERMINAL_STATUSES.has(order.status)) return { outcome: "terminal" as const };
    if (order.paymentRef !== null) return { outcome: "ref_exists" as const, paymentRef: order.paymentRef };

    await tx
      .update(orders)
      .set({ paymentRef: args.paymentRef, updatedAt: new Date() })
      .where(and(eq(orders.id, order.id), isNull(orders.paymentRef)));
    // idem-F3: رسالة الرابط بنفس ترانزاكشن الربط (لا انفصال يفقد الرسالة عند crash)
    if (args.linkMessage) {
      await writeOutbox(tx, tenantId, "payment.link", { orderId: order.id, userId: args.linkMessage.userId, url: args.linkMessage.url });
    }
    return { outcome: "attached" as const };
  });
}
