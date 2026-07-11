import { Controller, Get, Headers, Param, Query } from "@nestjs/common";
import { LoyaltyService, type LoyaltyBalanceResponse } from "./loyalty.service.js";

// §9 — GET /api/loyalty/:userId?tenantSlug= : رصيد الولاء (SUM) + آخر 20 حدثاً + المستوى.
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN) بالخدمة — نفس نمط orders.
@Controller("api/loyalty")
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get(":userId")
  async balance(
    @Headers("authorization") authorization: string | undefined,
    @Param("userId") userId: string,
    @Query() query: unknown,
  ): Promise<LoyaltyBalanceResponse> {
    return this.loyalty.balance(authorization, userId, query);
  }
}
