import { orders, withTenant, type Db } from "@quickdrop/db";
import { recomputeCustomerBrain } from "@quickdrop/brain";
import type { NotificationJob } from "@quickdrop/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

// دمج WaFlow (MERGE_PLAN §3.3) — مستهلك دماغ الزبون: يصله صف outbox عبر BRAIN_QUEUE
// (fan-out من عامل الالتقاط للمواضيع المهمّة). idempotent: يعيد الحساب من المصدر
// (orders) — تكرار المهمة = نفس النتيجة. يرشّح بالحمولة قبل أي عمل قاعدة (no-op رخيص).
//
// Phase 2: يتفاعل مع order.status_changed[to=delivered] (المنتِج القائم transition()).
// payment.paid (Billplz) يُضاف بـPhase 3 حين يصبح منتِجه حياً.

const statusChangedSchema = z.object({ orderId: z.string().uuid(), to: z.string() }).passthrough();
const paymentPaidSchema = z.object({ orderId: z.string().uuid() }).passthrough();

/**
 * قرار الترشيح النقي (قابل للاختبار بلا قاعدة، فلا تلوّث mocks بين الملفات): أي طلب
 * يستدعي إعادة حساب الدماغ من موضوع/حمولة الحدث، أو null للتجاهل.
 * order.status_changed[to=delivered] وpayment.paid فقط.
 */
export function brainTargetOrderId(topic: string, payload: unknown): string | null {
  if (topic === "order.status_changed") {
    const p = statusChangedSchema.safeParse(payload);
    return p.success && p.data.to === "delivered" ? p.data.orderId : null;
  }
  if (topic === "payment.paid") {
    const p = paymentPaidSchema.safeParse(payload);
    return p.success ? p.data.orderId : null;
  }
  return null; // موضوع لا يخصّ الدماغ (وصل للطابور احتياطاً)
}

export interface BrainConsumerDeps {
  appDb: Db;
}

export type BrainOutcome = "recomputed" | "skipped" | "order_missing";

export function createBrainProcessor(deps: BrainConsumerDeps): (job: NotificationJob) => Promise<BrainOutcome> {
  return async (job: NotificationJob): Promise<BrainOutcome> => {
    // (1) رشّح قبل أي عمل قاعدة (no-op رخيص للمواضيع/الحالات غير المعنيّة)
    const orderId = brainTargetOrderId(job.topic, job.payload);
    if (orderId === null) return "skipped";

    // (2) داخل سياق المستأجر: اجلب صاحب الطلب ثم أعِد حساب دماغه (كله idempotent)
    return withTenant(deps.appDb, job.tenantId, async (tx) => {
      const rows = await tx
        .select({ customerId: orders.customerId })
        .from(orders)
        .where(and(eq(orders.tenantId, job.tenantId), eq(orders.id, orderId)))
        .limit(1);
      const order = rows[0];
      if (!order) return "order_missing"; // طلب حُذف/غير موجود — لوغ فقط، لا رمي
      await recomputeCustomerBrain(tx, job.tenantId, order.customerId);
      return "recomputed";
    });
  };
}
