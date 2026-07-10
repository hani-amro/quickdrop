import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createDb, type DbHandle } from "@quickdrop/db";
import { TG_UPDATES_QUEUE } from "@quickdrop/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv, type ApiEnv } from "./env.js";
import { HealthController } from "./health/health.controller.js";
import { TelegramGatewayController } from "./telegram-gateway/gateway.controller.js";
import { TelegramGatewayService } from "./telegram-gateway/gateway.service.js";

export const ENV = "ENV";
export const DB = "DB";
export const REDIS = "REDIS";
export const TG_QUEUE = "TG_QUEUE";

@Module({
  controllers: [HealthController, TelegramGatewayController],
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
    TelegramGatewayService,
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(TG_QUEUE) private readonly queue: Queue,
  ) {}

  // §12 — إغلاق نظيف: استنزف ثم أغلق؛ وإلا كل نشرة deploy بتقطع طلبات بنصها.
  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    this.redis.disconnect();
    await this.db.close();
  }
}
