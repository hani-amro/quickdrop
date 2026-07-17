import { Body, Controller, Get, Headers, HttpCode, Post, Query } from "@nestjs/common";
import { Roles } from "../auth/roles.decorator.js";
import {
  SettlementsService,
  type AdjustSettlementResponse,
  type CloseSettlementResponse,
  type SettlementBoardResponse,
} from "./settlements.service.js";

// §8.2 — REST شاشة التسوية اليومية بالداشبورد:
//   GET  /api/settlements/board?tenantSlug= → صف لكل سائق عنده قيود غير مسوّاة
//                                             + periodDate اليوم بمنطقة المستأجر (الفخ 8)
//   POST /api/settlements/close             → إغلاق يوم سائق (settlements + قيد remitted §8.2)
//   POST /api/settlements/adjust            → تصفية بقايا الذمّة بقيد adjustment/payout جديد
//                                             (append-only — لا إعادة فتح تسوية مغلقة §8.2)
// التحقق (Zod §11) بالخدمة. §10.2/§11 — التسوية شأن مالي: محصورة بدور owner/accountant
// (RolesGuard)، فلا يفتعل دور support/dispatcher قيود payout/adjustment (threat #2).
@Controller("api/settlements")
@Roles("owner", "accountant")
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get("board")
  async board(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<SettlementBoardResponse> {
    return this.settlements.board(authorization, query);
  }

  @Post("close")
  @HttpCode(200) // فعل على مورد قائم (يوم السائق)، ليس إنشاء
  async close(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<CloseSettlementResponse> {
    return this.settlements.close(authorization, body);
  }

  @Post("adjust")
  @HttpCode(201) // إنشاء قيد دفتر جديد (adjustment/payout §8.2)
  async adjust(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<AdjustSettlementResponse> {
    return this.settlements.adjust(authorization, body);
  }
}
