import { createDb, fireScheduledOrder, offers, orders, scheduledDelayMs, webhookUpdates } from "@quickdrop/db";
import {
  BROADCAST_QUEUE,
  DISPATCH_QUEUE,
  installConsoleRedactor,
  NOTIFICATIONS_QUEUE,
  parseEnv,
  SCHEDULED_QUEUE,
  scheduledJobId,
  TG_UPDATES_QUEUE,
  type BroadcastJob,
  type DispatchJob,
  type NotificationJob,
  type ScheduledOrderJob,
  type TgUpdateJob,
} from "@quickdrop/shared";
import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { z } from "zod";
import { createBroadcastProcessor } from "./broadcast-consumer.js";
import { createDispatchProcessor, DISPATCH_JOB_OPTS, offerTimeoutJobId } from "./dispatch-worker.js";
import { createNotificationsProcessor, offerTimeoutDelayMs } from "./notifications-consumer.js";
import { createStorageClient, tryLoadStorageConfig } from "@quickdrop/storage";
import { startHousekeeping } from "./housekeeping.js";
import { initSentry, startMetricsServer } from "./observability.js";
import { startOutboxPoller } from "./outbox-poller.js";
import { processUpdate, type UpdateProcessorDeps } from "./update-processor.js";

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
      jobId: `${row.tenantId}:${row.updateId}`, // نفس مفتاح البوابة — لا ازدواج
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

async function main(): Promise<void> {
  await rescanPending();
  await rescanPendingOffers();
  await rescanScheduledOrders();

  // D9/§12 — بعد إعادة بناء الفائت: شغّل عامل التقاط الـ outbox (كل ثانية → طابور الإشعارات)
  const outboxPoller = startOutboxPoller({ scanDb: scanDb.db, appDb: appDb.db, queue: notificationsQueue });

  // §3/§16.25 — تنظيف الجداول الساخنة كل ساعة (webhook_updates >48س، driver_locations >90ي)
  const housekeeping = startHousekeeping({ scanDb: scanDb.db, appDb: appDb.db });

  // §13 — خادم /metrics + عمق الطوابير (تنبيه طابور > 500)
  const metricsServer = startMetricsServer({
    port: env.METRICS_PORT,
    queues: { [TG_UPDATES_QUEUE]: queue, [NOTIFICATIONS_QUEUE]: notificationsQueue, [DISPATCH_QUEUE]: dispatchQueue },
  });

  const worker = new Worker<TgUpdateJob>(
    TG_UPDATES_QUEUE,
    async (job) => {
      // §16.12: لا ابتلاع أخطاء — الرمي يعيد الجدولة عبر BullMQ backoff
      await processUpdate(updateProcessorDeps, job.data);
    },
    { connection: redis, concurrency: 10 },
  );

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
    await metricsServer.stop();
    await worker.close();
    await notificationsWorker.close();
    await dispatchWorker.close();
    await broadcastWorker.close();
    await scheduledWorker.close();
    await queue.close();
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
      queues: [TG_UPDATES_QUEUE, NOTIFICATIONS_QUEUE, DISPATCH_QUEUE, BROADCAST_QUEUE, SCHEDULED_QUEUE],
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
