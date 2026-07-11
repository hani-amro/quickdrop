import { Body, Controller, Get, Headers, Post, Query } from "@nestjs/common";
import { DriversService, type CreateDriverResponse, type ListDriversResponse } from "./drivers.service.js";

// §10.1/§14 — سائقو المكتب:
//   GET  /api/drivers?tenantSlug= : قائمة السائقين للإسناد اليدوي بشاشة الإرسال.
//   POST /api/drivers             : إنشاء/تفعيل سائق مع فرض حد الباقة (§14 → 409 ترقية).
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN) بالخدمة — نفس نمط orders.
@Controller("api/drivers")
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Post()
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<CreateDriverResponse> {
    return this.drivers.create(authorization, body);
  }

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ListDriversResponse> {
    return this.drivers.list(authorization, query);
  }
}
