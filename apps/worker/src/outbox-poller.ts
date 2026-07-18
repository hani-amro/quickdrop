import { outbox, withTenant, type Db } from "@quickdrop/db";
import type { NotificationJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

// D9/§12 — عامل التقاط الـ outbox: حلقة كل ثانية تلتقط الصفوف pending وتدفعها لطابور
// الإشعارات. الكتابة حصلت بنفس ترانزاكشن الحدث (writeOutbox)؛ هنا فقط النقل للطابور.
// الضمانة at-least-once — المستهلك idempotent بمفتاح إزالة تكرار = outbox.id (§12).

const BATCH_LIMIT = 100;
const DEFAULT_INTERVAL_MS = 1_000;

// §12 / MERGE_PLAN R-16 — محاسبة فشل الالتقاط: قبل هذا كانت أعمدة attempts/next_attempt_at
// ميتة — صف يفشل التقاطه دوماً (صف سام) كان يُعاد كل ثانية للأبد ويجوّع بقية الدفعة.
export const OUTBOX_MAX_ATTEMPTS = 10;
export const OUTBOX_BACKOFF_BASE_MS = 1_000;
export const OUTBOX_BACKOFF_MAX_MS = 5 * 60_000;

/** backoff أسّي حتمي: 1s، 2s، 4s… بسقف 5 دقائق — دالة نقية (قابلة للاختبار بلا قاعدة). */
export function outboxBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30)); // سقف الأس يمنع overflow
  return Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** exponent, OUTBOX_BACKOFF_MAX_MS);
}

