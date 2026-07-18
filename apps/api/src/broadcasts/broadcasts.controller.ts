import { Body, Controller, Get, Headers, HttpCode, Post, Query } from "@nestjs/common";
import { Roles } from "../auth/roles.decorator.js";
import {
  BroadcastsService,
  type AudienceCountResponse,
  type CreateBroadcastResponse,
  type ListBroadcastsResponse,
} from "./broadcasts.service.js";

// §4.3/§14 — REST البث الجماهيري. التحقق (Zod §11) بالخدمة. §10.2/§11 — البث للكل قناة
// حسّاسة: محصورة بدور owner/dispatcher (RolesGuard)، فلا يبثّ دور support/accountant.
@Controller("api/broadcasts")
@Roles("owner", "dispatcher")
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Post()
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<CreateBroadcastResponse> {
    return this.broadcasts.create(authorization, body);
  }

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ListBroadcastsResponse> {
    return this.broadcasts.list(authorization, query);
  }

  // معاينة الوصول (قراءة فقط، لا إرسال) → 200. POST لأن الفلتر جسم مركّب (مصفوفات).
  @Post("audience-count")
  @HttpCode(200)
  async audienceCount(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<AudienceCountResponse> {
    return this.broadcasts.audienceCount(authorization, body);
  }
}
