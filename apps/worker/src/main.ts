import { createDb, fireScheduledOrder, offers, orders, outbox, scheduledDelayMs, webhookUpdates } from "@quickdrop/db";
import {
  BRAIN_QUEUE,
  BROADCAST_QUEUE,
  DISPATCH_QUEUE,
  installConsoleRedactor,
  JOURNEYS_QUEUE,
  NOTIFICATIONS_QUEUE,
  parseEnv,
  SCHEDULED_QUEUE,
  scheduledJobId,
  TG_UPDATES_QUEUE,
  tgUpdateJobId,
  WA_UPDATES_QUEUE,
  waUpdateJobId,
  type JourneyStepJob,
  type WaUpdateJob,
  type BroadcastJob,
  type DispatchJob,
  type NotificationJob,
  type ScheduledOrderJob,
  type TgUpdateJob,
} from "@quickdrop/shared";
import { Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { z } from "zod";
import { createBroadcastProcessor } from "./broadcast-consumer.js";
import { createDispatchProcessor, DISPATCH_JOB_OPTS, offerTimeoutJobId } from "./dispatch-worker.js";
import { createNotificationsProcessor, offerTimeoutDelayMs } from "./notifications-consumer.js";
import { createStorageClient, tryLoadStorageConfig } from "@quickdrop/storage";
import { startHousekeeping } from "./housekeeping.js";
import { captureException, initSentry, startMetricsServer } from "./observability.js";
import { startOutboxPoller } from "./outbox-poller.js";
import { processUpdate, type UpdateProcessorDeps } from "./update-processor.js";
import { pendingWaUpdates, processWaUpdate, WA_RESCAN_BATCH } from "./wa-update-processor.js";
import { createBrainProcessor } from "./brain-consumer.js";
import { startBrainSweep } from "./brain-sweep.js";
import { createJourneyEnrollProcessor, createJourneyStepProcessor } from "./journeys-consumer.js";
import { startJourneysRescan } from "./journeys-sweep.js";

installConsoleRedactor(); // §11 — كل console.* يمرّ بالمنقّح (أسرار/هواتف) قبل الطباعة

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    DATABASE_URL_WORKER: z.string().url(),
    REDIS_URL: z.string().url(),
    // §4.2: MASTER_KEY 32 بايت hex — لفك تشفير توكنات البوتات عند المعالجة
    MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "MASTER_KEY must be 64 hex chars (32 bytes)"),
    // §13 — مراقبة: Sentry (اختياري)، ومنفذ /metrics الداخلي
    SENTRY_DSN: z.string().url().optional(),
    METRICS_PORT: z.coerce.number().int().positive().default(9100),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  }),
);

initSentry(env.SENTRY_DSN, env.NODE_ENV); // §13 — قبل أي عمل، ليلتقط أخطاء الإقلاع

const appDb = createDb(env.DATABASE_URL); // كتابات داخل withTenant حصراً (§2.3)
const scanDb = createDb(env.DATABASE_URL_WORKER); // مسح عابر للمستأجرين — قراءة فقط
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const masterKey = Buffer.from(env.MASTER_KEY, "hex");
const queue = new Queue(TG_UPDATES_QUEUE, { connection: redis });
const notificationsQueue = new Queue<NotificationJob>(NOTIFICATIONS_QUEUE, { connection: redis });
const dispatchQueue = new Queue<DispatchJob>(DISPATCH_QUEUE, { connection: redis });
const scheduledQueue = new Queue<ScheduledOrderJob>(SCHEDULED_QUEUE, { connection: redis });
const waQueue = new Queue<WaUpdateJob>(WA_UPDATES_QUEUE, { connection: redis }); // دمج WaFlow §3.1
const brainQueue = new Queue<NotificationJob>(BRAIN_QUEUE, { connection: redis }); // دمج WaFlow §3.3
const journeysQueue = new Queue<JourneyStepJob>(JOURNEYS_QUEUE, { connection: redis }); // دمج WaFlow §3.4


// §11 — عميل تخزين إثبات التسليم (S3/MinIO). غياب إعداد S3 → null → POD معطّل بلطف.
const storageConfig = tryLoadStorageConfig(process.env);
const storage = storageConfig !== null ? createStorageClient(storageConfig) : null;
if (storage === null) {
  console.warn(JSON.stringify({ action: "worker_started", pod_storage: "disabled_no_s3_config" }));
}