export interface OutboxPollerDeps {
  /** دور app_worker — مسح عابر للمستأجرين بسياسة قراءة/التقاط مسمّاة (§2.3)، بلا قفل. */
  scanDb: Db;
  /** دور app_user — كل كتابة/قفل داخل withTenant(مستأجر الصف) حصراً (§2.3 v1.1). */
  appDb: Db;
  queue: Queue<NotificationJob>;
  intervalMs?: number;
  /** يُستدعى مرة عند تحول صف إلى failed (تسميم) — للتنبيه/Sentry (§13). */
  onPoisoned?: (info: { outboxId: string; tenantId: string }) => void;
  /** حقن الساعة للاختبارات؛ الافتراضي الساعة الحقيقية (UTC). */
  now?: () => Date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** معالجة صف واحد: قفل داخل سياق المستأجر → دفع للطابور → تعليم sent. */
async function dispatchOne(deps: OutboxPollerDeps, outboxId: string, tenantId: string): Promise<void> {
  await withTenant(deps.appDb, tenantId, async (tx) => {
    // §2.3 v1.1 — القفل داخل سياق المستأجر: FOR UPDATE SKIP LOCKED يمنع تنافس
    // عاملين على نفس الصف بلا انتظار، وشرط status='pending' يعيد التحقق بعد نيل
    // القفل (المسح عبر scanDb كان بلا قفل — قد يكون صف التُقط بالفعل).
    const claimedRows = await tx
      .select({ id: outbox.id, topic: outbox.topic, payload: outbox.payload })
      .from(outbox)
      .where(and(eq(outbox.id, outboxId), eq(outbox.status, "pending")))
      .limit(1)
      .for("update", { skipLocked: true });
    const claimed = claimedRows[0];
    if (!claimed) return; // التقطه عامل آخر أو أُرسل بالفعل — لا شيء يُفعل

    const job: NotificationJob = {
      outboxId: claimed.id,
      tenantId,
      topic: claimed.topic,
      // jsonb يُستنتج unknown — writeOutbox هو الكاتب الوحيد ولا يقبل غير Record، فالتضييق آمن.
      payload: claimed.payload as Record<string, unknown>,
    };
    // §12 — الدفع قبل الالتزام: لو فشل الالتزام بعد queue.add بقي الصف pending وأُعيد
    // دفعه بالدورة التالية بنفس jobId (BullMQ يزيل الازدواج) — at-least-once، والمستهلك
    // idempotent بمفتاح outbox.id. هذا نداء Redis لا تيليغرام — D9 محفوظ.
    await deps.queue.add("deliver", job, {
      jobId: claimed.id, // مفتاح إزالة التكرار = outbox.id (§12)
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { count: 1000 },
    });
    await tx.update(outbox).set({ status: "sent" }).where(eq(outbox.id, claimed.id));
  });
}

/**
 * §12/R-16 — تسجيل فشل التقاط صف: ترانزاكشن منفصلة (ترانزاكشن الالتقاط انفجرت أصلاً)
 * تقفل الصف وتزيد attempts وتؤجل next_attempt_at بالـ backoff؛ عند بلوغ السقف يتحول
 * الصف failed (لا يُلتقط ثانية — DLQ منطقي) ويُبلَّغ onPoisoned مرة واحدة.
 * فشل هذا التسجيل نفسه (قاعدة ساقطة) = الصف يبقى pending ويُلتقط لاحقاً — آمن.
 */
async function recordDispatchFailure(
  deps: OutboxPollerDeps,
  outboxId: string,
  tenantId: string,
): Promise<"backoff" | "poisoned" | "skipped" | "accounting_failed"> {
  const nowFn = deps.now ?? ((): Date => new Date());
  try {
    const outcome = await withTenant(deps.appDb, tenantId, async (tx) => {
      const rows = await tx
        .select({ attempts: outbox.attempts })
        .from(outbox)
        .where(and(eq(outbox.id, outboxId), eq(outbox.status, "pending")))
        .limit(1)
        .for("update", { skipLocked: true });
      const row = rows[0];
      if (!row) return "skipped" as const; // التقطه/علّمه عامل آخر
      const attempts = row.attempts + 1;
      const poisoned = attempts >= OUTBOX_MAX_ATTEMPTS;
      await tx
        .update(outbox)
        .set({
          attempts,
          nextAttemptAt: new Date(nowFn().getTime() + outboxBackoffMs(attempts)),
          ...(poisoned ? { status: "failed" as const } : {}),
        })
        .where(eq(outbox.id, outboxId));
      return poisoned ? ("poisoned" as const) : ("backoff" as const);
    });
    if (outcome === "poisoned") deps.onPoisoned?.({ outboxId, tenantId });
    return outcome;
  } catch {
    return "accounting_failed";
  }
}

/** دورة واحدة: مسح بلا قفل عبر scanDb ثم معالجة كل صف داخل سياق مستأجره. */
export async function pollOnce(deps: OutboxPollerDeps, isStopped: () => boolean): Promise<void> {
  const due = await deps.scanDb
    .select({ id: outbox.id, tenantId: outbox.tenantId })
    .from(outbox)
    .where(
      and(
        eq(outbox.status, "pending"),
        or(isNull(outbox.nextAttemptAt), lte(outbox.nextAttemptAt, sql`now()`)),
      ),
    )
    .limit(BATCH_LIMIT);

  for (const row of due) {
    if (isStopped()) return; // إغلاق نظيف: لا تبدأ صفاً جديداً بعد طلب التوقف (§12)
    try {
      await dispatchOne(deps, row.id, row.tenantId);
    } catch (error: unknown) {
      // §16.12/R-16 — لا ابتلاع صامت ولا حلقة ساخنة: سجّل، ثم حاسِب الصف (attempts+backoff؛
      // بعد السقف failed) كي لا يجوّع صف سام بقية الدفعة كل ثانية. at-least-once محفوظة.
      const outcome = await recordDispatchFailure(deps, row.id, row.tenantId);
      console.error(
        JSON.stringify({
          action: "outbox_dispatch_error",
          outboxId: row.id,
          tenantId: row.tenantId,
          outcome,
          message: errorMessage(error),
        }),
      );
    }
  }
}

// §12 — التقاط pending كل ثانية. الحلقة لا تتوقف عند الخطأ (تسجّل وتكمل)،
// وstop() توقف الجدولة وتنتظر الدورة الجارية حتى نهايتها (graceful shutdown).
export function startOutboxPoller(deps: OutboxPollerDeps): { stop(): Promise<void> } {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let busy = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runCycle = (): void => {
    if (busy || stopped) return; // لا تداخل: دورة بطيئة لا تكدّس دورات فوقها
    busy = true;
    inFlight = pollOnce(deps, () => stopped)
      .catch((error: unknown) => {
        // §16.12 — خطأ الدورة (مثلاً انقطاع القاعدة) يُسجَّل ولا يقتل الحلقة.
        console.error(JSON.stringify({ action: "outbox_poll_error", message: errorMessage(error) }));
      })
      .finally(() => {
        busy = false;
      });
  };

  runCycle(); // دورة فورية عند الإقلاع — ما تراكم أثناء التوقف لا ينتظر (§12: القاعدة مصدر الحقيقة)
  const timer = setInterval(runCycle, intervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight; // انتظر الدورة الجارية — لا قطع بمنتصف صف (§12)
    },
  };
}
