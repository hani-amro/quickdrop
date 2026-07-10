import { Controller, Get, Headers, Query } from "@nestjs/common";
import { DriversService, type ListDriversResponse } from "./drivers.service.js";

// §10.1 — GET /api/drivers?tenantSlug= : قائمة السائقين للإسناد اليدوي بشاشة الإرسال.
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN) بالخدمة — نفس نمط orders.
@Controller("api/drivers")
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ListDriversResponse> {
    return this.drivers.list(authorization, query);
  }
}
