import { Body, Controller, Get, Headers, Post, Query } from "@nestjs/common";
import {
  BroadcastsService,
  type CreateBroadcastResponse,
  type ListBroadcastsResponse,
} from "./broadcasts.service.js";

// §4.3/§14 — REST البث الجماهيري:
//   POST /api/broadcasts  → إنشاء بثّة (ودفعها فوراً إن غير مجدولة)
//   GET  /api/broadcasts  → قائمة البثات بعدّاداتها
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN — §10.2 لاحقاً) بالخدمة.
@Controller("api/broadcasts")
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
}