// معالجة التحديثات (بوت الزبون §4.3/§4.4) — المنطق بـ update-processor.ts
const updateProcessorDeps: UpdateProcessorDeps = {
  appDb: appDb.db,
  scanDb: scanDb.db,
  redis,
  masterKey,
  rtRedis: redis, // §10.1 — نشر driver.location على قناة الوقت الحقيقي (نفس العميل)
  storage, // §11 — إثبات التسليم بالصورة
};

// §12 — الطوابير ليست مصدر حقيقة: عند الإقلاع أعد بناء المهام الفائتة من القاعدة.
async function rescanPending(): Promise<void> {
  const pending = await scanDb.db
    .select({ tenantId: webhookUpdates.tenantId, updateId: webhookUpdates.updateId })
    .from(webhookUpdates)
    .where(eq(webhookUpdates.status, "received"));
  for (const row of pending) {
    const job: TgUpdateJob = { tenantId: row.tenantId, updateId: row.updateId };
    await queue.add("process-update", job, {
      jobId: tgUpdateJobId(row.tenantId, row.updateId), // نفس مفتاح البوابة — لا ازدواج (بلا ':')
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { count: 1000 },
    });
  }
  if (pending.length > 0) {
    console.log(JSON.stringify({ action: "rescan_enqueued", count: pending.length }));
  }
}

// §12/§6.2 — نفس المبدأ لمُهل العروض: Redis بيضيع؛ offers.expires_at بالقاعدة لا.
// عند الإقلاع أعد جدولة مهلة كل عرض pending (jobId 'ot:{offerId}' يمنع الازدواج مع
// المجدول أصلاً)؛ عرض فات موعده → delay 0، وhandleOfferTimeout يقفل ويتحقق من
// expires_at قبل أي فعل (D16) — إعادة الجدولة آمنة التكرار دائماً.
async function rescanPendingOffers(): Promise<void> {
  const pendingOffers = await scanDb.db
    .select({ id: offers.id, tenantId: offers.tenantId, expiresAt: offers.expiresAt })
    .from(offers)
    .where(eq(offers.status, "pending"));
  const now = new Date();
  for (const offer of pendingOffers) {
    await dispatchQueue.add(
      "offer-timeout",
      { kind: "offer-timeout", tenantId: offer.tenantId, offerId: offer.id },
      { ...DISPATCH_JOB_OPTS, jobId: offerTimeoutJobId(offer.id), delay: offerTimeoutDelayMs(offer.expiresAt, now) },
    );
  }
  if (pendingOffers.length > 0) {
    console.log(JSON.stringify({ action: "rescan_offers_enqueued", count: pendingOffers.length }));
  }
}

// §6.3/§12 — القاعدة مصدر الحقيقة للجدولة: عند الإقلاع أعد جدولة كل طلب scheduled
// (مهمة api الأصلية قد تكون ضاعت مع Redis). jobId حتمي = 'sched-{orderId}' يجعلها
// idempotentة مع المهمة الأصلية؛ الفائت موعده → delay 0 فيُطلق فوراً.
async function rescanScheduledOrders(): Promise<void> {
  const scheduled = await scanDb.db
    .select({ id: orders.id, tenantId: orders.tenantId, scheduledAt: orders.scheduledAt })
    .from(orders)
    .where(eq(orders.status, "scheduled"));
  const now = new Date();
  for (const o of scheduled) {
    if (!o.scheduledAt) continue; // scheduled بلا موعد لا يُطلق آلياً (حماية)
    await scheduledQueue.add(
      "fire-scheduled",
      { tenantId: o.tenantId, orderId: o.id },
      { jobId: scheduledJobId(o.id), delay: scheduledDelayMs(o.scheduledAt, now), attempts: 5, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: { count: 1000 } },
    );
  }
  if (scheduled.length > 0) {
    console.log(JSON.stringify({ action: "rescan_scheduled_enqueued", count: scheduled.length }));
  }
}

