import { Body, Controller, Get, Headers, HttpCode, Post, Query } from "@nestjs/common";
import {
  OrdersService,
  type CreateOrderResponse,
  type ListOrdersResponse,
  type QuoteResponse,
} from "./orders.service.js";

// §10.1 D15 — REST شاشة إنشاء الطلب اليدوي بالداشبورد:
//   POST /api/orders/quote  → تسعير فوري بنفس محرك البوت (§4.4: السعر قبل الحفظ)
//   POST /api/orders        → إنشاء الطلب بفاعل staff
//   GET  /api/orders        → قائمة مختصرة (ترقيم من الخادم §10.1)
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN — §10.2 لاحقاً) بالخدمة.
@Controller("api/orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post("quote")
  @HttpCode(200) // استعلام سعر، ليس إنشاء مورد — 200 لا 201
  async quote(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<QuoteResponse> {
    return this.orders.quote(authorization, body);
  }

  @Post()
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<CreateOrderResponse> {
    return this.orders.create(authorization, body);
  }

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ListOrdersResponse> {
    return this.orders.list(authorization, query);
  }
}
