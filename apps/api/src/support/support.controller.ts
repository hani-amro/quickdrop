import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  SupportService,
  type ListSupportThreadsResponse,
  type SupportCloseResponse,
  type SupportReplyResponse,
  type SupportThreadDetailResponse,
} from "./support.service.js";

// §9 — REST خيوط الدعم (customer↔support) للداشبورد. التحقق (Zod §11) والتخويل المؤقت
// (Bearer STAFF_API_TOKEN / جلسة عبر الحارس §10.2) بالخدمة — نفس نمط orders/merchants.
@Controller("api/support")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ListSupportThreadsResponse> {
    return this.support.listThreads(authorization, query);
  }

  @Get(":id")
  async detail(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<SupportThreadDetailResponse> {
    return this.support.getThread(authorization, id, query);
  }

  // رد الموظف: فعل على مورد قائم (يُنشئ رسالة، لا مورد دائم جديد) → 200
  @Post(":id/reply")
  @HttpCode(200)
  async reply(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<SupportReplyResponse> {
    return this.support.reply(authorization, id, body);
  }

  // إغلاق خيط: فعل على مورد قائم → 200
  @Post(":id/close")
  @HttpCode(200)
  async close(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<SupportCloseResponse> {
    return this.support.close(authorization, id, body);
  }
}
