import { Body, Controller, Get, Headers, HttpCode, Param, Post } from "@nestjs/common";
import {
  AdminService,
  type ExtendTrialResponse,
  type ListTenantsResponse,
  type RecordPaymentResponse,
  type TenantStatusResponse,
} from "./admin.service.js";

// §14/§10.2 — كونسول المشرف (منصة). مصادقة منفصلة تماماً عن الـ staff (Bearer
// ADMIN_API_TOKEN — §10.2 دخول المشرف الكامل لاحقاً)؛ غياب التوكن من env = 503.
//   GET  /api/admin/tenants                     → صحّة كل المستأجرين (§14)
//   POST /api/admin/tenants/:id/status          → تغيير الحالة {status, reason?}
//   POST /api/admin/tenants/:id/extend-trial    → تمديد التجربة {days}
//   POST /api/admin/tenants/:id/payments        → تسجيل تحصيل {amount, periodNote?}
// التحقق (Zod §11) والتخويل بالخدمة.
@Controller("api/admin")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("tenants")
  async listTenants(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<ListTenantsResponse> {
    return this.admin.listTenants(authorization);
  }

  @Post("tenants/:id/status")
  @HttpCode(200) // فعل على مورد قائم، ليس إنشاء
  async setStatus(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<TenantStatusResponse> {
    return this.admin.setStatus(authorization, id, body);
  }

  @Post("tenants/:id/extend-trial")
  @HttpCode(200)
  async extendTrial(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ExtendTrialResponse> {
    return this.admin.extendTrial(authorization, id, body);
  }

  @Post("tenants/:id/payments") // إنشاء صف تحصيل — 201 الافتراضي
  async recordPayment(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<RecordPaymentResponse> {
    return this.admin.recordPayment(authorization, id, body);
  }
}