// دمج WaFlow §3.1/§12 — نفس مبدأ inbox تيليغرام: صفوف received المتروكة (crash بين
// الالتزام والمعالجة) تعاد للطابور عند الإقلاع. مراجعة Phase 1 (adversary):
// (1) **remove-then-add**: BullMQ يزيل التكرار بالـ jobId، فمهمة سابقة استنفدت
//     محاولاتها (DB سقط 31s) تبقى بمجموعة failed وتحجب أي re-add بنفس المعرّف →
//     الصف عالق للأبد (Meta أخذ 200 ولن يعيد). نحذف المهمة القديمة ثم نضيف نظيفة.
// (2) **تصريف كامل**: نتصفّح بدفعات حتى الفراغ لا 1000 فقط.
async function rescanWaUpdates(): Promise<void> {
  let after: { receivedAt: Date; id: string } | undefined;
  let total = 0;
  for (;;) {
    const pending = await pendingWaUpdates(scanDb.db, after);
    if (pending.length === 0) break;
    for (const row of pending) {
      const jobId = waUpdateJobId(row.id);
      await waQueue.remove(jobId).catch(() => undefined); // مهمة عالقة/منتهية بنفس المعرّف — أزلها بأمان
      const job: WaUpdateJob = { tenantId: row.tenantId, updateId: row.id };
      await waQueue.add("process-wa-update", job, {
        jobId,
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { count: 1000 },
      });
    }
    total += pending.length;
    const last = pending[pending.length - 1]!;
    after = { receivedAt: last.receivedAt, id: last.id };
    if (pending.length < WA_RESCAN_BATCH) break;
  }
  if (total > 0) {
    console.log(JSON.stringify({ action: "rescan_wa_enqueued", count: total }));
  }
}

