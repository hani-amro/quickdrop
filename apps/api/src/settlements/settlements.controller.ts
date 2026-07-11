import { Body, Controller, Get, Headers, HttpCode, Post, Query } from "@nestjs/common";
import {
  SettlementsService,
  type CloseSettlementResponse,
  type SettlementBoardResponse,
} from "./settlements.service.js";

// §8.2 — REST شاشة التسوية اليومية بالداشبورد:
//   GET  /api/settlements/board?tenantSlug= → صف لكل سائق عنده قيود غير مسوّاة
//                                             + periodDate اليوم بمنطقة المستأجر (الفخ 8)
//   POST /api/settlements/close             → إغلاق يوم سائق (settlements + قيد remitted §8.2)
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN) بالخدمة — نفس نمط orders.
@Controller("api/settlements")
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
}
