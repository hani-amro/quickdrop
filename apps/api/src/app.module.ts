import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createDb, type DbHandle } from "@quickdrop/db";
import { BROADCAST_QUEUE, TG_UPDATES_QUEUE, type BroadcastJob } from "@quickdrop/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { AdminController } from "./admin/admin.controller.js";
import { AdminService } from "./admin/admin.service.js";
import { AnalyticsController } from "./analytics/analytics.controller.js";
import { AnalyticsService } from "./analytics/analytics.service.js";
import { BroadcastsController } from "./broadcasts/broadcasts.controller.js";
import { BroadcastsService } from "./broadcasts/broadcasts.service.js";
import { DriversController } from "./drivers/drivers.controller.js";
import { DriversService } from "./drivers/drivers.service.js";
import { loadEnv, type ApiEnv } from "./env.js";
import { HealthController } from "./health/health.controller.js";
import { CouponsController } from "./loyalty/coupons.controller.js";
import { LoyaltyController } from "./loyalty/loyalty.controller.js";
import { LoyaltyService } from "./loyalty/loyalty.service.js";
import { ReferralsController } from "./loyalty/referrals.controller.js";
import { OrdersController } from "./orders/orders.controller.js";
import { OrdersService } from "./orders/orders.service.js";
import { SettlementsController } from "./settlements/settlements.controller.js";
import { SettlementsService } from "./settlements/settlements.service.js";
import { TelegramGatewayController } from "./telegram-gateway/gateway.controller.js";
import { TelegramGatewayService } from "./telegram-gateway/gateway.service.js";
import { TrackingController } from "./tracking/tracking.controller.js";

export const ENV = "ENV";
export const DB = "DB";
export const REDIS = "REDIS";
export const TG_QUEUE = "TG_QUEUE";
export const BROADCAST_Q = "BROADCAST_Q";

@Module({
  controllers: [
    HealthController,
    OrdersController,
    DriversController,
    SettlementsController,
    LoyaltyController, // §9 — GET /api/loyalty/:userId
    CouponsController, // §9 — POST/GET /api/coupons
    ReferralsController, // §9 — POST /api/referrals
    BroadcastsController, // §4.3/§14 — POST/GET /api/broadcasts
    AnalyticsController, // §13 — GET /api/analytics
    AdminController, // §14 — كونسول المشرف: /api/admin/* (مصادقة منفصلة)
    TrackingController, // §7 — عام بلا auth: /public/track/:token
    TelegramGatewayController,
  ],
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
    TelegramGatewayService,
    OrdersService,
    DriversService,
    SettlementsService,
    LoyaltyService, // §9 — الولاء/الكوبونات/الإحالات
    BroadcastsService, // §4.3/§14 — البث الجماهيري
    AnalyticsService, // §13 — تحليلات اللوحة
    AdminService, // §14 — دورة حياة المستأجر والباقات
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(TG_QUEUE) private readonly queue: Queue,
    @Inject(BROADCAST_Q) private readonly broadcastQueue: Queue<BroadcastJob>,
  ) {}

  // §12 — إغلاق نظيف: استنزف ثم أغلق؛ وإلا كل نشرة deploy بتقطع طلبات بنصها.
  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    await this.broadcastQueue.close();
    this.redis.disconnect();
    await this.db.close();
  }
}
