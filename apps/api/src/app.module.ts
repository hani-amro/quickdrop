// رموز الحقن أولاً — قبل أي كنترولر — كي تُهيَّأ قيمها قبل تقييم مُزخرِفات @Inject
// في الخدمات (التي تعيد استيرادها من هنا)؛ وإلا حلقة الاستيراد تجعلها undefined.
import { BROADCAST_Q, DB, ENV, REDIS, SCHEDULED_Q, TG_QUEUE, WA_QUEUE } from "./tokens.js";
export { BROADCAST_Q, DB, ENV, REDIS, SCHEDULED_Q, TG_QUEUE, WA_QUEUE };
import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
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
import { RolesGuard } from "./auth/roles.guard.js";
import { RateLimitGuard } from "./common/rate-limit.guard.js";
import { BroadcastsController } from "./broadcasts/broadcasts.controller.js";
import { BroadcastsService } from "./broadcasts/broadcasts.service.js";
import { DriversController } from "./drivers/drivers.controller.js";
import { DriversService } from "./drivers/drivers.service.js";
import { HealthController } from "./health/health.controller.js";
import { MetricsController, MetricsInterceptor } from "./observability/metrics.js";
import { CouponsController } from "./loyalty/coupons.controller.js";
import { LoyaltyController } from "./loyalty/loyalty.controller.js";
import { LoyaltyService } from "./loyalty/loyalty.service.js";
import { ReferralsController } from "./loyalty/referrals.controller.js";
import { MerchantsController } from "./merchants/merchants.controller.js";
import { MerchantsService } from "./merchants/merchants.service.js";
import { MiniappController } from "./miniapp/miniapp.controller.js";
import { RealtimeController } from "./realtime/realtime.controller.js";
import { MiniappService } from "./miniapp/miniapp.service.js";
import { OrdersController } from "./orders/orders.controller.js";
import { OrdersService } from "./orders/orders.service.js";
import { SettlementsController } from "./settlements/settlements.controller.js";
import { SettlementsService } from "./settlements/settlements.service.js";
import { SupportController } from "./support/support.controller.js";
import { SupportService } from "./support/support.service.js";
import { TelegramGatewayController } from "./telegram-gateway/gateway.controller.js";
import { TelegramGatewayService } from "./telegram-gateway/gateway.service.js";
import { TrackingController } from "./tracking/tracking.controller.js";
import { CoreModule } from "./core.module.js";
import { WaModule } from "./wa-gateway/wa.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { JourneysModule } from "./journeys/journeys.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { DriverController } from "./driver/driver.controller.js";
import { DriverService } from "./driver/driver.service.js";

@Module({
  imports: [CoreModule, WaModule, CrmModule, JourneysModule, PaymentsModule],
  controllers: [
    HealthController,
    OrdersController,
    DriversController,
    DriverController, // P5.1 — قناة السائق (PWA): /api/driver/* (ذاتي المصادقة بتوكن جلسة السائق)
    MerchantsController, // §3 — إدارة التجار وكتالوجهم
    MiniappController, // §10.3 — واجهة الـ Mini App (initData + توكن + بيانات)
    RealtimeController, // §10.1 — إصدار تذكرة اتصال الوقت الحقيقي (محروس بالجلسة)
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
    // §10.2/§11 — فصل الصلاحيات: **بعد** SessionGuard كي يقرأ staffSession.role. يفرض
    // @Roles على المعالجات الحساسة (تسوية مالية، بث) — يمنع دور support من أفعال accountant.
    { provide: APP_GUARD, useClass: RolesGuard },
    // §10.2 — حارس عام مستقل لكونسول المشرف: /api/admin/* تتطلب جلسة qd_admin أو Bearer
    // ADMIN_API_TOKEN (admin.guard يعفي /api/admin/auth الذاتية). دفاع مزدوج مع الخدمة.
    { provide: APP_GUARD, useClass: AdminGuard },
    TelegramGatewayService,
    OrdersService,
    DriversService,
    DriverService, // P5.1 — قناة السائق (جلسة Redis قابلة للإبطال + أفعال السائق)
    MerchantsService, // §3 — إدارة التجار وكتالوجهم
    MiniappService, // §10.3 — واجهة الـ Mini App
    SettlementsService,
    SupportService, // §9 — خيوط الدعم (customer↔support)
    LoyaltyService, // §9 — الولاء/الكوبونات/الإحالات
    BroadcastsService, // §4.3/§14 — البث الجماهيري
    AnalyticsService, // §13 — تحليلات اللوحة
    AdminService, // §14 — دورة حياة المستأجر والباقات
    AdminAuthService, // §10.2 — مصادقة المشرف الحقيقية (admin_users + جلسات qd_admin)
    AuthService, // §10.2 — مصادقة الطاقم (argon2id + جلسات Redis + TOTP)
    SessionGuard, // مزوّد الحارس العام أعلاه
    RolesGuard, // مزوّد حارس الأدوار العام أعلاه (Reflector يُحقن تلقائياً)
    AdminGuard, // مزوّد حارس المشرف العام أعلاه
  ],
})
export class AppModule {}
