import { Body, Controller, Get, Headers, Post, Query } from "@nestjs/common";
import {
  LoyaltyService,
  type CreateCouponResponse,
  type ListCouponsResponse,
} from "./loyalty.service.js";

// §9 — الكوبونات بالداشبورد:
//   POST /api/coupons          → إنشاء كوبون (تعارض الكود = 409)
//   GET  /api/coupons?tenantSlug= → قائمة + عدد الاستخدامات (§16.10)
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN) بالخدمة.
@Controller("api/coupons")
export class CouponsController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Post()
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<CreateCouponResponse> {
    return this.loyalty.createCoupon(authorization, body);
  }

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ListCouponsResponse> {
    return this.loyalty.listCoupons(authorization, query);
  }
}
