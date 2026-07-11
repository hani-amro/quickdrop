import { Controller, Get, Headers, Query } from "@nestjs/common";
import { AnalyticsService, type AnalyticsResponse } from "./analytics.service.js";

// §13/§10 — GET /api/analytics?days= : إحصاءات لوحة المكتب.
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN — §10.2 لاحقاً) بالخدمة.
@Controller("api/analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  async stats(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<AnalyticsResponse> {
    return this.analytics.stats(authorization, query);
  }
}
