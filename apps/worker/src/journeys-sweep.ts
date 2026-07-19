import { dueJourneyRuns, type Db } from "@quickdrop/db";
import { journeyStepJobId, type JourneyStepJob } from "@quickdrop/shared";
import type { Queue } from "bullmq";

// دمج WaFlow (MERGE_PLAN §3.4/§12) — شبكة أمان الرحلات: القاعدة مصدر الحقيقة. جدولة
// الخطوة (queue.add) أثر جانبي **بعد** الـ commit؛ لو فشلت (Redis عابر) أو مات العامل
// بينها، يبقى الـ run نشطاً بلا مهمة (enrollInJourneys عند إعادة المحاولة يعيد [] بسبب
// onConflictDoNothing، فلا يُعاد جدولته). rescan الإقلاع وحده لا يكفي: يلتقط المستحقّ
// وقتها فقط، وخطوة أولى مؤجّلة (delay>0) لا تكون مستحقّة عند الإقلاع فتضيع للأبد.
//
// الحل (نمط outbox-poller/brain-sweep): كنس دوري يلتقط كل run نشط مستحقّ (next_run_at
// <= now) ويجدول له مهمة خطوة. jobId حتمي (run, current_step) + remove-then-add =
// idempotent: مهمة حيّة بنفس المعرّف تُستبدل بمطابقة، ومهمة مفقودة تُحيا — بلا ازدواج
// تنفيذ (المنفّذ يقفل الصف FOR UPDATE ويتقدّم الخطوة مرة واحدة، وحمولة step تحرس التوقيت).
// run بموعد مستقبلي ليس مستحقّاً → لا يُلمس (مهمته المؤجّلة الأصلية قائمة، لا churn).

const DEFAULT_INTERVAL_MS = 60_000; // كل دقيقة — استعلام مفهرس رخيص، والمستحقّ عادة صفر
const STEP_JOB_OPTS = { attempts: 5, backoff: { type: "exponential" as const, delay: 1000 }, removeOnComplete: { count: 1000 } };

export interface JourneysRescanDeps {
  /** app_worker — سياسة worker_scan تتيح قراءة journey_runs عبر المستأجرين (§2.3). */
  scanDb: Db;
  journeysQueue: Queue<JourneyStepJob>;
  intervalMs?: number;
  now?: () => Date;
}

export interface JourneysRescanHandle {
  stop: () => Promise<void>;
  /** جولة واحدة (تُستدعى عند الإقلاع، وللاختبار) — يرجّع عدد الـ runs المعاد جدولتها. */
  runOnce: () => Promise<number>;
}

async function rescanOnce(deps: { scanDb: Db; journeysQueue: Queue<JourneyStepJob>; now: () => Date }): Promise<number> {
  const due = await dueJourneyRuns(deps.scanDb, deps.now());
  for (const run of due) {
    const jobId = journeyStepJobId(run.id, run.currentStep);
    await deps.journeysQueue.remove(jobId).catch(() => undefined);
    await deps.journeysQueue.add(
      "journey-step",
      { tenantId: run.tenantId, runId: run.id, step: run.currentStep },
      { ...STEP_JOB_OPTS, jobId }, // بلا delay — مستحقّ الآن
    );
  }
  if (due.length > 0) console.log(JSON.stringify({ action: "journeys_rescan", enqueued: due.length }));
  return due.length;
}

export function startJourneysRescan(deps: JourneysRescanDeps): JourneysRescanHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = deps.now ?? ((): Date => new Date());
  let stopped = false;
  let running = false;
  let current: Promise<unknown> | null = null;

  const run = async (): Promise<number> => {
    if (running || stopped) return 0;
    running = true;
    try {
      return await rescanOnce({ scanDb: deps.scanDb, journeysQueue: deps.journeysQueue, now });
    } catch (error) {
      // §16.12 — لا ابتلاع صامت: سجّل واستمر (الحلقة لا تموت بخطأ دورة)
      console.error(JSON.stringify({ action: "journeys_rescan", outcome: "error", message: error instanceof Error ? error.message : String(error) }));
      return 0;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    current = run();
  }, intervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (current) await current; // §12 — انتظر الدورة الجارية
    },
    runOnce: run,
  };
}
