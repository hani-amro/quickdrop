import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { DriverService, type DriverLinkResponse } from "../driver/driver.service.js";
import { DriversService, type CreateDriverResponse, type ListDriversResponse } from "./drivers.service.js";

// §10.1/§14 — سائقو المكتب:
//   GET  /api/drivers?tenantSlug= : قائمة السائقين للإسناد اليدوي بشاشة الإرسال.
//   POST /api/drivers             : إنشاء/تفعيل سائق مع فرض حد الباقة (§14 → 409 ترقية).
//   POST /api/drivers/:id/link          : إصدار رابط PWA للسائق (P5.1) — كود لمرة واحدة.
//   POST /api/drivers/:id/revoke-access : إبطال جلسة السائق فوراً (سائق غادر — P5.1).
// التحقق (Zod §11) والتخويل (جلسة الطاقم/STAFF_API_TOKEN) بالخدمة — نفس نمط orders.
@Controller("api/drivers")
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly driver: DriverService,
  ) {}

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

  // P5.1 — إصدار/إبطال وصول قناة السائق (PWA). @HttpCode(200): أفعال، لا إنشاء مورد دائم.
  @Post(":id/link")
  @HttpCode(200)
  async link(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<DriverLinkResponse> {
    return this.driver.issueLink(authorization, id, body);
  }

  @Post(":id/revoke-access")
  @HttpCode(200)
  async revokeAccess(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ revoked: true }> {
    return this.driver.revokeAccess(authorization, id, body);
  }
}
