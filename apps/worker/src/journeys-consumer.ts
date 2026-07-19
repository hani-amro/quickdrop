import { enrollInJourneys, executeJourneyStep, orders, withTenant, type Db } from "@quickdrop/db";
import { journeyStepJobId, type JourneyStepJob, type NotificationJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

// دمج WaFlow (MERGE_PLAN §3.4) — توصيل Journeys بالـworker:
// (أ) التسجيل: مستهلك على أحداث الـ spine (fan-out) يخرّط الموضوع→trigger + الزبون،
//     يسجّل الرحلات المطابقة، ويجدول مهمة خطوة مؤجّلة لكل run جديد (next_run_at).
// (ب) التنفيذ: مستهلك JOURNEYS_QUEUE ينفّذ الخطوة الحالية ثم يجدول التالية أو ينهي.
// jobId حتمي (run, step) → التسجيل والـ rescan idempotentان.

const lifecycleSchema = z.object({ userId: z.string().uuid() }).passthrough();
const contactSchema = z.object({ userId: z.string().uuid() }).passthrough();
const statusChangedSchema = z.object({ orderId: z.string().uuid(), to: z.string() }).passthrough();
const paymentSchema = z.object({ orderId: z.string().uuid() }).passthrough();

/** يخرّط حدث spine إلى {trigger, userId?/orderId?} — نقي (قابل للاختبار بلا قاعدة). */
export function journeyTriggerFor(topic: string, payload: unknown): { trigger: string; userId?: string; orderId?: string } | null {
  if (topic === "crm.lifecycle_changed") {
    const p = lifecycleSchema.safeParse(payload);
    return p.success ? { trigger: "crm.lifecycle_changed", userId: p.data.userId } : null;
  }
  if (topic === "contact.created") {
    const p = contactSchema.safeParse(payload);
    return p.success ? { trigger: "contact.created", userId: p.data.userId } : null;
  }
  if (topic === "order.status_changed") {
    const p = statusChangedSchema.safeParse(payload);
    return p.success && p.data.to === "delivered" ? { trigger: "order.delivered", orderId: p.data.orderId } : null;
  }
  if (topic === "payment.paid") {
    const p = paymentSchema.safeParse(payload);
    return p.success ? { trigger: "payment.paid", orderId: p.data.orderId } : null;
  }
  return null;
}

const STEP_JOB_OPTS = { attempts: 5, backoff: { type: "exponential" as const, delay: 1000 }, removeOnComplete: { count: 1000 } };

/** يجدول مهمة خطوة مؤجّلة (delay = next_run_at − now، ≥ 0)، jobId حتمي = (run, step).
 *  step يُحمَل في الحمولة أيضاً (لا الـ jobId فقط) كي يحرس المنفّذ ضد انهيار التأخير. */
async function scheduleStep(queue: Queue<JourneyStepJob>, tenantId: string, runId: string, step: number, nextRunAt: Date, now: Date): Promise<void> {
  const delay = Math.max(0, nextRunAt.getTime() - now.getTime());
  const jobId = journeyStepJobId(runId, step);
  await queue.remove(jobId).catch(() => undefined); // rescan/إعادة: أزل مهمة عالقة بنفس المعرّف ثم أضف نظيفة
  await queue.add("journey-step", { tenantId, runId, step }, { ...STEP_JOB_OPTS, jobId, delay });
}

export interface JourneyEnrollDeps {
  appDb: Db;
  journeysQueue: Queue<JourneyStepJob>;
  now?: () => Date;
}

/** (أ) مستهلك التسجيل — يصله صف outbox عبر fan-out (BRAIN_QUEUE). idempotent. */
export function createJourneyEnrollProcessor(deps: JourneyEnrollDeps): (job: NotificationJob) => Promise<number> {
  return async (job) => {
    const mapped = journeyTriggerFor(job.topic, job.payload);
    if (!mapped) return 0;
    const now = (deps.now ?? (() => new Date()))();

    const enrolled = await withTenant(deps.appDb, job.tenantId, async (tx) => {
      // حلّ الزبون: من الحمولة مباشرة، أو من الطلب لمواضيع order/payment
      let userId = mapped.userId;
      if (!userId && mapped.orderId) {
        const rows = await tx.select({ customerId: orders.customerId }).from(orders).where(and(eq(orders.tenantId, job.tenantId), eq(orders.id, mapped.orderId))).limit(1);
        userId = rows[0]?.customerId;
      }
      if (!userId) return [];
      return enrollInJourneys(tx, job.tenantId, userId, mapped.trigger, now);
    });

    for (const run of enrolled) {
      await scheduleStep(deps.journeysQueue, job.tenantId, run.runId, run.currentStep, run.nextRunAt, now);
    }
    return enrolled.length;
  };
}

export interface JourneyStepDeps {
  appDb: Db;
  journeysQueue: Queue<JourneyStepJob>;
  /** اسم المكتب لعرضه بالقوالب ({business_name}) — v1 ثابت؛ لكل مستأجر لاحقاً. */
  businessName?: string;
  now?: () => Date;
}

/** (ب) مستهلك تنفيذ الخطوة — ينفّذ ثم يجدول التالية أو ينهي. idempotent.
 *  يمرّر job.step كـ expectedStep: مهمة معاد تسليمها بعد تقدّم الصف → "stale" (لا تنفيذ
 *  مبكّر للخطوة التالية، ولا إعادة جدولة — المهمة الصحيحة للخطوة الحالية قائمة بتأخيرها). */
export function createJourneyStepProcessor(deps: JourneyStepDeps): (job: JourneyStepJob) => Promise<string> {
  const businessName = deps.businessName ?? "";
  return async (job) => {
    const now = (deps.now ?? (() => new Date()))();
    const result = await withTenant(deps.appDb, job.tenantId, (tx) => executeJourneyStep(tx, job.tenantId, job.runId, businessName, now, job.step));
    if (result.outcome === "advanced") {
      await scheduleStep(deps.journeysQueue, job.tenantId, job.runId, result.nextStep, result.nextRunAt, now);
    }
    return result.outcome;
  };
}
