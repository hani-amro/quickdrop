import { createDb, webhookUpdates } from "@quickdrop/db";
import {
  NOTIFICATIONS_QUEUE,
  parseEnv,
  TG_UPDATES_QUEUE,
  type NotificationJob,
  type TgUpdateJob,
} from "@quickdrop/shared";
import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { z } from "zod";
import { startOutboxPoller } from "./outbox-poller.js";
import { processUpdate, type UpdateProcessorDeps } from "./update-processor.js";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    DATABASE_URL_WORKER: z.string().url(),
    REDIS_URL: z.string().url(),
    // §4.2: MASTER_KEY 32 بايت hex — لفك تشفير توكنات البوتات عند المعالجة
    MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "MASTER_KEY must be 64 hex chars (32 bytes)"),
  }),
);

const appDb = createDb(env.DATABASE_URL); // كتابات داخل withTenant حصراً (§2.3)
const scanDb = createDb(env.DATABASE_URL_WORKER); // مسح عابر للمستأجرين — قراءة فقط
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(TG_UPDATES_QUEUE, { connection: redis });
const notificationsQueue = new Queue<NotificationJob>(NOTIFICATIONS_QUEUE, { connection: redis });

// معالجة التحديثات (بوت الزبون §4.3/§4.4) — المنطق بـ update-processor.ts
const updateProcessorDeps: UpdateProcessorDeps = {
  appDb: appDb.db,
  scanDb: scanDb.db,
  redis,
  masterKey: Buffer.from(env.MASTER_KEY, "hex"),
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

async function main(): Promise<void> {
  await rescanPending();

  // D9/§12 — بعد إعادة بناء الفائت: شغّل عامل التقاط الـ outbox (كل ثانية → طابور الإشعارات)
  const outboxPoller = startOutboxPoller({ scanDb: scanDb.db, appDb: appDb.db, queue: notificationsQueue });

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

  // D9 — مستهلك الإشعارات: placeholder يسجّل JSON فقط؛ الإرسال الفعلي لتيليغرام وحدة
  // زميلة لاحقة. جاهز للـ idempotency: التسليم at-least-once (§12) — مفتاح إزالة
  // التكرار = outboxId، والمرسل الفعلي يجب أن يتحقق "هل أُرسل هذا outboxId؟" قبل النداء.
  const notificationsWorker = new Worker<NotificationJob>(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      // §16.12: لا ابتلاع أخطاء — أي رمي هنا يعيد الجدولة عبر BullMQ backoff
      console.log(
        JSON.stringify({
          action: "notification_placeholder",
          outboxId: job.data.outboxId,
          tenantId: job.data.tenantId,
          topic: job.data.topic,
        }),
      );
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

  // §12 — إغلاق نظيف: استنزف الجاري قبل الخروج، وإلا كل deploy بيقتل مهام بنصها
  const shutdown = async (): Promise<void> => {
    await outboxPoller.stop(); // أولاً: أوقف إنتاج مهام جديدة وانتظر الدورة الجارية
    await worker.close();
    await notificationsWorker.close();
    await queue.close();
    await notificationsQueue.close();
    redis.disconnect();
    await appDb.close();
    await scanDb.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  console.log(JSON.stringify({ action: "worker_started", queues: [TG_UPDATES_QUEUE, NOTIFICATIONS_QUEUE] }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
