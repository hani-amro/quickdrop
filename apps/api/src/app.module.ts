// رموز الحقن أولاً — قبل أي كنترولر — كي تُهيَّأ قيمها قبل تقييم مُزخرِفات @Inject
// في الخدمات (التي تعيد استيرادها من هنا)؛ وإلا حلقة الاستيراد تجعلها undefined.
import { BROADCAST_Q, DB, ENV, REDIS, SCHEDULED_Q, TG_QUEUE } from "./tokens.js";
export { BROADCAST_Q, DB, ENV, REDIS, SCHEDULED_Q, TG_QUEUE };
import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { createDb, type DbHandle } from "@quickdrop/db";
import { BROADCAST_QUEUE, SCHEDULED_QUEUE, TG_UPDATES_QUEUE, type BroadcastJob, type ScheduledOrderJob } from "@quickdrop/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { AdminController } from "./admin/admin.controller.js";
import { AdminService } from "./admin/admin.service.js";
import { AdminAuthController } from "./admin/admin-auth.controller.js";
import { AdminAuthService } from "./admin/admin-auth.service.js";
import { AdminGuard } from "./admin/admin.guard.js";
import { AnalyticsController } from "./analytics/analytics.controller.js";
import { AnalyticsService } from "./analytics/analytics.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { SessionGuard } from "./auth/session.guard.js";
import { RateLimitGuard } from "./common/rate-limit.guard.js";
import { BroadcastsController } from "./broadcasts/broadcasts.controller.js";
import { BroadcastsService } from "./broadcasts/broadcasts.service.js";
import { DriversController } from "./drivers/drivers.controller.js";
import { DriversService } from "./drivers/drivers.service.js";
import { loadEnv, type ApiEnv } from "./env.js";
import { HealthController } from "./health/health.controller.js";
import { MetricsController, MetricsInterceptor } from "./observability/metrics.js";
import { CouponsController } from "./loyalty/coupons.controller.js";
import { LoyaltyController } from "./loyalty/loyalty.controller.js";
import { LoyaltyService } from "./loyalty/loyalty.service.js";
import { ReferralsController } from "./loyalty/referrals.controller.js";
import { MerchantsController } from "./merchants/merchants.controller.js";
import { MerchantsService } from "./merchants/merchants.service.js";
import { OrdersController } from "./orders/orders.controller.js";
import { OrdersService } from "./orders/orders.service.js";
import { SettlementsController } from "./settlements/settlements.controller.js";
import { SettlementsService } from "./settlements/settlements.service.js";
import { SupportController } from "./support/support.controller.js";
import { SupportService } from "./support/support.service.js";
import { TelegramGatewayController } from "./telegram-gateway/gateway.controller.js";
import { TelegramGatewayService } from "./telegram-gateway/gateway.service.js";
import { TrackingController } from "./tracking/tracking.controller.js";

@Module({
  controllers: [
    HealthController,
    OrdersController,
    DriversController,
    MerchantsController, // §3 — إدارة التجار وكتالوجهم
    SettlementsController,
    SupportController, // §9 — خيوط الدعم (customer↔support)
    LoyaltyController, // §9 — GET /api/loyalty/:userId
    CouponsController, // §9 — POST/GET /api/coupons
    ReferralsController, // §9 — POST /api/referrals
    BroadcastsController, // §4.3/§14 — POST/GET /api/broadcasts
    AnalyticsController, // §13 — GET /api/analytics
    AdminController, // §14 — كونسول المشرف: /api/admin/* (مصادقة منفصلة)
    AdminAuthController, // §10.2 — دخول المشرف المنفصل: /api/admin/auth/* (جلسات qd_admin)
    TrackingController, // §7 — عام بلا auth: /public/track/:token
    AuthController, // §10.2 — دخول/خروج/هوية الطاقم (jلسات cookie)
    MetricsController, // §13 — GET /metrics لـ Prometheus (معفى من الحارسَين)
    TelegramGatewayController,
  ],
  providers: [
    // §13 — interceptor عام يقيس زمن كل طلب (histogram Prometheus)
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    // §11 — حد المعدل لكل IP: حارس عام يُسجَّل **أولاً** كي يعمل قبل SessionGuard
    // (الحرّاس العامّون ينفَّذون بترتيب التسجيل) — يُرفض الفيضان قبل أي عمل مصادقة.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // §10.2 — حارس عام: مسارات /api/* للطاقم تتطلب جلسة cookie أو Bearer STAFF_API_TOKEN
    // (session.guard يعفي auth/admin/العامة). دفاع مزدوج مع تحقق طبقة الخدمات.
    { provide: APP_GUARD, useClass: SessionGuard },
    // §10.2 — حارس عام مستقل لكونسول المشرف: /api/admin/* تتطلب جلسة qd_admin أو Bearer
    // ADMIN_API_TOKEN (admin.guard يعفي /api/admin/auth الذاتية). دفاع مزدوج مع الخدمة.
    { provide: APP_GUARD, useClass: AdminGuard },
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
    TelegramGatewayService,
    OrdersService,
    DriversService,
    MerchantsService, // §3 — إدارة التجار وكتالوجهم
    SettlementsService,
    SupportService, // §9 — خيوط الدعم (customer↔support)
    LoyaltyService, // §9 — الولاء/الكوبونات/الإحالات
    BroadcastsService, // §4.3/§14 — البث الجماهيري
    AnalyticsService, // §13 — تحليلات اللوحة
    AdminService, // §14 — دورة حياة المستأجر والباقات
    AdminAuthService, // §10.2 — مصادقة المشرف الحقيقية (admin_users + جلسات qd_admin)
    AuthService, // §10.2 — مصادقة الطاقم (argon2id + جلسات Redis + TOTP)
    SessionGuard, // مزوّد الحارس العام أعلاه
    AdminGuard, // مزوّد حارس المشرف العام أعلاه
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(TG_QUEUE) private readonly queue: Queue,
    @Inject(BROADCAST_Q) private readonly broadcastQueue: Queue<BroadcastJob>,
    @Inject(SCHEDULED_Q) private readonly scheduledQueue: Queue<ScheduledOrderJob>,
  ) {}

  // §12 — إغلاق نظيف: استنزف ثم أغلق؛ وإلا كل نشرة deploy بتقطع طلبات بنصها.
  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    await this.broadcastQueue.close();
    await this.scheduledQueue.close();
    this.redis.disconnect();
    await this.db.close();
  }
}
