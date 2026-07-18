import { handleOfferTimeout, offers, startRound, withTenant, type Db } from "@quickdrop/db";
import type { DispatchJob, DispatchOrderJob, OfferTimeoutJob } from "@quickdrop/shared";
import type { JobsOptions, Queue } from "bullmq";
import { eq } from "drizzle-orm";

// §6/D16 — عامل الإسناد: كل قرار قبول/انتهاء/توسيع جولة يُتّخذ داخل ترانزاكشن قاعدة
// بأقفال صفوف (packages/db/dispatch.ts) — هذا الملف تنسيقُ طوابير فقط: يستدعي القرار
// ثم يترجم نتيجته إلى مهام BullMQ. الطوابير تلميحات تسريع لا مصدر حقيقة (§12):
// مصدر الحقيقة للمهلة offers.expires_at، وjobId حتمي يزيل تكرار at-least-once.

export interface DispatchProcessorDeps {
  /** دور app_user — dispatch.ts يفتح withTenant/الأقفال بنفسه (D16). */
  appDb: Db;
  /** نفس الطابور الذي نستهلكه — لإدراج الجولة التالية بعد انتهاء مهلة عرض. */
  dispatchQueue: Queue<DispatchJob>;
}

/**
 * jobId حتمي لجولة إسناد — التكرار (at-least-once §12) يُزال بالطابور.
 * **BullMQ يرمي "Custom Id cannot contain :"** (مثبت تجريبياً ضد Redis الحي) —
 * الفاصل '-' حصراً؛ الصيغ القديمة 'd:{id}:{round}' و'ot:{id}' كانت تُفشل كل
 * enqueue (فتُعاد المهمة الحاملة له حتى استنفاد محاولاتها).
 */
export function dispatchOrderJobId(orderId: string, round: number): string {
  return `d-${orderId}-${round}`;
}

/** jobId حتمي لمهلة عرض — نفس المفتاح من مستهلك الإشعارات ومن rescan الإقلاع (بلا ':'). */
export function offerTimeoutJobId(offerId: string): string {
  return `ot-${offerId}`;
}

// §12 — خيارات BullMQ الموحّدة لمهام الإسناد (attempts/backoff/removeOnComplete).
export const DISPATCH_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { count: 1000 },
};

/** kind='dispatch-order': ابدأ الجولة — القرار كله داخل startRound بأقفال القاعدة (D16). */
async function processDispatchOrder(deps: DispatchProcessorDeps, job: DispatchOrderJob): Promise<void> {
  const result = await startRound(deps.appDb, job.tenantId, job.orderId, job.round);

  if ("exhausted" in result) {
    // §6.2 — لا مرشّحين بهذه الجولة. لا حلقة إعادة محاولة لا نهائية هنا قصداً:
    // dispatch.ts يكتب outbox 'dispatch.exhausted' عند الاستنفاد (رسالة الزبون + تحذير
    // عبر مستهلك الإشعارات)، والموزّع يسند يدوياً من الداشبورد (§10.1: صف أحمر > 5 د).
    // TODO(v2): إعادة محاولة مؤجلة لطلب confirmed بلا مرشّحين (30 ثانية × حد أقصى
    // للمحاولات الفارغة) بدل الاعتماد على الإسناد اليدوي وحده.
    console.warn(
      JSON.stringify({
        action: "dispatch_round_exhausted",
        tenantId: job.tenantId,
        orderId: job.orderId,
        round: job.round,
      }),
    );
    return;
  }

  // العرض أُنشئ وoutbox 'offer.created' كُتب بنفس ترانزاكشن startRound (D9) —
  // مستهلك الإشعارات يرسل بطاقة السائق ويجدول مهمة 'offer-timeout' عند expires_at.
  console.log(
    JSON.stringify({
      action: "dispatch_offer_started",
      tenantId: job.tenantId,
      orderId: job.orderId,
      round: job.round,
      offerId: result.offerId,
      driverId: result.driverId,
    }),
  );
}

/** kind='offer-timeout': قرار الانتهاء داخل handleOfferTimeout بأقفاله (§6.2)؛ هنا فقط ترجمة {nextRound} لمهمة جديدة. */
async function processOfferTimeout(deps: DispatchProcessorDeps, job: OfferTimeoutJob): Promise<void> {
  // §6.2 — المعالج يقفل صفَّي الطلب والعرض داخل ترانزاكشن؛ إن لم يعد العرض pending
  // أو الطلب confirmed → {done} (خروج صامت بلا توسيع جولة). مصدر الحقيقة expires_at.
  const result = await handleOfferTimeout(deps.appDb, job.tenantId, job.offerId);
  if ("done" in result) return;

  // نحتاج orderId لعنونة الجولة الجديدة — قراءة عنونة فقط: القرار اتُّخذ داخل
  // handleOfferTimeout بأقفاله، وهذه ليست قراءة-ثم-كتابة على حالة → لا FOR UPDATE (§16.11).
  const orderId = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const rows = await tx
      .select({ orderId: offers.orderId })
      .from(offers)
      .where(eq(offers.id, job.offerId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      // §16.12 — عرض انتهت مهلته بلا صف: فساد بيانات يستحق فشلاً صاخباً (retry ثم DLQ)
      throw new Error(`dispatch: offer ${job.offerId} not found after timeout handling`);
    }
    return row.orderId;
  });

  await deps.dispatchQueue.add(
    "dispatch-order",
    { kind: "dispatch-order", tenantId: job.tenantId, orderId, round: result.nextRound },
    { ...DISPATCH_JOB_OPTS, jobId: dispatchOrderJobId(orderId, result.nextRound) },
  );
}

/**
 * §6 — معالج طابور الإسناد (DISPATCH_QUEUE): dispatch-order وoffer-timeout.
 * §16.12: لا ابتلاع أخطاء — أي رمي هنا يعيد الجدولة عبر BullMQ backoff.
 */
export function createDispatchProcessor(deps: DispatchProcessorDeps): (job: DispatchJob) => Promise<void> {
  return async (job) => {
    switch (job.kind) {
      case "dispatch-order":
        await processDispatchOrder(deps, job);
        return;
      case "offer-timeout":
        await processOfferTimeout(deps, job);
        return;
      default: {
        // §11 — الأنواع تُتحقق عند الاستهلاك: رسالة بنوع مجهول (نسخة أقدم/أحدث) تُسجَّل
        // ولا تُرمى — إعادة المحاولة على نوع مجهول بلا فائدة (§16.12: قرار صريح مسجَّل).
        const unknownJob: never = job;
        console.warn(JSON.stringify({ action: "dispatch_unknown_job_kind", job: unknownJob }));
      }
    }
  };
}