async function main(): Promise<void> {
  await rescanPending();
  await rescanPendingOffers();
  await rescanScheduledOrders();
  await rescanWaUpdates();

  // D9/§12 — بعد إعادة بناء الفائت: شغّل عامل التقاط الـ outbox (كل ثانية → طابور الإشعارات).
  // R-16: صف يفشل التقاطه يُحاسَب (backoff أسّي ثم failed بعد السقف) — التسميم يُبلَّغ Sentry.
  const outboxPoller = startOutboxPoller({
    scanDb: scanDb.db,
    appDb: appDb.db,
    queue: notificationsQueue,
    brainQueue, // §3.3 — fan-out أحداث الدماغ (BRAIN_TOPICS) لطابور مستقل
    onPoisoned: ({ outboxId, tenantId }) => {
      captureException(new Error(`outbox row poisoned after max attempts: ${outboxId}`), { tenantId });
    },
  });

  // §3.3/§3.4 — طابور الأتمتة (BRAIN_QUEUE، fan-out): لكل حدث (أ) دماغ الزبون يعيد الحساب
  // و(ب) Journeys تسجّل الرحلات المطابقة وتجدول خطواتها. كلاهما idempotent؛ رمي أيٍّ منهما
  // يعيد الجدولة (والآخر يُعاد لكنه idempotent).
  const processBrain = createBrainProcessor({ appDb: appDb.db });
  const processJourneyEnroll = createJourneyEnrollProcessor({ appDb: appDb.db, journeysQueue });
  const brainWorker = new Worker<NotificationJob>(
    BRAIN_QUEUE,
    async (job) => {
      await processBrain(job.data);
      await processJourneyEnroll(job.data);
    },
    { connection: redis, concurrency: 5 },
  );
  brainWorker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({ action: "job_failed", queue: BRAIN_QUEUE, jobId: job?.id, attempts: job?.attemptsMade, message: error.message }),
    );
  });
  const brainSweep = startBrainSweep({ scanDb: scanDb.db, appDb: appDb.db });

  // §3.4 — منفّذ خطوات الرحلات (JOURNEYS_QUEUE، مهام مؤجّلة): ينفّذ الخطوة ويجدول التالية.
  const processJourneyStep = createJourneyStepProcessor({ appDb: appDb.db, journeysQueue });
  const journeysWorker = new Worker<JourneyStepJob>(
    JOURNEYS_QUEUE,
    async (job) => {
      await processJourneyStep(job.data);
    },
    { connection: redis, concurrency: 5 },
  );
  journeysWorker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({ action: "job_failed", queue: JOURNEYS_QUEUE, jobId: job?.id, attempts: job?.attemptsMade, message: error.message }),
    );
  });

  // §3.4/§12 — شبكة أمان الرحلات (دورية + جولة إقلاع): تلتقط أي run نشط مستحقّ بلا مهمة
  // (فشل جدولة post-commit أو موت العامل بينها) وتعيد جدولته — القاعدة مصدر الحقيقة، لا
  // اعتماد على أثر جانبي وحيد. idempotent (jobId حتمي + حمولة step + قفل الصف بالمنفّذ).
  const journeysRescan = startJourneysRescan({ scanDb: scanDb.db, journeysQueue });
  await journeysRescan.runOnce(); // استرداد فوري عند الإقلاع (بعد توقّف/انهيار)

  // §3/§16.25 — تنظيف الجداول الساخنة كل ساعة (webhook_updates >48س، driver_locations >90ي،
  // outbox: sent >7ي وfailed >30ي — R-16)
  const housekeeping = startHousekeeping({ scanDb: scanDb.db, appDb: appDb.db });

  // §13 — خادم /metrics + عمق الطوابير (تنبيه طابور > 500) + outbox الفاشلة (تنبيه > 0، R-16)
  const metricsServer = startMetricsServer({
    port: env.METRICS_PORT,
    queues: {
      [TG_UPDATES_QUEUE]: queue,
      [NOTIFICATIONS_QUEUE]: notificationsQueue,
      [DISPATCH_QUEUE]: dispatchQueue,
      [WA_UPDATES_QUEUE]: waQueue,
      [BRAIN_QUEUE]: brainQueue,
      [JOURNEYS_QUEUE]: journeysQueue,
    },
    countOutboxFailed: async () => {
      // scanDb (app_worker، سياسة worker_scan للقراءة) — عدّ عابر للمستأجرين بلا سياق
      const rows = await scanDb.db.select({ n: sql<number>`count(*)::int` }).from(outbox).where(eq(outbox.status, "failed"));
      return rows[0]?.n ?? 0;
    },
  });

  const worker = new Worker<TgUpdateJob>(
    TG_UPDATES_QUEUE,
    async (job) => {
      // §16.12: لا ابتلاع أخطاء — الرمي يعيد الجدولة عبر BullMQ backoff
      await processUpdate(updateProcessorDeps, job.data);
    },
    { connection: redis, concurrency: 10 },
  );

  // دمج WaFlow §3.1 — مستهلك تحديثات واتساب (هيكل Phase 1: هوية الزبون + أحداث spine)
  const waWorker = new Worker<WaUpdateJob>(
    WA_UPDATES_QUEUE,
    async (job) => {
      // §16.12: لا ابتلاع — الرمي يعيد الجدولة عبر backoff
      await processWaUpdate({ appDb: appDb.db }, job.data);
    },
    { connection: redis, concurrency: 10 },
  );
  waWorker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({ action: "job_failed", queue: WA_UPDATES_QUEUE, jobId: job?.id, attempts: job?.attemptsMade, message: error.message }),
    );
  });

  worker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({ action: "job_failed", jobId: job?.id, attempts: job?.attemptsMade, message: error.message }),
    );
  });

  // D9/§12 — مستهلك الإشعارات الحقيقي (notifications-consumer.ts): تيليغرام بعد الالتزام
  // حصراً، at-least-once — كل الأفعال آمنة التكرار (تفاصيل الـ idempotency برأس الملف).
  const processNotification = createNotificationsProcessor({
    appDb: appDb.db,
    scanDb: scanDb.db,
    redis,
    masterKey,
    dispatchQueue,
    rtRedis: redis, // §10.1 — نشر order.changed على قناة الوقت الحقيقي (نفس العميل)
  });
  const notificationsWorker = new Worker<NotificationJob>(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      // §16.12: لا ابتلاع أخطاء — أي رمي هنا يعيد الجدولة عبر BullMQ backoff
      await processNotification(job.data);
    },
    { connection: redis, concurrency: 10 },
  );

  notificationsWorker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({
        action: "job_failed",
        queue: NOTIFICATIONS_QUEUE,
        jobId: job?.id,
        attempts: job?.attemptsMade,
        message: error.message,
      }),
    );
  });

  // §6/D16 — عامل الإسناد (dispatch-worker.ts): القرارات بترانزاكشنات القاعدة، هنا تنسيق فقط
  const processDispatch = createDispatchProcessor({ appDb: appDb.db, dispatchQueue });
  const dispatchWorker = new Worker<DispatchJob>(
    DISPATCH_QUEUE,
    async (job) => {
      // §16.12: لا ابتلاع أخطاء — الرمي يعيد الجدولة عبر BullMQ backoff
      await processDispatch(job.data);
    },
    { connection: redis, concurrency: 10 },
  );

  dispatchWorker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({
        action: "job_failed",
        queue: DISPATCH_QUEUE,
        jobId: job?.id,
        attempts: job?.attemptsMade,
        message: error.message,
      }),
    );
  });

  // §4.3/§14 — مستهلك البث (broadcast-consumer.ts): مهمة واحدة لكل بثّة، إرسال مضبوط المعدل.
  // concurrency 1 قصداً: كل مهمة تبثّ لكل الجمهور تسلسلياً تحت سقف الـ 30 msg/s للبوت (§4.3)؛
  // معالجة بثّتين لمستأجرين معاً بنفس العملية قد تتجاوز السقف — v1 يبثّ بثّة واحدة في كل لحظة.
  const processBroadcast = createBroadcastProcessor({ appDb: appDb.db, scanDb: scanDb.db, redis, masterKey });
  const broadcastWorker = new Worker<BroadcastJob>(
    BROADCAST_QUEUE,
    async (job) => {
      // §16.12: لا ابتلاع أخطاء — الرمي يعيد الجدولة عبر BullMQ backoff
      await processBroadcast(job.data);
    },
    { connection: redis, concurrency: 1 },
  );

  broadcastWorker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({
        action: "job_failed",
        queue: BROADCAST_QUEUE,
        jobId: job?.id,
        attempts: job?.attemptsMade,
        message: error.message,
      }),
    );
  });

  // §6.3 — مستهلك الطلبات المجدولة: عند الموعد يطلق الطلب scheduled→pending (القرار
  // بالقاعدة بقفل الصف وفحص الحالة — idempotent).
  const scheduledWorker = new Worker<ScheduledOrderJob>(
    SCHEDULED_QUEUE,
    async (job) => {
      // §16.12: لا ابتلاع — الرمي يعيد الجدولة عبر backoff
      await fireScheduledOrder(appDb.db, job.data.tenantId, job.data.orderId);
    },
    { connection: redis, concurrency: 10 },
  );
  scheduledWorker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({ action: "job_failed", queue: SCHEDULED_QUEUE, jobId: job?.id, attempts: job?.attemptsMade, message: error.message }),
    );
  });

  // §12 — إغلاق نظيف: استنزف الجاري قبل الخروج، وإلا كل deploy بيقتل مهام بنصها
  const shutdown = async (): Promise<void> => {
    await outboxPoller.stop(); // أولاً: أوقف إنتاج مهام جديدة وانتظر الدورة الجارية
    await housekeeping.stop();
    await brainSweep.stop();
    await journeysRescan.stop(); // أوقف الكنس الدوري قبل إغلاق طابور الرحلات
    await metricsServer.stop();
    await worker.close();
    await waWorker.close();
    await brainWorker.close();
    await journeysWorker.close();
    await notificationsWorker.close();
    await dispatchWorker.close();
    await broadcastWorker.close();
    await scheduledWorker.close();
    await queue.close();
    await waQueue.close();
    await brainQueue.close();
    await journeysQueue.close();
    await notificationsQueue.close();
    await dispatchQueue.close();
    await scheduledQueue.close();
    redis.disconnect();
    await appDb.close();
    await scanDb.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  console.log(
    JSON.stringify({
      action: "worker_started",
      queues: [TG_UPDATES_QUEUE, WA_UPDATES_QUEUE, BRAIN_QUEUE, JOURNEYS_QUEUE, NOTIFICATIONS_QUEUE, DISPATCH_QUEUE, BROADCAST_QUEUE, SCHEDULED_QUEUE],
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
