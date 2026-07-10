import { createDb, webhookUpdates, withTenant } from "@quickdrop/db";
import { parseEnv, TG_UPDATES_QUEUE, type TgUpdateJob } from "@quickdrop/shared";
import { Queue, Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { z } from "zod";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    DATABASE_URL_WORKER: z.string().url(),
    REDIS_URL: z.string().url(),
  }),
);

const appDb = createDb(env.DATABASE_URL); // كتابات داخل withTenant حصراً (§2.3)
const scanDb = createDb(env.DATABASE_URL_WORKER); // مسح عابر للمستأجرين — قراءة فقط
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(TG_UPDATES_QUEUE, { connection: redis });

async function processUpdate(job: TgUpdateJob): Promise<void> {
  await withTenant(appDb.db, job.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: webhookUpdates.id, status: webhookUpdates.status })
      .from(webhookUpdates)
      .where(eq(webhookUpdates.updateId, job.updateId))
      .limit(1);
    const row = rows[0];
    if (!row || row.status === "processed") return; // idempotent — الفخ 7: "ماذا لو نُفّذت مرتين؟"

    // المرحلة 1: هنا يُمرَّر الـ payload لـ grammY instance المستأجر.
    await tx
      .update(webhookUpdates)
      .set({ status: "processed" })
      .where(and(eq(webhookUpdates.id, row.id), eq(webhookUpdates.status, "received")));
  });
}

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

  const worker = new Worker<TgUpdateJob>(
    TG_UPDATES_QUEUE,
    async (job) => {
      // §16.12: لا ابتلاع أخطاء — الرمي يعيد الجدولة عبر BullMQ backoff
      await processUpdate(job.data);
    },
    { connection: redis, concurrency: 10 },
  );

  worker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({ action: "job_failed", jobId: job?.id, attempts: job?.attemptsMade, message: error.message }),
    );
  });

  // §12 — إغلاق نظيف: استنزف الجاري قبل الخروج، وإلا كل deploy بيقتل مهام بنصها
  const shutdown = async (): Promise<void> => {
    await worker.close();
    await queue.close();
    redis.disconnect();
    await appDb.close();
    await scanDb.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  console.log(JSON.stringify({ action: "worker_started", queue: TG_UPDATES_QUEUE }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
