import { Module, type OnApplicationShutdown, Inject } from "@nestjs/common";
import { createDb, type DbHandle } from "@quickdrop/db";
import {
  BROADCAST_QUEUE,
  SCHEDULED_QUEUE,
  TG_UPDATES_QUEUE,
  WA_UPDATES_QUEUE,
  type BroadcastJob,
  type ScheduledOrderJob,
  type WaUpdateJob,
} from "@quickdrop/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv, type ApiEnv } from "./env.js";
import { BROADCAST_Q, DB, ENV, REDIS, SCHEDULED_Q, TG_QUEUE, WA_QUEUE } from "./tokens.js";

// MERGE_PLAN §3.6 — CoreModule: البنية المشتركة (env/DB/Redis/منتجو الطوابير) بوحدة
// واحدة تصدّر رموز الحقن؛ وحدات الـ feature (WaModule الآن، CRM/AI/Journeys بـ Phase 2)
// تستوردها بدل التكديس بموديول مسطّح واحد. الإغلاق النظيف هنا لأن الموارد ملكه.
@Module({
  providers: [
    { provide: ENV, useFactory: (): ApiEnv => loadEnv() },
    {
      provide: DB,
      useFactory: (env: ApiEnv): DbHandle => createDb(env.DATABASE_URL),
      inject: [ENV],
    },
    {
      provide: REDIS,
      useFactory: (env: ApiEnv): Redis => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
      inject: [ENV],
    },
    {
      provide: TG_QUEUE,
      useFactory: (redis: Redis): Queue => new Queue(TG_UPDATES_QUEUE, { connection: redis }),
      inject: [REDIS],
    },
    {
      // §4.3/§14 — منتج طابور البث: الـ api يدفع مهمة لكل بثّة غير مجدولة
      provide: BROADCAST_Q,
      useFactory: (redis: Redis): Queue<BroadcastJob> =>
        new Queue<BroadcastJob>(BROADCAST_QUEUE, { connection: redis }),
      inject: [REDIS],
    },
    {
      // §6.3 — منتج طابور الجدولة: يدفع مهمة مؤجّلة عند إنشاء طلب بموعد مستقبلي
      provide: SCHEDULED_Q,
      useFactory: (redis: Redis): Queue<ScheduledOrderJob> =>
        new Queue<ScheduledOrderJob>(SCHEDULED_QUEUE, { connection: redis }),
      inject: [REDIS],
    },
    {
      // دمج WaFlow §3.1 — منتج طابور تحديثات واتساب (البوابة تدفع بعد الحفظ durable)
      provide: WA_QUEUE,
      useFactory: (redis: Redis): Queue<WaUpdateJob> => new Queue<WaUpdateJob>(WA_UPDATES_QUEUE, { connection: redis }),
      inject: [REDIS],
    },
  ],
  exports: [ENV, DB, REDIS, TG_QUEUE, BROADCAST_Q, SCHEDULED_Q, WA_QUEUE],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(TG_QUEUE) private readonly tgQueue: Queue,
    @Inject(BROADCAST_Q) private readonly broadcastQueue: Queue<BroadcastJob>,
    @Inject(SCHEDULED_Q) private readonly scheduledQueue: Queue<ScheduledOrderJob>,
    @Inject(WA_QUEUE) private readonly waQueue: Queue<WaUpdateJob>,
  ) {}

  // §12 — إغلاق نظيف: الطوابير ثم Redis ثم القاعدة (نفس ترتيب الموديول القديم)
  async onApplicationShutdown(): Promise<void> {
    await this.tgQueue.close();
    await this.broadcastQueue.close();
    await this.scheduledQueue.close();
    await this.waQueue.close();
    this.redis.disconnect();
    await this.db.close();
  }
}
