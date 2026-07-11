import { Body, Controller, Headers, Post } from "@nestjs/common";
import { LoyaltyService, type CreateReferralResponse } from "./loyalty.service.js";

// §9 — POST /api/referrals : إنشاء إحالة pending (المدعو يُحال مرة واحدة — تعارض 409).
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN) بالخدمة.
@Controller("api/referrals")
export class ReferralsController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Post()
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<CreateReferralResponse> {
    return this.loyalty.createReferral(authorization, body);
  }
}
